import assert from 'node:assert/strict';

export async function verify({ createHarness }) {
  const h = await createHarness({
    settingsMock: { brand_voice: '犀利硬核', weekly_publish_goal: 5 },
  });

  // 1. 初始空态驾驶舱 + V2 settings 读取
  const emptyDash = await h.action('growth.dashboard', {});
  assert.equal(emptyDash.revision, 0);
  assert.equal(emptyDash.calendar.length, 0);
  assert.equal(emptyDash.drafts.length, 0);
  assert.equal(emptyDash.periods.length, 0);
  assert.equal(emptyDash.settings.brand_voice, '犀利硬核');
  assert.equal(emptyDash.settings.weekly_publish_goal, 5);

  // 2. 一键加载 AI 开发者 IP 内容矩阵演示数据
  const seeded = await h.action('demo.seed', { expected_revision: 0 });
  assert.equal(seeded.status, 'seeded');
  assert.equal(seeded.calendar_count, 6);
  assert.equal(seeded.drafts_count, 3);
  assert.equal(seeded.periods_count, 6);

  const dash = await h.action('growth.dashboard', {});
  assert.equal(dash.revision, seeded.revision);
  assert.equal(dash.calendar.length, 6);
  assert.equal(dash.drafts.length, 3);
  assert.equal(dash.periods.length, 6);
  assert.ok(dash.kpis.total_views > 150000);
  assert.ok(dash.kpis.avg_engagement_rate > 5);
  assert.equal(dash.channel_totals.length, 6);

  // 3. 实时标题与可读性诊断仪（中英文与高/低分对比）
  const strongDiag = await h.action('draft.diagnose', {
    title: '为什么 90% 的 AI 插件都死在沙箱安全？6 条桌面端实战避坑指南',
    body: '## 1. 背景\n\n第一段概述。\n\n- 要点一\n- 要点二\n\n## 2. 结语\n\n落地总结。',
  });
  const weakDiag = await h.action('draft.diagnose', {
    title: '周报更新',
    body: '今天写了一些代码。',
  });
  assert.ok(strongDiag.score >= 85, `强标题期望 >= 85，实际 ${strongDiag.score}`);
  assert.equal(strongDiag.grade, 'S');
  assert.ok(weakDiag.score < 55, `弱标题期望 < 55，实际 ${weakDiag.score}`);
  assert.ok(weakDiag.suggestions.length >= 2);

  // 4. CAS 乐观锁冲突验证 + 排期新建/流转/删除
  const conflictRes = await h.action('calendar.move', {
    expected_revision: 0,
    id: 'cnt-005',
    stage: 'drafting',
  });
  assert.equal(conflictRes.status, 'conflict');

  const moved = await h.action('calendar.move', {
    expected_revision: dash.revision,
    id: 'cnt-005',
    stage: 'drafting',
  });
  assert.equal(moved.status, 'saved');

  const savedCard = await h.action('calendar.save', {
    expected_revision: moved.revision,
    id: 'NEW',
    title: 'How to Build a 10x Faster Local-First AI Workflow: 5 Benchmarks',
    stage: 'idea',
    channels: ['x', 'youtube'],
    publish_date: '2026-12-08',
    hook: 'Real telemetry from 30 days of local-first agent benchmarks.',
    tags: ['EN', 'Benchmark'],
  });
  assert.equal(savedCard.status, 'saved');
  assert.ok(savedCard.id.startsWith('cnt-'));
  assert.ok(savedCard.viral_score >= 70);

  const deletedCard = await h.action('calendar.delete', {
    expected_revision: savedCard.revision,
    id: savedCard.id,
  });
  assert.equal(deletedCard.status, 'deleted');

  // 5. 主稿读取与一稿多改衍生稿保存
  const readDrf = await h.action('draft.read', { id: 'drf-001' });
  assert.equal(readDrf.found, true);
  assert.equal(readDrf.draft.variants.length, 2);

  const savedVar = await h.action('draft.variant.save', {
    expected_revision: deletedCard.revision,
    draft_id: 'drf-001',
    mode: 'zhihu',
    content: '谢邀。过去半年审计了 40 多个 AI 插件原型，核心结论只有一条：没有最小权限边界的 Agent 扩展迟早会出事故。',
  });
  assert.equal(savedVar.status, 'saved');
  assert.equal(savedVar.variants_count, 3);

  // 6. 录入一期复盘指标
  const recMetric = await h.action('metrics.record', {
    expected_revision: savedVar.revision,
    period: 'W48',
    label: '11/25',
    published_count: 4,
    engagements: 4500,
    by_channel: { wechat: 14000, xiaohongshu: 16000, zhihu: 9000, x: 7500, youtube: 4000, bilibili: 5000 },
  });
  assert.equal(recMetric.status, 'saved');

  // 7. Agent Tools: content.draft.save & content.pipeline
  const toolSave = await h.tool('content.draft.save', {
    title: '7 个让 Agent 工具调用零幻觉的 Schema 契约实战清单',
    primary_channel: 'wechat',
    stage: 'scheduled',
    publish_date: '2026-11-30',
    hook: '把不确定性拦在边界之外的 7 条工程铁律。',
    body: '## 1. 强类型约束\n\n所有入参与出参严格校验。\n\n- 禁用宽泛 object\n- 必填 status 枚举',
  });
  assert.equal(toolSave.success, true);
  assert.equal(toolSave.status, 'saved');
  assert.ok(toolSave.headline_score >= 70);

  const pipe = await h.tool('content.pipeline', { stage: 'scheduled', channel: 'wechat' });
  assert.equal(pipe.success, true);
  assert.equal(pipe.status, 'ready');
  assert.ok(pipe.items.some(i => i.draft_id === toolSave.id));
  assert.equal(pipe.channel_totals.length, 6);

  // 8. document.list / export / import
  const docList = await h.action('document.list', {});
  assert.ok(docList.items.some(i => i.id === 'CALENDAR'));
  assert.ok(docList.items.some(i => i.id === 'drf-001'));

  const expDraft = await h.action('document.export', { id: 'drf-001' });
  assert.equal(expDraft.filename, 'drf-001.json');
  assert.ok(expDraft.text.includes('velai.content-growth-os'));

  const impDraft = await h.action('document.import', { text: expDraft.text });
  assert.equal(impDraft.imported, true);
  assert.ok(impDraft.id && impDraft.id !== 'drf-001');

  // 9. V2 nmas.data.delete（draft.delete）& nmas.data.list（document.list）验证
  const beforeDel = await h.action('growth.dashboard', {});
  const delDraft = await h.action('draft.delete', { expected_revision: beforeDel.revision, id: impDraft.id });
  assert.equal(delDraft.status, 'deleted');
  const readGone = await h.action('draft.read', { id: impDraft.id });
  assert.equal(readGone.found, false);
  const docListAfter = await h.action('document.list', {});
  assert.equal(docListAfter.items.some(i => i.id === impDraft.id), false);
}
