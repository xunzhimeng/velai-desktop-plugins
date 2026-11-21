const COL_SERVICES = 'services';
const COL_ENDPOINTS = 'endpoints';
const COL_SCHEMAS = 'schemas';
const KEY_INDEX = 'index';
const DOC_FORMAT = 'velai-api-arch-studio';

const MAX_RECORD_BYTES = 13800;
const MAX_CODE_BYTES = 11800;
const MAX_SERVICES = 24;
const MAX_EDGES = 48;
const MAX_ENDPOINTS = 32;
const MAX_SCHEMAS = 24;

const ID_RE = /^[a-zA-Z0-9._-]+$/;
const SVC_KINDS = ['gateway', 'service', 'db', 'queue', 'external'];
const PROTOCOLS = ['HTTP', 'gRPC', 'Event', 'SQL', 'Cache'];
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
const AUTHS = ['none', 'bearer', 'api_key', 'mtls', 'oauth2'];
const STATUSES = ['draft', 'review', 'stable', 'deprecated'];
const SCHEMA_KINDS = ['dto', 'entity', 'event', 'error'];
const FIELD_TYPES = ['string', 'integer', 'number', 'boolean', 'object', 'array'];
const PARAM_INS = ['path', 'query', 'header'];
const PARAM_TYPES = ['string', 'integer', 'number', 'boolean'];

function jsonBytes(v) {
  let b = 0;
  for (const ch of JSON.stringify(v)) {
    const cp = ch.codePointAt(0);
    b += cp <= 0x7f ? 1 : cp <= 0x7ff ? 2 : cp <= 0xffff ? 3 : 4;
  }
  return b;
}

function utf8Bytes(str) {
  let b = 0;
  for (const ch of str) {
    const cp = ch.codePointAt(0);
    b += cp <= 0x7f ? 1 : cp <= 0x7ff ? 2 : cp <= 0xffff ? 3 : 4;
  }
  return b;
}

function truncateUtf8(str, maxBytes) {
  if (utf8Bytes(str) <= maxBytes) return { text: str, truncated: false };
  let out = '';
  let b = 0;
  for (const ch of str) {
    const cp = ch.codePointAt(0);
    const cb = cp <= 0x7f ? 1 : cp <= 0x7ff ? 2 : cp <= 0xffff ? 3 : 4;
    if (b + cb > maxBytes - 32) break;
    out += ch;
    b += cb;
  }
  return { text: out, truncated: true };
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

/**
 * Tarjan SCC + Cycle Path & Coupling Analyzer
 */
function analyzeTopology(services, edges, endpoints) {
  const svcIds = new Set(services.map(s => s.id));
  const validEdges = edges.filter(e => svcIds.has(e.from) && svcIds.has(e.to));

  const adj = new Map();
  const fanIn = new Map();
  const fanOut = new Map();
  const epCount = new Map();
  for (const s of services) {
    adj.set(s.id, []);
    fanIn.set(s.id, 0);
    fanOut.set(s.id, 0);
    epCount.set(s.id, 0);
  }
  for (const e of validEdges) {
    adj.get(e.from).push(e);
    fanOut.set(e.from, fanOut.get(e.from) + 1);
    fanIn.set(e.to, fanIn.get(e.to) + 1);
  }
  for (const ep of endpoints) {
    if (epCount.has(ep.service_id)) epCount.set(ep.service_id, epCount.get(ep.service_id) + 1);
  }

  // Tarjan's SCC algorithm
  let idx = 0;
  const indexMap = new Map();
  const lowlink = new Map();
  const onStack = new Set();
  const stack = [];
  const sccs = [];

  function strongConnect(v) {
    indexMap.set(v, idx);
    lowlink.set(v, idx);
    idx += 1;
    stack.push(v);
    onStack.add(v);

    for (const e of adj.get(v) || []) {
      const w = e.to;
      if (!indexMap.has(w)) {
        strongConnect(w);
        lowlink.set(v, Math.min(lowlink.get(v), lowlink.get(w)));
      } else if (onStack.has(w)) {
        lowlink.set(v, Math.min(lowlink.get(v), indexMap.get(w)));
      }
    }

    if (lowlink.get(v) === indexMap.get(v)) {
      const comp = [];
      while (stack.length > 0) {
        const w = stack.pop();
        onStack.delete(w);
        comp.push(w);
        if (w === v) break;
      }
      sccs.push(comp);
    }
  }

  for (const s of services) {
    if (!indexMap.has(s.id)) strongConnect(s.id);
  }

  const inCycleNodes = new Set();
  const cycleEdgeIds = new Set();
  const cycles = [];

  for (const comp of sccs) {
    const compSet = new Set(comp);
    const hasSelfLoop = comp.length === 1 && (adj.get(comp[0]) || []).some(e => e.to === comp[0]);
    if (comp.length > 1 || hasSelfLoop) {
      for (const n of comp) inCycleNodes.add(n);
      for (const e of validEdges) {
        if (compSet.has(e.from) && compSet.has(e.to)) cycleEdgeIds.add(e.id);
      }
      // Extract a clean representative cycle path inside this SCC
      if (hasSelfLoop) {
        cycles.push([comp[0], comp[0]]);
      } else {
        const start = comp[comp.length - 1];
        const path = [start];
        const visited = new Set([start]);
        let curr = start;
        let closed = false;
        for (let step = 0; step <= comp.length; step++) {
          const outEdges = (adj.get(curr) || []).filter(e => compSet.has(e.to));
          const closeEdge = outEdges.find(e => e.to === start);
          if (closeEdge && path.length > 1) {
            path.push(start);
            closed = true;
            break;
          }
          const nextEdge = outEdges.find(e => !visited.has(e.to));
          if (!nextEdge) break;
          curr = nextEdge.to;
          visited.add(curr);
          path.push(curr);
        }
        if (!closed) path.push(start);
        cycles.push(path);
      }
    }
  }

  const warnings = [];
  for (const cyc of cycles) {
    warnings.push(`检测到循环依赖路径: ${cyc.join(' -> ')}`);
  }
  for (const s of services) {
    const fo = fanOut.get(s.id) || 0;
    const fi = fanIn.get(s.id) || 0;
    if (fo >= 4) warnings.push(`高扇出耦合: ${s.name} (${s.id}) 依赖 ${fo} 个下游服务`);
    if (fi >= 4 && s.kind !== 'db' && s.kind !== 'queue') {
      warnings.push(`高扇入热点: ${s.name} (${s.id}) 被 ${fi} 个上游调用`);
    }
  }
  const deprecatedCount = endpoints.filter(ep => ep.status === 'deprecated').length;
  if (deprecatedCount > 0) {
    warnings.push(`存在 ${deprecatedCount} 个已弃用 (deprecated) 接口待下线`);
  }

  const metrics = services.map(s => ({
    service_id: s.id,
    fan_in: fanIn.get(s.id) || 0,
    fan_out: fanOut.get(s.id) || 0,
    endpoint_count: epCount.get(s.id) || 0,
    in_cycle: inCycleNodes.has(s.id),
  }));

  const stableCount = endpoints.filter(ep => ep.status === 'stable').length;
  const stable_ratio = endpoints.length === 0 ? 0 : round1((stableCount / endpoints.length) * 100);

  return {
    metrics,
    cycles,
    cycle_edge_ids: Array.from(cycleEdgeIds),
    warnings: warnings.slice(0, 12),
    stable_ratio,
  };
}

/**
 * OpenAPI 3.0.3 JSON & TypeScript Interface Compiler
 */
function compileOpenApi(services, endpoints, schemas, serviceFilter) {
  const svcMap = new Map(services.map(s => [s.id, s]));
  const schemaMap = new Map(schemas.map(s => [s.id, s]));
  const eps = serviceFilter ? endpoints.filter(e => e.service_id === serviceFilter) : endpoints;

  const paths = {};
  const usedSchemaIds = new Set();

  function collectRefs(sid) {
    if (!sid || !schemaMap.has(sid) || usedSchemaIds.has(sid)) return;
    usedSchemaIds.add(sid);
    const sc = schemaMap.get(sid);
    for (const f of sc.fields) {
      if (f.ref && schemaMap.has(f.ref)) collectRefs(f.ref);
      if (f.item_type && schemaMap.has(f.item_type)) collectRefs(f.item_type);
    }
  }

  for (const ep of eps) {
    if (!paths[ep.path]) paths[ep.path] = {};
    const svc = svcMap.get(ep.service_id);
    const op = {
      operationId: ep.id.replace(/[^a-zA-Z0-9_]/g, '_'),
      summary: ep.summary,
      tags: [svc ? svc.name : ep.service_id],
    };
    if (ep.status === 'deprecated') op.deprecated = true;
    if (ep.auth && ep.auth !== 'none') op.security = [{ [ep.auth]: [] }];
    if (ep.params.length > 0) {
      op.parameters = ep.params.map(p => ({
        name: p.name,
        in: p.in,
        required: p.in === 'path' ? true : p.required,
        description: p.description || undefined,
        schema: { type: p.type },
      }));
    }
    if (ep.request_schema && schemaMap.has(ep.request_schema) && ep.method !== 'GET' && ep.method !== 'DELETE') {
      collectRefs(ep.request_schema);
      op.requestBody = {
        required: true,
        content: {
          'application/json': { schema: { $ref: `#/components/schemas/${ep.request_schema}` } },
        },
      };
    }
    const responses = {
      '200': ep.response_schema && schemaMap.has(ep.response_schema)
        ? {
            description: 'OK',
            content: { 'application/json': { schema: { $ref: `#/components/schemas/${ep.response_schema}` } } },
          }
        : { description: 'OK' },
    };
    if (ep.response_schema && schemaMap.has(ep.response_schema)) collectRefs(ep.response_schema);
    for (const err of ep.error_codes) {
      responses[String(err.code)] = { description: err.message };
    }
    op.responses = responses;
    paths[ep.path][ep.method.toLowerCase()] = op;
  }

  const targetSchemas = serviceFilter
    ? schemas.filter(s => usedSchemaIds.has(s.id))
    : schemas;

  const compSchemas = {};
  for (const sc of targetSchemas) {
    const props = {};
    const required = [];
    for (const f of sc.fields) {
      if (f.required) required.push(f.name);
      if (f.ref && schemaMap.has(f.ref)) {
        props[f.name] = { $ref: `#/components/schemas/${f.ref}` };
      } else if (f.type === 'array') {
        const itemSchema = f.item_type && schemaMap.has(f.item_type)
          ? { $ref: `#/components/schemas/${f.item_type}` }
          : { type: PARAM_TYPES.includes(f.item_type) ? f.item_type : 'string' };
        props[f.name] = { type: 'array', items: itemSchema, description: f.description || undefined };
      } else {
        props[f.name] = { type: f.type, description: f.description || undefined };
      }
    }
    compSchemas[sc.id] = {
      type: 'object',
      description: sc.description || undefined,
      required: required.length > 0 ? required : undefined,
      properties: props,
    };
  }

  const spec = {
    openapi: '3.0.3',
    info: {
      title: serviceFilter && svcMap.has(serviceFilter) ? `${svcMap.get(serviceFilter).name} API` : 'Project Architecture API',
      version: '1.0.0',
    },
    paths,
    components: {
      securitySchemes: {
        bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
        api_key: { type: 'apiKey', in: 'header', name: 'X-API-Key' },
        mtls: { type: 'mutualTLS' },
        oauth2: { type: 'oauth2', flows: { clientCredentials: { tokenUrl: '/oauth/token', scopes: {} } } },
      },
      schemas: compSchemas,
    },
  };

  const { text, truncated } = truncateUtf8(JSON.stringify(spec, null, 2), MAX_CODE_BYTES);
  return { code: text, endpoint_count: eps.length, schema_count: targetSchemas.length, truncated };
}

function tsTypeOf(f, schemaIds) {
  if (f.ref && schemaIds.has(f.ref)) return f.ref;
  if (f.type === 'integer' || f.type === 'number') return 'number';
  if (f.type === 'boolean' || f.type === 'string') return f.type;
  if (f.type === 'object') return 'Record<string, unknown>';
  if (f.type === 'array') {
    if (f.item_type && schemaIds.has(f.item_type)) return `${f.item_type}[]`;
    if (f.item_type === 'integer' || f.item_type === 'number') return 'number[]';
    if (f.item_type === 'boolean') return 'boolean[]';
    return 'string[]';
  }
  return 'unknown';
}

function compileTypeScript(services, endpoints, schemas, serviceFilter) {
  const schemaIds = new Set(schemas.map(s => s.id));
  const eps = serviceFilter ? endpoints.filter(e => e.service_id === serviceFilter) : endpoints;
  const lines = ['// Auto-generated by Velai API Arch Studio', ''];

  for (const sc of schemas) {
    if (sc.description) lines.push(`/** ${sc.name}: ${sc.description} */`);
    lines.push(`export interface ${sc.id} {`);
    for (const f of sc.fields) {
      const comment = f.description ? ` // ${f.description}` : '';
      lines.push(`  ${f.name}${f.required ? '' : '?'}: ${tsTypeOf(f, schemaIds)};${comment}`);
    }
    lines.push('}', '');
  }

  lines.push('export interface ApiContractMap {');
  for (const ep of eps) {
    const reqT = ep.request_schema && schemaIds.has(ep.request_schema) ? ep.request_schema : 'void';
    const resT = ep.response_schema && schemaIds.has(ep.response_schema) ? ep.response_schema : 'void';
    const paramsStr = ep.params.length
      ? `{ ${ep.params.map(p => `${p.name}${p.required ? '' : '?'}: ${p.type === 'integer' || p.type === 'number' ? 'number' : p.type}`).join('; ')} }`
      : 'never';
    lines.push(`  /** [${ep.status}] ${ep.summary} (${ep.service_id}) */`);
    lines.push(`  '${ep.method} ${ep.path}': { params: ${paramsStr}; request: ${reqT}; response: ${resT}; auth: '${ep.auth}' };`);
  }
  lines.push('}');

  const { text, truncated } = truncateUtf8(lines.join('\n'), MAX_CODE_BYTES);
  return { code: text, endpoint_count: eps.length, schema_count: schemas.length, truncated };
}

async function readServicesDoc() {
  const receipt = await globalThis.nmas.data.read({ collection: COL_SERVICES, key: KEY_INDEX });
  const doc = receipt.value === null ? { schema_version: 1, services: [], edges: [] } : receipt.value;
  if (!doc || doc.schema_version !== 1 || !Array.isArray(doc.services) || !Array.isArray(doc.edges)) {
    throw new Error('服务拓扑数据格式无效');
  }
  return { revision: receipt.revision, services: doc.services, edges: doc.edges };
}

async function readListDoc(collection, fieldName) {
  const receipt = await globalThis.nmas.data.read({ collection, key: KEY_INDEX });
  const doc = receipt.value === null ? { schema_version: 1, [fieldName]: [] } : receipt.value;
  if (!doc || doc.schema_version !== 1 || !Array.isArray(doc[fieldName])) {
    throw new Error(`集合 ${collection} 数据格式无效`);
  }
  return { revision: receipt.revision, items: doc[fieldName] };
}

async function readAll() {
  const s = await readServicesDoc();
  const e = await readListDoc(COL_ENDPOINTS, 'endpoints');
  const sc = await readListDoc(COL_SCHEMAS, 'schemas');
  return {
    revision: sc.revision,
    services: s.services,
    edges: s.edges,
    endpoints: e.items,
    schemas: sc.items,
  };
}

async function writeDoc(collection, expectedRevision, value) {
  if (jsonBytes(value) > MAX_RECORD_BYTES) {
    return { status: 'limit', revision: expectedRevision };
  }
  try {
    const receipt = await globalThis.nmas.data.write({
      collection,
      key: KEY_INDEX,
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

function sanitizeParams(params) {
  if (!Array.isArray(params)) return [];
  const out = [];
  for (const p of params) {
    if (!p || typeof p.name !== 'string' || !p.name.trim()) continue;
    out.push({
      name: p.name.trim().slice(0, 40),
      in: PARAM_INS.includes(p.in) ? p.in : 'query',
      type: PARAM_TYPES.includes(p.type) ? p.type : 'string',
      required: Boolean(p.required),
      description: typeof p.description === 'string' ? p.description.trim().slice(0, 100) : '',
    });
    if (out.length >= 10) break;
  }
  return out;
}

function sanitizeErrors(errs) {
  if (!Array.isArray(errs)) return [];
  const out = [];
  for (const e of errs) {
    if (!e || !Number.isInteger(e.code) || e.code < 400 || e.code > 599) continue;
    const msg = typeof e.message === 'string' && e.message.trim() ? e.message.trim().slice(0, 80) : `HTTP ${e.code}`;
    out.push({ code: e.code, message: msg });
    if (out.length >= 8) break;
  }
  return out;
}

function sanitizeFields(fields) {
  if (!Array.isArray(fields)) return [];
  const out = [];
  for (const f of fields) {
    if (!f || typeof f.name !== 'string' || !f.name.trim()) continue;
    out.push({
      name: f.name.trim().slice(0, 40),
      type: FIELD_TYPES.includes(f.type) ? f.type : 'string',
      item_type: typeof f.item_type === 'string' ? f.item_type.trim().slice(0, 48) : '',
      ref: typeof f.ref === 'string' ? f.ref.trim().slice(0, 48) : '',
      required: Boolean(f.required),
      description: typeof f.description === 'string' ? f.description.trim().slice(0, 100) : '',
    });
    if (out.length >= 16) break;
  }
  return out;
}

function buildDemoData() {
  const services = [
    { id: 'api-gateway', name: '统一 API 网关', kind: 'gateway', owner: 'Platform', description: '鉴权、限流、灰度路由与统一契约出口', tier: 0 },
    { id: 'order-svc', name: '订单核心服务', kind: 'service', owner: 'Commerce', description: '订单状态机、幂等创建与取消编排', tier: 1 },
    { id: 'risk-svc', name: '实时风控引擎', kind: 'service', owner: 'Trust', description: '反欺诈规则评分、设备指纹与黑名单拦截', tier: 1 },
    { id: 'payment-svc', name: '支付清算服务', kind: 'service', owner: 'Fintech', description: '多渠道收单、预授权扣款与对账回调', tier: 2 },
    { id: 'event-bus', name: '领域事件总线 Kafka', kind: 'queue', owner: 'Infra', description: '异步解耦订单、风控与履约领域事件', tier: 2 },
    { id: 'order-db', name: '订单主库 PostgreSQL', kind: 'db', owner: 'DBA', description: '订单分库分表持久化与分布式事务表', tier: 3 },
  ];

  const edges = [
    { id: 'e-gw-ord', from: 'api-gateway', to: 'order-svc', protocol: 'HTTP', label: '下单与查询路由' },
    { id: 'e-gw-pay', from: 'api-gateway', to: 'payment-svc', protocol: 'HTTP', label: '支付状态查询' },
    { id: 'e-ord-rsk', from: 'order-svc', to: 'risk-svc', protocol: 'gRPC', label: '同步下单风控评分' },
    { id: 'e-rsk-ord', from: 'risk-svc', to: 'order-svc', protocol: 'gRPC', label: '回查近24h历史订单(环依赖)' },
    { id: 'e-ord-pay', from: 'order-svc', to: 'payment-svc', protocol: 'gRPC', label: '发起支付扣款' },
    { id: 'e-ord-db', from: 'order-svc', to: 'order-db', protocol: 'SQL', label: '订单主表读写' },
    { id: 'e-ord-bus', from: 'order-svc', to: 'event-bus', protocol: 'Event', label: 'OrderCreated 事件' },
    { id: 'e-pay-bus', from: 'payment-svc', to: 'event-bus', protocol: 'Event', label: 'PaymentSettled 事件' },
  ];

  const schemas = [
    {
      id: 'CreateOrderReq',
      name: '创建订单请求',
      kind: 'dto',
      description: '客户端下单幂等提交载荷',
      fields: [
        { name: 'idempotencyKey', type: 'string', item_type: '', ref: '', required: true, description: '幂等令牌 UUID' },
        { name: 'userId', type: 'string', item_type: '', ref: '', required: true, description: '下单用户 ID' },
        { name: 'skuIds', type: 'array', item_type: 'string', ref: '', required: true, description: '商品 SKU 列表' },
        { name: 'amountCents', type: 'integer', item_type: '', ref: '', required: true, description: '订单总金额(分)' },
      ],
    },
    {
      id: 'OrderDTO',
      name: '订单领域实体',
      kind: 'entity',
      description: '对外返回的标准化订单视图',
      fields: [
        { name: 'orderId', type: 'string', item_type: '', ref: '', required: true, description: '全局订单号' },
        { name: 'status', type: 'string', item_type: '', ref: '', required: true, description: 'PENDING/PAID/CANCELLED' },
        { name: 'amountCents', type: 'integer', item_type: '', ref: '', required: true, description: '实付金额(分)' },
        { name: 'riskDecision', type: 'object', item_type: '', ref: 'RiskDecisionDTO', required: false, description: '风控决策快照' },
      ],
    },
    {
      id: 'RiskEvalReq',
      name: '风控评估请求',
      kind: 'dto',
      description: '交易风控打分输入上下文',
      fields: [
        { name: 'userId', type: 'string', item_type: '', ref: '', required: true, description: '用户 ID' },
        { name: 'amountCents', type: 'integer', item_type: '', ref: '', required: true, description: '交易金额(分)' },
        { name: 'deviceFingerprint', type: 'string', item_type: '', ref: '', required: true, description: '设备指纹哈希' },
      ],
    },
    {
      id: 'RiskDecisionDTO',
      name: '风控决策结果',
      kind: 'event',
      description: '实时风控引擎返回的评分与处置动作',
      fields: [
        { name: 'action', type: 'string', item_type: '', ref: '', required: true, description: 'ALLOW/CHALLENGE/REJECT' },
        { name: 'score', type: 'number', item_type: '', ref: '', required: true, description: '风险分 0~100' },
        { name: 'hitRules', type: 'array', item_type: 'string', ref: '', required: false, description: '命中的规则编号' },
      ],
    },
  ];

  const endpoints = [
    {
      id: 'ep-order-create',
      service_id: 'order-svc',
      method: 'POST',
      path: '/v1/orders',
      summary: '幂等创建电商订单',
      auth: 'bearer',
      status: 'stable',
      params: [{ name: 'X-Trace-Id', in: 'header', type: 'string', required: false, description: '全链路追踪 ID' }],
      request_schema: 'CreateOrderReq',
      response_schema: 'OrderDTO',
      error_codes: [
        { code: 409, message: '重复幂等键冲突' },
        { code: 422, message: '风控策略拦截拒绝下单' },
      ],
    },
    {
      id: 'ep-order-get',
      service_id: 'order-svc',
      method: 'GET',
      path: '/v1/orders/{orderId}',
      summary: '按订单号查询订单详情',
      auth: 'bearer',
      status: 'stable',
      params: [{ name: 'orderId', in: 'path', type: 'string', required: true, description: '订单 ID' }],
      request_schema: '',
      response_schema: 'OrderDTO',
      error_codes: [{ code: 404, message: '订单不存在' }],
    },
    {
      id: 'ep-order-cancel',
      service_id: 'order-svc',
      method: 'PATCH',
      path: '/v1/orders/{orderId}/cancel',
      summary: '取消未支付订单并释放库存',
      auth: 'bearer',
      status: 'review',
      params: [{ name: 'orderId', in: 'path', type: 'string', required: true, description: '订单 ID' }],
      request_schema: '',
      response_schema: 'OrderDTO',
      error_codes: [{ code: 409, message: '订单已进入清算阶段不可取消' }],
    },
    {
      id: 'ep-risk-eval',
      service_id: 'risk-svc',
      method: 'POST',
      path: '/v1/risk/evaluate',
      summary: '执行交易实时风控评分',
      auth: 'mtls',
      status: 'stable',
      params: [],
      request_schema: 'RiskEvalReq',
      response_schema: 'RiskDecisionDTO',
      error_codes: [{ code: 503, message: '特征服务超时降级' }],
    },
    {
      id: 'ep-pay-charge',
      service_id: 'payment-svc',
      method: 'POST',
      path: '/v1/payments/charge',
      summary: '发起订单收单扣款',
      auth: 'mtls',
      status: 'stable',
      params: [],
      request_schema: 'CreateOrderReq',
      response_schema: 'OrderDTO',
      error_codes: [{ code: 402, message: '余额不足或渠道拒付' }],
    },
    {
      id: 'ep-pay-status',
      service_id: 'payment-svc',
      method: 'GET',
      path: '/v1/payments/{txId}/status',
      summary: '查询支付流水实时清算状态',
      auth: 'api_key',
      status: 'draft',
      params: [{ name: 'txId', in: 'path', type: 'string', required: true, description: '支付流水号' }],
      request_schema: '',
      response_schema: 'OrderDTO',
      error_codes: [{ code: 404, message: '流水记录未找到' }],
    },
    {
      id: 'ep-legacy-del',
      service_id: 'api-gateway',
      method: 'DELETE',
      path: '/v0/orders/{orderId}',
      summary: '旧版订单物理删除接口（计划下线）',
      auth: 'oauth2',
      status: 'deprecated',
      params: [{ name: 'orderId', in: 'path', type: 'string', required: true, description: '旧版订单 ID' }],
      request_schema: '',
      response_schema: '',
      error_codes: [{ code: 410, message: '接口即将移除' }],
    },
  ];

  return { services, edges, endpoints, schemas };
}

export default async function (request) {
  const { kind, contribution, input } = request ?? {};

  if (kind === 'action') {
    if (contribution === 'arch.state') {
      const all = await readAll();
      return {
        revision: all.revision,
        services: all.services,
        edges: all.edges,
        endpoints: all.endpoints,
        schemas: all.schemas,
        analysis: analyzeTopology(all.services, all.edges, all.endpoints),
      };
    }

    if (contribution === 'arch.service.save') {
      const { expected_revision, id, name, kind: svcKind, owner, description, tier } = input;
      if (!ID_RE.test(id) || !name.trim() || !SVC_KINDS.includes(svcKind)) {
        return { status: 'invalid_input', revision: expected_revision };
      }
      const doc = await readServicesDoc();
      if (doc.revision !== expected_revision) return { status: 'conflict', revision: doc.revision };
      const exists = doc.services.some(s => s.id === id);
      if (!exists && doc.services.length >= MAX_SERVICES) return { status: 'limit', revision: doc.revision };
      const rec = {
        id,
        name: name.trim().slice(0, 60),
        kind: svcKind,
        owner: (owner || '').trim().slice(0, 40),
        description: (description || '').trim().slice(0, 180),
        tier: Number.isInteger(tier) ? Math.max(0, Math.min(4, tier)) : 1,
      };
      const nextServices = exists ? doc.services.map(s => (s.id === id ? rec : s)) : [...doc.services, rec];
      return writeDoc(COL_SERVICES, expected_revision, { schema_version: 1, services: nextServices, edges: doc.edges });
    }

    if (contribution === 'arch.service.delete') {
      const { expected_revision, id } = input;
      const all = await readAll();
      if (all.revision !== expected_revision) return { status: 'conflict', revision: all.revision };
      if (!all.services.some(s => s.id === id)) return { status: 'not_found', revision: all.revision };
      const nextServices = all.services.filter(s => s.id !== id);
      const nextEdges = all.edges.filter(e => e.from !== id && e.to !== id);
      const nextEndpoints = all.endpoints.filter(ep => ep.service_id !== id);

      const r1 = await writeDoc(COL_SERVICES, expected_revision, { schema_version: 1, services: nextServices, edges: nextEdges });
      if (r1.status !== 'saved') return { status: 'conflict', revision: r1.revision };
      if (nextEndpoints.length !== all.endpoints.length) {
        const r2 = await writeDoc(COL_ENDPOINTS, r1.revision, { schema_version: 1, endpoints: nextEndpoints });
        if (r2.status !== 'saved') return { status: 'conflict', revision: r2.revision };
        return { status: 'deleted', revision: r2.revision };
      }
      return { status: 'deleted', revision: r1.revision };
    }

    if (contribution === 'arch.edge.save') {
      const { expected_revision, id, from, to, protocol, label } = input;
      if (!ID_RE.test(id) || !PROTOCOLS.includes(protocol)) {
        return { status: 'invalid_input', revision: expected_revision };
      }
      const doc = await readServicesDoc();
      if (doc.revision !== expected_revision) return { status: 'conflict', revision: doc.revision };
      const ids = new Set(doc.services.map(s => s.id));
      if (!ids.has(from) || !ids.has(to)) return { status: 'service_not_found', revision: doc.revision };
      const exists = doc.edges.some(e => e.id === id);
      if (!exists && doc.edges.length >= MAX_EDGES) return { status: 'limit', revision: doc.revision };
      const rec = { id, from, to, protocol, label: (label || '').trim().slice(0, 60) };
      const nextEdges = exists ? doc.edges.map(e => (e.id === id ? rec : e)) : [...doc.edges, rec];
      return writeDoc(COL_SERVICES, expected_revision, { schema_version: 1, services: doc.services, edges: nextEdges });
    }

    if (contribution === 'arch.edge.delete') {
      const { expected_revision, id } = input;
      const doc = await readServicesDoc();
      if (doc.revision !== expected_revision) return { status: 'conflict', revision: doc.revision };
      if (!doc.edges.some(e => e.id === id)) return { status: 'not_found', revision: doc.revision };
      const nextEdges = doc.edges.filter(e => e.id !== id);
      const r = await writeDoc(COL_SERVICES, expected_revision, { schema_version: 1, services: doc.services, edges: nextEdges });
      return r.status === 'saved' ? { status: 'deleted', revision: r.revision } : { status: 'conflict', revision: r.revision };
    }

    if (contribution === 'arch.endpoint.save') {
      const {
        expected_revision, id, service_id, method, path, summary, auth, status,
        params, request_schema, response_schema, error_codes,
      } = input;
      if (!ID_RE.test(id) || !METHODS.includes(method) || !path.startsWith('/') || !summary.trim() || !AUTHS.includes(auth) || !STATUSES.includes(status)) {
        return { status: 'invalid_input', revision: expected_revision };
      }
      const all = await readAll();
      if (all.revision !== expected_revision) return { status: 'conflict', revision: all.revision };
      if (!all.services.some(s => s.id === service_id)) return { status: 'service_not_found', revision: all.revision };
      const exists = all.endpoints.some(ep => ep.id === id);
      if (!exists && all.endpoints.length >= MAX_ENDPOINTS) return { status: 'limit', revision: all.revision };
      const rec = {
        id,
        service_id,
        method,
        path: path.trim().slice(0, 120),
        summary: summary.trim().slice(0, 100),
        auth,
        status,
        params: sanitizeParams(params),
        request_schema: (request_schema || '').trim().slice(0, 48),
        response_schema: (response_schema || '').trim().slice(0, 48),
        error_codes: sanitizeErrors(error_codes),
      };
      const next = exists ? all.endpoints.map(ep => (ep.id === id ? rec : ep)) : [rec, ...all.endpoints];
      const r = await writeDoc(COL_ENDPOINTS, expected_revision, { schema_version: 1, endpoints: next });
      return r.status === 'saved' ? { status: 'saved', revision: r.revision, endpoint_id: id } : { status: r.status, revision: r.revision };
    }

    if (contribution === 'arch.endpoint.delete') {
      const { expected_revision, id } = input;
      const doc = await readListDoc(COL_ENDPOINTS, 'endpoints');
      if (doc.revision !== expected_revision) return { status: 'conflict', revision: doc.revision };
      if (!doc.items.some(ep => ep.id === id)) return { status: 'not_found', revision: doc.revision };
      const r = await writeDoc(COL_ENDPOINTS, expected_revision, { schema_version: 1, endpoints: doc.items.filter(ep => ep.id !== id) });
      return r.status === 'saved' ? { status: 'deleted', revision: r.revision } : { status: 'conflict', revision: r.revision };
    }

    if (contribution === 'arch.schema.save') {
      const { expected_revision, id, name, kind: scKind, description, fields } = input;
      if (!ID_RE.test(id) || !name.trim() || !SCHEMA_KINDS.includes(scKind)) {
        return { status: 'invalid_input', revision: expected_revision };
      }
      const doc = await readListDoc(COL_SCHEMAS, 'schemas');
      if (doc.revision !== expected_revision) return { status: 'conflict', revision: doc.revision };
      const exists = doc.items.some(sc => sc.id === id);
      if (!exists && doc.items.length >= MAX_SCHEMAS) return { status: 'limit', revision: doc.revision };
      const rec = {
        id,
        name: name.trim().slice(0, 60),
        kind: scKind,
        description: (description || '').trim().slice(0, 160),
        fields: sanitizeFields(fields),
      };
      const next = exists ? doc.items.map(sc => (sc.id === id ? rec : sc)) : [...doc.items, rec];
      return writeDoc(COL_SCHEMAS, expected_revision, { schema_version: 1, schemas: next });
    }

    if (contribution === 'arch.schema.delete') {
      const { expected_revision, id } = input;
      const all = await readAll();
      if (all.revision !== expected_revision) return { status: 'conflict', revision: all.revision };
      if (!all.schemas.some(sc => sc.id === id)) return { status: 'not_found', revision: all.revision };
      const nextSchemas = all.schemas.filter(sc => sc.id !== id);
      const r1 = await writeDoc(COL_SCHEMAS, expected_revision, { schema_version: 1, schemas: nextSchemas });
      if (r1.status !== 'saved') return { status: 'conflict', revision: r1.revision };
      let changedEp = false;
      const nextEndpoints = all.endpoints.map(ep => {
        if (ep.request_schema === id || ep.response_schema === id) {
          changedEp = true;
          return {
            ...ep,
            request_schema: ep.request_schema === id ? '' : ep.request_schema,
            response_schema: ep.response_schema === id ? '' : ep.response_schema,
          };
        }
        return ep;
      });
      if (changedEp) {
        const r2 = await writeDoc(COL_ENDPOINTS, r1.revision, { schema_version: 1, endpoints: nextEndpoints });
        if (r2.status !== 'saved') return { status: 'conflict', revision: r2.revision };
        return { status: 'deleted', revision: r2.revision };
      }
      return { status: 'deleted', revision: r1.revision };
    }

    if (contribution === 'arch.codegen') {
      const all = await readAll();
      const filter = typeof input.service_id === 'string' && input.service_id.trim() ? input.service_id.trim() : '';
      const out = input.target === 'openapi'
        ? compileOpenApi(all.services, all.endpoints, all.schemas, filter)
        : compileTypeScript(all.services, all.endpoints, all.schemas, filter);
      return { target: input.target, ...out };
    }

    if (contribution === 'arch.demo.load') {
      const all = await readAll();
      if (all.revision !== input.expected_revision) {
        return {
          status: 'conflict',
          revision: all.revision,
          services_count: all.services.length,
          endpoints_count: all.endpoints.length,
          schemas_count: all.schemas.length,
        };
      }
      const demo = buildDemoData();
      const r1 = await writeDoc(COL_SERVICES, input.expected_revision, { schema_version: 1, services: demo.services, edges: demo.edges });
      if (r1.status !== 'saved') return { status: 'conflict', revision: r1.revision, services_count: 0, endpoints_count: 0, schemas_count: 0 };
      const r2 = await writeDoc(COL_ENDPOINTS, r1.revision, { schema_version: 1, endpoints: demo.endpoints });
      if (r2.status !== 'saved') return { status: 'conflict', revision: r2.revision, services_count: 0, endpoints_count: 0, schemas_count: 0 };
      const r3 = await writeDoc(COL_SCHEMAS, r2.revision, { schema_version: 1, schemas: demo.schemas });
      if (r3.status !== 'saved') return { status: 'conflict', revision: r3.revision, services_count: 0, endpoints_count: 0, schemas_count: 0 };
      return {
        status: 'loaded',
        revision: r3.revision,
        services_count: demo.services.length,
        endpoints_count: demo.endpoints.length,
        schemas_count: demo.schemas.length,
      };
    }

    if (contribution === 'document.list') {
      const all = await readAll();
      const items = [];
      if (all.services.length > 0 || all.endpoints.length > 0 || all.schemas.length > 0) {
        items.push({ id: 'all', label: `完整项目架构快照 (${all.services.length} 服务 · ${all.endpoints.length} 接口 · ${all.schemas.length} 模型)` });
      }
      for (const s of all.services) {
        const cnt = all.endpoints.filter(ep => ep.service_id === s.id).length;
        items.push({ id: `svc:${s.id}`, label: `服务契约: ${s.name} (${cnt} API)` });
      }
      return { items };
    }

    if (contribution === 'document.export') {
      const all = await readAll();
      let payload;
      let filename = 'api-arch-snapshot.json';
      if (input.id === 'all') {
        payload = { format: DOC_FORMAT, version: 1, services: all.services, edges: all.edges, endpoints: all.endpoints, schemas: all.schemas };
      } else {
        const sid = input.id.startsWith('svc:') ? input.id.slice(4) : input.id;
        const svc = all.services.find(s => s.id === sid);
        if (!svc) return { error: 'not_found' };
        const eps = all.endpoints.filter(ep => ep.service_id === sid);
        const usedSc = new Set();
        eps.forEach(ep => { if (ep.request_schema) usedSc.add(ep.request_schema); if (ep.response_schema) usedSc.add(ep.response_schema); });
        payload = {
          format: DOC_FORMAT,
          version: 1,
          services: [svc],
          edges: all.edges.filter(e => e.from === sid || e.to === sid),
          endpoints: eps,
          schemas: all.schemas.filter(sc => usedSc.has(sc.id)),
        };
        filename = `arch-${svc.id}.json`;
      }
      const text = JSON.stringify(payload, null, 2);
      if (utf8Bytes(text) > 12000) return { error: 'too_large' };
      return { filename, text };
    }

    if (contribution === 'document.import') {
      let parsed;
      try {
        parsed = JSON.parse(input.text);
      } catch {
        return { imported: false, reason: 'invalid_json' };
      }
      if (
        parsed?.format !== DOC_FORMAT ||
        parsed?.version !== 1 ||
        !Array.isArray(parsed.services) ||
        !Array.isArray(parsed.endpoints) ||
        !Array.isArray(parsed.schemas)
      ) {
        return { imported: false, reason: 'invalid_document' };
      }
      const all = await readAll();
      const svcMap = new Map(all.services.map(s => [s.id, s]));
      for (const s of parsed.services) {
        if (!s || typeof s.id !== 'string' || !ID_RE.test(s.id) || typeof s.name !== 'string' || !s.name.trim()) continue;
        if (!svcMap.has(s.id) && svcMap.size >= MAX_SERVICES) continue;
        svcMap.set(s.id, {
          id: s.id.slice(0, 40),
          name: s.name.trim().slice(0, 60),
          kind: SVC_KINDS.includes(s.kind) ? s.kind : 'service',
          owner: typeof s.owner === 'string' ? s.owner.trim().slice(0, 40) : '',
          description: typeof s.description === 'string' ? s.description.trim().slice(0, 180) : '',
          tier: Number.isInteger(s.tier) ? Math.max(0, Math.min(4, s.tier)) : 1,
        });
      }

      const edgeMap = new Map(all.edges.map(e => [e.id, e]));
      for (const e of Array.isArray(parsed.edges) ? parsed.edges : []) {
        if (!e || typeof e.id !== 'string' || !ID_RE.test(e.id) || !svcMap.has(e.from) || !svcMap.has(e.to)) continue;
        if (!edgeMap.has(e.id) && edgeMap.size >= MAX_EDGES) continue;
        edgeMap.set(e.id, {
          id: e.id.slice(0, 48),
          from: e.from,
          to: e.to,
          protocol: PROTOCOLS.includes(e.protocol) ? e.protocol : 'HTTP',
          label: typeof e.label === 'string' ? e.label.trim().slice(0, 60) : '',
        });
      }

      const epMap = new Map(all.endpoints.map(ep => [ep.id, ep]));
      for (const ep of parsed.endpoints) {
        if (!ep || typeof ep.id !== 'string' || !ID_RE.test(ep.id) || !svcMap.has(ep.service_id) || !METHODS.includes(ep.method) || typeof ep.path !== 'string' || !ep.path.startsWith('/')) continue;
        if (!epMap.has(ep.id) && epMap.size >= MAX_ENDPOINTS) continue;
        epMap.set(ep.id, {
          id: ep.id.slice(0, 48),
          service_id: ep.service_id,
          method: ep.method,
          path: ep.path.trim().slice(0, 120),
          summary: typeof ep.summary === 'string' && ep.summary.trim() ? ep.summary.trim().slice(0, 100) : ep.path,
          auth: AUTHS.includes(ep.auth) ? ep.auth : 'none',
          status: STATUSES.includes(ep.status) ? ep.status : 'draft',
          params: sanitizeParams(ep.params),
          request_schema: typeof ep.request_schema === 'string' ? ep.request_schema.trim().slice(0, 48) : '',
          response_schema: typeof ep.response_schema === 'string' ? ep.response_schema.trim().slice(0, 48) : '',
          error_codes: sanitizeErrors(ep.error_codes),
        });
      }

      const scMap = new Map(all.schemas.map(sc => [sc.id, sc]));
      for (const sc of parsed.schemas) {
        if (!sc || typeof sc.id !== 'string' || !ID_RE.test(sc.id) || typeof sc.name !== 'string' || !sc.name.trim()) continue;
        if (!scMap.has(sc.id) && scMap.size >= MAX_SCHEMAS) continue;
        scMap.set(sc.id, {
          id: sc.id.slice(0, 48),
          name: sc.name.trim().slice(0, 60),
          kind: SCHEMA_KINDS.includes(sc.kind) ? sc.kind : 'dto',
          description: typeof sc.description === 'string' ? sc.description.trim().slice(0, 160) : '',
          fields: sanitizeFields(sc.fields),
        });
      }

      const nextSvcs = Array.from(svcMap.values());
      const nextEdges = Array.from(edgeMap.values());
      const nextEps = Array.from(epMap.values());
      const nextScs = Array.from(scMap.values());

      const r1 = await writeDoc(COL_SERVICES, all.revision, { schema_version: 1, services: nextSvcs, edges: nextEdges });
      if (r1.status !== 'saved') return { imported: false, reason: r1.status };
      const r2 = await writeDoc(COL_ENDPOINTS, r1.revision, { schema_version: 1, endpoints: nextEps });
      if (r2.status !== 'saved') return { imported: false, reason: r2.status };
      const r3 = await writeDoc(COL_SCHEMAS, r2.revision, { schema_version: 1, schemas: nextScs });
      if (r3.status !== 'saved') return { imported: false, reason: r3.status };
      return {
        imported: true,
        services_count: nextSvcs.length,
        endpoints_count: nextEps.length,
        schemas_count: nextScs.length,
      };
    }
  }

  if (kind === 'tool') {
    if (contribution === 'arch.topology') {
      const all = await readAll();
      const analysis = analyzeTopology(all.services, all.edges, all.endpoints);
      const metricMap = new Map(analysis.metrics.map(m => [m.service_id, m]));
      const svcFilter = typeof input?.service_id === 'string' && input.service_id.trim() ? input.service_id.trim() : '';
      const eps = svcFilter ? all.endpoints.filter(ep => ep.service_id === svcFilter) : all.endpoints;

      return {
        success: true,
        status: all.services.length > 0 ? 'ready' : 'empty',
        service_count: all.services.length,
        edge_count: all.edges.length,
        endpoint_count: eps.length,
        cycles: analysis.cycles,
        warnings: analysis.warnings,
        services: all.services.map(s => {
          const m = metricMap.get(s.id) || { fan_in: 0, fan_out: 0, in_cycle: false, endpoint_count: 0 };
          return {
            id: s.id,
            name: s.name,
            kind: s.kind,
            fan_in: m.fan_in,
            fan_out: m.fan_out,
            in_cycle: m.in_cycle,
            endpoint_count: m.endpoint_count,
          };
        }),
        endpoints: eps.slice(0, 20).map(({ id, service_id, method, path, summary, status, auth }) => ({
          id,
          service_id,
          method,
          path,
          summary,
          status,
          auth,
        })),
      };
    }

    if (contribution === 'arch.endpoint.upsert') {
      const {
        id: rawId,
        service_id,
        method,
        path,
        summary,
        auth = 'bearer',
        status = 'draft',
        request_schema = '',
        response_schema = '',
      } = input;
      const all = await readAll();
      if (!METHODS.includes(method) || !path.startsWith('/') || !summary.trim() || !AUTHS.includes(auth) || !STATUSES.includes(status)) {
        return { success: false, status: 'invalid_input', revision: all.revision };
      }
      if (!all.services.some(s => s.id === service_id)) {
        return { success: false, status: 'service_not_found', revision: all.revision };
      }
      const existing = rawId
        ? all.endpoints.find(ep => ep.id === rawId)
        : all.endpoints.find(ep => ep.service_id === service_id && ep.method === method && ep.path === path.trim());
      const id = existing
        ? existing.id
        : rawId && ID_RE.test(rawId)
          ? rawId.slice(0, 48)
          : `ep-${Date.now().toString(36)}-${(all.endpoints.length + 1).toString(36)}`.slice(0, 48);
      if (!existing && all.endpoints.length >= MAX_ENDPOINTS) {
        return { success: false, status: 'limit', revision: all.revision };
      }
      const rec = {
        id,
        service_id,
        method,
        path: path.trim().slice(0, 120),
        summary: summary.trim().slice(0, 100),
        auth,
        status,
        params: existing ? existing.params : [],
        request_schema: (request_schema || '').trim().slice(0, 48),
        response_schema: (response_schema || '').trim().slice(0, 48),
        error_codes: existing ? existing.error_codes : [],
      };
      const next = existing ? all.endpoints.map(ep => (ep.id === id ? rec : ep)) : [rec, ...all.endpoints];
      const r = await writeDoc(COL_ENDPOINTS, all.revision, { schema_version: 1, endpoints: next });
      if (r.status !== 'saved') {
        return { success: false, status: r.status, revision: r.revision };
      }
      return {
        success: true,
        status: existing ? 'updated' : 'created',
        endpoint_id: id,
        revision: r.revision,
      };
    }
  }

  throw new Error(`不支持的调用: ${kind}/${contribution}`);
}
