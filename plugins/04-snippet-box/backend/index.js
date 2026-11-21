const COLLECTION = 'snippets';
const KEY = 'box';
const MAX_BYTES = 12 * 1024;
const MAX_SNIPPETS = 60;

function jsonBytes(v) {
  let b = 0;
  for (const ch of JSON.stringify(v)) {
    const cp = ch.codePointAt(0);
    b += cp <= 0x7f ? 1 : cp <= 0x7ff ? 2 : cp <= 0xffff ? 3 : 4;
  }
  return b;
}

function sortSnippets(list) {
  return list.slice().sort((a, b) => Number(b.pinned) - Number(a.pinned));
}

async function readBox() {
  const receipt = await globalThis.nmas.data.read({ collection: COLLECTION, key: KEY });
  const doc = receipt.value === null ? { schema_version: 1, snippets: [] } : receipt.value;
  if (!doc || doc.schema_version !== 1 || !Array.isArray(doc.snippets)) {
    throw new Error('片段库数据格式无效');
  }
  return { revision: receipt.revision, snippets: sortSnippets(doc.snippets) };
}

async function writeBox(expectedRevision, snippets) {
  const value = { schema_version: 1, snippets: sortSnippets(snippets) };
  if (snippets.length > MAX_SNIPPETS || jsonBytes(value) > MAX_BYTES) {
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
    if (contribution === 'snippet.list') return readBox();

    if (contribution === 'snippet.save') {
      const { expected_revision, id, title, tag, pinned, body } = input;
      if (!title.trim() || !body.trim() || !/^[a-zA-Z0-9._-]+$/.test(id)) {
        return { status: 'invalid_input', revision: expected_revision };
      }
      const box = await readBox();
      if (box.revision !== expected_revision) return { status: 'conflict', revision: box.revision };
      const record = { id, title: title.trim(), tag: tag.trim(), pinned: Boolean(pinned), body: body.trim() };
      const exists = box.snippets.some(s => s.id === id);
      const next = exists ? box.snippets.map(s => (s.id === id ? record : s)) : [...box.snippets, record];
      return writeBox(expected_revision, next);
    }

    if (contribution === 'snippet.delete') {
      const box = await readBox();
      if (box.revision !== input.expected_revision) return { status: 'conflict', revision: box.revision };
      if (!box.snippets.some(s => s.id === input.id)) return { status: 'not_found', revision: box.revision };
      const res = await writeBox(input.expected_revision, box.snippets.filter(s => s.id !== input.id));
      return res.status === 'saved' ? { status: 'deleted', revision: res.revision } : { status: 'conflict', revision: res.revision };
    }
  }

  if (kind === 'tool' && contribution === 'snippet.search') {
    const box = await readBox();
    const kw = (input.keyword || '').trim().toLowerCase();
    const tag = (input.tag || '').trim().toLowerCase();
    const matched = box.snippets.filter(s => {
      if (tag && s.tag.toLowerCase() !== tag) return false;
      if (kw && !`${s.title} ${s.tag} ${s.body}`.toLowerCase().includes(kw)) return false;
      return true;
    });
    return { success: true, status: 'ready', snippets: matched.slice(0, 12) };
  }

  throw new Error(`不支持的调用: ${kind}/${contribution}`);
}
