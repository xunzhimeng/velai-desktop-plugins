const COLLECTION = 'checklist';
const KEY = 'board';
const MAX_BYTES = 12 * 1024;
const MAX_ITEMS = 80;
const PRIORITIES = ['high', 'medium', 'low'];
const STATES = ['todo', 'doing', 'done'];
const DOC_FORMAT = 'velai.project-checklist';

function jsonBytes(value) {
  let bytes = 0;
  for (const ch of JSON.stringify(value)) {
    const cp = ch.codePointAt(0);
    bytes += cp <= 0x7f ? 1 : cp <= 0x7ff ? 2 : cp <= 0xffff ? 3 : 4;
  }
  return bytes;
}

function summarize(items) {
  const todo = items.filter(i => i.state === 'todo').length;
  const doing = items.filter(i => i.state === 'doing').length;
  const done = items.filter(i => i.state === 'done').length;
  const total = items.length;
  return { total, todo, doing, done, completion_pct: total === 0 ? 0 : Math.round((done * 100) / total) };
}

async function readBoard() {
  const receipt = await globalThis.nmas.data.read({ collection: COLLECTION, key: KEY });
  const doc = receipt.value === null ? { schema_version: 1, items: [] } : receipt.value;
  if (!doc || doc.schema_version !== 1 || !Array.isArray(doc.items)) {
    throw new Error('项目清单数据格式无效');
  }
  return { revision: receipt.revision, items: doc.items };
}

async function writeBoard(expectedRevision, items) {
  const value = { schema_version: 1, items };
  if (items.length > MAX_ITEMS || jsonBytes(value) > MAX_BYTES) {
    return { status: 'limit', revision: expectedRevision };
  }
  try {
    const receipt = await globalThis.nmas.data.write({
      collection: COLLECTION,
      key: KEY,
      expected_revision: expectedRevision,
      value,
    });
    return { status: 'saved', revision: receipt.revision };
  } catch (err) {
    if (err?.code === 'conflict' && err.outcome_unknown === false) {
      return { status: 'conflict', revision: expectedRevision };
    }
    throw err;
  }
}

export default async function (request) {
  const { kind, contribution, input } = request ?? {};

  if (kind === 'action') {
    if (contribution === 'tasks.list') {
      const board = await readBoard();
      return { revision: board.revision, items: board.items, summary: summarize(board.items) };
    }

    if (contribution === 'tasks.upsert') {
      const { expected_revision, id, title, milestone, priority, state, note } = input;
      const cleanTitle = title.trim();
      if (!cleanTitle || !/^[a-zA-Z0-9._-]+$/.test(id) || !PRIORITIES.includes(priority) || !STATES.includes(state)) {
        return { status: 'invalid_input', revision: expected_revision };
      }
      const board = await readBoard();
      if (board.revision !== expected_revision) return { status: 'conflict', revision: board.revision };
      const record = { id, title: cleanTitle, milestone: milestone.trim(), priority, state, note: note.trim() };
      const exists = board.items.some(item => item.id === id);
      const next = exists ? board.items.map(item => (item.id === id ? record : item)) : [...board.items, record];
      return writeBoard(expected_revision, next);
    }

    if (contribution === 'tasks.remove') {
      const { expected_revision, id } = input;
      const board = await readBoard();
      if (board.revision !== expected_revision) return { status: 'conflict', revision: board.revision };
      if (!board.items.some(item => item.id === id)) return { status: 'not_found', revision: board.revision };
      const next = board.items.filter(item => item.id !== id);
      const res = await writeBoard(expected_revision, next);
      return res.status === 'saved' ? { status: 'deleted', revision: res.revision } : { status: 'conflict', revision: res.revision };
    }

    if (contribution === 'document.list') {
      const board = await readBoard();
      return { items: board.items.length ? [{ id: 'all', label: `全部项目任务 (${board.items.length} 项)` }] : [] };
    }

    if (contribution === 'document.export') {
      const board = await readBoard();
      if (input.id !== 'all') return { error: 'not_found' };
      const text = JSON.stringify({ format: DOC_FORMAT, version: 1, items: board.items }, null, 2);
      return { filename: 'project-checklist.json', text };
    }

    if (contribution === 'document.import') {
      let parsed;
      try { parsed = JSON.parse(input.text); } catch { return { imported: false, reason: 'invalid_json' }; }
      if (parsed?.format !== DOC_FORMAT || parsed?.version !== 1 || !Array.isArray(parsed.items)) {
        return { imported: false, reason: 'invalid_document' };
      }
      const board = await readBoard();
      const next = [...board.items];
      for (let i = 0; i < parsed.items.length; i++) {
        const raw = parsed.items[i];
        if (typeof raw?.title !== 'string' || !raw.title.trim()) continue;
        next.push({
          id: `imp-${Date.now().toString(36)}-${i}`,
          title: raw.title.trim().slice(0, 120),
          milestone: typeof raw.milestone === 'string' ? raw.milestone.trim().slice(0, 48) : '',
          priority: PRIORITIES.includes(raw.priority) ? raw.priority : 'medium',
          state: STATES.includes(raw.state) ? raw.state : 'todo',
          note: typeof raw.note === 'string' ? raw.note.trim().slice(0, 300) : '',
        });
      }
      const res = await writeBoard(board.revision, next);
      return res.status === 'saved' ? { imported: true } : { imported: false, reason: res.status };
    }
  }

  if (kind === 'tool') {
    if (contribution === 'checklist.list') {
      const board = await readBoard();
      const ms = (input.milestone || '').trim().toLowerCase();
      const items = board.items
        .filter(item => (!input.state || item.state === input.state) && (!ms || item.milestone.toLowerCase().includes(ms)))
        .map(({ id, title, milestone, priority, state }) => ({ id, title, milestone, priority, state }));
      return { success: true, status: 'ready', completion_pct: summarize(board.items).completion_pct, items };
    }

    if (contribution === 'checklist.add') {
      const cleanTitle = (input.title || '').trim();
      if (!cleanTitle) return { success: false, status: 'invalid_input' };
      const board = await readBoard();
      const id = `t-${Date.now().toString(36)}-${board.items.length + 1}`;
      const record = {
        id,
        title: cleanTitle,
        milestone: (input.milestone || '').trim(),
        priority: PRIORITIES.includes(input.priority) ? input.priority : 'medium',
        state: 'todo',
        note: (input.note || '').trim(),
      };
      const saved = await writeBoard(board.revision, [...board.items, record]);
      return saved.status === 'saved'
        ? { success: true, status: 'saved', id }
        : { success: false, status: saved.status };
    }
  }

  throw new Error(`不支持的调用: ${kind}/${contribution}`);
}
