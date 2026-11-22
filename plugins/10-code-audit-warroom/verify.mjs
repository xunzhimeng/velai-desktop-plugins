import assert from 'node:assert/strict';

export async function verify({ createHarness }) {
  const vulnerableSample = [
    'import crypto from "node:crypto";',
    'const api_key = "sk-live_9f8e7d6c5b4a3210abcd";',
    'export function runExpr(expr) {',
    '  return eval(expr);',
    '}',
    'export function queryUser(db, userId) {',
    '  return db.query(`SELECT * FROM users WHERE id = ${userId}`);',
    '}',
    'export function RenderHtml({ html }) {',
    '  return { dangerouslySetInnerHTML: { __html: html } };',
    '}',
    'export const digest = s => crypto.createHash("md5").update(s).digest("hex");',
  ].join('\n');

  const safeSample = [
    'export function add(a, b) {',
    '  return a + b;',
    '}',
  ].join('\n');

  const h = await createHarness({
    fsInitial: {
      'src/vulnerable.js': vulnerableSample,
      'src/safe.js': safeSample,
    },
  });

  // 1. 初始空态
  const emptyState = await h.action('warroom.state', {});
  assert.equal(emptyState.revision, 0);
  assert.equal(emptyState.findings.length, 0);
  assert.equal(emptyState.incidents.length, 0);
  assert.equal(emptyState.actions.length, 0);
  assert.equal(emptyState.kpis.health_score, 100);

  // 2. 一键加载演示数据
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
  assert.equal(st.kpis.open_p0_p1, 3);
  assert.equal(st.kpis.mttr_min, 30);
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

  // 7. 只读工作区 FS 浏览与内置静态安全规则扫描
  const fsRoot = await h.action('audit.fs_list', { path: '' });
  assert.ok(fsRoot.entries.some(e => e.name === 'src' && e.kind === 'dir'));

  const fsSrc = await h.action('audit.fs_list', { path: 'src' });
  assert.ok(fsSrc.entries.some(e => e.name === 'vulnerable.js' && e.kind === 'file'));

  const scanVuln = await h.action('audit.fs_scan_file', { path: 'src/vulnerable.js' });
  assert.equal(scanVuln.status, 'scanned');
  assert.match(scanVuln.sha256, /^[0-9a-f]{64}$/);
  assert.equal(scanVuln.line_count, 12);
  const hitRules = new Set(scanVuln.candidates.map(c => c.rule_id));
  assert.ok(hitRules.has('hardcoded-secret'), '应检出硬编码密钥');
  assert.ok(hitRules.has('dynamic-code-exec'), '应检出 eval');
  assert.ok(hitRules.has('sql-concat'), '应检出 SQL 模板拼接');
  assert.ok(hitRules.has('unsafe-dom-xss'), '应检出 dangerouslySetInnerHTML');
  assert.ok(hitRules.has('weak-crypto'), '应检出 MD5 弱哈希');
  const evalHit = scanVuln.candidates.find(c => c.rule_id === 'dynamic-code-exec');
  assert.equal(evalHit.line, 4);

  const scanSafe = await h.action('audit.fs_scan_file', { path: 'src/safe.js' });
  assert.equal(scanSafe.status, 'scanned');
  assert.equal(scanSafe.candidates.length, 0);

  const scanDir = await h.action('audit.fs_scan_file', { path: 'src' });
  assert.equal(scanDir.status, 'not_a_file');

  // 8. 敏感路径 .env / .git 负向拒绝测试
  await assert.rejects(
    () => h.action('audit.fs_list', { path: '.git' }),
    err => err.code === 'permission_denied',
  );
  await assert.rejects(
    () => h.action('audit.fs_scan_file', { path: '.env' }),
    err => err.code === 'permission_denied',
  );
  await assert.rejects(
    () => h.action('audit.fs_scan_file', { path: '.git/config' }),
    err => err.code === 'permission_denied',
  );

  // 9. 3 个 v2 Agent Tools: audit.read_project_file, audit.log_finding, audit.get_warroom_summary
  const readProj = await h.tool('audit.read_project_file', {
    path: 'src/vulnerable.js',
    start_line: 1,
    end_line: 8,
    run_scan: true,
  });
  assert.equal(readProj.success, true);
  assert.equal(readProj.status, 'ready');
  assert.equal(readProj.total_lines, 12);
  assert.ok(readProj.candidates.some(c => c.rule_id === 'dynamic-code-exec'));

  const readEnvDenied = await h.tool('audit.read_project_file', { path: '.env' });
  assert.equal(readEnvDenied.success, false);
  assert.equal(readEnvDenied.status, 'permission_denied');

  const readGitDenied = await h.tool('audit.read_project_file', { path: '.git/HEAD' });
  assert.equal(readGitDenied.success, false);
  assert.equal(readGitDenied.status, 'permission_denied');

  const toolAdd = await h.tool('audit.log_finding', {
    title: '动态 eval 执行外部表达式存在任意代码执行风险',
    category: 'owasp',
    dimension: 'validation',
    severity: 'critical',
    impact: 5,
    likelihood: 4,
    component: 'src/vulnerable.js:L4',
    remediation: '移除 eval 调用，改用显式白名单表达式求值器。',
  });
  assert.equal(toolAdd.success, true);
  assert.equal(toolAdd.status, 'saved');
  assert.equal(toolAdd.id, 'SEC-007');
  assert.equal(toolAdd.risk_score, 20);

  const summary = await h.tool('audit.get_warroom_summary', {});
  assert.equal(summary.success, true);
  assert.equal(summary.status, 'ready');
  assert.ok(summary.high_risk_findings.some(f => f.id === 'SEC-007'));
  assert.equal(summary.incident_lessons.length, 2);

  // 10. document.list / export / import 回归
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
