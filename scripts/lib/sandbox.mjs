import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { validateJsonSchema } from './validator.mjs';

const UUIDV4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const FS_DENIED_EXACT = new Set([
  '.git', '.env', '.ssh', '.aws', '.gnupg', '.kube', '.docker', '.config',
  '.velai', '.nmas', '.netrc', '.npmrc', '.pypirc', 'credentials.json',
  '.git-credentials', 'keychains', '..namedfork',
]);
const FS_DENIED_EXTS = ['.pem', '.key', '.p12', '.pfx', '.jks'];
const sha256Hex = buf => createHash('sha256').update(buf).digest('hex');

function makeErr(code, message, outcomeUnknown = false) {
  const err = new Error(message);
  err.code = code;
  err.outcome_unknown = outcomeUnknown;
  return err;
}

function validateFsRelativePath(relPath, allowEmpty = false) {
  if (allowEmpty && (relPath === undefined || relPath === '')) return [];
  if (typeof relPath !== 'string' || relPath.length === 0 || relPath.length > 1023 || relPath.startsWith('/') || relPath.includes('\\')) {
    throw makeErr('permission_denied', `非法相对路径: ${relPath}`);
  }
  const parts = relPath.split('/');
  if (parts.length > 64) throw makeErr('permission_denied', '路径层级超限');
  for (const seg of parts) {
    if (!seg || seg === '.' || seg === '..' || seg.length > 255 || seg.startsWith(' ') || seg.endsWith(' ') || seg.endsWith('.')) {
      throw makeErr('permission_denied', `非法路径段: ${seg}`);
    }
    const lower = seg.toLowerCase();
    if (
      lower.startsWith('.nmas-plugin-stage-') ||
      lower.startsWith('.env.') ||
      lower.startsWith('secrets.') ||
      lower.startsWith('id_rsa') ||
      lower.startsWith('id_ed25519') ||
      FS_DENIED_EXTS.some(ext => lower.endsWith(ext)) ||
      FS_DENIED_EXACT.has(lower)
    ) {
      throw makeErr('permission_denied', `禁止访问敏感路径: ${seg}`);
    }
  }
  return parts;
}

function projectJson(obj, projection) {
  const out = {};
  for (const field of projection) {
    let cur = obj;
    for (const seg of field.path) {
      if (cur === null || typeof cur !== 'object' || Array.isArray(cur) || !Object.prototype.hasOwnProperty.call(cur, seg)) {
        throw makeErr('http_response', `携密响应缺少投影字段 ${field.path.join('.')}`);
      }
      cur = cur[seg];
    }
    const ok =
      (field.type === 'boolean' && typeof cur === 'boolean') ||
      (field.type === 'integer' && typeof cur === 'number' && Number.isSafeInteger(cur)) ||
      (field.type === 'number' && typeof cur === 'number' && Number.isFinite(cur));
    if (!ok) throw makeErr('http_response', `携密响应投影类型不匹配 ${field.path.join('.')}`);
    out[field.path.join('.')] = cur;
  }
  return out;
}

export async function createPluginHarness(
  pluginDir,
  manifest,
  {
    httpMock = {},
    hostMock = {},
    settingsMock = {},
    secretsConfigured = {},
    fsInitial = {},
    aiMock = null,
    onAiEvent = null,
  } = {},
) {
  const hostApi = manifest.host_api ?? 1;
  const maxValueBytes = hostApi === 2 ? 256 * 1024 : 16 * 1024;
  const maxRecordBytes = hostApi === 2 ? 252 * 1024 : 16 * 1024;
  const maxBrokerCalls = hostApi === 2 ? 64 : 32;

  const mod = await import(`${pathToFileURL(`${pluginDir}/backend/index.js`).href}?t=${Date.now()}-${Math.random()}`);
  const entry = mod.default;
  if (typeof entry !== 'function') throw new Error(`${manifest.plugin_id}: backend/index.js 未导出 default 函数`);

  const store = new Map();
  let revision = 0;

  // Virtual workspace FS (dirs set + files map)
  const fsDirs = new Set(['']);
  const fsFiles = new Map();
  for (const [p, content] of Object.entries(fsInitial)) {
    const parts = validateFsRelativePath(p, false);
    for (let i = 1; i < parts.length; i++) fsDirs.add(parts.slice(0, i).join('/'));
    fsFiles.set(p, String(content));
  }

  // AI stream tracker
  let sseSeq = 0;
  const aiRequests = new Map();

  const actionsById = new Map(manifest.actions.map(a => [a.id, a]));
  const toolsById = new Map(manifest.tools.map(t => [t.id, t]));
  const declaredCollections = new Set((manifest.data ?? []).map(d => d.collection));

  async function invoke(kind, contribution, input) {
    const decl = kind === 'action' ? actionsById.get(contribution) : toolsById.get(contribution);
    if (!decl) throw new Error(`${manifest.plugin_id}: 未声明的 ${kind} ${contribution}`);
    const inputText = JSON.stringify(input);
    if (Buffer.byteLength(inputText, 'utf8') > maxValueBytes) {
      throw new Error(`${manifest.plugin_id}/${contribution}: input 超过 ${maxValueBytes} B`);
    }
    validateJsonSchema(decl.input_schema, JSON.parse(inputText), `${contribution}.input`, hostApi);

    let brokerCalls = 0;
    let inflight = false;
    const withBrokerSlot = async fn => {
      if (inflight) {
        throw makeErr('invalid_state', 'QuickJS BrokerExecutor 仅允许单在途串行 nmas.* 调用，禁止 Promise.all 并发调用');
      }
      brokerCalls += 1;
      if (brokerCalls > maxBrokerCalls) throw makeErr('resource_limit', 'broker_call_limit');
      inflight = true;
      await Promise.resolve();
      try {
        return await fn();
      } finally {
        inflight = false;
      }
    };
    const ensurePerm = perm => {
      if (!decl.permissions.includes(perm)) {
        throw makeErr('permission_denied', `贡献 ${contribution} 缺少权限 ${perm}`);
      }
    };

    const dataApi = {
      read({ collection, key }) {
        return withBrokerSlot(async () => {
          ensurePerm('data.read');
          if (!declaredCollections.has(collection)) throw makeErr('permission_denied', `未声明的 collection: ${collection}`);
          const raw = store.get(`${collection}\0${key}`);
          return { revision, value: raw === undefined ? null : JSON.parse(raw) };
        });
      },
      write({ collection, key, expected_revision, value }) {
        return withBrokerSlot(async () => {
          ensurePerm('data.write');
          if (!declaredCollections.has(collection)) throw makeErr('permission_denied', `未声明的 collection: ${collection}`);
          if (expected_revision !== revision) throw makeErr('conflict', 'CAS revision 冲突');
          const encoded = JSON.stringify(value);
          if (Buffer.byteLength(encoded, 'utf8') > maxRecordBytes) throw makeErr('resource_limit', `单条记录超过 ${maxRecordBytes} B`);
          revision += 1;
          store.set(`${collection}\0${key}`, encoded);
          return { revision, value: JSON.parse(encoded) };
        });
      },
    };

    if (hostApi === 2) {
      dataApi.list = ({ collection, prefix = '', limit = 20, cursor } = {}) =>
        withBrokerSlot(async () => {
          ensurePerm('data.read');
          if (!declaredCollections.has(collection)) throw makeErr('permission_denied', `未声明的 collection: ${collection}`);
          if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw makeErr('invalid_input', 'limit 必须在 1..=50');
          const allKeys = [];
          for (const k of store.keys()) {
            const [col, key] = k.split('\0');
            if (col === collection && key.startsWith(prefix)) allKeys.push(key);
          }
          allKeys.sort();
          const start = cursor ? Number(String(cursor).split(':')[0]) : 0;
          if (!Number.isInteger(start) || start < 0 || (cursor && start >= allKeys.length)) throw makeErr('stale_binding', '无效游标');
          const slice = allKeys.slice(start, start + limit);
          const next = start + slice.length < allKeys.length ? `${start + slice.length}:mock` : null;
          return { keys: slice, next_cursor: next, revision };
        });

      dataApi.delete = ({ collection, key, expected_revision }) =>
        withBrokerSlot(async () => {
          ensurePerm('data.write');
          if (!declaredCollections.has(collection)) throw makeErr('permission_denied', `未声明的 collection: ${collection}`);
          if (expected_revision !== revision) throw makeErr('conflict', 'CAS revision 冲突');
          revision += 1;
          store.delete(`${collection}\0${key}`);
          return { revision, value: null };
        });
    }

    const httpApi = Object.freeze({
      request(req) {
        return withBrokerSlot(async () => {
          ensurePerm('http.request');
          const { rule, method = 'GET', path, query, headers, body, responseType = 'json' } = req || {};
          if (!Number.isInteger(rule) || rule < 0 || rule >= manifest.http.length) {
            throw makeErr('permission_denied', `无效 HTTP rule: ${rule}`);
          }
          const declRule = manifest.http[rule];
          if (hostApi === 1) {
            if (body !== null && body !== undefined) throw makeErr('invalid_input', 'GET 不接受 body');
            const handler = httpMock[rule];
            if (!handler) throw makeErr('network_error', `未提供 rule ${rule} mock`);
            const json = typeof handler === 'function' ? await handler(req) : handler;
            return { json: JSON.parse(JSON.stringify(json)) };
          }
          if (!declRule.methods.includes(method)) throw makeErr('permission_denied', `rule ${rule} 不允许 method ${method}`);
          if (method === 'GET' && body !== undefined) throw makeErr('invalid_input', 'GET 不接受 body');
          const base = declRule.path_prefix ?? declRule.path;
          const actualPath = path ?? base;
          if (actualPath !== base && !(declRule.path_prefix && actualPath.startsWith(`${declRule.path_prefix}/`))) {
            throw makeErr('permission_denied', `path ${actualPath} 超出 rule ${rule} 范围`);
          }
          if (query) {
            const allowedQ = new Set(declRule.query_keys ?? []);
            for (const qk of Object.keys(query)) {
              if (!allowedQ.has(qk)) throw makeErr('permission_denied', `未授权的 query key: ${qk}`);
            }
          }
          if (headers) {
            const allowedH = new Set(declRule.headers ?? []);
            for (const hk of Object.keys(headers)) {
              if (!allowedH.has(hk.toLowerCase())) throw makeErr('permission_denied', `未授权的 header: ${hk}`);
            }
          }
          if (declRule.credential) {
            if (!secretsConfigured[declRule.credential.slot]) {
              throw makeErr('credential_missing', `密钥槽 ${declRule.credential.slot} 未配置或未确认`);
            }
            if (responseType !== 'json') throw makeErr('invalid_input', '携密规则只允许 JSON 标量投影');
          }
          const handler = httpMock[rule];
          if (!handler) throw makeErr('network_error', `未提供 rule ${rule} mock`);
          const res = typeof handler === 'function' ? await handler({ rule, method, path: actualPath, query, headers, body, responseType }) : handler;
          if (declRule.credential) {
            const rawJson = res && typeof res === 'object' && 'json' in res ? res.json : res;
            return {
              status: 200,
              content_type: 'application/json',
              body: null,
              json: projectJson(rawJson, declRule.credential.projection),
            };
          }
          if (res && typeof res === 'object' && 'status' in res) {
            return JSON.parse(JSON.stringify(res));
          }
          return {
            status: 200,
            content_type: responseType === 'text' ? 'text/plain' : 'application/json',
            body: responseType === 'text' ? String(res) : null,
            json: responseType === 'json' ? JSON.parse(JSON.stringify(res)) : null,
          };
        });
      },
    });

    const nmasObj = {
      data: Object.freeze(dataApi),
      http: httpApi,
      tasks: Object.freeze({
        async start() { throw new Error('tasks.start 在 macOS 宿主不可用'); },
        async inspect() { throw new Error('tasks.inspect 在 macOS 宿主不可用'); },
        async cancel() { throw new Error('tasks.cancel 在 macOS 宿主不可用'); },
      }),
    };

    if (hostApi === 2) {
      nmasObj.settings = Object.freeze({
        get() {
          return withBrokerSlot(async () => {
            const out = {};
            for (const s of manifest.settings ?? []) {
              if (s.secret) continue;
              if (Object.prototype.hasOwnProperty.call(settingsMock, s.key)) {
                out[s.key] = settingsMock[s.key];
              } else if (s.default !== undefined) {
                out[s.key] = s.default;
              } else if (s.required) {
                throw makeErr('missing_setting', `缺少必填配置项: ${s.key}`);
              }
            }
            return JSON.parse(JSON.stringify(out));
          });
        },
      });

      nmasObj.host = Object.freeze({
        usageSummary({ days = 7 } = {}) {
          return withBrokerSlot(async () => {
            ensurePerm('host.usage.read');
            if (days !== 7 && days !== 30) throw makeErr('invalid_input', 'days 仅支持 7 或 30');
            if (typeof hostMock.usageSummary === 'function') return JSON.parse(JSON.stringify(await hostMock.usageSummary({ days })));
            return hostMock.usageSummary ? JSON.parse(JSON.stringify(hostMock.usageSummary)) : {
              as_of: '2026-11-22T12:00:00Z',
              timezone: 'Asia/Shanghai',
              windows: {
                '5m': { input_tokens: 0, output_tokens: 0, total_tokens: 0, cached_input_tokens: 0, cache_rate: null, tokens_per_second: null },
                '1h': { input_tokens: 0, output_tokens: 0, total_tokens: 0, cached_input_tokens: 0, cache_rate: null, tokens_per_second: null },
                today: { input_tokens: 0, output_tokens: 0, total_tokens: 0, cached_input_tokens: 0, cache_rate: null, tokens_per_second: null },
                '7d': { input_tokens: 0, output_tokens: 0, total_tokens: 0, cached_input_tokens: 0, cache_rate: null, tokens_per_second: null },
                '30d': { input_tokens: 0, output_tokens: 0, total_tokens: 0, cached_input_tokens: 0, cache_rate: null, tokens_per_second: null },
              },
              by_day: [],
              by_model: [],
              models_truncated: false,
            };
          });
        },
        listSessions({ offset = 0, limit = 20, is_archived } = {}) {
          return withBrokerSlot(async () => {
            ensurePerm('host.sessions.read');
            if (!Number.isInteger(offset) || offset < 0 || offset > 10000 || !Number.isInteger(limit) || limit < 1 || limit > 50) {
              throw makeErr('invalid_input', '分页参数超出范围');
            }
            if (typeof hostMock.listSessions === 'function') return JSON.parse(JSON.stringify(await hostMock.listSessions({ offset, limit, is_archived })));
            const all = (hostMock.sessions ?? []).filter(s => is_archived === undefined || s.is_archived === is_archived);
            const items = all.slice(offset, offset + limit);
            return { items: JSON.parse(JSON.stringify(items)), next_offset: offset + items.length < all.length ? offset + items.length : null };
          });
        },
        getSession({ sessionId, includeMessages } = {}) {
          return withBrokerSlot(async () => {
            ensurePerm('host.sessions.read');
            if (includeMessages === true) throw makeErr('permission_denied', '不提供会话正文');
            const found = (hostMock.sessions ?? []).find(s => s.id === sessionId);
            if (!found) throw makeErr('not_found', '没有可见的会话');
            return JSON.parse(JSON.stringify(found));
          });
        },
        listProjects({ offset = 0, limit = 20 } = {}) {
          return withBrokerSlot(async () => {
            ensurePerm('host.projects.read');
            if (!Number.isInteger(offset) || offset < 0 || offset > 10000 || !Number.isInteger(limit) || limit < 1 || limit > 50) {
              throw makeErr('invalid_input', '分页参数超出范围');
            }
            if (typeof hostMock.listProjects === 'function') return JSON.parse(JSON.stringify(await hostMock.listProjects({ offset, limit })));
            const all = hostMock.projects ?? [];
            const items = all.slice(offset, offset + limit);
            return { items: JSON.parse(JSON.stringify(items)), next_offset: offset + items.length < all.length ? offset + items.length : null };
          });
        },
      });

      nmasObj.fs = Object.freeze({
        listDir({ path = '', limit = 50, cursor } = {}) {
          return withBrokerSlot(async () => {
            ensurePerm('workspace.fs.read');
            const parts = validateFsRelativePath(path, true);
            const dir = parts.join('/');
            if (!fsDirs.has(dir)) throw makeErr('permission_denied', `目录不存在: ${dir}`);
            if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw makeErr('invalid_input', 'limit 必须在 1..=100');
            const rows = [];
            const seen = new Set();
            for (const d of fsDirs) {
              if (!d || d === dir) continue;
              const rel = dir ? (d.startsWith(`${dir}/`) ? d.slice(dir.length + 1) : null) : d;
              if (rel && !rel.includes('/') && !seen.has(rel)) {
                seen.add(rel);
                rows.push({ name: rel, kind: 'dir', size_bytes: null });
              }
            }
            for (const [f, content] of fsFiles.entries()) {
              const rel = dir ? (f.startsWith(`${dir}/`) ? f.slice(dir.length + 1) : null) : f;
              if (rel && !rel.includes('/') && !seen.has(rel)) {
                seen.add(rel);
                rows.push({ name: rel, kind: 'file', size_bytes: Buffer.byteLength(content, 'utf8') });
              }
            }
            rows.sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)));
            const start = cursor ? Number(String(cursor).split(':')[0]) : 0;
            const entries = rows.slice(start, start + limit);
            const next = start + entries.length < rows.length ? `${start + entries.length}:mock` : null;
            return { entries, next_cursor: next };
          });
        },
        stat({ path }) {
          return withBrokerSlot(async () => {
            ensurePerm('workspace.fs.read');
            const p = validateFsRelativePath(path, false).join('/');
            if (fsDirs.has(p)) return { kind: 'dir', size_bytes: null, sha256: null };
            if (!fsFiles.has(p)) throw makeErr('permission_denied', `文件不存在: ${p}`);
            const buf = Buffer.from(fsFiles.get(p), 'utf8');
            return { kind: 'file', size_bytes: buf.length, sha256: sha256Hex(buf) };
          });
        },
        readText({ path }) {
          return withBrokerSlot(async () => {
            ensurePerm('workspace.fs.read');
            const p = validateFsRelativePath(path, false).join('/');
            if (!fsFiles.has(p)) throw makeErr('permission_denied', `文件不存在: ${p}`);
            const content = fsFiles.get(p);
            const buf = Buffer.from(content, 'utf8');
            if (buf.length > 224 * 1024) throw makeErr('resource_limit', '文件超过 224 KiB');
            return { content, size_bytes: buf.length, sha256: sha256Hex(buf) };
          });
        },
        writeText({ path, content, expected_sha256, create_only }) {
          return withBrokerSlot(async () => {
            ensurePerm('workspace.fs.write');
            const parts = validateFsRelativePath(path, false);
            const p = parts.join('/');
            const parent = parts.slice(0, -1).join('/');
            if (!fsDirs.has(parent)) throw makeErr('permission_denied', `父目录不存在（不自动建目录）: ${parent}`);
            if (typeof content !== 'string' || content.includes('\0')) throw makeErr('invalid_input', 'content 无效');
            const buf = Buffer.from(content, 'utf8');
            if (buf.length > 224 * 1024) throw makeErr('resource_limit', '写入正文超过 224 KiB');
            const hasCreate = create_only === true;
            const hasHash = typeof expected_sha256 === 'string' && /^[0-9a-f]{64}$/.test(expected_sha256);
            if (hasCreate === hasHash) throw makeErr('invalid_input', 'create_only 与 expected_sha256 必须二选一');
            if (hasCreate) {
              if (fsFiles.has(p) || fsDirs.has(p)) throw makeErr('conflict', '文件已存在');
            } else {
              if (!fsFiles.has(p)) throw makeErr('conflict', '目标文件不存在');
              const curHash = sha256Hex(Buffer.from(fsFiles.get(p), 'utf8'));
              if (curHash !== expected_sha256) throw makeErr('conflict', 'expected_sha256 不匹配');
            }
            fsFiles.set(p, content);
            return { size_bytes: buf.length, sha256: sha256Hex(buf) };
          });
        },
      });

      nmasObj.ai = Object.freeze({
        complete({ request_id, prompt, format = 'text' } = {}) {
          return withBrokerSlot(async () => {
            ensurePerm('ai.complete');
            if (!UUIDV4_RE.test(String(request_id || ''))) throw makeErr('invalid_input', 'request_id 必须为小写 UUIDv4');
            if (typeof prompt !== 'string' || !prompt.trim() || prompt.includes('\0') || Buffer.byteLength(prompt, 'utf8') > 8192) {
              throw makeErr('invalid_input', 'prompt 无效或超过 8192 字节');
            }
            if (format !== 'text' && format !== 'json') throw makeErr('invalid_input', 'format 仅支持 text/json');
            if (aiRequests.has(request_id)) throw makeErr('conflict', '重复的 AI request_id');
            aiRequests.set(request_id, { state: 'completed' });
            const res = aiMock?.complete
              ? await aiMock.complete({ request_id, prompt, format })
              : format === 'json'
                ? { model: manifest.ai.model, text: null, json: { ok: true }, input_tokens: 120, output_tokens: 64, cost_microcredits: 12 }
                : { model: manifest.ai.model, text: '合成 AI 回复', json: null, input_tokens: 120, output_tokens: 64, cost_microcredits: 12 };
            return JSON.parse(JSON.stringify(res));
          });
        },
        stream_start({ request_id, prompt } = {}) {
          return withBrokerSlot(async () => {
            ensurePerm('ai.complete');
            if (!UUIDV4_RE.test(String(request_id || ''))) throw makeErr('invalid_input', 'request_id 必须为小写 UUIDv4');
            if (typeof prompt !== 'string' || !prompt.trim() || prompt.includes('\0') || Buffer.byteLength(prompt, 'utf8') > 8192) {
              throw makeErr('invalid_input', 'prompt 无效或超过 8192 字节');
            }
            if (aiRequests.has(request_id)) throw makeErr('conflict', '重复的 AI request_id');
            aiRequests.set(request_id, { state: 'running' });
            if (onAiEvent) {
              const chunks = aiMock?.streamChunks ? await aiMock.streamChunks({ request_id, prompt }) : ['第一段流式输出', '，第二段流式输出。'];
              for (const text of chunks) {
                sseSeq += 1;
                onAiEvent({ type: 'ai.delta', request_id, seq: sseSeq, text });
              }
              sseSeq += 1;
              onAiEvent({ type: 'ai.done', request_id, seq: sseSeq, cost_microcredits: aiMock?.streamCost ?? 8 });
            }
            return { request_id, status: 'started' };
          });
        },
        cancel({ request_id } = {}) {
          return withBrokerSlot(async () => {
            ensurePerm('ai.complete');
            if (!UUIDV4_RE.test(String(request_id || ''))) throw makeErr('invalid_input', 'request_id 必须为小写 UUIDv4');
            if (!aiRequests.has(request_id)) throw makeErr('not_found', '未找到进行中的 AI 请求');
            aiRequests.set(request_id, { state: 'cancelled' });
            return { request_id, status: 'cancel_requested' };
          });
        },
      });
    }

    const previousNmas = globalThis.nmas;
    globalThis.nmas = Object.freeze(nmasObj);

    try {
      const result = await entry({ kind, contribution, input: JSON.parse(inputText) });
      const outputText = JSON.stringify(result);
      if (Buffer.byteLength(outputText, 'utf8') > maxValueBytes) {
        throw new Error(`${manifest.plugin_id}/${contribution}: output 超过 ${maxValueBytes} B`);
      }
      validateJsonSchema(decl.output_schema, JSON.parse(outputText), `${contribution}.output`, hostApi);
      return JSON.parse(outputText);
    } finally {
      if (previousNmas === undefined) delete globalThis.nmas;
      else globalThis.nmas = previousNmas;
    }
  }

  return {
    action: (id, input = {}) => invoke('action', id, input),
    tool: (id, input = {}) => invoke('tool', id, input),
    getRevision: () => revision,
    getFsFile: p => fsFiles.get(p),
    listFsFiles: () => [...fsFiles.keys()].sort(),
  };
}
