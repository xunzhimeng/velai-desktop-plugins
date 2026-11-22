import { createHash } from 'node:crypto';

const LIMITS = {
  1: {
    archiveBytes: 1024 * 1024,
    sourceBytes: 128 * 1024,
    htmlBytes: 256 * 1024,
    maxHttpRules: 32,
  },
  2: {
    archiveBytes: 4 * 1024 * 1024,
    sourceBytes: 512 * 1024,
    serializedSourceBytes: 2 * 1024 * 1024 - 4 * 1024,
    htmlBytes: 1024 * 1024,
    maxHttpRules: 16,
  },
};

const MAX_FILES = 128;
const MAX_SCHEMA_DEPTH = 16;
const MAX_SCHEMA_NODES = 512;
const MAX_ENUM_VALUES = 128;
const MAX_SETTINGS = 32;
const MAX_PUBLIC_SETTINGS_BYTES = 12 * 1024;
const MAX_SETTING_STRING_BYTES = 4096;

const BASE_PERMISSIONS = new Set([
  'data.read',
  'data.write',
  'http.request',
  'tasks.start',
  'tasks.read',
  'tasks.cancel',
]);
const HOST_READ_PERMISSIONS = new Set([
  'host.usage.read',
  'host.sessions.read',
  'host.projects.read',
]);
const FS_PERMISSIONS = new Set(['workspace.fs.read', 'workspace.fs.write']);
const AI_PERMISSION = 'ai.complete';

const VALID_ICONS = new Set(['app', 'text', 'chat', 'media', 'table', 'edit']);
const VALID_SURFACES = new Set(['workspace', 'chat', 'assistant']);
const V1_SCHEMA_KEYWORDS = new Set([
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
const V2_SCHEMA_KEYWORDS = new Set([
  ...V1_SCHEMA_KEYWORDS,
  'minItems',
  'maxItems',
  'const',
]);
const SCHEMA_TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);
const MANIFEST_FIELDS = new Set([
  'manifest_version',
  'plugin_id',
  'name',
  'version',
  'host_api',
  'backend',
  'page',
  'ui',
  'permissions',
  'actions',
  'tools',
  'ai',
  'data',
  'settings',
  'http',
  'tasks',
  'files',
]);
const SETTING_FIELDS = new Set(['key', 'type', 'secret', 'required', 'default']);
const HTTP_FIELDS = new Set([
  'host',
  'path',
  'path_prefix',
  'query_keys',
  'headers',
  'credential',
  'redirects',
  'methods',
  'port',
]);
const CREDENTIAL_FIELDS = new Set(['slot', 'header', 'prefix', 'projection']);
const PROJECTION_FIELDS = new Set(['path', 'type']);
const AI_FIELDS = new Set([
  'model',
  'max_output_tokens',
  'max_call_microcredits',
  'max_day_microcredits',
]);
const PROTOTYPE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

const sha256 = data => createHash('sha256').update(data).digest('hex');

function assertCond(cond, message) {
  if (!cond) throw new Error(message);
}

function assertOnlyFields(obj, allowed, label) {
  assertCond(obj !== null && typeof obj === 'object' && !Array.isArray(obj), `${label} 必须为对象`);
  for (const key of Object.keys(obj)) {
    assertCond(allowed.has(key), `${label} 包含未知字段: ${key}`);
  }
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

function validModelName(model) {
  if (typeof model !== 'string' || model.length === 0 || model.length > 128) return false;
  return model.split(/[/:]/).every(part => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part));
}

function validSettingKey(key) {
  return typeof key === 'string' && key.length >= 1 && key.length <= 64 && /^[a-z][a-z0-9_]*$/.test(key);
}

function settingAcceptsValue(kind, value) {
  if (kind === 'string') {
    return typeof value === 'string' && Buffer.byteLength(value, 'utf8') <= MAX_SETTING_STRING_BYTES && !value.includes('\0');
  }
  if (kind === 'boolean') return typeof value === 'boolean';
  if (kind === 'integer') return typeof value === 'number' && Number.isSafeInteger(value);
  if (kind === 'number') return typeof value === 'number' && Number.isFinite(value);
  return false;
}

function resolveSchemaType(schema, hostApi) {
  const raw = schema.type;
  if (typeof raw === 'string' && SCHEMA_TYPES.has(raw)) {
    return { primary: raw, nullable: raw === 'null' };
  }
  if (
    hostApi === 2 &&
    Array.isArray(raw) &&
    raw.length === 2 &&
    typeof raw[0] === 'string' &&
    raw[0] !== 'null' &&
    SCHEMA_TYPES.has(raw[0]) &&
    raw[1] === 'null'
  ) {
    return { primary: raw[0], nullable: true };
  }
  throw new Error(`schema type 无效: ${JSON.stringify(raw)}`);
}

function checkSchema(schema, depth, state, hostApi = 2) {
  state.nodes += 1;
  assertCond(depth <= MAX_SCHEMA_DEPTH && state.nodes <= MAX_SCHEMA_NODES, 'schema 深度或节点数超限');
  assertCond(schema !== null && typeof schema === 'object' && !Array.isArray(schema), 'schema 必须为对象');
  const keywords = hostApi === 2 ? V2_SCHEMA_KEYWORDS : V1_SCHEMA_KEYWORDS;
  for (const key of Object.keys(schema)) {
    assertCond(keywords.has(key), `schema 不支持关键字: ${key}`);
  }
  const { primary: kind } = resolveSchemaType(schema, hostApi);

  for (const kw of ['properties', 'required', 'additionalProperties']) {
    if (kw in schema) assertCond(kind === 'object', `${kw} 仅适用于 object`);
  }
  if ('properties' in schema) {
    assertCond(schema.properties && typeof schema.properties === 'object' && !Array.isArray(schema.properties), 'properties 必须为对象');
    for (const [name, child] of Object.entries(schema.properties)) {
      assertCond(name.length >= 1 && name.length <= 128 && !hasControl(name), `properties 字段名无效: ${name}`);
      checkSchema(child, depth + 1, state, hostApi);
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
    checkSchema(schema.items, depth + 1, state, hostApi);
  } else {
    assertCond(!('items' in schema), 'items 仅适用于 array');
  }
  for (const kw of ['minItems', 'maxItems']) {
    if (kw in schema) {
      assertCond(kind === 'array' && Number.isInteger(schema[kw]) && schema[kw] >= 0 && schema[kw] <= 4096, `${kw} 无效`);
    }
  }
  if ('minItems' in schema && 'maxItems' in schema) {
    assertCond(schema.minItems <= schema.maxItems, 'minItems 大于 maxItems');
  }
  const maxStrLen = LIMITS[hostApi].archiveBytes;
  for (const kw of ['minLength', 'maxLength']) {
    if (kw in schema) {
      assertCond(kind === 'string' && Number.isInteger(schema[kw]) && schema[kw] >= 0 && schema[kw] <= maxStrLen, `${kw} 无效`);
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
    for (const item of schema.enum) validateJsonSchema(copy, item, '$', hostApi);
  }
  if ('const' in schema) {
    const copy = { ...schema };
    delete copy.const;
    validateJsonSchema(copy, schema.const, '$', hostApi);
  }
  if ('description' in schema) validateDescription(schema.description);
  if ('default' in schema) {
    const copy = { ...schema };
    delete copy.default;
    validateJsonSchema(copy, schema.default, '$', hostApi);
  }
}

export function validateSchema(schema, hostApi = 2) {
  checkSchema(schema, 0, { nodes: 0 }, hostApi);
}

export function validateJsonSchema(schema, value, path = '$', hostApi = 2) {
  validateSchema(schema, hostApi);
  const { primary: kind, nullable } = resolveSchemaType(schema, hostApi);
  if (value === null) {
    assertCond(nullable, `${path}: 不允许 null`);
  } else {
    const matches =
      (kind === 'object' && typeof value === 'object' && !Array.isArray(value)) ||
      (kind === 'array' && Array.isArray(value)) ||
      (kind === 'string' && typeof value === 'string') ||
      (kind === 'number' && typeof value === 'number' && Number.isFinite(value)) ||
      (kind === 'integer' && typeof value === 'number' && Number.isInteger(value)) ||
      (kind === 'boolean' && typeof value === 'boolean');
    assertCond(matches, `${path}: 类型不匹配，期望 ${JSON.stringify(schema.type)}，实际 ${JSON.stringify(value)}`);
  }

  if ('enum' in schema) {
    assertCond(schema.enum.some(v => JSON.stringify(v) === JSON.stringify(value)), `${path}: 不属于 enum`);
  }
  if ('const' in schema) {
    assertCond(JSON.stringify(schema.const) === JSON.stringify(value), `${path}: 不匹配 const`);
  }
  if (value === null) return true;
  if (kind === 'object') {
    for (const req of schema.required || []) {
      assertCond(Object.prototype.hasOwnProperty.call(value, req), `${path}.${req}: 缺少必填字段`);
    }
    const props = schema.properties || {};
    for (const [k, v] of Object.entries(value)) {
      if (Object.prototype.hasOwnProperty.call(props, k)) {
        validateJsonSchema(props[k], v, `${path}.${k}`, hostApi);
      } else if (schema.additionalProperties === false) {
        throw new Error(`${path}.${k}: 不允许额外字段`);
      }
    }
  }
  if (kind === 'array') {
    if ('minItems' in schema) assertCond(value.length >= schema.minItems, `${path}: 长度小于 minItems`);
    if ('maxItems' in schema) assertCond(value.length <= schema.maxItems, `${path}: 长度大于 maxItems`);
    for (let i = 0; i < value.length; i++) {
      validateJsonSchema(schema.items, value[i], `${path}[${i}]`, hostApi);
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

function validateSettings(settings, hostV2) {
  if (settings === undefined) return [];
  assertCond(hostV2, 'v1 不支持 settings 声明');
  assertCond(Array.isArray(settings) && settings.length <= MAX_SETTINGS, 'settings 数量超限');
  const keys = new Set();
  const defaults = {};
  for (const s of settings) {
    assertOnlyFields(s, SETTING_FIELDS, 'setting');
    assertCond(validSettingKey(s.key) && !keys.has(s.key), `setting key 无效或重复: ${s.key}`);
    keys.add(s.key);
    assertCond(['string', 'boolean', 'integer', 'number'].includes(s.type), `setting type 不支持: ${s.type}`);
    assertCond(typeof s.secret === 'boolean' && typeof s.required === 'boolean', 'setting secret/required 必须为 boolean');
    if (s.default !== undefined) {
      assertCond(!s.secret && settingAcceptsValue(s.type, s.default), `setting ${s.key} default 无效或属于 secret`);
      defaults[s.key] = s.default;
    }
  }
  assertCond(Buffer.byteLength(JSON.stringify(defaults), 'utf8') <= MAX_PUBLIC_SETTINGS_BYTES, 'settings 默认值合计超限');
  return settings;
}

function validateProjection(projection) {
  assertCond(Array.isArray(projection) && projection.length >= 1 && projection.length <= 8, 'credential projection 必须为 1..=8 项');
  const paths = [];
  for (const item of projection) {
    assertOnlyFields(item, PROJECTION_FIELDS, 'projection');
    assertCond(['boolean', 'integer', 'number'].includes(item.type), `projection 仅允许标量类型 boolean/integer/number，实际: ${item.type}`);
    assertCond(Array.isArray(item.path) && item.path.length >= 1 && item.path.length <= 4, 'projection path 必须为 1..=4 段');
    for (const seg of item.path) {
      assertCond(
        typeof seg === 'string' && seg.length >= 1 && seg.length <= 64 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(seg) && !PROTOTYPE_KEYS.has(seg),
        `projection path 段无效: ${seg}`,
      );
    }
    paths.push(item.path);
  }
  for (let i = 0; i < paths.length; i++) {
    for (let j = i + 1; j < paths.length; j++) {
      const a = paths[i], b = paths[j];
      const shorter = a.length <= b.length ? a : b;
      const longer = a.length <= b.length ? b : a;
      const prefixConflict = shorter.every((seg, idx) => seg === longer[idx]);
      assertCond(!prefixConflict, `projection 存在重复或祖先/后代路径冲突: ${a.join('.')} vs ${b.join('.')}`);
    }
  }
}

function validateHttpRules(rules, settings, hostV2) {
  const maxHttp = hostV2 ? LIMITS[2].maxHttpRules : LIMITS[1].maxHttpRules;
  assertCond(Array.isArray(rules) && rules.length <= maxHttp, `HTTP 规则数量超限（最多 ${maxHttp}）`);
  const grants = new Set();
  const boundSlots = new Set();
  const maxMethods = hostV2 ? 4 : 1;

  for (const r of rules) {
    assertOnlyFields(r, HTTP_FIELDS, 'http rule');
    if (!hostV2) {
      for (const k of ['path_prefix', 'query_keys', 'headers', 'credential', 'redirects']) {
        assertCond(!(k in r), `v1 不支持扩展 HTTP 字段: ${k}`);
      }
    }
    const hasPath = typeof r.path === 'string' && r.path.length > 0;
    const hasPrefix = typeof r.path_prefix === 'string' && r.path_prefix.length > 0;
    assertCond(hasPath !== hasPrefix, 'HTTP 必须且只能声明 path 或 path_prefix');
    const path = hasPrefix ? r.path_prefix : r.path;
    assertCond(
      validHost(r.host) && r.port === 443 && validHttpPath(path) && (!hasPrefix || !path.endsWith('/')),
      `HTTP host/path/port 无效: ${JSON.stringify(r)}`,
    );
    assertCond(Array.isArray(r.methods) && r.methods.length >= 1 && r.methods.length <= maxMethods, 'HTTP methods 无效');
    for (const m of r.methods) {
      const ok = m === 'GET' || m === 'POST' || (hostV2 && (m === 'PUT' || m === 'DELETE'));
      const key = `${r.host}\0${path}\0${hasPrefix}\0${m}`;
      assertCond(ok && !grants.has(key), `HTTP method 不支持或规则重复: ${m}`);
      grants.add(key);
    }
    const redirects = r.redirects ?? 0;
    assertCond(Number.isInteger(redirects) && redirects >= 0 && redirects <= 3, 'HTTP redirects 必须为 0..=3');
    assertCond(redirects === 0 || (r.methods.length === 1 && r.methods[0] === 'GET'), 'HTTP redirects 仅限单一 GET');

    const queryKeys = r.query_keys ?? [];
    const headers = r.headers ?? [];
    if (r.credential !== undefined) {
      assertOnlyFields(r.credential, CREDENTIAL_FIELDS, 'http.credential');
      assertCond(redirects === 0 && queryKeys.length === 0 && headers.length === 0, '携密 HTTP 禁止自定义 query/header 或重定向');
      const slot = settings.find(s => s.key === r.credential.slot && s.secret && s.type === 'string');
      assertCond(Boolean(slot) && !boundSlots.has(r.credential.slot), `凭据 slot 必须是仅绑定此规则的 secret string: ${r.credential.slot}`);
      boundSlots.add(r.credential.slot);
      assertCond(['authorization', 'x-api-key'].includes(r.credential.header), `凭据 header 不受支持: ${r.credential.header}`);
      assertCond(r.credential.prefix === undefined || r.credential.prefix === '' || r.credential.prefix === 'Bearer ', `凭据 prefix 不受支持: ${r.credential.prefix}`);
      validateProjection(r.credential.projection);
    }
    const qSet = new Set();
    assertCond(queryKeys.length <= 16, 'HTTP query_keys 最多 16 个');
    for (const k of queryKeys) {
      assertCond(typeof k === 'string' && k.length >= 1 && k.length <= 64 && /^[A-Za-z0-9._-]+$/.test(k) && !qSet.has(k), `HTTP query_key 无效: ${k}`);
      qSet.add(k);
    }
    const hSet = new Set();
    for (const h of headers) {
      assertCond(['accept', 'content-type', 'accept-language'].includes(h) && !hSet.has(h), `HTTP header 不受支持或重复: ${h}`);
      hSet.add(h);
    }
  }
  for (const s of settings) {
    if (s.secret) {
      assertCond(boundSlots.has(s.key), `secret setting ${s.key} 必须绑定一条 HTTP 凭据规则`);
    }
  }
}

function isSessionTurn(id) {
  return id === 'session.turn' || id.startsWith('session.turn.');
}

export function validateArchiveForDesktop(rawText) {
  const totalBytes = Buffer.byteLength(rawText, 'utf8');
  assertCond(totalBytes >= 1 && totalBytes <= LIMITS[2].archiveBytes, `归档大小超限: ${totalBytes}`);
  const archive = JSON.parse(rawText);
  assertCond(archive.format === 'nmas-plugin' && archive.version === 1, '归档格式或版本无效');
  const m = archive.manifest;
  assertOnlyFields(m, MANIFEST_FIELDS, 'manifest');
  const hostV2 = m.manifest_version === 2 && m.host_api === 2;
  const hostV1 = m.manifest_version === 1 && m.host_api === 1;
  assertCond(hostV1 || hostV2, `不支持的 manifest_version/host_api: ${m.manifest_version}/${m.host_api}`);
  const limits = LIMITS[m.host_api];
  assertCond(totalBytes <= limits.archiveBytes, `归档大小超过 v${m.host_api} 上限: ${totalBytes} > ${limits.archiveBytes}`);

  const settings = validateSettings(m.settings, hostV2);
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
    if (f.path.endsWith('.js')) assertCond(bytes <= limits.sourceBytes, `JS 超限: ${bytes} > ${limits.sourceBytes}`);
    if (f.path.endsWith('.html')) assertCond(bytes <= limits.htmlBytes, `HTML 超限: ${bytes} > ${limits.htmlBytes}`);
  }
  assertCond(m.files.length === fileMap.size, 'manifest.files 数量与 archive.files 不一致');
  for (const decl of m.files) {
    assertCond(fileMap.has(decl.path), `缺少文件: ${decl.path}`);
    assertCond(decl.sha256 === sha256(fileMap.get(decl.path)), `SHA-256 不匹配: ${decl.path}`);
  }
  const hasMigration = fileMap.has('data/migration.json');
  const expectedFiles = (m.page ? 2 : 1) + (hasMigration ? 1 : 0);
  assertCond(fileMap.size === expectedFiles, `macOS 宿主要求文件数严格等于 ${expectedFiles}，实际 ${fileMap.size}`);
  if (m.page) {
    assertCond(fileMap.get(m.page).trim().length > 0, 'ui/index.html 不能为空');
  }
  const boundSource = `// nmas-package-sha256:${sha256(rawText)}\n${fileMap.get(m.backend)}`;
  assertCond(Buffer.byteLength(boundSource, 'utf8') <= limits.sourceBytes, `带前缀的 backend 超过 v${m.host_api} 上限`);
  if (hostV2) {
    const serialized = Buffer.byteLength(JSON.stringify(boundSource), 'utf8');
    assertCond(serialized <= limits.serializedSourceBytes, `转义后的 source 超过 v2 Prepare 预算: ${serialized}`);
  }

  // 权限校验
  const permSet = new Set();
  for (const p of m.permissions) {
    const known =
      BASE_PERMISSIONS.has(p) ||
      (hostV2 && (HOST_READ_PERMISSIONS.has(p) || FS_PERMISSIONS.has(p) || p === AI_PERMISSION));
    assertCond(known && !permSet.has(p), `未知或重复权限: ${p}`);
    permSet.add(p);
  }
  assertCond(m.actions.length <= 64 && m.tools.length <= 32, 'action/tool 数量超限');
  assertCond(m.tasks.length === 0, 'macOS 宿主当前不支持 manifest.tasks 非空');

  const ids = new Set();
  const contributions = [...m.actions, ...m.tools];
  for (const c of contributions) {
    validateId(c.id, 'contribution.id');
    validateTitle(c.title, 'contribution.title');
    if (c.description !== undefined) validateDescription(c.description);
    assertCond(!ids.has(c.id), `action/tool ID 重复: ${c.id}`);
    ids.add(c.id);
    for (const p of c.permissions) {
      assertCond(permSet.has(p), `贡献 ${c.id} 权限 ${p} 超出 manifest.permissions`);
    }
    validateSchema(c.input_schema, m.host_api);
    validateSchema(c.output_schema, m.host_api);
  }
  if (m.page) {
    for (const a of m.actions) {
      assertCond(a.id.length <= 64, `页面动作 ID 超过 64 字符: ${a.id}`);
    }
  }

  // AI 校验 (validate_ai + macos_ai_runtime::supported)
  const hasAiPerm = permSet.has(AI_PERMISSION);
  assertCond(hasAiPerm === (m.ai !== undefined), 'ai.complete 必须与 manifest.ai 同时出现');
  if (m.ai !== undefined) {
    assertOnlyFields(m.ai, AI_FIELDS, 'manifest.ai');
    assertCond(hostV2 && validModelName(m.ai.model), `受管 AI 模型名无效: ${m.ai.model}`);
    assertCond(Number.isInteger(m.ai.max_output_tokens) && m.ai.max_output_tokens >= 1 && m.ai.max_output_tokens <= 1024, 'max_output_tokens 必须为 1..=1024');
    assertCond(Number.isInteger(m.ai.max_call_microcredits) && m.ai.max_call_microcredits >= 1 && m.ai.max_call_microcredits <= 1_000_000, 'max_call_microcredits 必须为 1..=1_000_000');
    assertCond(Number.isInteger(m.ai.max_day_microcredits) && m.ai.max_day_microcredits >= m.ai.max_call_microcredits && m.ai.max_day_microcredits <= 10_000_000, 'max_day_microcredits 无效');
    const surfaces = m.ui?.surfaces ?? ['workspace'];
    assertCond(
      permSet.size === 1 &&
        m.tools.length === 0 &&
        m.tasks.length === 0 &&
        m.http.length === 0 &&
        (m.data ?? []).length === 0 &&
        settings.length === 0 &&
        Boolean(m.page) &&
        surfaces.length === 1 &&
        surfaces[0] === 'workspace' &&
        m.actions.length > 0 &&
        m.actions.some(a => a.permissions.includes(AI_PERMISSION)) &&
        m.actions.every(a => a.permissions.length === 0 || (a.permissions.length === 1 && a.permissions[0] === AI_PERMISSION)) &&
        m.actions.every(a => !isSessionTurn(a.id) && !a.id.startsWith('host.')),
      '受管 AI 包仅允许 Workspace 页和 ai.complete Action，禁止混用其他能力',
    );
  }

  // Host reads 组合限制
  const hasHostReads = [...permSet].some(p => HOST_READ_PERMISSIONS.has(p));
  if (hasHostReads) {
    assertCond(
      !permSet.has('http.request') &&
        ![...permSet].some(p => p.startsWith('tasks.')) &&
        !contributions.some(c => isSessionTurn(c.id)),
      '宿主读取不能与外发、任务或会话代理同包声明',
    );
  }

  // Workspace FS 校验 (validate_workspace_fs + macos_workspace_fs::supported)
  const declaresFs = m.permissions.some(p => FS_PERMISSIONS.has(p));
  const dataDecl = m.data ?? [];
  if (declaresFs) {
    const surfaces = m.page ? (m.ui?.surfaces ?? ['workspace']) : [];
    assertCond(hostV2, 'workspace.fs.* 仅支持 host_api 2');
    if (permSet.has('workspace.fs.read')) {
      assertCond(!permSet.has('http.request') && m.http.length === 0, '项目文件读取不能与 HTTPS 同包声明');
    }
    if (m.http.length > 0) {
      assertCond(dataDecl.length === 0 && m.http.every(r => r.credential === undefined), '项目文件写入与 HTTPS 同包时不能声明数据集合或携密规则');
    }
    assertCond(!surfaces.includes('assistant'), '项目文件权限不能用于 Assistant surface');
    assertCond(dataDecl.every(d => d.scope === 'project' && (d.schema_version === 1 || d.schema_version === 2)), '项目文件包的数据集合仅支持 project scope');
    assertCond(!hasHostReads && m.tasks.length === 0 && ![...permSet].some(p => p.startsWith('tasks.')), '项目文件权限不能与任务或宿主读取组合');
    assertCond(contributions.every(c => !isSessionTurn(c.id) && !c.id.startsWith('host.')), '项目文件包禁止保留前缀');
    for (const p of m.permissions) {
      assertCond(contributions.some(c => c.permissions.includes(p)), `项目文件包权限 ${p} 必须由具体 action 或 tool 声明`);
    }
  } else if (m.ai === undefined) {
    assertCond(Array.isArray(m.data), '缺少 data 声明');
  }

  // Data collections 校验
  if (dataDecl.length > 0) {
    assertCond(permSet.has('data.read') || permSet.has('data.write'), 'data 声明缺少数据权限');
    const colSet = new Set();
    for (const d of dataDecl) {
      validateId(d.collection, 'collection');
      assertCond(!colSet.has(d.collection), `collection 重复: ${d.collection}`);
      colSet.add(d.collection);
      assertCond(d.scope === dataDecl[0].scope, 'data collection scope 必须一致');
      assertCond(d.schema_version === 1 || (d.schema_version === 2 && hasMigration), `不支持的 schema_version: ${d.schema_version}`);
    }
  }

  // HTTP 规则校验
  if (m.http.length > 0) {
    assertCond(permSet.has('http.request'), 'http 非空时必须声明 http.request');
    validateHttpRules(m.http, settings, hostV2);
  } else {
    assertCond(!permSet.has('http.request'), '未声明 http 时不能申请 http.request');
    assertCond(!settings.some(s => s.secret), '无 HTTP 规则时不能声明 secret setting');
  }

  // Agent Tools 准入规则 (macos_agent_tools::supported)
  for (const tool of m.tools) {
    const allowedToolPerm = p =>
      p === 'data.read' ||
      p === 'data.write' ||
      (hostV2 && (p === 'http.request' || FS_PERMISSIONS.has(p) || HOST_READ_PERMISSIONS.has(p)));
    assertCond(tool.permissions.every(allowedToolPerm), `tool ${tool.id} 包含不支持的权限: ${JSON.stringify(tool.permissions)}`);
    assertCond(!tool.id.startsWith('host.') && !isSessionTurn(tool.id), `tool ${tool.id} 使用了保留前缀`);
    assertCond(tool.input_schema.type === 'object', `tool ${tool.id} input_schema 必须为 object`);
    assertCond(tool.output_schema.type === 'object', `tool ${tool.id} output_schema 必须为 object`);
    const req = tool.output_schema.required || [];
    assertCond(req.includes('success') && tool.output_schema.properties?.success?.type === 'boolean', `tool ${tool.id} output_schema 缺少必填 boolean success`);
    assertCond(req.includes('status') && tool.output_schema.properties?.status?.type === 'string', `tool ${tool.id} output_schema 缺少必填 string status`);
  }

  // macOS Desktop host_api=2 / host_api=1 宿主准入规则 (macos_turns::supported_manifest & macos_https_v2::supported)
  const surfaces = m.page ? (m.ui?.surfaces ?? ['workspace']) : [];
  const isProjectData = dataDecl.length > 0 && dataDecl[0].scope === 'project';
  if (hostV2) {
    if (!declaresFs && m.ai === undefined) {
      if (m.http.length > 0) {
        assertCond(dataDecl.every(d => d.scope === 'account'), 'v2 联网插件（非 FS）仅支持 account scope 数据');
        assertCond(
          m.permissions.every(
            p => (p === 'http.request' || (dataDecl.length > 0 && (p === 'data.read' || p === 'data.write'))) && contributions.some(c => c.permissions.includes(p)),
          ),
          'v2 联网插件存在不支持或未使用的权限',
        );
        assertCond(contributions.every(c => !c.id.startsWith('host.') && !isSessionTurn(c.id)), 'v2 联网插件禁止 host./session.turn. 贡献');
      } else {
        if (isProjectData) {
          assertCond(!hasHostReads && !surfaces.includes('assistant'), 'v2 project scope 不能组合宿主读取或 assistant surface');
        }
        assertCond(
          m.permissions.every(
            p => (HOST_READ_PERMISSIONS.has(p) || (dataDecl.length > 0 && (p === 'data.read' || p === 'data.write'))) && contributions.some(c => c.permissions.includes(p)),
          ),
          'v2 插件存在不支持或未使用的权限（v2 禁止 tasks.* / session.turn.*）',
        );
        assertCond(contributions.every(c => !c.id.startsWith('host.') && !isSessionTurn(c.id)), 'v2 插件禁止 host./session.turn. 贡献');
      }
    }
  } else {
    // v1 保留原校验逻辑
    const turn = m.actions.some(a => a.id === 'session.turn.request');
    const data = dataDecl.length > 0;
    if (isProjectData) {
      assertCond(!turn && !surfaces.includes('assistant'), 'v1 project scope 不能与 session.turn.request 或 assistant 共存');
    }
    if (turn) {
      assertCond(Boolean(m.page), 'session.turn.request 需要页面');
      for (const tp of ['tasks.start', 'tasks.read', 'tasks.cancel']) {
        assertCond(permSet.has(tp), `session.turn.request 需要权限 ${tp}`);
      }
    }
  }

  // 静态检查 backend 不含 ESM import
  const backendSrc = fileMap.get(m.backend);
  assertCond(!/^\s*import\s+/m.test(backendSrc), 'QuickJS 插件后端禁止使用 import 语句');

  return {
    plugin_id: m.plugin_id,
    name: m.name,
    version: m.version,
    manifest_version: m.manifest_version,
    host_api: m.host_api,
    bytes: totalBytes,
    toolsCount: m.tools.length,
    actionsCount: m.actions.length,
  };
}
