const COL_ACCOUNTS = 'accounts';
const COL_LEDGER = 'ledger';
const COL_GOALS = 'goals';
const KEY_LIST = 'list';
const DOC_FORMAT = 'velai-finance-wealth-os';

const MAX_RECORD_BYTES = 240 * 1024;
const MAX_ACCOUNTS = 64;
const MAX_LEDGER = 500;
const MAX_GOALS = 48;

const ACC_KINDS = ['asset', 'liability'];
const ASSET_CLASSES = ['cash', 'equity', 'fund', 'real_estate', 'fixed_income', 'debt', 'other'];
const TX_TYPES = ['income', 'expense', 'transfer'];
const TX_CATS = [
  'salary', 'bonus', 'dividend', 'housing', 'food', 'transport',
  'health', 'shopping', 'education', 'entertainment', 'travel', 'invest', 'other',
];
const GOAL_KINDS = ['budget', 'target'];

function jsonBytes(v) {
  let b = 0;
  for (const ch of JSON.stringify(v)) {
    const cp = ch.codePointAt(0);
    b += cp <= 0x7f ? 1 : cp <= 0x7ff ? 2 : cp <= 0xffff ? 3 : 4;
  }
  return b;
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function monthStr(offsetMonths = 0) {
  const now = new Date();
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offsetMonths, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function isDate(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function isMonth(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}$/.test(s);
}

function validId(s) {
  return typeof s === 'string' && s.length >= 1 && s.length <= 48 && /^[a-zA-Z0-9._-]+$/.test(s);
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function makeId(prefix) {
  const rand = Math.floor(Math.random() * 0xffffff).toString(36).padStart(4, '0');
  return `${prefix}-${Date.now().toString(36)}-${rand}`.slice(0, 48);
}

async function readAccounts() {
  const receipt = await globalThis.nmas.data.read({ collection: COL_ACCOUNTS, key: KEY_LIST });
  const doc = receipt.value === null ? { schema_version: 1, items: [] } : receipt.value;
  if (!doc || doc.schema_version !== 1 || !Array.isArray(doc.items)) throw new Error('accounts 数据格式无效');
  return { revision: receipt.revision, items: doc.items };
}

async function readLedger() {
  const receipt = await globalThis.nmas.data.read({ collection: COL_LEDGER, key: KEY_LIST });
  const doc = receipt.value === null ? { schema_version: 1, items: [] } : receipt.value;
  if (!doc || doc.schema_version !== 1 || !Array.isArray(doc.items)) throw new Error('ledger 数据格式无效');
  return { revision: receipt.revision, items: doc.items };
}

async function readGoalsDoc() {
  const receipt = await globalThis.nmas.data.read({ collection: COL_GOALS, key: KEY_LIST });
  const doc = receipt.value === null
    ? { schema_version: 1, items: [], snapshots: [], cfo_memo: '' }
    : receipt.value;
  if (!doc || doc.schema_version !== 1 || !Array.isArray(doc.items)) throw new Error('goals 数据格式无效');
  return {
    revision: receipt.revision,
    items: doc.items,
    snapshots: Array.isArray(doc.snapshots) ? doc.snapshots : [],
    cfo_memo: typeof doc.cfo_memo === 'string' ? doc.cfo_memo : '',
  };
}

async function readAll() {
  const acc = await readAccounts();
  const led = await readLedger();
  const goalDoc = await readGoalsDoc();
  return {
    revision: Math.max(acc.revision, led.revision, goalDoc.revision),
    accounts: acc.items,
    ledger: led.items,
    goals: goalDoc.items,
    snapshots: goalDoc.snapshots,
    cfo_memo: goalDoc.cfo_memo,
  };
}

async function writeDoc(collection, expectedRevision, value) {
  if (jsonBytes(value) > MAX_RECORD_BYTES) return { status: 'limit', revision: expectedRevision };
  try {
    const receipt = await globalThis.nmas.data.write({
      collection,
      key: KEY_LIST,
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

async function readPluginSettings() {
  const raw = await globalThis.nmas.settings.get();
  const base_currency = typeof raw?.base_currency === 'string' && /^[A-Z]{3,8}$/.test(raw.base_currency.trim().toUpperCase())
    ? raw.base_currency.trim().toUpperCase()
    : 'CNY';
  const pct = Number.isInteger(raw?.target_savings_pct) ? raw.target_savings_pct : 30;
  const target_savings_pct = Math.max(1, Math.min(95, pct));
  return { base_currency, target_savings_pct };
}

function sanitizeAccount(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.id || '').trim();
  const name = String(raw.name || '').trim();
  const kind = String(raw.kind || '').trim();
  const assetClass = String(raw.asset_class || '').trim();
  const balance = Number(raw.balance);
  const apy = Number(raw.apy);
  const institution = String(raw.institution || '').trim().slice(0, 36);
  const note = String(raw.note || '').trim().slice(0, 120);
  const updatedAt = isDate(raw.updated_at) ? raw.updated_at : todayStr();

  if (
    !validId(id) ||
    !name ||
    name.length > 48 ||
    !ACC_KINDS.includes(kind) ||
    !ASSET_CLASSES.includes(assetClass) ||
    !Number.isFinite(balance) ||
    balance < 0 ||
    balance > 999999999 ||
    !Number.isFinite(apy) ||
    apy < -50 ||
    apy > 100
  ) {
    return null;
  }
  return {
    id,
    name,
    kind,
    asset_class: kind === 'liability' ? 'debt' : assetClass,
    balance: round2(balance),
    apy: round2(apy),
    institution,
    note,
    updated_at: updatedAt,
  };
}

function sanitizeTx(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.id || '').trim();
  const date = String(raw.date || '').trim();
  const type = String(raw.type || '').trim();
  const category = String(raw.category || '').trim();
  const amount = Number(raw.amount);
  const accountId = String(raw.account_id || '').trim();
  const targetAccountId = String(raw.target_account_id || '').trim();
  const note = String(raw.note || '').trim().slice(0, 100);

  if (
    !validId(id) ||
    !isDate(date) ||
    !TX_TYPES.includes(type) ||
    !TX_CATS.includes(category) ||
    !Number.isFinite(amount) ||
    amount < 0.01 ||
    amount > 99999999 ||
    !validId(accountId) ||
    (targetAccountId && !validId(targetAccountId))
  ) {
    return null;
  }
  return {
    id,
    date,
    type,
    category,
    amount: round2(amount),
    account_id: accountId,
    target_account_id: type === 'transfer' ? targetAccountId : '',
    note,
  };
}

function sanitizeGoal(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.id || '').trim();
  const kind = String(raw.kind || '').trim();
  const category = String(raw.category || '').trim().slice(0, 32);
  const label = String(raw.label || '').trim().slice(0, 48);
  const monthlyLimit = Number(raw.monthly_limit);
  const currentSaved = Number(raw.current_saved ?? 0);
  const targetDate = String(raw.target_date || '').trim();

  if (
    !validId(id) ||
    !GOAL_KINDS.includes(kind) ||
    !category ||
    !label ||
    !Number.isFinite(monthlyLimit) ||
    monthlyLimit < 1 ||
    monthlyLimit > 999999999 ||
    !Number.isFinite(currentSaved) ||
    currentSaved < 0 ||
    currentSaved > 999999999 ||
    (targetDate && !isDate(targetDate))
  ) {
    return null;
  }
  return {
    id,
    kind,
    category,
    label,
    monthly_limit: round2(monthlyLimit),
    current_saved: round2(currentSaved),
    target_date: targetDate,
  };
}

function budgetLevel(ratio) {
  if (ratio > 95) return 'over';
  if (ratio >= 75) return 'warn';
  return 'ok';
}

function computeAnalytics(state, targetMonth) {
  const month = isMonth(targetMonth) ? targetMonth : monthStr(0);

  let totalAssets = 0;
  let totalLiabilities = 0;
  const classTotals = {
    cash: 0,
    equity: 0,
    fund: 0,
    real_estate: 0,
    fixed_income: 0,
    other: 0,
  };

  for (const a of state.accounts) {
    const bal = Number(a.balance) || 0;
    if (a.kind === 'liability') {
      totalLiabilities = round2(totalLiabilities + bal);
    } else {
      totalAssets = round2(totalAssets + bal);
      const cls = Object.prototype.hasOwnProperty.call(classTotals, a.asset_class) ? a.asset_class : 'other';
      classTotals[cls] = round2(classTotals[cls] + bal);
    }
  }

  const netWorth = round2(totalAssets - totalLiabilities);
  const debtRatio = totalAssets > 0 ? round2((totalLiabilities / totalAssets) * 100) : 0;

  const allocation = Object.entries(classTotals)
    .filter(([, amt]) => amt > 0)
    .map(([asset_class, amount]) => ({
      asset_class,
      amount,
      share: totalAssets > 0 ? round2((amount / totalAssets) * 100) : 0,
    }))
    .sort((a, b) => b.amount - a.amount);

  let monthlyIncome = 0;
  let monthlyExpense = 0;
  const catExpense = {};

  for (const tx of state.ledger) {
    if (!tx.date.startsWith(month)) continue;
    const amt = Number(tx.amount) || 0;
    if (tx.type === 'income') {
      monthlyIncome = round2(monthlyIncome + amt);
    } else if (tx.type === 'expense') {
      monthlyExpense = round2(monthlyExpense + amt);
      catExpense[tx.category] = round2((catExpense[tx.category] || 0) + amt);
    }
  }

  const monthlySurplus = round2(monthlyIncome - monthlyExpense);
  const savingsRate = monthlyIncome > 0 ? round2((monthlySurplus / monthlyIncome) * 100) : 0;

  let overBudgetCount = 0;
  let warnBudgetCount = 0;
  const budgets = state.goals
    .filter(g => g.kind === 'budget')
    .map(g => {
      const spent = round2(catExpense[g.category] || 0);
      const ratio = round2((spent / g.monthly_limit) * 100);
      const level = budgetLevel(ratio);
      if (level === 'over') overBudgetCount += 1;
      else if (level === 'warn') warnBudgetCount += 1;
      return {
        id: g.id,
        category: g.category,
        label: g.label,
        limit: g.monthly_limit,
        spent,
        ratio,
        level,
      };
    })
    .sort((a, b) => b.ratio - a.ratio);

  const topExpenses = Object.entries(catExpense)
    .map(([category, amount]) => ({
      category,
      amount,
      share: monthlyExpense > 0 ? round2((amount / monthlyExpense) * 100) : 0,
    }))
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 6);

  // Merge historical snapshots with current month live metrics
  const snapMap = new Map();
  for (const s of state.snapshots) {
    if (isMonth(s.month)) {
      snapMap.set(s.month, {
        month: s.month,
        net_worth: round2(Number(s.net_worth) || 0),
        income: round2(Math.max(0, Number(s.income) || 0)),
        expense: round2(Math.max(0, Number(s.expense) || 0)),
      });
    }
  }
  snapMap.set(month, {
    month,
    net_worth: netWorth,
    income: monthlyIncome,
    expense: monthlyExpense,
  });
  const trend = Array.from(snapMap.values())
    .sort((a, b) => a.month.localeCompare(b.month))
    .slice(-6);

  return {
    month,
    summary: {
      total_assets: totalAssets,
      total_liabilities: totalLiabilities,
      net_worth: netWorth,
      debt_ratio: debtRatio,
      monthly_income: monthlyIncome,
      monthly_expense: monthlyExpense,
      monthly_surplus: monthlySurplus,
      savings_rate: savingsRate,
      over_budget_count: overBudgetCount,
      warn_budget_count: warnBudgetCount,
    },
    allocation,
    budgets,
    top_expenses: topExpenses,
    trend,
  };
}

function runFireScenario(startNw, monthlyInvest, nominalRatePct, inflationPct, fireTarget, horizonYears) {
  const nom = nominalRatePct / 100;
  const inf = inflationPct / 100;
  const realAnnual = (1 + nom) / (1 + inf) - 1;
  const realMonthly = Math.pow(1 + realAnnual, 1 / 12) - 1;

  const yearlyValues = [round2(startNw)];
  let bal = startNw;
  let yearsToFire = startNw >= fireTarget ? 0 : -1;
  const maxSimYears = Math.max(horizonYears, 80);

  for (let y = 1; y <= maxSimYears; y++) {
    for (let m = 0; m < 12; m++) {
      bal = bal * (1 + realMonthly) + monthlyInvest;
    }
    if (yearsToFire === -1 && bal >= fireTarget) {
      yearsToFire = y;
    }
    if (y <= horizonYears) {
      yearlyValues.push(round2(bal));
    }
  }

  const startYear = new Date().getUTCFullYear();
  return {
    rate: round2(nominalRatePct),
    real_rate: round2(realAnnual * 100),
    final_real: yearlyValues[horizonYears],
    fire_year: yearsToFire >= 0 ? startYear + yearsToFire : 0,
    years_to_fire: yearsToFire,
    yearlyValues,
  };
}

function computeMortgage(m) {
  const P = Number(m.principal);
  const r = Number(m.annual_rate) / 100 / 12;
  const totalMonths = Number(m.total_years) * 12;
  const paid = Math.min(Number(m.paid_months), totalMonths - 1);
  const remainMonths = Math.max(1, totalMonths - paid);
  const powN = Math.pow(1 + r, totalMonths);
  const powK = Math.pow(1 + r, paid);

  const origMonthly = (P * r * powN) / (powN - 1);
  const remPrincipal = paid === 0 ? P : (P * (powN - powK)) / (powN - 1);
  const origRemInterest = Math.max(0, origMonthly * remainMonths - remPrincipal);

  const prepay = Math.min(Math.max(0, Number(m.prepay_amount)), remPrincipal);
  const newPrincipal = Math.max(0, remPrincipal - prepay);

  if (newPrincipal <= 0.01) {
    return {
      original_monthly: round2(origMonthly),
      remaining_principal: round2(remPrincipal),
      original_remaining_interest: round2(origRemInterest),
      new_monthly: 0,
      new_remaining_months: 0,
      new_remaining_interest: 0,
      interest_saved: round2(origRemInterest),
      months_saved: remainMonths,
    };
  }

  if (m.mode === 'reduce_payment') {
    const powR = Math.pow(1 + r, remainMonths);
    const newMonthly = (newPrincipal * r * powR) / (powR - 1);
    const newRemInterest = Math.max(0, newMonthly * remainMonths - newPrincipal);
    return {
      original_monthly: round2(origMonthly),
      remaining_principal: round2(remPrincipal),
      original_remaining_interest: round2(origRemInterest),
      new_monthly: round2(newMonthly),
      new_remaining_months: remainMonths,
      new_remaining_interest: round2(newRemInterest),
      interest_saved: round2(Math.max(0, origRemInterest - newRemInterest)),
      months_saved: 0,
    };
  }

  // reduce_term: keep original monthly payment, amortize month-by-month for exact precision
  let bal = newPrincipal;
  let months = 0;
  let totalInterest = 0;
  while (bal > 0.01 && months < remainMonths) {
    const interest = bal * r;
    const principalPaid = Math.min(bal, Math.max(0.01, origMonthly - interest));
    bal -= principalPaid;
    totalInterest += interest;
    months += 1;
  }

  return {
    original_monthly: round2(origMonthly),
    remaining_principal: round2(remPrincipal),
    original_remaining_interest: round2(origRemInterest),
    new_monthly: round2(origMonthly),
    new_remaining_months: months,
    new_remaining_interest: round2(totalInterest),
    interest_saved: round2(Math.max(0, origRemInterest - totalInterest)),
    months_saved: Math.max(0, remainMonths - months),
  };
}

function buildDemoDataset() {
  const m0 = monthStr(0);
  const d0 = todayStr();
  const day = n => `${m0}-${String(n).padStart(2, '0')}`;

  const accounts = [
    {
      id: 'fin-cash',
      name: '招商活期与货币基金',
      kind: 'asset',
      asset_class: 'cash',
      balance: 265000,
      apy: 2.1,
      institution: '招商银行',
      note: '含 6 个月家庭应急储备金',
      updated_at: d0,
    },
    {
      id: 'fin-equity',
      name: '港美股科技精选账户',
      kind: 'asset',
      asset_class: 'equity',
      balance: 640000,
      apy: 11.5,
      institution: '富途证券',
      note: '核心持股：AI 基础设施与消费龙头',
      updated_at: d0,
    },
    {
      id: 'fin-fund',
      name: '全球宽基指数 ETF 定投',
      kind: 'asset',
      asset_class: 'fund',
      balance: 485000,
      apy: 8.2,
      institution: '雪球基金',
      note: '沪深300 + 标普500 + 黄金ETF 组合',
      updated_at: d0,
    },
    {
      id: 'fin-fixed',
      name: '国债与纯债固收组合',
      kind: 'asset',
      asset_class: 'fixed_income',
      balance: 310000,
      apy: 3.4,
      institution: '中银理财',
      note: '低波防御底仓',
      updated_at: d0,
    },
    {
      id: 'fin-house',
      name: '自住改善型住宅估值',
      kind: 'asset',
      asset_class: 'real_estate',
      balance: 2600000,
      apy: 1.5,
      institution: '自有产权',
      note: '按同小区近期成交均价保守估值',
      updated_at: d0,
    },
    {
      id: 'fin-mortgage',
      name: '住房商业按揭贷款',
      kind: 'liability',
      asset_class: 'debt',
      balance: 1180000,
      apy: 3.45,
      institution: '建设银行',
      note: '剩余 22 年，LPR 重定价日每年 1 月',
      updated_at: d0,
    },
  ];

  const ledger = [
    { id: 'tx-01', date: day(1), type: 'income', category: 'salary', amount: 42000, account_id: 'fin-cash', target_account_id: '', note: '本月税后主业薪资' },
    { id: 'tx-02', date: day(3), type: 'income', category: 'dividend', amount: 3600, account_id: 'fin-fund', target_account_id: '', note: '红利低波 ETF 季度分红' },
    { id: 'tx-03', date: day(5), type: 'income', category: 'bonus', amount: 6500, account_id: 'fin-cash', target_account_id: '', note: '技术顾问与专栏稿费' },
    { id: 'tx-04', date: day(2), type: 'expense', category: 'housing', amount: 7200, account_id: 'fin-cash', target_account_id: '', note: '本月房贷月供与物业费' },
    { id: 'tx-05', date: day(4), type: 'expense', category: 'food', amount: 1850, account_id: 'fin-cash', target_account_id: '', note: '家庭生鲜商超采购' },
    { id: 'tx-06', date: day(7), type: 'expense', category: 'transport', amount: 680, account_id: 'fin-cash', target_account_id: '', note: '通勤充电、停车与打车' },
    { id: 'tx-07', date: day(8), type: 'expense', category: 'shopping', amount: 2480, account_id: 'fin-cash', target_account_id: '', note: '人体工学外设与冬季服饰' },
    { id: 'tx-08', date: day(10), type: 'expense', category: 'food', amount: 1460, account_id: 'fin-cash', target_account_id: '', note: '周末家庭聚餐与咖啡' },
    { id: 'tx-09', date: day(11), type: 'expense', category: 'education', amount: 1680, account_id: 'fin-cash', target_account_id: '', note: '专业技术书籍与云算力订阅' },
    { id: 'tx-10', date: day(12), type: 'expense', category: 'health', amount: 920, account_id: 'fin-cash', target_account_id: '', note: '年度体检升级与健身年卡分摊' },
    { id: 'tx-11', date: day(14), type: 'expense', category: 'entertainment', amount: 1580, account_id: 'fin-cash', target_account_id: '', note: '演唱会门票与流媒体会员' },
    { id: 'tx-12', date: day(15), type: 'expense', category: 'shopping', amount: 1750, account_id: 'fin-cash', target_account_id: '', note: '家庭智能家电升级' },
    { id: 'tx-13', date: day(16), type: 'expense', category: 'food', amount: 1290, account_id: 'fin-cash', target_account_id: '', note: '工作日午餐与外卖' },
    { id: 'tx-14', date: day(18), type: 'transfer', category: 'invest', amount: 18000, account_id: 'fin-cash', target_account_id: 'fin-fund', note: '月度自动定投宽基指数 ETF' },
  ];

  const goals = [
    { id: 'goal-b-housing', kind: 'budget', category: 'housing', label: '居住与月供', monthly_limit: 8000, current_saved: 0, target_date: '' },
    { id: 'goal-b-food', kind: 'budget', category: 'food', label: '餐饮美食', monthly_limit: 5200, current_saved: 0, target_date: '' },
    { id: 'goal-b-shopping', kind: 'budget', category: 'shopping', label: '购物与数码', monthly_limit: 4000, current_saved: 0, target_date: '' },
    { id: 'goal-b-ent', kind: 'budget', category: 'entertainment', label: '休闲娱乐', monthly_limit: 1800, current_saved: 0, target_date: '' },
    { id: 'goal-b-edu', kind: 'budget', category: 'education', label: '学习成长', monthly_limit: 2500, current_saved: 0, target_date: '' },
    { id: 'goal-t-fire', kind: 'target', category: 'invest', label: '金融净资产 200 万里程碑', monthly_limit: 2000000, current_saved: 1700000, target_date: '2028-12-31' },
  ];

  const snapshots = [
    { month: monthStr(-5), net_worth: 2945000, income: 44500, expense: 20100 },
    { month: monthStr(-4), net_worth: 2982000, income: 46200, expense: 19400 },
    { month: monthStr(-3), net_worth: 3018000, income: 45800, expense: 21500 },
    { month: monthStr(-2), net_worth: 3054000, income: 48000, expense: 18900 },
    { month: monthStr(-1), net_worth: 3088000, income: 49500, expense: 20200 },
  ];

  return { accounts, ledger, goals, snapshots };
}

export default async function (request) {
  const { kind, contribution, input } = request ?? {};

  if (kind === 'action') {
    if (contribution === 'finance.snapshot') {
      const state = await readAll();
      const settings = await readPluginSettings();
      const analytics = computeAnalytics(state, input.month);
      return {
        revision: state.revision,
        month: analytics.month,
        accounts: state.accounts,
        ledger: state.ledger,
        goals: state.goals,
        summary: analytics.summary,
        allocation: analytics.allocation,
        budgets: analytics.budgets,
        top_expenses: analytics.top_expenses,
        trend: analytics.trend,
        cfo_memo: state.cfo_memo,
        settings,
      };
    }

    if (contribution === 'finance.account.save') {
      const record = sanitizeAccount({ ...input, updated_at: todayStr() });
      if (!record) return { status: 'invalid_input', revision: input.expected_revision };
      const cur = await readAccounts();
      if (cur.revision !== input.expected_revision) return { status: 'conflict', revision: cur.revision };
      const exists = cur.items.some(a => a.id === record.id);
      const next = exists ? cur.items.map(a => (a.id === record.id ? record : a)) : [...cur.items, record];
      if (next.length > MAX_ACCOUNTS) return { status: 'limit', revision: cur.revision };
      return writeDoc(COL_ACCOUNTS, input.expected_revision, { schema_version: 1, items: next });
    }

    if (contribution === 'finance.account.delete') {
      const cur = await readAccounts();
      if (cur.revision !== input.expected_revision) return { status: 'conflict', revision: cur.revision };
      if (!cur.items.some(a => a.id === input.id)) return { status: 'not_found', revision: cur.revision };
      const next = cur.items.filter(a => a.id !== input.id);
      const res = await writeDoc(COL_ACCOUNTS, input.expected_revision, { schema_version: 1, items: next });
      return res.status === 'saved' ? { status: 'deleted', revision: res.revision } : { status: 'conflict', revision: res.revision };
    }

    if (contribution === 'finance.tx.save') {
      const record = sanitizeTx(input);
      if (!record) return { status: 'invalid_input', revision: input.expected_revision };
      const acc = await readAccounts();
      const led = await readLedger();
      const rev = Math.max(acc.revision, led.revision);
      if (rev !== input.expected_revision) return { status: 'conflict', revision: rev };

      const exists = led.items.some(t => t.id === record.id);
      const nextLedger = exists ? led.items.map(t => (t.id === record.id ? record : t)) : [record, ...led.items];
      if (nextLedger.length > MAX_LEDGER) return { status: 'limit', revision: rev };

      const r1 = await writeDoc(COL_LEDGER, input.expected_revision, { schema_version: 1, items: nextLedger });
      if (r1.status !== 'saved') return r1;

      if (input.sync_balance && !exists) {
        let changed = false;
        const nextAccounts = acc.items.map(a => {
          if (a.id === record.account_id) {
            changed = true;
            const delta = record.type === 'income' ? record.amount : -record.amount;
            return { ...a, balance: round2(Math.max(0, a.balance + delta)), updated_at: todayStr() };
          }
          if (record.type === 'transfer' && record.target_account_id && a.id === record.target_account_id) {
            changed = true;
            return { ...a, balance: round2(a.balance + record.amount), updated_at: todayStr() };
          }
          return a;
        });
        if (changed) {
          const r2 = await writeDoc(COL_ACCOUNTS, r1.revision, { schema_version: 1, items: nextAccounts });
          if (r2.status === 'saved') return r2;
        }
      }
      return r1;
    }

    if (contribution === 'finance.tx.delete') {
      const led = await readLedger();
      if (led.revision !== input.expected_revision) return { status: 'conflict', revision: led.revision };
      if (!led.items.some(t => t.id === input.id)) return { status: 'not_found', revision: led.revision };
      const next = led.items.filter(t => t.id !== input.id);
      const res = await writeDoc(COL_LEDGER, input.expected_revision, { schema_version: 1, items: next });
      return res.status === 'saved' ? { status: 'deleted', revision: res.revision } : { status: 'conflict', revision: res.revision };
    }

    if (contribution === 'finance.goal.save') {
      const record = sanitizeGoal(input);
      if (!record) return { status: 'invalid_input', revision: input.expected_revision };
      const cur = await readGoalsDoc();
      if (cur.revision !== input.expected_revision) return { status: 'conflict', revision: cur.revision };
      const exists = cur.items.some(g => g.id === record.id);
      const next = exists ? cur.items.map(g => (g.id === record.id ? record : g)) : [...cur.items, record];
      if (next.length > MAX_GOALS) return { status: 'limit', revision: cur.revision };
      return writeDoc(COL_GOALS, input.expected_revision, {
        schema_version: 1,
        items: next,
        snapshots: cur.snapshots,
        cfo_memo: cur.cfo_memo,
      });
    }

    if (contribution === 'finance.goal.delete') {
      const cur = await readGoalsDoc();
      if (cur.revision !== input.expected_revision) return { status: 'conflict', revision: cur.revision };
      if (!cur.items.some(g => g.id === input.id)) return { status: 'not_found', revision: cur.revision };
      const next = cur.items.filter(g => g.id !== input.id);
      const res = await writeDoc(COL_GOALS, input.expected_revision, {
        schema_version: 1,
        items: next,
        snapshots: cur.snapshots,
        cfo_memo: cur.cfo_memo,
      });
      return res.status === 'saved' ? { status: 'deleted', revision: res.revision } : { status: 'conflict', revision: res.revision };
    }

    if (contribution === 'finance.cfo.memo') {
      const cur = await readGoalsDoc();
      if (cur.revision !== input.expected_revision) return { status: 'conflict', revision: cur.revision };
      return writeDoc(COL_GOALS, input.expected_revision, {
        schema_version: 1,
        items: cur.items,
        snapshots: cur.snapshots,
        cfo_memo: String(input.memo || '').trim().slice(0, 2048),
      });
    }

    if (contribution === 'finance.simulate') {
      const nw = Number(input.current_net_worth);
      const monthly = Number(input.monthly_invest);
      const ret = Number(input.expected_return);
      const inf = Number(input.inflation);
      const annualExp = Number(input.annual_expense);
      const swr = Number(input.swr ?? 4);
      const years = Number(input.years ?? 20);
      const fireTarget = round2(annualExp / (swr / 100));
      const startYear = new Date().getUTCFullYear();

      const cons = runFireScenario(nw, monthly, Math.max(0, ret - 2.5), inf, fireTarget, years);
      const base = runFireScenario(nw, monthly, ret, inf, fireTarget, years);
      const opt = runFireScenario(nw, monthly, ret + 2.5, inf, fireTarget, years);

      const series = [];
      for (let i = 0; i <= years; i++) {
        series.push({
          year: startYear + i,
          conservative: cons.yearlyValues[i],
          base: base.yearlyValues[i],
          optimistic: opt.yearlyValues[i],
        });
      }

      const out = {
        fire_target: fireTarget,
        start_year: startYear,
        years,
        scenarios: {
          conservative: {
            rate: cons.rate,
            real_rate: cons.real_rate,
            final_real: cons.final_real,
            fire_year: cons.fire_year,
            years_to_fire: cons.years_to_fire,
          },
          base: {
            rate: base.rate,
            real_rate: base.real_rate,
            final_real: base.final_real,
            fire_year: base.fire_year,
            years_to_fire: base.years_to_fire,
          },
          optimistic: {
            rate: opt.rate,
            real_rate: opt.real_rate,
            final_real: opt.final_real,
            fire_year: opt.fire_year,
            years_to_fire: opt.years_to_fire,
          },
        },
        series,
      };
      if (input.mortgage) {
        out.mortgage_result = computeMortgage(input.mortgage);
      }
      return out;
    }

    if (contribution === 'finance.demo.seed') {
      const cur = await readAccounts();
      if (cur.revision !== input.expected_revision) return { status: 'conflict', revision: cur.revision };
      const demo = buildDemoDataset();
      let rev = input.expected_revision;
      const r1 = await writeDoc(COL_ACCOUNTS, rev, { schema_version: 1, items: demo.accounts });
      if (r1.status !== 'saved') return { status: 'conflict', revision: r1.revision };
      rev = r1.revision;
      const r2 = await writeDoc(COL_LEDGER, rev, { schema_version: 1, items: demo.ledger });
      if (r2.status !== 'saved') return { status: 'conflict', revision: r2.revision };
      rev = r2.revision;
      const r3 = await writeDoc(COL_GOALS, rev, {
        schema_version: 1,
        items: demo.goals,
        snapshots: demo.snapshots,
        cfo_memo: '',
      });
      if (r3.status !== 'saved') return { status: 'conflict', revision: r3.revision };
      return {
        status: 'seeded',
        revision: r3.revision,
        counts: {
          accounts: demo.accounts.length,
          ledger: demo.ledger.length,
          goals: demo.goals.length,
        },
      };
    }

    if (contribution === 'document.list') {
      const state = await readAll();
      return {
        items: [
          {
            id: 'all',
            label: `完整财务数据包（${state.accounts.length} 账户 / ${state.ledger.length} 流水 / ${state.goals.length} 预算目标）`,
          },
          { id: 'balance-sheet', label: `资产负债表快照（${state.accounts.length} 个账户）` },
          { id: 'ledger', label: `收支流水账本（${state.ledger.length} 笔）` },
        ],
      };
    }

    if (contribution === 'document.export') {
      const state = await readAll();
      let payload;
      let filename;
      if (input.id === 'all') {
        payload = {
          format: DOC_FORMAT,
          version: 1,
          scope: 'full',
          accounts: state.accounts,
          ledger: state.ledger,
          goals: state.goals,
          snapshots: state.snapshots,
        };
        filename = `finance-wealth-os-${todayStr()}.json`;
      } else if (input.id === 'balance-sheet') {
        payload = { format: DOC_FORMAT, version: 1, scope: 'accounts', accounts: state.accounts };
        filename = `balance-sheet-${todayStr()}.json`;
      } else if (input.id === 'ledger') {
        payload = { format: DOC_FORMAT, version: 1, scope: 'ledger', ledger: state.ledger };
        filename = `ledger-${todayStr()}.json`;
      } else {
        return { error: 'not_found' };
      }
      const text = JSON.stringify(payload);
      if (jsonBytes(text) > MAX_RECORD_BYTES) return { error: 'payload_too_large' };
      return { filename, text };
    }

    if (contribution === 'document.import') {
      let parsed;
      try {
        parsed = JSON.parse(input.text);
      } catch {
        return { imported: false, reason: 'invalid_json' };
      }
      if (!parsed || parsed.format !== DOC_FORMAT || parsed.version !== 1) {
        return { imported: false, reason: 'invalid_document' };
      }
      const state = await readAll();
      let rev = state.revision;

      if (Array.isArray(parsed.accounts)) {
        const cleanAcc = parsed.accounts.map(sanitizeAccount).filter(Boolean).slice(0, MAX_ACCOUNTS);
        const r = await writeDoc(COL_ACCOUNTS, rev, { schema_version: 1, items: cleanAcc });
        if (r.status !== 'saved') return { imported: false, reason: r.status };
        rev = r.revision;
      }
      if (Array.isArray(parsed.ledger)) {
        const cleanLed = parsed.ledger.map(sanitizeTx).filter(Boolean).slice(0, MAX_LEDGER);
        const r = await writeDoc(COL_LEDGER, rev, { schema_version: 1, items: cleanLed });
        if (r.status !== 'saved') return { imported: false, reason: r.status };
        rev = r.revision;
      }
      if (Array.isArray(parsed.goals)) {
        const cleanGoals = parsed.goals.map(sanitizeGoal).filter(Boolean).slice(0, MAX_GOALS);
        const cleanSnaps = Array.isArray(parsed.snapshots) ? parsed.snapshots.slice(-12) : state.snapshots;
        const r = await writeDoc(COL_GOALS, rev, {
          schema_version: 1,
          items: cleanGoals,
          snapshots: cleanSnaps,
          cfo_memo: state.cfo_memo,
        });
        if (r.status !== 'saved') return { imported: false, reason: r.status };
      }
      return { imported: true };
    }

    if (contribution === 'finance.fetch_fx_rates') {
      const settings = await readPluginSettings();
      const rawBase = typeof input.base === 'string' && input.base.trim() ? input.base.trim().toUpperCase() : settings.base_currency;
      if (!/^[A-Z]{3,8}$/.test(rawBase)) {
        return { status: 'invalid_input', base: settings.base_currency, date: '', rates: [], target_savings_pct: settings.target_savings_pct, error: '无效的基础币种代码' };
      }
      const defaults = ['USD', 'EUR', 'HKD', 'JPY', 'GBP'].filter(c => c !== rawBase);
      const rawSymbols = Array.isArray(input.symbols) && input.symbols.length
        ? input.symbols.map(s => String(s || '').trim().toUpperCase()).filter(s => /^[A-Z]{3,8}$/.test(s) && s !== rawBase)
        : defaults;
      const symbolsList = [...new Set(rawSymbols)].slice(0, 12);
      const query = { base: rawBase };
      if (symbolsList.length) query.symbols = symbolsList.join(',');
      try {
        const res = await globalThis.nmas.http.request({
          rule: 0,
          method: 'GET',
          path: '/v1/latest',
          query,
          headers: { accept: 'application/json' },
          responseType: 'json',
        });
        if (res.status && res.status >= 400) {
          return {
            status: 'http_error',
            base: rawBase,
            date: '',
            rates: [],
            target_savings_pct: settings.target_savings_pct,
            error: `Frankfurter HTTP ${res.status}`,
          };
        }
        const data = res.json ?? {};
        const ratesObj = data.rates && typeof data.rates === 'object' ? data.rates : {};
        const rates = Object.entries(ratesObj)
          .filter(([k, v]) => typeof k === 'string' && typeof v === 'number' && Number.isFinite(v) && v >= 0)
          .map(([currency, rate]) => ({ currency: currency.toUpperCase().slice(0, 8), rate }))
          .sort((a, b) => a.currency.localeCompare(b.currency));
        return {
          status: 'ok',
          base: typeof data.base === 'string' ? data.base.toUpperCase().slice(0, 8) : rawBase,
          date: typeof data.date === 'string' ? data.date.slice(0, 16) : todayStr(),
          rates,
          target_savings_pct: settings.target_savings_pct,
        };
      } catch (err) {
        return {
          status: 'http_error',
          base: rawBase,
          date: '',
          rates: [],
          target_savings_pct: settings.target_savings_pct,
          error: String(err?.message || 'network_error').slice(0, 160),
        };
      }
    }
  }

  if (kind === 'tool') {
    if (contribution === 'finance.summary') {
      const state = await readAll();
      const a = computeAnalytics(state, input.month);
      const hasData = state.accounts.length > 0 || state.ledger.length > 0;
      return {
        success: true,
        status: hasData ? 'ready' : 'empty',
        month: a.month,
        summary: {
          total_assets: a.summary.total_assets,
          total_liabilities: a.summary.total_liabilities,
          net_worth: a.summary.net_worth,
          debt_ratio: a.summary.debt_ratio,
          monthly_income: a.summary.monthly_income,
          monthly_expense: a.summary.monthly_expense,
          savings_rate: a.summary.savings_rate,
        },
        allocation: a.allocation,
        budget_alerts: a.budgets.map(({ category, label, limit, spent, ratio, level }) => ({
          category,
          label,
          limit,
          spent,
          ratio,
          level,
        })),
        top_expenses: a.top_expenses,
      };
    }

    if (contribution === 'finance.tx.add') {
      const state = await readAll();
      const q = String(input.account_name || '').trim().toLowerCase();
      const matchedAcc =
        (q && state.accounts.find(a => a.id.toLowerCase() === q || a.name.toLowerCase().includes(q))) ||
        state.accounts.find(a => a.asset_class === 'cash') ||
        state.accounts[0];
      const accountId = matchedAcc ? matchedAcc.id : 'default-cash';
      const date = input.date || todayStr();

      const record = sanitizeTx({
        id: makeId('tx'),
        date,
        type: input.type,
        category: input.category,
        amount: input.amount,
        account_id: accountId,
        target_account_id: '',
        note: input.note || '',
      });
      if (!record) return { success: false, status: 'invalid_input' };
      const nextLedger = [record, ...state.ledger];
      if (nextLedger.length > MAX_LEDGER) return { success: false, status: 'limit' };
      const res = await writeDoc(COL_LEDGER, state.revision, { schema_version: 1, items: nextLedger });
      if (res.status !== 'saved') {
        return { success: false, status: res.status === 'limit' ? 'limit' : 'conflict' };
      }

      // Compute updated category budget status
      const m = date.slice(0, 7);
      const budgetGoal = state.goals.find(g => g.kind === 'budget' && g.category === record.category);
      let budgetRatio = 0;
      let level = 'none';
      if (budgetGoal && record.type === 'expense') {
        const spent = nextLedger
          .filter(t => t.type === 'expense' && t.category === record.category && t.date.startsWith(m))
          .reduce((s, t) => s + t.amount, 0);
        budgetRatio = round2((spent / budgetGoal.monthly_limit) * 100);
        level = budgetLevel(budgetRatio);
      }

      return {
        success: true,
        status: 'recorded',
        tx_id: record.id,
        budget_ratio: budgetRatio,
        budget_level: level,
      };
    }
  }

  throw new Error(`不支持的调用: ${kind}/${contribution}`);
}
