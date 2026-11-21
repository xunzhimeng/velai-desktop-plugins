import { createHash } from 'node:crypto';

const MAX_ARCHIVE_BYTES = 1024 * 1024;
const MAX_FILES = 128;
const MAX_SOURCE_BYTES = 128 * 1024;
const MAX_HTML_BYTES = 256 * 1024;
const MAX_SCHEMA_DEPTH = 16;
const MAX_SCHEMA_NODES = 512;
const MAX_VALUE_NODES = 16384;
const MAX_ENUM_VALUES = 128;

const VALID_PERMISSIONS = new Set([
  'data.read',
  'data.write',
  'http.request',
  'tasks.start',
  'tasks.read',
  'tasks.cancel',
]);
const VALID_ICONS = new Set(['app', 'text', 'chat', 'media', 'table', 'edit']);
const VALID_SURFACES = new Set(['workspace', 'chat', 'assistant']);
const SCHEMA_KEYWORDS = new Set([
  'type',
  'properties',
  'required',
  'items',
  'enum',
  'additionalProperties',
  'minLength',
  'maxLength',
  'minimum',
  'maximum',
  'description',
  'default',
]);
const SCHEMA_TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);

const sha256 = data => createHash('sha256').update(data).digest('hex');

function assertCond(cond, message) {
  if (!cond) throw new Error(message);
}

function hasControl(str) {
  for (const ch of str) {
    const cp = ch.codePointAt(0);
    if (cp <= 0x1f || (cp >= 0x7f && cp <= 0x9f)) return true;
  }
  return false;
}

function validateId(id, label = 'id') {
  assertCond(
    typeof id === 'string' &&
      id.length >= 1 &&
      id.length <= 128 &&
      /^[a-z][a-z0-9._-]*$/.test(id),
    `${label} 无效: ${id}`,
  );
}

function validateTitle(title, label = 'title') {
  assertCond(
    typeof title === 'string' &&
      title.trim().length > 0 &&
      Buffer.byteLength(title, 'utf8') <= 256 &&
      !hasControl(title),
    `${label} 无效: ${title}`,
  );
}

function validateDescription(desc) {
  assertCond(
    typeof desc === 'string' &&
      desc.trim().length > 0 &&
      Buffer.byteLength(desc, 'utf8') <= 512 &&
      !hasControl(desc),
    `description 无效: ${desc}`,
  );
}

function isSemver(v) {
  return (
    typeof v === 'string' &&
    v.length > 0 &&
    v.length <= 128 &&
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(
      v,
    )
  );
}

function validHttpPath(p) {
  return (
    typeof p === 'string' &&
    p.startsWith('/') &&
    p.length <= 256 &&
    !p.includes('//') &&
    /^[A-Za-z0-9/._~-]+$/.test(p) &&
    !p.split('/').some(part => part === '.' || part === '..')
  );
}

function validHost(host) {
  if (typeof host !== 'string' || host.length > 253 || !host.includes('.')) return false;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(':')) return false;
  const labels = host.split('.');
  const last = labels[labels.length - 1];
  if (!/[a-z]/.test(last)) return false;
  return labels.every(
    label =>
      label.length >= 1 &&
      label.length <= 63 &&
      !label.startsWith('-') &&
      !label.endsWith('-') &&
      !label.startsWith('xn--') &&
      /^[a-z0-9-]+$/.test(label),
  );
}

function checkSchema(schema, depth, state) {
  state.nodes += 1;
  assertCond(depth <= MAX_SCHEMA_DEPTH && state.nodes <= MAX_SCHEMA_NODES, 'schema 深度或节点数超限');
  assertCond(schema !== null && typeof schema === 'object' && !Array.isArray(schema), 'schema 必须为对象');
  for (const key of Object.keys(schema)) {
    assertCond(SCHEMA_KEYWORDS.has(key), `schema 不支持关键字: ${key}`);
  }
  const kind = schema.type;
  assertCond(typeof kind === 'string' && SCHEMA_TYPES.has(kind), `schema type 无效: ${kind}`);

  for (const kw of ['properties', 'required', 'additionalProperties']) {
    if (kw in schema) assertCond(kind === 'object', `${kw} 仅适用于 object`);
  }
  if ('properties' in schema) {
    assertCond(schema.properties && typeof schema.properties === 'object' && !Array.isArray(schema.properties), 'properties 必须为对象');
    for (const [name, child] of Object.entries(schema.properties)) {
      assertCond(name.length >= 1 && name.length <= 128 && !hasControl(name), `properties 字段名无效: ${name}`);
      checkSchema(child, depth + 1, state);
    }
  }
  if ('required' in schema) {
    assertCond(Array.isArray(schema.required), 'required 必须为数组');
    const seen = new Set();
    for (const name of schema.required) {
      assertCond(typeof name === 'string' && !seen.has(name), `required 项无效或重复: ${name}`);
      seen.add(name);
      assertCond(schema.properties && Object.prototype.hasOwnProperty.call(schema.properties, name), `required 项未在 properties 中声明: ${name}`);
    }
  }
  if ('additionalProperties' in schema) {
    assertCond(typeof schema.additionalProperties === 'boolean', 'additionalProperties 仅支持 boolean');
  }
  if (kind === 'array') {
    assertCond('items' in schema, 'array 必须声明 items');
    checkSchema(schema.items, depth + 1, state);
  } else {
    assertCond(!('items' in schema), 'items 仅适用于 array');
  }
  for (const kw of ['minLength', 'maxLength']) {
    if (kw in schema) {
      assertCond(kind === 'string' && Number.isInteger(schema[kw]) && schema[kw] >= 0 && schema[kw] <= MAX_ARCHIVE_BYTES, `${kw} 无效`);
    }
  }
  if ('minLength' in schema && 'maxLength' in schema) {
    assertCond(schema.minLength <= schema.maxLength, 'minLength 大于 maxLength');
  }
  for (const kw of ['minimum', 'maximum']) {
    if (kw in schema) {
      assertCond((kind === 'number' || kind === 'integer') && typeof schema[kw] === 'number' && Number.isFinite(schema[kw]), `${kw} 无效`);
    }
  }
  if ('minimum' in schema && 'maximum' in schema) {
    assertCond(schema.minimum <= schema.maximum, 'minimum 大于 maximum');
  }
  if ('enum' in schema) {
    assertCond(Array.isArray(schema.enum) && schema.enum.length > 0 && schema.enum.length <= MAX_ENUM_VALUES, 'enum 无效');
    const copy = { ...schema };
    delete copy.enum;
    for (const item of schema.enum) validateJsonSchema(copy, item);
  }
  if ('description' in schema) validateDescription(schema.description);
  if ('default' in schema) validateJsonSchema(schema, schema.default);
}

export function validateSchema(schema) {
  checkSchema(schema, 0, { nodes: 0 });
}

export function validateJsonSchema(schema, value, path = '$') {
  validateSchema(schema);
  const kind = schema.type;
  const matches =
    (kind === 'object' && value !== null && typeof value === 'object' && !Array.isArray(value)) ||
    (kind === 'array' && Array.isArray(value)) ||
    (kind === 'string' && typeof value === 'string') ||
    (kind === 'number' && typeof value === 'number' && Number.isFinite(value)) ||
    (kind === 'integer' && typeof value === 'number' && Number.isInteger(value)) ||
    (kind === 'boolean' && typeof value === 'boolean') ||
    (kind === 'null' && value === null);
  assertCond(matches, `${path}: 类型不匹配，期望 ${kind}，实际 ${JSON.stringify(value)}`);

  if ('enum' in schema) {
    assertCond(schema.enum.some(v => JSON.stringify(v) === JSON.stringify(value)), `${path}: 不属于 enum`);
  }
  if (kind === 'object') {
    for (const req of schema.required || []) {
      assertCond(Object.prototype.hasOwnProperty.call(value, req), `${path}.${req}: 缺少必填字段`);
    }
    const props = schema.properties || {};
    for (const [k, v] of Object.entries(value)) {
      if (Object.prototype.hasOwnProperty.call(props, k)) {
        validateJsonSchema(props[k], v, `${path}.${k}`);
      } else if (schema.additionalProperties === false) {
        throw new Error(`${path}.${k}: 不允许额外字段`);
      }
    }
  }
  if (kind === 'array') {
    for (let i = 0; i < value.length; i++) {
      validateJsonSchema(schema.items, value[i], `${path}[${i}]`);
    }
  }
  if (kind === 'string') {
    const len = Array.from(value).length;
    if ('minLength' in schema) assertCond(len >= schema.minLength, `${path}: 长度小于 minLength`);
    if ('maxLength' in schema) assertCond(len <= schema.maxLength, `${path}: 长度大于 maxLength`);
  }
  if (kind === 'number' || kind === 'integer') {
    if ('minimum' in schema) assertCond(value >= schema.minimum, `${path}: 小于 minimum`);
    if ('maximum' in schema) assertCond(value <= schema.maximum, `${path}: 大于 maximum`);
  }
  return true;
}

export function validateArchiveForDesktop(rawText) {
  const totalBytes = Buffer.byteLength(rawText, 'utf8');
  assertCond(totalBytes >= 1 && totalBytes <= MAX_ARCHIVE_BYTES, `归档大小超限: ${totalBytes}`);
  const archive = JSON.parse(rawText);
  assertCond(archive.format === 'nmas-plugin' && archive.version === 1, '归档格式或版本无效');
  const m = archive.manifest;
  assertCond(m.manifest_version === 1 && m.host_api === 1, 'manifest_version 或 host_api 无效');
  validateId(m.plugin_id, 'plugin_id');
  validateTitle(m.name, 'name');
  assertCond(isSemver(m.version), `version 必须为 SemVer 2.0.0: ${m.version}`);
  assertCond(m.backend === 'backend/index.js', 'backend 必须为 backend/index.js');
  if (m.page !== undefined && m.page !== null) {
    assertCond(m.page === 'ui/index.html', 'page 必须为 ui/index.html');
  }
  if (m.ui !== undefined) {
    assertCond(Boolean(m.page), '声明 ui 时必须提供 page');
    assertCond(VALID_ICONS.has(m.ui.icon), `无效 icon: ${m.ui.icon}`);
    assertCond(Array.isArray(m.ui.surfaces) && m.ui.surfaces.length > 0, 'surfaces 不能为空');
    const surfSet = new Set(m.ui.surfaces);
    assertCond(surfSet.size === m.ui.surfaces.length && m.ui.surfaces.every(s => VALID_SURFACES.has(s)), 'surfaces 无效或重复');
  }

  // 文件校验
  assertCond(Array.isArray(archive.files) && archive.files.length >= 1 && archive.files.length <= MAX_FILES, 'files 数量无效');
  const fileMap = new Map();
  for (const f of archive.files) {
    assertCond(!f.content.includes('\0'), '不允许 NUL 字节');
    fileMap.set(f.path, f.content);
    const bytes = Buffer.byteLength(f.content, 'utf8');
    if (f.path.endsWith('.js')) assertCond(bytes <= MAX_SOURCE_BYTES, `JS 超限: ${bytes}`);
    if (f.path.endsWith('.html')) assertCond(bytes <= MAX_HTML_BYTES, `HTML 超限: ${bytes}`);
  }
  assertCond(m.files.length === fileMap.size, 'manifest.files 数量与 archive.files 不一致');
  for (const decl of m.files) {
    assertCond(fileMap.has(decl.path), `缺少文件: ${decl.path}`);
    assertCond(decl.sha256 === sha256(fileMap.get(decl.path)), `SHA-256 不匹配: ${decl.path}`);
  }
  const expectedFiles = m.page ? 2 : 1;
  assertCond(fileMap.size === expectedFiles, `macOS 宿主要求文件数严格等于 ${expectedFiles}，实际 ${fileMap.size}`);
  if (m.page) {
    assertCond(fileMap.get(m.page).trim().length > 0, 'ui/index.html 不能为空');
  }
  const boundSource = `// nmas-package-sha256:${sha256(rawText)}\n${fileMap.get(m.backend)}`;
  assertCond(Buffer.byteLength(boundSource, 'utf8') <= MAX_SOURCE_BYTES, '带前缀的 backend 超过 128 KiB');

  // 权限校验
  const permSet = new Set();
  for (const p of m.permissions) {
    assertCond(VALID_PERMISSIONS.has(p) && !permSet.has(p), `未知或重复权限: ${p}`);
    permSet.add(p);
  }
  assertCond(m.actions.length <= 64 && m.tools.length <= 32, 'action/tool 数量超限');
  assertCond(m.tasks.length === 0, 'macOS 宿主当前不支持 manifest.tasks 非空');

  const ids = new Set();
  for (const c of [...m.actions, ...m.tools]) {
    validateId(c.id, 'contribution.id');
    validateTitle(c.title, 'contribution.title');
    if (c.description !== undefined) validateDescription(c.description);
    assertCond(!ids.has(c.id), `action/tool ID 重复: ${c.id}`);
    ids.add(c.id);
    for (const p of c.permissions) {
      assertCond(permSet.has(p), `贡献 ${c.id} 权限 ${p} 超出 manifest.permissions`);
    }
    validateSchema(c.input_schema);
    validateSchema(c.output_schema);
  }
  if (m.page) {
    for (const a of m.actions) {
      assertCond(a.id.length <= 64, `页面动作 ID 超过 64 字符: ${a.id}`);
    }
  }

  // Agent Tools 准入规则 (macos_agent_tools::supported)
  for (const tool of m.tools) {
    assertCond(
      tool.permissions.every(p => p === 'data.read' || p === 'data.write'),
      `tool ${tool.id} 仅允许 data.read/data.write 权限`,
    );
    assertCond(!tool.id.startsWith('host.') && !tool.id.startsWith('session.turn.'), `tool ${tool.id} 使用了保留前缀`);
    assertCond(tool.input_schema.type === 'object', `tool ${tool.id} input_schema 必须为 object`);
    assertCond(tool.output_schema.type === 'object', `tool ${tool.id} output_schema 必须为 object`);
    const req = tool.output_schema.required || [];
    assertCond(
      req.includes('success') && tool.output_schema.properties?.success?.type === 'boolean',
      `tool ${tool.id} output_schema 必须包含必填 boolean 字段 success`,
    );
    assertCond(
      req.includes('status') && tool.output_schema.properties?.status?.type === 'string',
      `tool ${tool.id} output_schema 必须包含必填 string 字段 status`,
    );
  }

  // HTTP 规则 (macos_https::supported)
  const network = m.http.length > 0;
  if (network) {
    assertCond(permSet.has('http.request'), 'http 非空时必须声明 http.request 权限');
    for (const r of m.http) {
      assertCond(validHost(r.host) && validHttpPath(r.path) && r.port === 443, `HTTP 规则无效: ${JSON.stringify(r)}`);
      assertCond(Array.isArray(r.methods) && r.methods.length === 1 && r.methods[0] === 'GET', 'macOS 仅支持静态 GET');
    }
    if (m.data.length === 0) {
      assertCond(m.http.length <= 8, '纯网络插件最多 8 条 HTTP 规则');
      assertCond(m.permissions.length === 1 && m.permissions[0] === 'http.request', '纯网络插件权限只能是 ["http.request"]');
      assertCond(m.tools.length === 0, '纯网络插件不支持 tools');
      assertCond(m.actions.some(a => a.permissions.length === 1 && a.permissions[0] === 'http.request'), '纯网络插件至少需一个 http.request action');
      assertCond(
        m.actions.every(a => a.permissions.length === 0 || (a.permissions.length === 1 && a.permissions[0] === 'http.request')),
        '纯网络插件 action 权限只能为空或 ["http.request"]',
      );
    } else {
      assertCond(m.http.length === 1 && Boolean(m.page), '带数据的网络插件仅支持 1 条静态 GET 且需页面');
      assertCond(m.data.every(d => d.scope === 'project'), '带数据的网络插件仅支持 project scope');
      const surfaces = m.ui?.surfaces ?? ['workspace'];
      assertCond(!surfaces.includes('assistant'), 'project scope 插件不能出现在 assistant surface');
    }
  } else {
    assertCond(!permSet.has('http.request'), '未声明 http 时不能申请 http.request 权限');
  }

  // turns::supported_manifest
  const turn = m.actions.some(a => a.id === 'session.turn.request');
  const data = m.data.length > 0;
  const project = m.data.length > 0 && m.data[0].scope === 'project';
  const surfaces = m.page ? (m.ui?.surfaces ?? ['workspace']) : [];
  if (data) {
    assertCond(m.data.every(d => d.schema_version === 1 && d.scope === m.data[0].scope), 'data collection scope 必须一致且 schema_version=1');
  }
  if (project) {
    assertCond(!turn, 'project scope 不能与 session.turn.request 共存');
    assertCond(!surfaces.includes('assistant'), 'project scope 不能出现在 assistant surface');
  }
  if (turn) {
    assertCond(Boolean(m.page), 'session.turn.request 需要页面');
    for (const tp of ['tasks.start', 'tasks.read', 'tasks.cancel']) {
      assertCond(permSet.has(tp), `session.turn.request 需要权限 ${tp}`);
    }
  }
  for (const p of m.permissions) {
    const ok =
      (data && (p === 'data.read' || p === 'data.write') && [...m.actions, ...m.tools].some(a => a.permissions.includes(p))) ||
      (network && p === 'http.request') ||
      (turn && ['tasks.start', 'tasks.read', 'tasks.cancel'].includes(p));
    assertCond(ok, `权限 ${p} 未被对应声明和动作使用，将被 macOS 宿主拒绝`);
  }
  for (const a of m.actions) {
    if (a.id === 'session.turn.request') {
      assertCond(a.permissions.length === 1 && a.permissions[0] === 'tasks.start', 'session.turn.request 权限必须严格为 ["tasks.start"]');
    } else if (a.id === 'session.turn.result') {
      assertCond(turn && a.permissions.length === 1 && a.permissions[0] === 'tasks.read', 'session.turn.result 权限必须严格为 ["tasks.read"]');
    } else {
      assertCond(
        a.permissions.every(p => (data && (p === 'data.read' || p === 'data.write')) || (network && p === 'http.request')),
        `action ${a.id} 包含不支持的权限组合: ${JSON.stringify(a.permissions)}`,
      );
    }
  }

  // 静态检查 backend 不含 ESM import
  const backendSrc = fileMap.get(m.backend);
  assertCond(!/^\s*import\s+/m.test(backendSrc), 'QuickJS 插件后端禁止使用 import 语句');

  return {
    plugin_id: m.plugin_id,
    name: m.name,
    version: m.version,
    bytes: totalBytes,
    toolsCount: m.tools.length,
    actionsCount: m.actions.length,
  };
}
