const COLLECTION = 'decisions';
const KEY = 'adr-log';
const MAX_BYTES = 12 * 1024;
const MAX_RECORDS = 40;
const STATUSES = ['proposed', 'accepted', 'superseded', 'deprecated'];
const DOC_FORMAT = 'velai.decision-log';

function jsonBytes(v) {
  let bytes = 0;
  for (const ch of JSON.stringify(v)) {
    const cp = ch.codePointAt(0);
    bytes += cp <= 0x7f ? 1 : cp <= 0x7ff ? 2 : cp <= 0xffff ? 3 : 4;
  }
  return bytes;
}

function nextAdrId(records) {
  let maxNum = 0;
  for (const r of records) {
    const m = /^ADR-(\d+)$/.exec(r.id);
    if (m) maxNum = Math.max(maxNum, Number(m[1]));
  }
  return `ADR-${String(maxNum + 1).padStart(3, '0')}`;
}

async function readLog() {
  const receipt = await globalThis.nmas.data.read({ collection: COLLECTION, key: KEY });
  const doc = receipt.value === null ? { schema_version: 1, records: [] } : receipt.value;
  if (!doc || doc.schema_version !== 1 || !Array.isArray(doc.records)) {
    throw new Error('决策日志格式无效');
  }
  return { revision: receipt.revision, records: doc.records };
}

async function writeLog(expectedRevision, records) {
  const value = { schema_version: 1, records };
  if (records.length > MAX_RECORDS || jsonBytes(value) > MAX_BYTES) {
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
    if (contribution === 'adr.list') return readLog();

    if (contribution === 'adr.save') {
      const { expected_revision, id, title, status, context, decision, consequences } = input;
      if (!title.trim() || !decision.trim() || !STATUSES.includes(status)) {
        return { status: 'invalid_input', revision: expected_revision };
      }
      const log = await readLog();
      if (log.revision !== expected_revision) return { status: 'conflict', revision: log.revision };
      const finalId = id === 'NEW' ? nextAdrId(log.records) : id;
      const existing = log.records.find(r => r.id === finalId);
      const record = {
        id: finalId,
        title: title.trim(),
        status,
        context: context.trim(),
        decision: decision.trim(),
        consequences: consequences.trim(),
        date: existing?.date || new Date().toISOString().slice(0, 10),
      };
      const next = existing
        ? log.records.map(r => (r.id === finalId ? record : r))
        : [...log.records, record];
      const saved = await writeLog(expected_revision, next);
      return saved.status === 'saved' ? { status: 'saved', revision: saved.revision, id: finalId } : saved;
    }

    if (contribution === 'adr.delete') {
      const log = await readLog();
      if (log.revision !== input.expected_revision) return { status: 'conflict', revision: log.revision };
      if (!log.records.some(r => r.id === input.id)) return { status: 'not_found', revision: log.revision };
      const res = await writeLog(input.expected_revision, log.records.filter(r => r.id !== input.id));
      return res.status === 'saved' ? { status: 'deleted', revision: res.revision } : { status: 'conflict', revision: res.revision };
    }

    if (contribution === 'document.list') {
      const log = await readLog();
      return { items: log.records.map(r => ({ id: r.id, label: `${r.id} ${r.title}` })) };
    }

    if (contribution === 'document.export') {
      const log = await readLog();
      const rec = log.records.find(r => r.id === input.id);
      if (!rec) return { error: 'not_found' };
      const text = JSON.stringify({ format: DOC_FORMAT, version: 1, record: rec }, null, 2);
      return { filename: `${rec.id.toLowerCase()}.json`, text };
    }

    if (contribution === 'document.import') {
      let parsed;
      try { parsed = JSON.parse(input.text); } catch { return { imported: false, reason: 'invalid_json' }; }
      const r = parsed?.record;
      if (parsed?.format !== DOC_FORMAT || parsed?.version !== 1 || typeof r?.title !== 'string' || !r.title.trim() || typeof r?.decision !== 'string' || !r.decision.trim()) {
        return { imported: false, reason: 'invalid_document' };
      }
      const log = await readLog();
      const id = nextAdrId(log.records);
      const record = {
        id,
        title: r.title.trim().slice(0, 100),
        status: STATUSES.includes(r.status) ? r.status : 'proposed',
        context: typeof r.context === 'string' ? r.context.trim().slice(0, 600) : '',
        decision: r.decision.trim().slice(0, 600),
        consequences: typeof r.consequences === 'string' ? r.consequences.trim().slice(0, 600) : '',
        date: new Date().toISOString().slice(0, 10),
      };
      const res = await writeLog(log.revision, [...log.records, record]);
      return res.status === 'saved' ? { imported: true } : { imported: false, reason: res.status };
    }
  }

  if (kind === 'tool') {
    if (contribution === 'decision.list') {
      const log = await readLog();
      const kw = (input.keyword || '').trim().toLowerCase();
      const records = log.records
        .filter(r => (!input.status || r.status === input.status) && (!kw || `${r.id} ${r.title} ${r.context} ${r.decision}`.toLowerCase().includes(kw)))
        .map(({ id, title, status, decision, date }) => ({ id, title, status, decision, date }));
      return { success: true, status: 'ready', records };
    }

    if (contribution === 'decision.record') {
      if (!input.title.trim() || !input.decision.trim()) return { success: false, status: 'invalid_input' };
      const log = await readLog();
      const id = nextAdrId(log.records);
      const record = {
        id,
        title: input.title.trim(),
        status: STATUSES.includes(input.status) ? input.status : 'proposed',
        context: (input.context || '').trim(),
        decision: input.decision.trim(),
        consequences: (input.consequences || '').trim(),
        date: new Date().toISOString().slice(0, 10),
      };
      const saved = await writeLog(log.revision, [...log.records, record]);
      return saved.status === 'saved' ? { success: true, status: 'saved', id } : { success: false, status: saved.status };
    }
  }

  throw new Error(`不支持的调用: ${kind}/${contribution}`);
}
