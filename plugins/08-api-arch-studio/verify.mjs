import assert from 'node:assert/strict';

export async function verify({ createHarness }) {
  const h = await createHarness({
    fsInitial: {
      'docs/README.md': '# Architecture Docs\n',
    },
  });

  // 1. 初始空状态
  const init = await h.action('arch.state', {});
  assert.equal(init.revision, 0);
  assert.equal(init.services.length, 0);
  assert.equal(init.endpoints.length, 0);
  assert.equal(init.analysis.cycles.length, 0);

  // 2. 载入分布式电商订单与风控演示数据
  const demo = await h.action('arch.demo.load', { expected_revision: 0 });
  assert.equal(demo.status, 'loaded');
  assert.equal(demo.services_count, 6);
  assert.equal(demo.endpoints_count, 7);
  assert.equal(demo.schemas_count, 4);

  const st1 = await h.action('arch.state', {});
  assert.equal(st1.services.length, 6);
  assert.equal(st1.edges.length, 8);
  assert.equal(st1.endpoints.length, 7);
  assert.equal(st1.schemas.length, 4);
  assert.ok(Buffer.byteLength(JSON.stringify(st1), 'utf8') < 14 * 1024, 'arch.state 响应应小于 14 KiB');

  // 3. 拓扑环依赖检测与扇入/扇出校验
  assert.equal(st1.analysis.cycles.length, 1, '演示拓扑应检测到 order-svc <-> risk-svc 循环依赖');
  assert.ok(st1.analysis.cycle_edge_ids.includes('e-rsk-ord'));
  assert.ok(st1.analysis.cycle_edge_ids.includes('e-ord-rsk'));
  const orderMetric = st1.analysis.metrics.find(m => m.service_id === 'order-svc');
  assert.equal(orderMetric.in_cycle, true);
  assert.equal(orderMetric.fan_in, 2);
  assert.equal(orderMetric.fan_out, 4);
  assert.equal(orderMetric.endpoint_count, 3);

  // 4. CAS 冲突校验
  const conflict = await h.action('arch.service.save', {
    expected_revision: 0,
    id: 'stale-svc',
    name: '过期服务',
    kind: 'service',
    owner: '',
    description: '',
    tier: 1,
  });
  assert.equal(conflict.status, 'conflict');

  // 5. 断开环依赖回边 -> 拓扑变为无环健康态
  let rev = st1.revision;
  const delEdge = await h.action('arch.edge.delete', { expected_revision: rev, id: 'e-rsk-ord' });
  assert.equal(delEdge.status, 'deleted');
  rev = delEdge.revision;

  const st2 = await h.action('arch.state', {});
  assert.equal(st2.analysis.cycles.length, 0, '断开回边后应消除循环依赖');
  assert.equal(st2.analysis.cycle_edge_ids.length, 0);

  // 6. OpenAPI 3.0.3 与 TypeScript 实时代码生成
  const oa = await h.action('arch.codegen', { target: 'openapi' });
  assert.equal(oa.target, 'openapi');
  assert.equal(oa.endpoint_count, 7);
  const spec = JSON.parse(oa.code);
  assert.equal(spec.openapi, '3.0.3');
  assert.equal(spec.paths['/v1/orders'].post.requestBody.content['application/json'].schema.$ref, '#/components/schemas/CreateOrderReq');
  assert.ok(spec.components.schemas.OrderDTO.properties.orderId);

  const ts = await h.action('arch.codegen', { target: 'typescript' });
  assert.equal(ts.target, 'typescript');
  assert.ok(ts.code.includes('export interface CreateOrderReq'));
  assert.ok(ts.code.includes('export interface ApiContractMap'));
  assert.ok(ts.code.includes("'POST /v1/orders'"));

  // 7. Agent Tools: arch.topology 与 arch.endpoint.upsert
  const topo = await h.tool('arch.topology', {});
  assert.equal(topo.success, true);
  assert.equal(topo.status, 'ready');
  assert.equal(topo.service_count, 6);
  assert.equal(topo.cycles.length, 0);

  const badUpsert = await h.tool('arch.endpoint.upsert', {
    service_id: 'unknown-svc',
    method: 'GET',
    path: '/v1/ping',
    summary: '不存在的服务',
  });
  assert.equal(badUpsert.success, false);
  assert.equal(badUpsert.status, 'service_not_found');

  const created = await h.tool('arch.endpoint.upsert', {
    id: 'ep-risk-rules',
    service_id: 'risk-svc',
    method: 'GET',
    path: '/v1/risk/rules',
    summary: '列出当前生效风控规则',
    auth: 'mtls',
    status: 'review',
    response_schema: 'RiskDecisionDTO',
  });
  assert.equal(created.success, true);
  assert.equal(created.status, 'created');
  assert.equal(created.endpoint_id, 'ep-risk-rules');

  const updated = await h.tool('arch.endpoint.upsert', {
    id: 'ep-risk-rules',
    service_id: 'risk-svc',
    method: 'GET',
    path: '/v1/risk/rules',
    summary: '列出当前生效风控规则（已稳定）',
    auth: 'mtls',
    status: 'stable',
    response_schema: 'RiskDecisionDTO',
  });
  assert.equal(updated.success, true);
  assert.equal(updated.status, 'updated');
  rev = updated.revision;

  // 8. 删除 Schema 自动清理失效引用
  const delSc = await h.action('arch.schema.delete', { expected_revision: rev, id: 'RiskEvalReq' });
  assert.equal(delSc.status, 'deleted');
  const st3 = await h.action('arch.state', {});
  const riskEvalEp = st3.endpoints.find(ep => ep.id === 'ep-risk-eval');
  assert.equal(riskEvalEp.request_schema, '', '删除 Schema 后应清理关联接口的 request_schema');

  // 9. document.list / document.export / document.import 闭环
  const docList = await h.action('document.list', {});
  assert.ok(docList.items.some(i => i.id === 'all'));
  const exp = await h.action('document.export', { id: 'svc:risk-svc' });
  assert.equal(exp.filename, 'arch-risk-svc.json');
  const imp = await h.action('document.import', { text: exp.text });
  assert.equal(imp.imported, true);
  assert.ok(imp.services_count >= 6);

  // 10. V2 Workspace FS 同步（OpenAPI + ADR + create_only / CAS expected_sha256 / 敏感路径拦截）
  const rootList = await h.action('fs_list', { path: '' });
  assert.equal(rootList.status, 'ok');
  assert.ok(rootList.entries.some(e => e.name === 'docs' && e.kind === 'dir'));

  const expOa = await h.action('fs_export_doc', {
    target: 'openapi',
    path: 'docs/openapi.json',
    create_only: true,
  });
  assert.equal(expOa.status, 'written');
  assert.equal(expOa.sha256.length, 64);

  const dupOa = await h.action('fs_export_doc', {
    target: 'openapi',
    path: 'docs/openapi.json',
    create_only: true,
  });
  assert.equal(dupOa.status, 'conflict');

  const readOa = await h.action('fs_import_doc', { path: 'docs/openapi.json' });
  assert.equal(readOa.status, 'ok');
  assert.equal(readOa.format, 'openapi_json');
  assert.equal(readOa.sha256, expOa.sha256);

  const expAdr = await h.action('fs_export_doc', {
    target: 'adr',
    path: 'docs/adr-001.md',
    create_only: true,
  });
  assert.equal(expAdr.status, 'written');

  const casAdr = await h.action('fs_export_doc', {
    target: 'adr',
    path: 'docs/adr-001.md',
    expected_sha256: expAdr.sha256,
  });
  assert.equal(casAdr.status, 'written');

  const staleAdr = await h.action('fs_export_doc', {
    target: 'adr',
    path: 'docs/adr-001.md',
    expected_sha256: '0'.repeat(64),
  });
  assert.equal(staleAdr.status, 'conflict');

  const denied = await h.action('fs_import_doc', { path: '.env' });
  assert.equal(denied.status, 'permission_denied');
}
