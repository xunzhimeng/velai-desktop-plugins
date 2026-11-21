const COLLECTION = 'okr';
const KEY = 'board';
const MAX_BYTES = 12 * 1024;
const MAX_OBJECTIVES = 20;
const MAX_KRS = 8;
const DOC_FORMAT = 'velai.okr-tracker';

function jsonBytes(v) {
  let b = 0;
  for (const ch of JSON.stringify(v)) {
    const cp = ch.codePointAt(0);
    b += cp <= 0x7f ? 1 : cp <= 0x7ff ? 2 : cp <= 0xffff ? 3 : 4;
  }
  return b;
}

function clampPct(n) {
  return Math.max(0, Math.min(100, Math.round(n)));
}

function enrichObjective(o) {
  const krs = (o.krs || []).map(kr => ({
    ...kr,
    pct: clampPct((kr.current / kr.target) * 100),
  }));
  const progress_pct = krs.length ? clampPct(krs.reduce((s, k) => s + k.pct, 0) / krs.length) : 0;
  return { id: o.id, cycle: o.cycle, title: o.title, progress_pct, krs };
}

function calcOverall(objectives) {
  if (!objectives.length) return 0;
  return clampPct(objectives.reduce((s, o) => s + o.progress_pct, 0) / objectives.length);
}

async function readOkr() {
  const receipt = await globalThis.nmas.data.read({ collection: COLLECTION, key: KEY });
  const doc = receipt.value === null ? { schema_version: 1, objectives: [] } : receipt.value;
  if (!doc || doc.schema_version !== 1 || !Array.isArray(doc.objectives)) {
    throw new Error('OKR 数据结构无效');
  }
  const objectives = doc.objectives.map(enrichObjective);
  return { revision: receipt.revision, overall_pct: calcOverall(objectives), objectives };
}

async function writeOkr(expectedRevision, objectives) {
  const clean = objectives.map(o => ({
    id: o.id,
    cycle: o.cycle,
    title: o.title,
    krs: o.krs.map(({ id, title, current, target, unit }) => ({ id, title, current, target, unit })),
  }));
  const value = { schema_version: 1, objectives: clean };
  if (clean.length > MAX_OBJECTIVES || jsonBytes(value) > MAX_BYTES) {
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
    if (contribution === 'okr.read') return readOkr();

    if (contribution === 'okr.save') {
      const { expected_revision, id, cycle, title, krs } = input;
      if (!title.trim() || !cycle.trim() || krs.length > MAX_KRS || !/^[a-zA-Z0-9._-]+$/.test(id)) {
        return { status: 'invalid_input', revision: expected_revision };
      }
      const data = await readOkr();
      if (data.revision !== expected_revision) return { status: 'conflict', revision: data.revision };
      const record = {
        id,
        cycle: cycle.trim(),
        title: title.trim(),
        krs: krs.map(k => ({
          id: k.id,
          title: k.title.trim(),
          current: Number(k.current),
          target: Number(k.target),
          unit: k.unit.trim(),
        })),
      };
      const exists = data.objectives.some(o => o.id === id);
      const next = exists ? data.objectives.map(o => (o.id === id ? record : o)) : [...data.objectives, record];
      return writeOkr(expected_revision, next);
    }

    if (contribution === 'okr.delete') {
      const data = await readOkr();
      if (data.revision !== input.expected_revision) return { status: 'conflict', revision: data.revision };
      if (!data.objectives.some(o => o.id === input.id)) return { status: 'not_found', revision: data.revision };
      const res = await writeOkr(input.expected_revision, data.objectives.filter(o => o.id !== input.id));
      return res.status === 'saved' ? { status: 'deleted', revision: res.revision } : { status: 'conflict', revision: res.revision };
    }

    if (contribution === 'document.list') {
      const data = await readOkr();
      return { items: data.objectives.length ? [{ id: 'all', label: `全部 OKR (${data.objectives.length} 项)` }] : [] };
    }

    if (contribution === 'document.export') {
      const data = await readOkr();
      if (input.id !== 'all') return { error: 'not_found' };
      const text = JSON.stringify({ format: DOC_FORMAT, version: 1, objectives: data.objectives }, null, 2);
      return { filename: 'okr-tracker.json', text };
    }

    if (contribution === 'document.import') {
      let parsed;
      try { parsed = JSON.parse(input.text); } catch { return { imported: false, reason: 'invalid_json' }; }
      if (parsed?.format !== DOC_FORMAT || parsed?.version !== 1 || !Array.isArray(parsed.objectives)) {
        return { imported: false, reason: 'invalid_document' };
      }
      const data = await readOkr();
      const next = [...data.objectives];
      for (let i = 0; i < parsed.objectives.length; i++) {
        const o = parsed.objectives[i];
        if (typeof o?.title !== 'string' || !o.title.trim() || typeof o?.cycle !== 'string' || !o.cycle.trim()) continue;
        const krs = Array.isArray(o.krs)
          ? o.krs
              .filter(k => typeof k?.title === 'string' && k.title.trim() && Number(k.target) > 0)
              .slice(0, MAX_KRS)
              .map((k, ki) => ({
                id: `kr-${ki + 1}`,
                title: k.title.trim().slice(0, 100),
                current: Math.max(0, Number(k.current) || 0),
                target: Number(k.target),
                unit: typeof k.unit === 'string' ? k.unit.trim().slice(0, 16) : '',
              }))
          : [];
        next.push({
          id: `obj-${Date.now().toString(36)}-${i}`,
          cycle: o.cycle.trim().slice(0, 24),
          title: o.title.trim().slice(0, 120),
          krs,
        });
      }
      const res = await writeOkr(data.revision, next);
      return res.status === 'saved' ? { imported: true } : { imported: false, reason: res.status };
    }
  }

  if (kind === 'tool' && contribution === 'okr.summary') {
    const data = await readOkr();
    const cycle = (input.cycle || '').trim();
    const filtered = data.objectives.filter(o => !cycle || o.cycle === cycle);
    return {
      success: true,
      status: 'ready',
      overall_pct: calcOverall(filtered),
      objectives: filtered.map(o => ({
        id: o.id,
        cycle: o.cycle,
        title: o.title,
        progress_pct: o.progress_pct,
        kr_count: o.krs.length,
      })),
    };
  }

  throw new Error(`不支持的调用: ${kind}/${contribution}`);
}
