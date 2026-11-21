import { pathToFileURL } from 'node:url';
import { validateJsonSchema } from './validator.mjs';

const MAX_VALUE_BYTES = 16 * 1024;
const MAX_BROKER_CALLS = 32;

export async function createPluginHarness(pluginDir, manifest, { httpMock = {} } = {}) {
  const mod = await import(`${pathToFileURL(`${pluginDir}/backend/index.js`).href}?t=${Date.now()}-${Math.random()}`);
  const entry = mod.default;
  if (typeof entry !== 'function') throw new Error(`${manifest.plugin_id}: backend/index.js 未导出 default 函数`);

  const store = new Map();
  let revision = 0;

  const actionsById = new Map(manifest.actions.map(a => [a.id, a]));
  const toolsById = new Map(manifest.tools.map(t => [t.id, t]));
  const declaredCollections = new Set(manifest.data.map(d => d.collection));

  async function invoke(kind, contribution, input) {
    const decl = kind === 'action' ? actionsById.get(contribution) : toolsById.get(contribution);
    if (!decl) throw new Error(`${manifest.plugin_id}: 未声明的 ${kind} ${contribution}`);
    const inputText = JSON.stringify(input);
    if (Buffer.byteLength(inputText, 'utf8') > MAX_VALUE_BYTES) {
      throw new Error(`${manifest.plugin_id}/${contribution}: input 超过 16 KiB`);
    }
    validateJsonSchema(decl.input_schema, JSON.parse(inputText), `${contribution}.input`);

    let brokerCalls = 0;
    const ensureBudget = () => {
      brokerCalls += 1;
      if (brokerCalls > MAX_BROKER_CALLS) throw new Error('broker_call_limit');
    };
    const ensurePerm = perm => {
      if (!decl.permissions.includes(perm)) {
        const err = new Error(`缺少权限 ${perm}`);
        err.code = 'permission_denied';
        err.outcome_unknown = false;
        throw err;
      }
    };

    const previousNmas = globalThis.nmas;
    globalThis.nmas = Object.freeze({
      data: Object.freeze({
        async read({ collection, key }) {
          ensureBudget();
          ensurePerm('data.read');
          if (!declaredCollections.has(collection)) {
            const err = new Error(`未声明的 collection: ${collection}`);
            err.code = 'permission_denied';
            err.outcome_unknown = false;
            throw err;
          }
          const raw = store.get(`${collection}\0${key}`);
          return { revision, value: raw === undefined ? null : JSON.parse(raw) };
        },
        async write({ collection, key, expected_revision, value }) {
          ensureBudget();
          ensurePerm('data.write');
          if (!declaredCollections.has(collection)) {
            const err = new Error(`未声明的 collection: ${collection}`);
            err.code = 'permission_denied';
            err.outcome_unknown = false;
            throw err;
          }
          if (expected_revision !== revision) {
            const err = new Error('CAS revision 冲突');
            err.code = 'conflict';
            err.outcome_unknown = false;
            throw err;
          }
          const encoded = JSON.stringify(value);
          if (Buffer.byteLength(encoded, 'utf8') > MAX_VALUE_BYTES) {
            const err = new Error('单条记录超过 16 KiB');
            err.code = 'resource_limit';
            err.outcome_unknown = false;
            throw err;
          }
          revision += 1;
          store.set(`${collection}\0${key}`, encoded);
          return { revision, value: JSON.parse(encoded) };
        },
      }),
      http: Object.freeze({
        async request({ rule, body }) {
          ensureBudget();
          ensurePerm('http.request');
          if (body !== null && body !== undefined) {
            const err = new Error('GET 不接受 body');
            err.code = 'invalid_input';
            err.outcome_unknown = false;
            throw err;
          }
          if (!Number.isInteger(rule) || rule < 0 || rule >= manifest.http.length) {
            const err = new Error(`无效 HTTP rule: ${rule}`);
            err.code = 'permission_denied';
            err.outcome_unknown = false;
            throw err;
          }
          const handler = httpMock[rule];
          if (!handler) {
            const err = new Error(`未提供 rule ${rule} mock`);
            err.code = 'network_error';
            err.outcome_unknown = false;
            throw err;
          }
          const json = typeof handler === 'function' ? await handler() : handler;
          return { json: JSON.parse(JSON.stringify(json)) };
        },
      }),
      tasks: Object.freeze({
        async start() { throw new Error('tasks.start 在 macOS 宿主由页面桥处理'); },
        async inspect() { throw new Error('tasks.inspect 在 macOS 宿主由页面桥处理'); },
        async cancel() { throw new Error('tasks.cancel 在 macOS 宿主由页面桥处理'); },
      }),
    });

    try {
      const result = await entry({ kind, contribution, input: JSON.parse(inputText) });
      const outputText = JSON.stringify(result);
      if (Buffer.byteLength(outputText, 'utf8') > MAX_VALUE_BYTES) {
        throw new Error(`${manifest.plugin_id}/${contribution}: output 超过 16 KiB`);
      }
      validateJsonSchema(decl.output_schema, JSON.parse(outputText), `${contribution}.output`);
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
  };
}
