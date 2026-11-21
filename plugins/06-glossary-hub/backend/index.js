const COLLECTION = 'glossary';
const KEY = 'terms';
const MAX_BYTES = 12 * 1024;
const MAX_TERMS = 100;
const DOC_FORMAT = 'velai.glossary-hub';

function jsonBytes(v) {
  let b = 0;
  for (const ch of JSON.stringify(v)) {
    const cp = ch.codePointAt(0);
    b += cp <= 0x7f ? 1 : cp <= 0x7ff ? 2 : cp <= 0xffff ? 3 : 4;
  }
  return b;
}

function sortTerms(list) {
  return list.slice().sort((a, b) => a.term.localeCompare(b.term, 'zh-CN'));
}

async function readGlossary() {
  const receipt = await globalThis.nmas.data.read({ collection: COLLECTION, key: KEY });
  const doc = receipt.value === null ? { schema_version: 1, terms: [] } : receipt.value;
  if (!doc || doc.schema_version !== 1 || !Array.isArray(doc.terms)) {
    throw new Error('术语表格式无效');
  }
  return { revision: receipt.revision, terms: sortTerms(doc.terms) };
}

async function writeGlossary(expectedRevision, terms) {
  const value = { schema_version: 1, terms: sortTerms(terms) };
  if (terms.length > MAX_TERMS || jsonBytes(value) > MAX_BYTES) {
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
    if (contribution === 'glossary.list') return readGlossary();

    if (contribution === 'glossary.save') {
      const term = input.term.trim();
      const def = input.definition.trim();
      if (!term || !def) return { status: 'invalid_input', revision: input.expected_revision };
      const data = await readGlossary();
      if (data.revision !== input.expected_revision) return { status: 'conflict', revision: data.revision };
      const record = { term, alias: input.alias.trim(), domain: input.domain.trim(), definition: def };
      const idx = data.terms.findIndex(t => t.term.toLowerCase() === term.toLowerCase());
      const next = idx >= 0 ? data.terms.map((t, i) => (i === idx ? record : t)) : [...data.terms, record];
      return writeGlossary(input.expected_revision, next);
    }

    if (contribution === 'glossary.delete') {
      const data = await readGlossary();
      if (data.revision !== input.expected_revision) return { status: 'conflict', revision: data.revision };
      const key = input.term.trim().toLowerCase();
      if (!data.terms.some(t => t.term.toLowerCase() === key)) return { status: 'not_found', revision: data.revision };
      const res = await writeGlossary(input.expected_revision, data.terms.filter(t => t.term.toLowerCase() !== key));
      return res.status === 'saved' ? { status: 'deleted', revision: res.revision } : { status: 'conflict', revision: res.revision };
    }

    if (contribution === 'document.list') {
      const data = await readGlossary();
      return { items: data.terms.length ? [{ id: 'all', label: `项目全部术语 (${data.terms.length} 条)` }] : [] };
    }

    if (contribution === 'document.export') {
      const data = await readGlossary();
      if (input.id !== 'all') return { error: 'not_found' };
      const text = JSON.stringify({ format: DOC_FORMAT, version: 1, terms: data.terms }, null, 2);
      return { filename: 'project-glossary.json', text };
    }

    if (contribution === 'document.import') {
      let parsed;
      try { parsed = JSON.parse(input.text); } catch { return { imported: false, reason: 'invalid_json' }; }
      if (parsed?.format !== DOC_FORMAT || parsed?.version !== 1 || !Array.isArray(parsed.terms)) {
        return { imported: false, reason: 'invalid_document' };
      }
      const data = await readGlossary();
      const map = new Map(data.terms.map(t => [t.term.toLowerCase(), t]));
      for (const raw of parsed.terms) {
        if (typeof raw?.term !== 'string' || !raw.term.trim() || typeof raw?.definition !== 'string' || !raw.definition.trim()) continue;
        const term = raw.term.trim().slice(0, 64);
        map.set(term.toLowerCase(), {
          term,
          alias: typeof raw.alias === 'string' ? raw.alias.trim().slice(0, 80) : '',
          domain: typeof raw.domain === 'string' ? raw.domain.trim().slice(0, 40) : '',
          definition: raw.definition.trim().slice(0, 400),
        });
      }
      const res = await writeGlossary(data.revision, Array.from(map.values()));
      return res.status === 'saved' ? { imported: true } : { imported: false, reason: res.status };
    }
  }

  if (kind === 'tool') {
    if (contribution === 'glossary.lookup') {
      const data = await readGlossary();
      const q = (input.query || '').trim().toLowerCase();
      const domain = (input.domain || '').trim().toLowerCase();
      const matched = data.terms.filter(t => {
        if (domain && t.domain.toLowerCase() !== domain) return false;
        if (q && !`${t.term} ${t.alias} ${t.definition}`.toLowerCase().includes(q)) return false;
        return true;
      });
      return { success: true, status: 'ready', terms: matched.slice(0, 20) };
    }

    if (contribution === 'glossary.upsert') {
      const term = input.term.trim();
      const def = input.definition.trim();
      if (!term || !def) return { success: false, status: 'invalid_input' };
      const data = await readGlossary();
      const record = { term, alias: (input.alias || '').trim(), domain: (input.domain || '').trim(), definition: def };
      const idx = data.terms.findIndex(t => t.term.toLowerCase() === term.toLowerCase());
      const next = idx >= 0 ? data.terms.map((t, i) => (i === idx ? record : t)) : [...data.terms, record];
      const saved = await writeGlossary(data.revision, next);
      return { success: saved.status === 'saved', status: saved.status };
    }
  }

  throw new Error(`不支持的调用: ${kind}/${contribution}`);
}
