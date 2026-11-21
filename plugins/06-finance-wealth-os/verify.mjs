import assert from 'node:assert/strict';

export async function verify({ createHarness }) {
  const h = await createHarness();

  // 1. 初始空快照
  const empty = await h.action('finance.snapshot', {});
  assert.equal(empty.revision, 0);
  assert.equal(empty.accounts.length, 0);
  assert.equal(empty.summary.net_worth, 0);

  // 2. 加载完整演示数据集 + CAS 冲突校验
  const badSeed = await h.action('finance.demo.seed', { expected_revision: 42 });
  assert.equal(badSeed.status, 'conflict');

  const seeded = await h.action('finance.demo.seed', { expected_revision: 0 });
  assert.equal(seeded.status, 'seeded');
  assert.deepEqual(seeded.counts, { accounts: 6, ledger: 14, goals: 6 });

  const snap = await h.action('finance.snapshot', {});
  assert.equal(snap.accounts.length, 6);
  assert.equal(snap.ledger.length, 14);
  assert.equal(snap.goals.length, 6);
  assert.equal(snap.summary.total_assets, 4300000);
  assert.equal(snap.summary.total_liabilities, 1180000);
  assert.equal(snap.summary.net_worth, 3120000);
  assert.ok(snap.summary.savings_rate > 50);
  assert.ok(snap.summary.over_budget_count >= 1);
  assert.ok(snap.summary.warn_budget_count >= 1);
  assert.equal(snap.trend.length, 6);

  // 3. 记账同步更新账户余额 + 保存 CFO 诊断备忘
  const beforeCash = snap.accounts.find(a => a.id === 'fin-cash').balance;
  const txRes = await h.action('finance.tx.save', {
    expected_revision: snap.revision,
    id: 'tx-verify-1',
    date: `${snap.month}-19`,
    type: 'expense',
    category: 'food',
    amount: 500,
    account_id: 'fin-cash',
    target_account_id: '',
    note: '自动化测试餐饮支出',
    sync_balance: true,
  });
  assert.equal(txRes.status, 'saved');

  const afterSnap = await h.action('finance.snapshot', {});
  assert.equal(afterSnap.accounts.find(a => a.id === 'fin-cash').balance, beforeCash - 500);

  const memoRes = await h.action('finance.cfo.memo', {
    expected_revision: afterSnap.revision,
    memo: '建议将现金超额部分分批配置到沪深300与标普500宽基 ETF，控制购物预算在 4000 元以内。',
  });
  assert.equal(memoRes.status, 'saved');

  // 4. FIRE 复利引擎 & 房贷省息引擎精确校验
  const simTerm = await h.action('finance.simulate', {
    current_net_worth: 1700000,
    monthly_invest: 18000,
    expected_return: 8,
    inflation: 2.5,
    annual_expense: 220000,
    swr: 4,
    years: 20,
    mortgage: {
      principal: 1500000,
      annual_rate: 3.45,
      total_years: 30,
      paid_months: 60,
      prepay_amount: 300000,
      mode: 'reduce_term',
    },
  });
  assert.equal(simTerm.fire_target, 5500000);
  assert.equal(simTerm.series.length, 21);
  assert.ok(simTerm.scenarios.conservative.final_real < simTerm.scenarios.base.final_real);
  assert.ok(simTerm.scenarios.base.final_real < simTerm.scenarios.optimistic.final_real);
  assert.ok(simTerm.scenarios.base.years_to_fire > 0 && simTerm.scenarios.base.years_to_fire <= 20);
  assert.ok(simTerm.mortgage_result.interest_saved > 100000);
  assert.ok(simTerm.mortgage_result.months_saved > 50);

  const simPay = await h.action('finance.simulate', {
    current_net_worth: 1700000,
    monthly_invest: 18000,
    expected_return: 8,
    inflation: 2.5,
    annual_expense: 220000,
    swr: 4,
    years: 20,
    mortgage: {
      principal: 1500000,
      annual_rate: 3.45,
      total_years: 30,
      paid_months: 60,
      prepay_amount: 300000,
      mode: 'reduce_payment',
    },
  });
  assert.equal(simPay.mortgage_result.months_saved, 0);
  assert.ok(simPay.mortgage_result.new_monthly < simPay.mortgage_result.original_monthly);
  assert.ok(simTerm.mortgage_result.interest_saved > simPay.mortgage_result.interest_saved);

  // 5. 测试 2 个 Agent Tools
  const sumTool = await h.tool('finance.summary', {});
  assert.equal(sumTool.success, true);
  assert.equal(sumTool.status, 'ready');
  assert.ok(sumTool.budget_alerts.length >= 5);

  const addTool = await h.tool('finance.tx.add', {
    type: 'expense',
    category: 'food',
    amount: 350,
    account_name: '招商',
    note: '朋友聚餐 AA',
  });
  assert.equal(addTool.success, true);
  assert.equal(addTool.status, 'recorded');
  assert.equal(addTool.budget_level, 'over');
  assert.ok(addTool.budget_ratio > 95);

  // 6. document.list / document.export / document.import 闭环
  const docList = await h.action('document.list', {});
  assert.ok(docList.items.some(i => i.id === 'all'));

  const exp = await h.action('document.export', { id: 'all' });
  assert.ok(exp.filename.endsWith('.json'));
  assert.ok(exp.text.length > 100);

  const h2 = await createHarness();
  const imp = await h2.action('document.import', { text: exp.text });
  assert.equal(imp.imported, true);
  const snap2 = await h2.action('finance.snapshot', {});
  assert.equal(snap2.accounts.length, 6);
  assert.equal(snap2.ledger.length, 16);
  assert.equal(snap2.goals.length, 6);
}
