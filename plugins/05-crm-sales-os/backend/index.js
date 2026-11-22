const COL_ACCOUNTS = 'accounts';
const COL_DEALS = 'deals';
const COL_ACTIVITIES = 'activities';
const KEY_LIST = 'list';
const DOC_FORMAT = 'velai-crm-sales-os';

const MAX_RECORD_BYTES = 240 * 1024;
const MAX_ACCOUNTS = 120;
const MAX_DEALS = 240;
const MAX_ACTIVITIES = 360;

const STAGES = ['lead', 'qualified', 'proposal', 'negotiation', 'won', 'lost'];
const SIZES = ['startup', 'smb', 'midmarket', 'enterprise'];
const ACT_TYPES = ['call', 'meeting', 'demo', 'quote', 'email', 'ai_note'];
const STAGE_PROB = {
  lead: 15,
  qualified: 35,
  proposal: 60,
  negotiation: 80,
  won: 100,
  lost: 0,
};

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

function addDays(offset) {
  const d = new Date(Date.now() + offset * 86400000);
  return d.toISOString().slice(0, 10);
}

function isDate(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
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

async function readCollection(collection) {
  const receipt = await globalThis.nmas.data.read({ collection, key: KEY_LIST });
  const doc = receipt.value === null ? { schema_version: 1, items: [] } : receipt.value;
  if (!doc || doc.schema_version !== 1 || !Array.isArray(doc.items)) {
    throw new Error(`集合 ${collection} 数据格式无效`);
  }
  return { revision: receipt.revision, items: doc.items };
}

async function readAll() {
  const acc = await readCollection(COL_ACCOUNTS);
  const deal = await readCollection(COL_DEALS);
  const act = await readCollection(COL_ACTIVITIES);
  return {
    revision: Math.max(acc.revision, deal.revision, act.revision),
    accounts: acc.items,
    deals: deal.items,
    activities: act.items,
  };
}

async function writeCollection(collection, expectedRevision, items, maxCount) {
  if (items.length === 0) {
    try {
      const receipt = await globalThis.nmas.data.delete({
        collection,
        key: KEY_LIST,
        expected_revision: expectedRevision,
      });
      return { status: 'saved', revision: receipt.revision };
    } catch (err) {
      if (err?.code === 'conflict' && err.outcome_unknown === false) {
        return { status: 'conflict', revision: expectedRevision };
      }
      throw err;
    }
  }
  const value = { schema_version: 1, items };
  if (items.length > maxCount || jsonBytes(value) > MAX_RECORD_BYTES) {
    return { status: 'limit', revision: expectedRevision };
  }
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
  const default_currency = typeof raw?.default_currency === 'string' && /^[A-Z]{3,8}$/.test(raw.default_currency.trim().toUpperCase())
    ? raw.default_currency.trim().toUpperCase()
    : 'CNY';
  const days = Number.isInteger(raw?.follow_up_days) ? raw.follow_up_days : 3;
  const follow_up_days = Math.max(1, Math.min(30, days));
  return { default_currency, follow_up_days };
}

function computeMetrics(accounts, deals, activities, followUpDays = 3) {
  const today = todayStr();
  const soonLimit = addDays(followUpDays);
  const funnelMap = {};
  for (const s of STAGES) funnelMap[s] = { stage: s, count: 0, amount: 0, weighted: 0 };

  let activePipeline = 0;
  let weightedForecast = 0;
  let wonAmount = 0;
  let lostAmount = 0;
  let activeCount = 0;
  let wonCount = 0;
  let closedCount = 0;

  for (const d of deals) {
    const amt = Number(d.amount) || 0;
    const prob = Number(d.probability) || 0;
    const w = round2((amt * prob) / 100);
    const bucket = funnelMap[d.stage];
    if (bucket) {
      bucket.count += 1;
      bucket.amount = round2(bucket.amount + amt);
      bucket.weighted = round2(bucket.weighted + w);
    }
    if (d.stage === 'won') {
      wonAmount = round2(wonAmount + amt);
      wonCount += 1;
      closedCount += 1;
    } else if (d.stage === 'lost') {
      lostAmount = round2(lostAmount + amt);
      closedCount += 1;
    } else {
      activePipeline = round2(activePipeline + amt);
      weightedForecast = round2(weightedForecast + w);
      activeCount += 1;
    }
  }

  const avgHealth = accounts.length
    ? round2(accounts.reduce((s, a) => s + (Number(a.health) || 0), 0) / accounts.length)
    : 0;
  const winRate = closedCount > 0 ? round2((wonCount / closedCount) * 100) : 0;

  let overdueCount = 0;
  let dueSoonCount = 0;
  for (const a of activities) {
    if (a.done || !a.next_due) continue;
    if (a.next_due < today) overdueCount += 1;
    else if (a.next_due <= soonLimit) dueSoonCount += 1;
  }

  return {
    active_pipeline: activePipeline,
    weighted_forecast: weightedForecast,
    won_amount: wonAmount,
    lost_amount: lostAmount,
    active_deal_count: activeCount,
    win_rate: winRate,
    avg_health: avgHealth,
    overdue_count: overdueCount,
    due_soon_count: dueSoonCount,
    funnel: STAGES.map(s => funnelMap[s]),
  };
}

function buildDemoDataset() {
  const d0 = todayStr();
  const accounts = [
    {
      id: 'acc-nebula',
      name: '星云智造科技',
      industry: '智能制造',
      size: 'enterprise',
      health: 88,
      contact_name: '陈志远',
      contact_role: 'CTO',
      annual_potential: 1800000,
      tags: ['灯塔客户', '私有部署', '高增潜'],
      risk_note: '法务正在审阅数据合规附件，预计本月底前完成签章。',
      updated_at: d0,
    },
    {
      id: 'acc-aurora',
      name: '极光跨境物流',
      industry: '供应链物流',
      size: 'midmarket',
      health: 74,
      contact_name: '林婉清',
      contact_role: '运营副总裁',
      annual_potential: 960000,
      tags: ['多仓协同', '竞品替换'],
      risk_note: '竞品给出首年 8 折报价，需突出 AI 异常预警 ROI 差异化。',
      updated_at: d0,
    },
    {
      id: 'acc-finpulse',
      name: '脉动金融数据',
      industry: '金融科技',
      size: 'enterprise',
      health: 92,
      contact_name: '周明轩',
      contact_role: '首席数据官',
      annual_potential: 2400000,
      tags: ['战略续约', '增购席位'],
      risk_note: '一期上线满意度高，可推动 Q2 扩展风控团队 120 席位。',
      updated_at: d0,
    },
    {
      id: 'acc-medcore',
      name: '康核生命健康',
      industry: '生物医药',
      size: 'midmarket',
      health: 58,
      contact_name: '苏嘉宁',
      contact_role: 'IT 总监',
      annual_potential: 720000,
      tags: ['合规敏感', '需高层切入'],
      risk_note: '采购预算冻结风险，关键决策人尚未参与 POC 验收。',
      updated_at: d0,
    },
    {
      id: 'acc-cloudretail',
      name: '云杉新零售',
      industry: '消费零售',
      size: 'smb',
      health: 81,
      contact_name: '陆思成',
      contact_role: '增长负责人',
      annual_potential: 450000,
      tags: ['PLG 转化', '快签'],
      risk_note: '试用团队活跃度高，关注按季付款与微信生态打通能力。',
      updated_at: d0,
    },
  ];

  const deals = [
    {
      id: 'deal-nebula-ai',
      account_id: 'acc-nebula',
      title: '星云智造 AI 质检中台年度订阅',
      stage: 'negotiation',
      amount: 680000,
      probability: 85,
      close_date: addDays(14),
      owner: '张锐',
      next_step: '与法务对齐 SLA 违约条款并提交终版合同',
      loss_reason: '',
      updated_at: d0,
    },
    {
      id: 'deal-aurora-ops',
      account_id: 'acc-aurora',
      title: '极光全球运力调度自动化项目',
      stage: 'proposal',
      amount: 420000,
      probability: 60,
      close_date: addDays(28),
      owner: '李佳',
      next_step: '交付 3 年 TCO 测算模型与竞品对比白皮书',
      loss_reason: '',
      updated_at: d0,
    },
    {
      id: 'deal-finpulse-exp',
      account_id: 'acc-finpulse',
      title: '脉动金融风控团队 120 席位增购',
      stage: 'won',
      amount: 540000,
      probability: 100,
      close_date: addDays(-4),
      owner: '张锐',
      next_step: '交接客户成功经理启动培训上线',
      loss_reason: '',
      updated_at: d0,
    },
    {
      id: 'deal-medcore-poc',
      account_id: 'acc-medcore',
      title: '康核临床文档智能检索平台',
      stage: 'qualified',
      amount: 360000,
      probability: 35,
      close_date: addDays(45),
      owner: '王晨',
      next_step: '约见研发 VP 确认脱敏数据集与 POC 验收指标',
      loss_reason: '',
      updated_at: d0,
    },
    {
      id: 'deal-retail-std',
      account_id: 'acc-cloudretail',
      title: '云杉全渠道会员 AI 营销套件',
      stage: 'negotiation',
      amount: 210000,
      probability: 80,
      close_date: addDays(9),
      owner: '李佳',
      next_step: '确认季度付款审批单与上线排期',
      loss_reason: '',
      updated_at: d0,
    },
    {
      id: 'deal-nebula-edge',
      account_id: 'acc-nebula',
      title: '星云二期工厂边缘节点扩展包',
      stage: 'lead',
      amount: 320000,
      probability: 20,
      close_date: addDays(70),
      owner: '张锐',
      next_step: '一期上线后开展产线调研挖掘二期预算',
      loss_reason: '',
      updated_at: d0,
    },
    {
      id: 'deal-medcore-legacy',
      account_id: 'acc-medcore',
      title: '康核旧版报表迁移服务',
      stage: 'lost',
      amount: 150000,
      probability: 0,
      close_date: addDays(-12),
      owner: '王晨',
      next_step: '',
      loss_reason: '客户决定由内部团队自行维护旧系统，预算转投 AI 检索项目。',
      updated_at: d0,
    },
  ];

  const activities = [
    {
      id: 'act-01',
      account_id: 'acc-nebula',
      deal_id: 'deal-nebula-ai',
      type: 'quote',
      date: addDays(-3),
      summary: '发出 68 万年度阶梯报价单，CTO 认可技术方案，要求法务核查数据不出境条款。',
      next_action: '跟进法务终审意见并预约高层签字',
      next_due: addDays(-1),
      done: false,
    },
    {
      id: 'act-02',
      account_id: 'acc-aurora',
      deal_id: 'deal-aurora-ops',
      type: 'demo',
      date: addDays(-5),
      summary: '完成多仓异常预测实景演示，运营团队对预警准确率反馈积极，关注与现有 ERP 集成周期。',
      next_action: '发送 ERP 对接排期表与 ROI 测算',
      next_due: addDays(1),
      done: false,
    },
    {
      id: 'act-03',
      account_id: 'acc-medcore',
      deal_id: 'deal-medcore-poc',
      type: 'call',
      date: addDays(-6),
      summary: '与 IT 总监沟通 POC 进展，得知 Q2 预算需经研发 VP 联签，存在延期风险。',
      next_action: '起草致研发 VP 的业务价值简报并约访',
      next_due: addDays(-2),
      done: false,
    },
    {
      id: 'act-04',
      account_id: 'acc-cloudretail',
      deal_id: 'deal-retail-std',
      type: 'meeting',
      date: addDays(-2),
      summary: '与增长负责人核对企业微信接入流程，对方希望将年付拆为两期付款以加速内部审批。',
      next_action: '内部申请分期付款特批并回传合同',
      next_due: addDays(2),
      done: false,
    },
    {
      id: 'act-05',
      account_id: 'acc-finpulse',
      deal_id: 'deal-finpulse-exp',
      type: 'meeting',
      date: addDays(-4),
      summary: '120 席位增购合同正式盖章赢单，CDO 提出希望分享最佳实践给集团其他子公司。',
      next_action: '安排客户成功启动会并准备案例访谈',
      next_due: addDays(5),
      done: false,
    },
    {
      id: 'act-06',
      account_id: 'acc-nebula',
      deal_id: 'deal-nebula-edge',
      type: 'email',
      date: addDays(-8),
      summary: '分享边缘推理低延迟白皮书，CTO 表达对华东二厂试点的初步兴趣。',
      next_action: '约技术架构师评估产线网关现状',
      next_due: addDays(10),
      done: false,
    },
    {
      id: 'act-07',
      account_id: 'acc-aurora',
      deal_id: 'deal-aurora-ops',
      type: 'call',
      date: addDays(-10),
      summary: '摸底竞品动态：对方以低价切入但缺少自定义工作流与中文大模型语义检索。',
      next_action: '整理 5 点竞品差异化攻防清单',
      next_due: addDays(-3),
      done: true,
    },
    {
      id: 'act-08',
      account_id: 'acc-finpulse',
      deal_id: 'deal-finpulse-exp',
      type: 'demo',
      date: addDays(-14),
      summary: '面向风控审核团队做专项演示，平均单据核验耗时缩短 46%。',
      next_action: '输出 POC 量化验收报告',
      next_due: addDays(-9),
      done: true,
    },
    {
      id: 'act-09',
      account_id: 'acc-cloudretail',
      deal_id: 'deal-retail-std',
      type: 'email',
      date: addDays(-7),
      summary: '发送 14 天试用数据分析报告：自动生成营销文案点击率提升 22%。',
      next_action: '确认正式版席位清单',
      next_due: addDays(-3),
      done: true,
    },
    {
      id: 'act-10',
      account_id: 'acc-medcore',
      deal_id: 'deal-medcore-legacy',
      type: 'ai_note',
      date: addDays(-12),
      summary: '旧版报表项目丢单复盘：前期未绑定高层痛点，后续聚焦 AI 临床检索高价值场景。',
      next_action: '沉淀医药行业合规答疑库',
      next_due: addDays(-5),
      done: true,
    },
  ];

  return { accounts, deals, activities };
}

function sanitizeAccount(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.id || '').trim();
  const name = String(raw.name || '').trim();
  const industry = String(raw.industry || '').trim();
  const size = String(raw.size || '').trim();
  const health = Number(raw.health);
  const contactName = String(raw.contact_name || '').trim();
  const contactRole = String(raw.contact_role || '').trim();
  const annualPotential = Number(raw.annual_potential);
  const tags = Array.isArray(raw.tags)
    ? raw.tags.map(t => String(t).trim()).filter(Boolean).slice(0, 5).map(t => t.slice(0, 24))
    : [];
  const riskNote = String(raw.risk_note || '').trim().slice(0, 240);
  const updatedAt = isDate(raw.updated_at) ? raw.updated_at : todayStr();

  if (
    !validId(id) ||
    !name ||
    name.length > 64 ||
    !industry ||
    industry.length > 32 ||
    !SIZES.includes(size) ||
    !Number.isInteger(health) ||
    health < 0 ||
    health > 100 ||
    !contactName ||
    contactName.length > 40 ||
    !Number.isFinite(annualPotential) ||
    annualPotential < 0 ||
    annualPotential > 999999999
  ) {
    return null;
  }
  return {
    id,
    name,
    industry,
    size,
    health,
    contact_name: contactName,
    contact_role: contactRole.slice(0, 40),
    annual_potential: round2(annualPotential),
    tags,
    risk_note: riskNote,
    updated_at: updatedAt,
  };
}

function sanitizeDeal(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.id || '').trim();
  const accountId = String(raw.account_id || '').trim();
  const title = String(raw.title || '').trim();
  const stage = String(raw.stage || '').trim();
  const amount = Number(raw.amount);
  const probability = Number(raw.probability);
  const closeDate = String(raw.close_date || '').trim();
  const owner = String(raw.owner || '').trim().slice(0, 32);
  const nextStep = String(raw.next_step || '').trim().slice(0, 160);
  const lossReason = String(raw.loss_reason || '').trim().slice(0, 160);
  const updatedAt = isDate(raw.updated_at) ? raw.updated_at : todayStr();

  if (
    !validId(id) ||
    !validId(accountId) ||
    !title ||
    title.length > 80 ||
    !STAGES.includes(stage) ||
    !Number.isFinite(amount) ||
    amount < 0 ||
    amount > 999999999 ||
    !Number.isInteger(probability) ||
    probability < 0 ||
    probability > 100 ||
    !isDate(closeDate)
  ) {
    return null;
  }
  return {
    id,
    account_id: accountId,
    title,
    stage,
    amount: round2(amount),
    probability,
    close_date: closeDate,
    owner,
    next_step: nextStep,
    loss_reason: lossReason,
    updated_at: updatedAt,
  };
}

function sanitizeActivity(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.id || '').trim();
  const accountId = String(raw.account_id || '').trim();
  const dealId = String(raw.deal_id || '').trim();
  const type = String(raw.type || '').trim();
  const date = String(raw.date || '').trim();
  const summary = String(raw.summary || '').trim().slice(0, 400);
  const nextAction = String(raw.next_action || '').trim().slice(0, 160);
  const nextDue = String(raw.next_due || '').trim();
  const done = Boolean(raw.done);

  if (
    !validId(id) ||
    !validId(accountId) ||
    (dealId && !validId(dealId)) ||
    !ACT_TYPES.includes(type) ||
    !isDate(date) ||
    !summary ||
    (nextDue && !isDate(nextDue))
  ) {
    return null;
  }
  return {
    id,
    account_id: accountId,
    deal_id: dealId,
    type,
    date,
    summary,
    next_action: nextAction,
    next_due: nextDue,
    done,
  };
}

function findAccountByNameOrId(accounts, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return null;
  return (
    accounts.find(a => a.id.toLowerCase() === q) ||
    accounts.find(a => a.name.toLowerCase() === q) ||
    accounts.find(a => a.name.toLowerCase().includes(q)) ||
    null
  );
}

export default async function (request) {
  const { kind, contribution, input } = request ?? {};

  if (kind === 'action') {
    if (contribution === 'crm.snapshot') {
      const state = await readAll();
      const settings = await readPluginSettings();
      const metrics = computeMetrics(state.accounts, state.deals, state.activities, settings.follow_up_days);
      return {
        revision: state.revision,
        accounts: state.accounts,
        deals: state.deals,
        activities: state.activities,
        metrics,
        settings,
      };
    }

    if (contribution === 'crm.account.save') {
      const record = sanitizeAccount({ ...input, updated_at: todayStr() });
      if (!record) return { status: 'invalid_input', revision: input.expected_revision };
      const cur = await readCollection(COL_ACCOUNTS);
      if (cur.revision !== input.expected_revision) return { status: 'conflict', revision: cur.revision };
      const exists = cur.items.some(a => a.id === record.id);
      const next = exists ? cur.items.map(a => (a.id === record.id ? record : a)) : [record, ...cur.items];
      return writeCollection(COL_ACCOUNTS, input.expected_revision, next, MAX_ACCOUNTS);
    }

    if (contribution === 'crm.account.delete') {
      const state = await readAll();
      if (state.revision !== input.expected_revision) return { status: 'conflict', revision: state.revision };
      if (!state.accounts.some(a => a.id === input.id)) return { status: 'not_found', revision: state.revision };

      const nextAcc = state.accounts.filter(a => a.id !== input.id);
      const nextDeals = state.deals.filter(d => d.account_id !== input.id);
      const nextActs = state.activities.filter(a => a.account_id !== input.id);

      let rev = input.expected_revision;
      const r1 = await writeCollection(COL_ACCOUNTS, rev, nextAcc, MAX_ACCOUNTS);
      if (r1.status !== 'saved') return { status: 'conflict', revision: r1.revision };
      rev = r1.revision;

      if (nextDeals.length !== state.deals.length) {
        const r2 = await writeCollection(COL_DEALS, rev, nextDeals, MAX_DEALS);
        if (r2.status !== 'saved') return { status: 'conflict', revision: r2.revision };
        rev = r2.revision;
      }
      if (nextActs.length !== state.activities.length) {
        const r3 = await writeCollection(COL_ACTIVITIES, rev, nextActs, MAX_ACTIVITIES);
        if (r3.status !== 'saved') return { status: 'conflict', revision: r3.revision };
        rev = r3.revision;
      }
      return { status: 'deleted', revision: rev };
    }

    if (contribution === 'crm.deal.save') {
      const record = sanitizeDeal({ ...input, updated_at: todayStr() });
      if (!record) return { status: 'invalid_input', revision: input.expected_revision };
      const acc = await readCollection(COL_ACCOUNTS);
      const deals = await readCollection(COL_DEALS);
      const rev = Math.max(acc.revision, deals.revision);
      if (rev !== input.expected_revision) return { status: 'conflict', revision: rev };
      if (!acc.items.some(a => a.id === record.account_id)) {
        return { status: 'account_not_found', revision: rev };
      }
      const exists = deals.items.some(d => d.id === record.id);
      const next = exists ? deals.items.map(d => (d.id === record.id ? record : d)) : [record, ...deals.items];
      return writeCollection(COL_DEALS, input.expected_revision, next, MAX_DEALS);
    }

    if (contribution === 'crm.deal.stage') {
      const deals = await readCollection(COL_DEALS);
      if (deals.revision !== input.expected_revision) return { status: 'conflict', revision: deals.revision };
      const target = deals.items.find(d => d.id === input.id);
      if (!target) return { status: 'not_found', revision: deals.revision };
      const prob = typeof input.probability === 'number' ? input.probability : STAGE_PROB[input.stage];
      const updated = {
        ...target,
        stage: input.stage,
        probability: prob,
        loss_reason: typeof input.loss_reason === 'string' ? input.loss_reason.trim().slice(0, 160) : target.loss_reason,
        updated_at: todayStr(),
      };
      const next = deals.items.map(d => (d.id === input.id ? updated : d));
      const res = await writeCollection(COL_DEALS, input.expected_revision, next, MAX_DEALS);
      if (res.status !== 'saved') return { status: 'conflict', revision: res.revision };
      return { status: 'saved', revision: res.revision, stage: updated.stage, probability: updated.probability };
    }

    if (contribution === 'crm.deal.delete') {
      const deals = await readCollection(COL_DEALS);
      if (deals.revision !== input.expected_revision) return { status: 'conflict', revision: deals.revision };
      if (!deals.items.some(d => d.id === input.id)) return { status: 'not_found', revision: deals.revision };
      const res = await writeCollection(COL_DEALS, input.expected_revision, deals.items.filter(d => d.id !== input.id), MAX_DEALS);
      return res.status === 'saved' ? { status: 'deleted', revision: res.revision } : { status: 'conflict', revision: res.revision };
    }

    if (contribution === 'crm.activity.save') {
      const record = sanitizeActivity(input);
      if (!record) return { status: 'invalid_input', revision: input.expected_revision };
      const acc = await readCollection(COL_ACCOUNTS);
      const acts = await readCollection(COL_ACTIVITIES);
      const rev = Math.max(acc.revision, acts.revision);
      if (rev !== input.expected_revision) return { status: 'conflict', revision: rev };
      if (!acc.items.some(a => a.id === record.account_id)) {
        return { status: 'account_not_found', revision: rev };
      }
      const exists = acts.items.some(a => a.id === record.id);
      const next = exists ? acts.items.map(a => (a.id === record.id ? record : a)) : [record, ...acts.items];
      return writeCollection(COL_ACTIVITIES, input.expected_revision, next, MAX_ACTIVITIES);
    }

    if (contribution === 'crm.activity.delete') {
      const acts = await readCollection(COL_ACTIVITIES);
      if (acts.revision !== input.expected_revision) return { status: 'conflict', revision: acts.revision };
      if (!acts.items.some(a => a.id === input.id)) return { status: 'not_found', revision: acts.revision };
      const res = await writeCollection(COL_ACTIVITIES, input.expected_revision, acts.items.filter(a => a.id !== input.id), MAX_ACTIVITIES);
      return res.status === 'saved' ? { status: 'deleted', revision: res.revision } : { status: 'conflict', revision: res.revision };
    }

    if (contribution === 'crm.demo.seed') {
      const cur = await readCollection(COL_ACCOUNTS);
      if (cur.revision !== input.expected_revision) return { status: 'conflict', revision: cur.revision };
      const demo = buildDemoDataset();
      let rev = input.expected_revision;
      const r1 = await writeCollection(COL_ACCOUNTS, rev, demo.accounts, MAX_ACCOUNTS);
      if (r1.status !== 'saved') return { status: 'conflict', revision: r1.revision };
      rev = r1.revision;
      const r2 = await writeCollection(COL_DEALS, rev, demo.deals, MAX_DEALS);
      if (r2.status !== 'saved') return { status: 'conflict', revision: r2.revision };
      rev = r2.revision;
      const r3 = await writeCollection(COL_ACTIVITIES, rev, demo.activities, MAX_ACTIVITIES);
      if (r3.status !== 'saved') return { status: 'conflict', revision: r3.revision };
      return {
        status: 'seeded',
        revision: r3.revision,
        counts: {
          accounts: demo.accounts.length,
          deals: demo.deals.length,
          activities: demo.activities.length,
        },
      };
    }

    if (contribution === 'document.list') {
      const listed = await globalThis.nmas.data.list({ collection: COL_ACCOUNTS, limit: 20 });
      const state = listed.keys.length ? await readAll() : { accounts: [], deals: [], activities: [] };
      const items = [
        {
          id: 'all',
          label: `完整 CRM 快照（${state.accounts.length} 客户 / ${state.deals.length} 商机 / ${state.activities.length} 互动）`,
        },
        ...state.accounts.map(a => ({ id: a.id, label: `客户 360° 档案：${a.name} (${a.industry})` })),
      ];
      return { items };
    }

    if (contribution === 'document.export') {
      const state = await readAll();
      if (input.id === 'all') {
        const payload = {
          format: DOC_FORMAT,
          version: 1,
          scope: 'full',
          accounts: state.accounts,
          deals: state.deals,
          activities: state.activities,
        };
        const text = JSON.stringify(payload);
        if (jsonBytes(text) > MAX_RECORD_BYTES) return { error: 'payload_too_large' };
        return { filename: `crm-sales-os-${todayStr()}.json`, text };
      }
      const acc = state.accounts.find(a => a.id === input.id);
      if (!acc) return { error: 'not_found' };
      const payload = {
        format: DOC_FORMAT,
        version: 1,
        scope: 'account',
        accounts: [acc],
        deals: state.deals.filter(d => d.account_id === acc.id),
        activities: state.activities.filter(a => a.account_id === acc.id),
      };
      const text = JSON.stringify(payload);
      if (jsonBytes(text) > MAX_RECORD_BYTES) return { error: 'payload_too_large' };
      return { filename: `crm-${acc.id}.json`, text };
    }

    if (contribution === 'document.import') {
      let parsed;
      try {
        parsed = JSON.parse(input.text);
      } catch {
        return { imported: false, reason: 'invalid_json' };
      }
      if (
        !parsed ||
        parsed.format !== DOC_FORMAT ||
        parsed.version !== 1 ||
        !Array.isArray(parsed.accounts) ||
        !Array.isArray(parsed.deals) ||
        !Array.isArray(parsed.activities)
      ) {
        return { imported: false, reason: 'invalid_document' };
      }
      const cleanAcc = parsed.accounts.map(sanitizeAccount).filter(Boolean);
      const cleanDeals = parsed.deals.map(sanitizeDeal).filter(Boolean);
      const cleanActs = parsed.activities.map(sanitizeActivity).filter(Boolean);
      if (!cleanAcc.length) return { imported: false, reason: 'empty_accounts' };

      const state = await readAll();
      let nextAcc;
      let nextDeals;
      let nextActs;
      if (parsed.scope === 'full') {
        nextAcc = cleanAcc;
        nextDeals = cleanDeals;
        nextActs = cleanActs;
      } else {
        const mergeById = (base, incoming) => {
          const map = new Map(base.map(x => [x.id, x]));
          for (const item of incoming) map.set(item.id, item);
          return Array.from(map.values());
        };
        nextAcc = mergeById(state.accounts, cleanAcc);
        nextDeals = mergeById(state.deals, cleanDeals);
        nextActs = mergeById(state.activities, cleanActs);
      }

      let rev = state.revision;
      const r1 = await writeCollection(COL_ACCOUNTS, rev, nextAcc, MAX_ACCOUNTS);
      if (r1.status !== 'saved') return { imported: false, reason: r1.status };
      rev = r1.revision;
      const r2 = await writeCollection(COL_DEALS, rev, nextDeals, MAX_DEALS);
      if (r2.status !== 'saved') return { imported: false, reason: r2.status };
      rev = r2.revision;
      const r3 = await writeCollection(COL_ACTIVITIES, rev, nextActs, MAX_ACTIVITIES);
      if (r3.status !== 'saved') return { imported: false, reason: r3.status };
      return { imported: true };
    }
  }

  if (kind === 'tool') {
    if (contribution === 'crm.pipeline') {
      const state = await readAll();
      const metrics = computeMetrics(state.accounts, state.deals, state.activities);
      const accNameMap = new Map(state.accounts.map(a => [a.id, a.name]));
      const filteredDeals = input.stage ? state.deals.filter(d => d.stage === input.stage) : state.deals;
      const topDeals = [...filteredDeals]
        .sort((a, b) => b.amount - a.amount)
        .slice(0, 8)
        .map(d => ({
          id: d.id,
          title: d.title,
          account_name: accNameMap.get(d.account_id) || d.account_id,
          stage: d.stage,
          amount: d.amount,
          probability: d.probability,
          close_date: d.close_date,
        }));
      return {
        success: true,
        status: state.deals.length ? 'ready' : 'empty',
        summary: {
          active_pipeline: metrics.active_pipeline,
          weighted_forecast: metrics.weighted_forecast,
          won_amount: metrics.won_amount,
          win_rate: metrics.win_rate,
          overdue_count: metrics.overdue_count,
          due_soon_count: metrics.due_soon_count,
        },
        stages: metrics.funnel,
        top_deals: topDeals,
      };
    }

    if (contribution === 'crm.account.get') {
      const state = await readAll();
      const acc = findAccountByNameOrId(state.accounts, input.name);
      if (!acc) return { success: false, status: 'not_found' };
      const accDeals = state.deals.filter(d => d.account_id === acc.id);
      const totalDealAmount = round2(accDeals.reduce((s, d) => s + (Number(d.amount) || 0), 0));
      const recentActs = state.activities
        .filter(a => a.account_id === acc.id)
        .sort((a, b) => b.date.localeCompare(a.date))
        .slice(0, 6)
        .map(({ id, type, date, summary, next_action, next_due, done }) => ({
          id,
          type,
          date,
          summary,
          next_action,
          next_due,
          done,
        }));
      return {
        success: true,
        status: 'found',
        account: {
          id: acc.id,
          name: acc.name,
          industry: acc.industry,
          size: acc.size,
          health: acc.health,
          contact_name: acc.contact_name,
          contact_role: acc.contact_role,
          annual_potential: acc.annual_potential,
          risk_note: acc.risk_note,
          total_deal_amount: totalDealAmount,
        },
        deals: accDeals.map(({ id, title, stage, amount, probability, close_date }) => ({
          id,
          title,
          stage,
          amount,
          probability,
          close_date,
        })),
        recent_activities: recentActs,
      };
    }

    if (contribution === 'crm.activity.log') {
      const state = await readAll();
      const acc = findAccountByNameOrId(state.accounts, input.account_name);
      if (!acc) return { success: false, status: 'account_not_found' };
      const date = input.date || todayStr();
      const nextDue = input.next_due || '';
      const dealId = input.deal_id || '';
      const record = sanitizeActivity({
        id: makeId('act'),
        account_id: acc.id,
        deal_id: dealId,
        type: input.type,
        date,
        summary: input.summary,
        next_action: input.next_action || '',
        next_due: nextDue,
        done: false,
      });
      if (!record) return { success: false, status: 'invalid_input' };
      const res = await writeCollection(COL_ACTIVITIES, state.revision, [record, ...state.activities], MAX_ACTIVITIES);
      if (res.status !== 'saved') {
        return { success: false, status: res.status === 'limit' ? 'limit' : 'conflict' };
      }
      return {
        success: true,
        status: 'logged',
        activity_id: record.id,
        account_name: acc.name,
      };
    }
  }

  throw new Error(`不支持的调用: ${kind}/${contribution}`);
}
