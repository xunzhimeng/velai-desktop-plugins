const COLLECTION = 'prompts';
const KEY = 'vault';
const MAX_BYTES = 12 * 1024;
const MAX_TEMPLATES = 48;
const CATEGORIES = ['general', 'coding', 'writing', 'analysis', 'translation'];
const DOC_FORMAT = 'velai.prompt-vault';

function jsonBytes(value) {
  let bytes = 0;
  for (const ch of JSON.stringify(value)) {
    const cp = ch.codePointAt(0);
    bytes += cp <= 0x7f ? 1 : cp <= 0x7ff ? 2 : cp <= 0xffff ? 3 : 4;
  }
  return bytes;
}

function extractVariables(content) {
  const seen = new Set();
  const list = [];
  const re = /\{\{\s*([a-zA-Z0-9_\-\u4e00-\u9fff]{1,40})\s*\}\}/g;
  let match;
  while ((match = re.exec(content)) !== null) {
    const name = match[1];
    if (!seen.has(name) && list.length < 24) {
      seen.add(name);
      list.push(name);
    }
  }
  return list;
}

function renderTemplate(content, values) {
  const map = new Map();
  for (const item of values || []) {
    if (item && typeof item.name === 'string' && typeof item.value === 'string') {
      map.set(item.name, item.value);
    }
  }
  const missing = [];
  const seenMissing = new Set();
  const rendered = content.replace(/\{\{\s*([a-zA-Z0-9_\-\u4e00-\u9fff]{1,40})\s*\}\}/g, (full, name) => {
    if (map.has(name) && map.get(name) !== '') return map.get(name);
    if (!seenMissing.has(name)) {
      seenMissing.add(name);
      missing.push(name);
    }
    return full;
  });
  return { rendered, missing };
}

function validId(id) {
  return typeof id === 'string' && id.length >= 1 && id.length <= 64 && /^[a-zA-Z0-9._-]+$/.test(id);
}

async function readVault() {
  const receipt = await globalThis.nmas.data.read({ collection: COLLECTION, key: KEY });
  const doc = receipt.value === null ? { schema_version: 1, templates: [] } : receipt.value;
  if (!doc || doc.schema_version !== 1 || !Array.isArray(doc.templates)) {
    throw new Error('提示词库数据结构无效');
  }
  return { revision: receipt.revision, templates: doc.templates };
}

async function writeVault(expectedRevision, templates) {
  const value = { schema_version: 1, templates };
  if (templates.length > MAX_TEMPLATES || jsonBytes(value) > MAX_BYTES) {
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
    if (contribution === 'vault.list') {
      return readVault();
    }

    if (contribution === 'vault.save') {
      const { expected_revision, id, title, category, content } = input;
      const cleanTitle = title.trim();
      const cleanContent = content.trim();
      if (!validId(id) || !cleanTitle || !cleanContent || !CATEGORIES.includes(category)) {
        return { status: 'invalid_input', revision: expected_revision };
      }
      const current = await readVault();
      if (current.revision !== expected_revision) {
        return { status: 'conflict', revision: current.revision };
      }
      const variables = extractVariables(cleanContent);
      const record = {
        id,
        title: cleanTitle,
        category,
        content: cleanContent,
        variables,
        updated_at: new Date().toISOString().slice(0, 19) + 'Z',
      };
      const exists = current.templates.some(t => t.id === id);
      const next = exists
        ? current.templates.map(t => (t.id === id ? record : t))
        : [...current.templates, record];
      const saved = await writeVault(expected_revision, next);
      return saved.status === 'saved' ? { status: 'saved', revision: saved.revision, variables } : saved;
    }

    if (contribution === 'vault.delete') {
      const { expected_revision, id } = input;
      const current = await readVault();
      if (current.revision !== expected_revision) {
        return { status: 'conflict', revision: current.revision };
      }
      if (!current.templates.some(t => t.id === id)) {
        return { status: 'not_found', revision: current.revision };
      }
      const next = current.templates.filter(t => t.id !== id);
      const saved = await writeVault(expected_revision, next);
      return saved.status === 'saved'
        ? { status: 'deleted', revision: saved.revision }
        : { status: 'conflict', revision: saved.revision };
    }

    if (contribution === 'vault.render') {
      const current = await readVault();
      const tpl = current.templates.find(t => t.id === input.id);
      if (!tpl) return { status: 'not_found' };
      const { rendered, missing } = renderTemplate(tpl.content, input.values);
      return { status: 'ready', rendered, missing };
    }

    if (contribution === 'document.list') {
      const current = await readVault();
      return { items: current.templates.map(t => ({ id: t.id, label: `[${t.category}] ${t.title}` })) };
    }

    if (contribution === 'document.export') {
      const current = await readVault();
      const tpl = current.templates.find(t => t.id === input.id);
      if (!tpl) return { error: 'not_found' };
      const text = JSON.stringify(
        { format: DOC_FORMAT, version: 1, template: { title: tpl.title, category: tpl.category, content: tpl.content } },
        null,
        2,
      );
      return { filename: `prompt-${tpl.id}.json`, text };
    }

    if (contribution === 'document.import') {
      let parsed;
      try {
        parsed = JSON.parse(input.text);
      } catch {
        return { imported: false, reason: 'invalid_json' };
      }
      const tpl = parsed?.template;
      if (
        parsed?.format !== DOC_FORMAT ||
        parsed?.version !== 1 ||
        typeof tpl?.title !== 'string' ||
        !tpl.title.trim() ||
        !CATEGORIES.includes(tpl.category) ||
        typeof tpl?.content !== 'string' ||
        !tpl.content.trim()
      ) {
        return { imported: false, reason: 'invalid_document' };
      }
      const current = await readVault();
      const newId = `imp-${Date.now().toString(36)}`;
      const record = {
        id: newId,
        title: tpl.title.trim().slice(0, 80),
        category: tpl.category,
        content: tpl.content.trim().slice(0, 2048),
        variables: extractVariables(tpl.content.trim()),
        updated_at: new Date().toISOString().slice(0, 19) + 'Z',
      };
      const saved = await writeVault(current.revision, [...current.templates, record]);
      return saved.status === 'saved' ? { imported: true } : { imported: false, reason: saved.status };
    }
  }

  if (kind === 'tool') {
    if (contribution === 'prompt.list') {
      const current = await readVault();
      const kw = (input.keyword || '').trim().toLowerCase();
      const filtered = current.templates.filter(t => {
        if (input.category && t.category !== input.category) return false;
        if (kw && !t.title.toLowerCase().includes(kw) && !t.content.toLowerCase().includes(kw)) return false;
        return true;
      });
      return {
        success: true,
        status: 'ready',
        templates: filtered.map(({ id, title, category, variables }) => ({ id, title, category, variables })),
      };
    }

    if (contribution === 'prompt.render') {
      const current = await readVault();
      const tpl = current.templates.find(t => t.id === input.id);
      if (!tpl) return { success: false, status: 'not_found' };
      const { rendered, missing } = renderTemplate(tpl.content, input.values || []);
      return { success: true, status: 'ready', title: tpl.title, rendered, missing };
    }
  }

  throw new Error(`不支持的调用: ${kind}/${contribution}`);
}
