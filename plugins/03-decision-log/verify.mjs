import assert from 'node:assert/strict';

export async function verify({ createHarness }) {
  const h = await createHarness();
  const r1 = await h.action('adr.save', {
    expected_revision: 0,
    id: 'NEW',
    title: '采用单文件归档分发插件',
    status: 'accepted',
    context: '需要跨平台离线校验完整性',
    decision: '使用 canonical JSON .nmas-plugin 归档并绑定 SHA-256',
    consequences: '无解压路径穿越风险，但单包上限 1 MiB',
  });
  assert.equal(r1.status, 'saved');
  assert.equal(r1.id, 'ADR-001');

  const r2 = await h.tool('decision.record', {
    title: 'HTTP 访问仅允许静态 GET 规则',
    status: 'accepted',
    decision: '插件仅通过 rule 索引发起只读公开 JSON 请求',
  });
  assert.equal(r2.success, true);
  assert.equal(r2.id, 'ADR-002');

  const found = await h.tool('decision.list', { keyword: 'SHA-256' });
  assert.equal(found.success, true);
  assert.equal(found.records.length, 1);
  assert.equal(found.records[0].id, 'ADR-001');

  const exp = await h.action('document.export', { id: 'ADR-001' });
  assert.equal(exp.filename, 'adr-001.json');
  const imp = await h.action('document.import', { text: exp.text });
  assert.equal(imp.imported, true);
}
