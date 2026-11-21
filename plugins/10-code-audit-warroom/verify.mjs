import assert from 'node:assert/strict';

export async function verify({ createHarness }) {
  const h = await createHarness();

  // 1. 初始空态
  const emptyState = await h.action('warroom.state', {});
  assert.equal(emptyState.revision, 0);
  assert.equal(emptyState.findings.length, 0);
  assert.equal(emptyState.incidents.length, 0);
  assert.equal(emptyState.actions.length, 0);
  assert.equal(emptyState.kpis.health_score, 100);

  // 2. 一键加载「桌面端插件沙箱与网关安全审计」演示数据
  const seeded = await h.action('demo.seed', { expected_revision: 0 });
  assert.equal(seeded.status, 'seeded');
  assert.equal(seeded.findings_count, 6);
  assert.equal(seeded.incidents_count, 2);
  assert.equal(seeded.actions_count, 6);

  const st = await h.action('warroom.state', {});
  assert.equal(st.revision, seeded.revision);
  assert.equal(st.findings.length, 6);
  assert.equal(st.incidents.length, 2);
  assert.equal(st.actions.length, 6);
  assert.equal(st.kpis.open_p0_p1, 3); // SEC-001(open crit), SEC-002(mitigating crit), SEC-003(open high)
  assert.equal(st.kpis.mttr_min, 30); // (38 + 22) / 2
  assert.ok(st.kpis.health_score >= 40 && st.kpis.health_score <= 90);
  assert.ok(st.radar_scores.isolation < 85);

  // 3. CAS 冲突验证 + 新增与删除审计发现
  const conflict = await h.action('finding.save', {
    expected_revision: 0,
    id: 'NEW',
    title: '过期修订测试',
    category: 'owasp',
    dimension: 'auth',
    severity: 'low',
    impact: 1,
    likelihood: 1,
    status: 'open',
    component: 'test',
    remediation: 'none',
  });
  assert.equal(conflict.status, 'conflict');

  const addedF = await h.action('finding.save', {
    expected_revision: st.revision,
    id: 'NEW',
    title: '日志脱敏遗漏 Authorization Bearer 前缀',
    category: 'compliance',
    dimension: 'observability',
    severity: 'high',
    impact: 4,
    likelihood: 3,
    status: 'open',
    component: 'gateway-logger',
    remediation: '统一接入正则脱敏中间件并覆盖单测。',
  });
  assert.equal(addedF.status, 'saved');
  assert.equal(addedF.id, 'SEC-007');
  assert.equal(addedF.risk_score, 12);

  const delF = await h.action('finding.delete', { expected_revision: addedF.revision, id: 'SEC-007' });
  assert.equal(delF.status, 'deleted');

  // 4. 故障复盘 COE 保存与删除
  const addedInc = await h.action('incident.save', {
    expected_revision: delF.revision,
    id: 'NEW',
    title: '本地配置迁移脚本锁竞争导致冷启动延迟',
    severity: 'SEV3',
    duration_min: 12,
    status: 'closed',
    occurred_at: '2026-11-21',
    impact_summary: '少量用户冷启动耗时增加至 6 秒。',
    timeline: [
      { time: '10:01', event: '用户上报冷启动变慢' },
      { time: '10:13', event: '释放并发锁并发布热修' },
    ],
    five_whys: [
      { level: 1, question: '为什么冷启动变慢？', answer: '迁移脚本持有了全局排他文件锁。' },
      { level: 2, question: '为什么其他插件也被阻塞？', answer: '初始化阶段未按 plugin_id 分片加锁。' },
    ],
    lessons: '所有本地迁移锁必须下沉到单插件粒度。',
  });
  assert.equal(addedInc.status, 'saved');
  assert.equal(addedInc.id, 'INC-003');

  const delInc = await h.action('incident.delete', { expected_revision: addedInc.revision, id: 'INC-003' });
  assert.equal(delInc.status, 'deleted');

  // 5. 整改行动项流转
  const actSaved = await h.action('action_item.save', {
    expected_revision: delInc.revision,
    id: 'ACT-001',
    title: '在 http-broker 中禁止 3xx 自动重定向并落地私有网段 IP 拦截器',
    source_type: 'finding',
    source_id: 'SEC-001',
    owner: '林骁 (Gateway)',
    due_date: '2026-11-25',
    priority: 'P0',
    status: 'verified',
    verification_note: 'IPv4/IPv6 环回及内网段拦截均已通过压测。',
  });
  assert.equal(actSaved.status, 'saved');

  // 6. 生成 Markdown 复盘报告
  const report = await h.action('report.generate', {});
  assert.ok(report.markdown.includes('# 安全审计与故障复盘 (COE) 作战报告'));
  assert.ok(report.markdown.includes('SEC-001'));
  assert.ok(report.markdown.includes('INC-001'));

  // 7. Agent Tools: audit.finding.add & audit.summary
  const toolAdd = await h.tool('audit.finding.add', {
    title: '插件更新源未限制重定向后的目标域名一致性',
    category: 'owasp',
    dimension: 'supply_chain',
    severity: 'high',
    impact: 4,
    likelihood: 4,
    component: 'updater-client',
    remediation: '校验跳转目标严格属于白名单域名并核对 SHA-256。',
  });
  assert.equal(toolAdd.success, true);
  assert.equal(toolAdd.status, 'saved');
  assert.equal(toolAdd.id, 'SEC-007');
  assert.equal(toolAdd.risk_score, 16);

  const summary = await h.tool('audit.summary', {});
  assert.equal(summary.success, true);
  assert.equal(summary.status, 'ready');
  assert.ok(summary.high_risk_findings.some(f => f.id === 'SEC-007'));
  assert.equal(summary.incident_lessons.length, 2);

  // 8. document.list / export / import
  const list = await h.action('document.list', {});
  assert.ok(list.items.some(i => i.id === 'SNAPSHOT'));
  assert.ok(list.items.some(i => i.id === 'SEC-001'));
  assert.ok(list.items.some(i => i.id === 'INC-001'));

  const expF = await h.action('document.export', { id: 'SEC-001' });
  assert.equal(expF.filename, 'sec-001.json');
  const impF = await h.action('document.import', { text: expF.text });
  assert.equal(impF.imported, true);
  assert.ok(impF.id && impF.id !== 'SEC-001');

  const expSnap = await h.action('document.export', { id: 'SNAPSHOT' });
  assert.equal(expSnap.filename, 'audit-warroom-snapshot.json');
  assert.ok(expSnap.text.includes('velai.code-audit-warroom'));
}
