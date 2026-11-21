function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v !== null && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = sortKeys(v[k]);
    return out;
  }
  return v;
}

function stats(v, depth = 0) {
  if (Array.isArray(v)) {
    let maxD = depth;
    let keys = 0;
    for (const item of v) {
      const s = stats(item, depth + 1);
      if (s.depth > maxD) maxD = s.depth;
      keys += s.keys;
    }
    return { depth: maxD, keys };
  }
  if (v !== null && typeof v === 'object') {
    const entries = Object.values(v);
    let maxD = depth;
    let keys = entries.length;
    for (const child of entries) {
      const s = stats(child, depth + 1);
      if (s.depth > maxD) maxD = s.depth;
      keys += s.keys;
    }
    return { depth: maxD, keys };
  }
  return { depth, keys: 0 };
}

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function queryPath(root, path) {
  const clean = path.trim().replace(/^\$\.?/, '');
  if (!clean) return { found: true, value: root };
  const tokens = [];
  const re = /([^[.\]]+)|\[(\d+)\]/g;
  let m;
  while ((m = re.exec(clean)) !== null) {
    tokens.push(m[1] !== undefined ? m[1] : Number(m[2]));
  }
  let cur = root;
  for (const tok of tokens) {
    if (cur === null || typeof cur !== 'object') return { found: false };
    if (typeof tok === 'number') {
      if (!Array.isArray(cur) || tok < 0 || tok >= cur.length) return { found: false };
      cur = cur[tok];
    } else {
      if (!Object.prototype.hasOwnProperty.call(cur, tok)) return { found: false };
      cur = cur[tok];
    }
  }
  return { found: true, value: cur };
}

function preview(v) {
  const s = JSON.stringify(v);
  return s.length > 100 ? `${s.slice(0, 97)}...` : s;
}

function diffValues(a, b, path, out) {
  if (out.length >= 64) return;
  if (a === b) return;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) {
    out.push({ path, kind: 'changed', detail: `${preview(a)} -> ${preview(b)}` });
    return;
  }
  if (Array.isArray(a)) {
    const maxLen = Math.max(a.length, b.length);
    for (let i = 0; i < maxLen && out.length < 64; i++) {
      const p = `${path}[${i}]`;
      if (i >= a.length) out.push({ path: p, kind: 'added', detail: preview(b[i]) });
      else if (i >= b.length) out.push({ path: p, kind: 'removed', detail: preview(a[i]) });
      else diffValues(a[i], b[i], p, out);
    }
    return;
  }
  const allKeys = Array.from(new Set([...Object.keys(a), ...Object.keys(b)])).sort();
  for (const k of allKeys) {
    if (out.length >= 64) break;
    const p = `${path}.${k}`;
    const hasA = Object.prototype.hasOwnProperty.call(a, k);
    const hasB = Object.prototype.hasOwnProperty.call(b, k);
    if (!hasA) out.push({ path: p, kind: 'added', detail: preview(b[k]) });
    else if (!hasB) out.push({ path: p, kind: 'removed', detail: preview(a[k]) });
    else diffValues(a[k], b[k], p, out);
  }
}

export default async function (request) {
  const { kind, contribution, input } = request ?? {};

  if (kind === 'action' && contribution === 'json.format') {
    let parsed;
    try { parsed = JSON.parse(input.text); } catch (e) { return { valid: false, error: String(e?.message || 'JSON 解析失败').slice(0, 200) }; }
    const s = stats(parsed);
    const output = input.mode === 'minify'
      ? JSON.stringify(parsed)
      : input.mode === 'canonical'
        ? JSON.stringify(sortKeys(parsed), null, 2)
        : JSON.stringify(parsed, null, 2);
    return { valid: true, output, root_type: typeOf(parsed), depth: s.depth, keys: s.keys };
  }

  if (kind === 'action' && contribution === 'json.query') {
    let parsed;
    try { parsed = JSON.parse(input.text); } catch (e) { return { found: false, error: String(e?.message || 'JSON 解析失败').slice(0, 200) }; }
    const q = queryPath(parsed, input.path);
    if (!q.found) return { found: false, error: `未找到路径：${input.path}` };
    return { found: true, result: JSON.stringify(q.value, null, 2) };
  }

  if (kind === 'action' && contribution === 'json.diff') {
    let a, b;
    try { a = JSON.parse(input.left); } catch (e) { return { ok: false, error: `左侧 JSON 无效：${e?.message}`, changes: [] }; }
    try { b = JSON.parse(input.right); } catch (e) { return { ok: false, error: `右侧 JSON 无效：${e?.message}`, changes: [] }; }
    const changes = [];
    diffValues(a, b, '$', changes);
    return { ok: true, changes };
  }

  if (kind === 'tool' && contribution === 'json.analyze') {
    let parsed;
    try { parsed = JSON.parse(input.text); } catch (e) {
      return { success: false, status: 'invalid_json', error: String(e?.message || 'JSON 解析失败').slice(0, 200) };
    }
    const s = stats(parsed);
    return {
      success: true,
      status: 'valid',
      root_type: typeOf(parsed),
      depth: s.depth,
      keys: s.keys,
      canonical: JSON.stringify(sortKeys(parsed)),
    };
  }

  throw new Error(`不支持的调用: ${kind}/${contribution}`);
}
