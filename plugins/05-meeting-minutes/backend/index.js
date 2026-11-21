const COLLECTION = 'minutes';
const KEY = 'notebook';
const MAX_BYTES = 12 * 1024;
const MAX_MEETINGS = 32;

function jsonBytes(v) {
  let b = 0;
  for (const ch of JSON.stringify(v)) {
    const cp = ch.codePointAt(0);
    b += cp <= 0x7f ? 1 : cp <= 0x7ff ? 2 : cp <= 0xffff ? 3 : 4;
  }
  return b;
}

async function readNotebook() {
  const receipt = await globalThis.nmas.data.read({ collection: COLLECTION, key: KEY });
  const doc = receipt.value === null ? { schema_version: 1, meetings: [] } : receipt.value;
  if (!doc || doc.schema_version !== 1 || !Array.isArray(doc.meetings)) {
    throw new Error('会议纪要数据格式无效');
  }
  return { revision: receipt.revision, meetings: doc.meetings };
}

async function writeNotebook(expectedRevision, meetings) {
  const value = { schema_version: 1, meetings };
  if (meetings.length > MAX_MEETINGS || jsonBytes(value) > MAX_BYTES) {
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
    if (contribution === 'minutes.read') return readNotebook();

    if (contribution === 'minutes.save') {
      const { expected_revision, id, title, date, attendees, raw_notes, summary } = input;
      if (!title.trim() || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^[a-zA-Z0-9._-]+$/.test(id)) {
        return { status: 'invalid_input', revision: expected_revision };
      }
      const book = await readNotebook();
      if (book.revision !== expected_revision) return { status: 'conflict', revision: book.revision };
      const record = {
        id,
        title: title.trim(),
        date,
        attendees: attendees.trim(),
        raw_notes: raw_notes.trim(),
        summary: summary.trim(),
      };
      const exists = book.meetings.some(m => m.id === id);
      const next = exists ? book.meetings.map(m => (m.id === id ? record : m)) : [record, ...book.meetings];
      return writeNotebook(expected_revision, next);
    }

    if (contribution === 'minutes.delete') {
      const book = await readNotebook();
      if (book.revision !== input.expected_revision) return { status: 'conflict', revision: book.revision };
      if (!book.meetings.some(m => m.id === input.id)) return { status: 'not_found', revision: book.revision };
      const res = await writeNotebook(input.expected_revision, book.meetings.filter(m => m.id !== input.id));
      return res.status === 'saved' ? { status: 'deleted', revision: res.revision } : { status: 'conflict', revision: res.revision };
    }
  }

  if (kind === 'tool' && contribution === 'minutes.list') {
    const book = await readNotebook();
    const kw = (input.keyword || '').trim().toLowerCase();
    const matched = book.meetings
      .filter(m => !kw || `${m.title} ${m.date} ${m.attendees} ${m.summary} ${m.raw_notes}`.toLowerCase().includes(kw))
      .map(({ id, title, date, attendees, summary }) => ({ id, title, date, attendees, summary }));
    return { success: true, status: 'ready', meetings: matched.slice(0, 10) };
  }

  throw new Error(`不支持的调用: ${kind}/${contribution}`);
}
