import assert from 'node:assert/strict';

export async function verify({ createHarness }) {
  const h = await createHarness({
    settingsMock: { default_currency: 'USD', follow_up_days: 5 },
  });

  // 1. 初始空快照 + V2 settings 读取
  const empty = await h.action('crm.snapshot', {});
  assert.equal(empty.revision, 0);
  assert.equal(empty.accounts.length, 0);
  assert.equal(empty.metrics.active_pipeline, 0);
  assert.equal(empty.settings.default_currency, 'USD');
  assert.equal(empty.settings.follow_up_days, 5);

  // 2. 加载完整 B2B SaaS 演示数据集 + 校验 CAS 冲突
  const badSeed = await h.action('crm.demo.seed', { expected_revision: 99 });
  assert.equal(badSeed.status, 'conflict');

  const seeded = await h.action('crm.demo.seed', { expected_revision: 0 });
  assert.equal(seeded.status, 'seeded');
  assert.deepEqual(seeded.counts, { accounts: 5, deals: 7, activities: 10 });

  const snap = await h.action('crm.snapshot', {});
  assert.equal(snap.accounts.length, 5);
  assert.equal(snap.deals.length, 7);
  assert.equal(snap.activities.length, 10);
  assert.ok(snap.metrics.active_pipeline > 0);
  assert.ok(snap.metrics.weighted_forecast > 0);
  assert.equal(snap.metrics.won_amount, 540000);
  assert.ok(snap.metrics.overdue_count >= 2);
  assert.ok(snap.metrics.due_soon_count >= 2);

  // 3. 商机阶段一键推进 & 赢率联动
  const staged = await h.action('crm.deal.stage', {
    expected_revision: snap.revision,
    id: 'deal-aurora-ops',
    stage: 'negotiation',
  });
  assert.equal(staged.status, 'saved');
  assert.equal(staged.stage, 'negotiation');
  assert.equal(staged.probability, 80);

  // 4. 新增客户与商机
  const savedAcc = await h.action('crm.account.save', {
    expected_revision: staged.revision,
    id: 'acc-quantum',
    name: '量子智算网络',
    industry: '云计算',
    size: 'enterprise',
    health: 90,
    contact_name: '赵启明',
    contact_role: '副总裁',
    annual_potential: 1500000,
    tags: ['战略大客', 'GPU 集群'],
    risk_note: '高意向推进中',
  });
  assert.equal(savedAcc.status, 'saved');

  const savedDeal = await h.action('crm.deal.save', {
    expected_revision: savedAcc.revision,
    id: 'deal-quantum-1',
    account_id: 'acc-quantum',
    title: '量子算力调度平台年框',
    stage: 'proposal',
    amount: 800000,
    probability: 65,
    close_date: '2026-12-20',
    owner: '张锐',
    next_step: '安排架构师答疑',
    loss_reason: '',
  });
  assert.equal(savedDeal.status, 'saved');

  // 5. 测试 3 个 Agent Tools
  const pipeTool = await h.tool('crm.pipeline', {});
  assert.equal(pipeTool.success, true);
  assert.equal(pipeTool.status, 'ready');
  assert.equal(pipeTool.stages.length, 6);
  assert.ok(pipeTool.top_deals.length >= 5);

  const accTool = await h.tool('crm.account.get', { name: '量子智算' });
  assert.equal(accTool.success, true);
  assert.equal(accTool.status, 'found');
  assert.equal(accTool.account.id, 'acc-quantum');
  assert.equal(accTool.account.total_deal_amount, 800000);

  const logTool = await h.tool('crm.activity.log', {
    account_name: '星云智造',
    deal_id: 'deal-nebula-ai',
    type: 'call',
    summary: '确认法务终版合同无实质异议，下周二签章。',
    next_action: '发送正式签章版 PDF',
    next_due: '2026-11-28',
  });
  assert.equal(logTool.success, true);
  assert.equal(logTool.status, 'logged');
  assert.equal(logTool.account_name, '星云智造科技');

  // 6. document.list / document.export / document.import 闭环
  const docList = await h.action('document.list', {});
  assert.ok(docList.items.some(i => i.id === 'all'));
  assert.ok(docList.items.some(i => i.id === 'acc-quantum'));

  const exportedAll = await h.action('document.export', { id: 'all' });
  assert.ok(exportedAll.filename.endsWith('.json'));
  assert.ok(exportedAll.text.length > 100);

  const h2 = await createHarness();
  const imported = await h2.action('document.import', { text: exportedAll.text });
  assert.equal(imported.imported, true);
  const snap2 = await h2.action('crm.snapshot', {});
  assert.equal(snap2.accounts.length, 6);
  assert.equal(snap2.deals.length, 8);
  assert.equal(snap2.activities.length, 11);

  // 7. 删除客户并验证级联清理关联商机
  const latestRev = h.getRevision();
  const delAcc = await h.action('crm.account.delete', {
    expected_revision: latestRev,
    id: 'acc-quantum',
  });
  assert.equal(delAcc.status, 'deleted');
  const afterDel = await h.tool('crm.account.get', { name: '量子智算' });
  assert.equal(afterDel.success, false);
  assert.equal(afterDel.status, 'not_found');

  // 8. V2 nmas.data.delete & nmas.data.list 清理与列举验证
  const h3 = await createHarness();
  const s1 = await h3.action('crm.account.save', {
    expected_revision: 0,
    id: 'acc-only',
    name: '独苗测试客户',
    industry: '软件',
    size: 'smb',
    health: 80,
    contact_name: '林测试',
    contact_role: 'VP',
    annual_potential: 100000,
    tags: [],
    risk_note: '',
  });
  assert.equal(s1.status, 'saved');
  const d1 = await h3.action('crm.account.delete', { expected_revision: s1.revision, id: 'acc-only' });
  assert.equal(d1.status, 'deleted');
  const listEmpty = await h3.action('document.list', {});
  assert.equal(listEmpty.items.length, 1);
  assert.equal(listEmpty.items[0].id, 'all');
}
