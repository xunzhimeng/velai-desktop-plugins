const MAX_RECORD_BYTES = 13 * 1024;
const MAX_SESSIONS = 40;
const CATEGORIES = ['coding', 'writing', 'research', 'planning', 'ops', 'chat'];
const DOC_FORMAT = 'velai.usage-analytics-hub';

const r2 = n => Math.round(n * 100) / 100;
const r3 = n => Math.round(n * 1000) / 1000;

function jsonBytes(v) {
  let b = 0;
  for (const ch of JSON.stringify(v)) {
    const cp = ch.codePointAt(0);
    b += cp <= 0x7f ? 1 : cp <= 0x7ff ? 2 : cp <= 0xffff ? 3 : 4;
  }
  return b;
}

const DEFAULT_CONFIG = {
  schema_version: 1,
  monthly_cost_usd: 45,
  monthly_tokens_m: 12,
  latest_review: '',
};

async function readKey(collection, key, fallback) {
  const res = await globalThis.nmas.data.read({ collection, key });
  return { revision: res.revision, value: res.value === null ? fallback : res.value };
}

async function writeKey(collection, key, expectedRevision, value) {
  if (jsonBytes(value) > MAX_RECORD_BYTES) return { status: 'limit', revision: expectedRevision };
  try {
    const res = await globalThis.nmas.data.write({ collection, key, expected_revision: expectedRevision, value });
    return { status: 'saved', revision: res.revision };
  } catch (e) {
    if (e?.code === 'conflict' && e.outcome_unknown === false) return { status: 'conflict', revision: expectedRevision };
    throw e;
  }
}

function estimateCost(model, inTok, outTok, cachedTok) {
  const m = (model || '').toLowerCase();
  let inRate = 2.0, outRate = 8.0; // USD per 1M tokens
  if (m.includes('flash') || m.includes('mini') || m.includes('haiku')) { inRate = 0.25; outRate = 1.0; }
  else if (m.includes('deepseek')) { inRate = 0.55; outRate = 2.19; }
  else if (m.includes('claude') && m.includes('opus')) { inRate = 15.0; outRate = 75.0; }
  else if (m.includes('claude')) { inRate = 3.0; outRate = 15.0; }
  else if (m.includes('gemini') && m.includes('pro')) { inRate = 1.25; outRate = 10.0; }
  else if (m.includes('gpt-4')) { inRate = 2.5; outRate = 10.0; }
  const billableIn = Math.max(0, inTok - cachedTok) + cachedTok * 0.25;
  return r3((billableIn * inRate + outTok * outRate) / 1_000_000);
}

function validDate(d) {
  return typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d);
}

function sanitizeSession(raw, fallbackId) {
  const date = validDate(raw.date) ? raw.date : new Date().toISOString().slice(0, 10);
  const title = typeof raw.title === 'string' ? raw.title.trim().slice(0, 100) : '';
  const model = typeof raw.model === 'string' ? raw.model.trim().slice(0, 48) : '';
  const category = CATEGORIES.includes(raw.category) ? raw.category : 'chat';
  if (!title || !model) return null;
  const input_tokens = Math.max(0, Math.round(Number(raw.input_tokens) || 0));
  const output_tokens = Math.max(0, Math.round(Number(raw.output_tokens) || 0));
  const cached_tokens = Math.min(input_tokens, Math.max(0, Math.round(Number(raw.cached_tokens) || 0)));
  const cost_usd = raw.cost_usd !== undefined && Number.isFinite(Number(raw.cost_usd)) && Number(raw.cost_usd) >= 0
    ? r3(Number(raw.cost_usd))
    : estimateCost(model, input_tokens, output_tokens, cached_tokens);
  const hour = Number.isInteger(raw.hour) && raw.hour >= 0 && raw.hour <= 23 ? raw.hour : 14;
  const turns = Math.min(10000, Math.max(1, Math.round(Number(raw.turns) || 6)));
  const minutes = Math.min(1440, Math.max(1, Math.round(Number(raw.minutes) || 12)));
  const rating = Math.min(5, Math.max(1, Math.round(Number(raw.rating) || 4)));
  const id = typeof raw.id === 'string' && /^[a-zA-Z0-9._-]+$/.test(raw.id) ? raw.id.slice(0, 48) : fallbackId;
  return {
    id,
    date,
    hour,
    title,
    category,
    model,
    input_tokens,
    output_tokens,
    cached_tokens,
    cost_usd,
    turns,
    minutes,
    rating,
    summary: typeof raw.summary === 'string' ? raw.summary.trim().slice(0, 260) : '',
    tags: typeof raw.tags === 'string' ? raw.tags.trim().slice(0, 80) : '',
  };
}

function sortSessions(list) {
  return list.slice().sort((a, b) => (b.date + String(b.hour).padStart(2, '0')).localeCompare(a.date + String(a.hour).padStart(2, '0')));
}

function dateDiffDays(a, b) {
  const ta = Date.parse(`${a}T00:00:00Z`), tb = Date.parse(`${b}T00:00:00Z`);
  return Math.round((ta - tb) / 86400000);
}

function aggregate(allSessions, config, range = '30d') {
  const sorted = sortSessions(allSessions);
  const anchorDate = sorted.length ? sorted[0].date : new Date().toISOString().slice(0, 10);
  const maxDays = range === '7d' ? 7 : range === '30d' ? 30 : 3650;
  const filtered = range === 'all'
    ? sorted
    : sorted.filter(s => {
        const diff = dateDiffDays(anchorDate, s.date);
        return diff >= 0 && diff < maxDays;
      });

  let input_tokens = 0, output_tokens = 0, cached_tokens = 0, total_cost_usd = 0;
  let total_minutes = 0, total_turns = 0, ratingSum = 0;
  const dayMap = new Map();
  const modelMap = new Map();
  const catMap = new Map();
  const hours = new Array(24).fill(0);

  for (const s of filtered) {
    const tok = s.input_tokens + s.output_tokens;
    input_tokens += s.input_tokens;
    output_tokens += s.output_tokens;
    cached_tokens += s.cached_tokens;
    total_cost_usd += s.cost_usd;
    total_minutes += s.minutes;
    total_turns += s.turns;
    ratingSum += s.rating;
    hours[s.hour] += 1;

    const d = dayMap.get(s.date) || { date: s.date, sessions: 0, tokens: 0, cached: 0, cost_usd: 0, minutes: 0 };
    d.sessions += 1; d.tokens += tok; d.cached += s.cached_tokens; d.cost_usd = r3(d.cost_usd + s.cost_usd); d.minutes += s.minutes;
    dayMap.set(s.date, d);

    const m = modelMap.get(s.model) || { model: s.model, sessions: 0, tokens: 0, inTok: 0, cached: 0, cost_usd: 0, ratingSum: 0 };
    m.sessions += 1; m.tokens += tok; m.inTok += s.input_tokens; m.cached += s.cached_tokens; m.cost_usd = r3(m.cost_usd + s.cost_usd); m.ratingSum += s.rating;
    modelMap.set(s.model, m);

    const c = catMap.get(s.category) || { category: s.category, sessions: 0, tokens: 0, cost_usd: 0, ratingSum: 0 };
    c.sessions += 1; c.tokens += tok; c.cost_usd = r3(c.cost_usd + s.cost_usd); c.ratingSum += s.rating;
    catMap.set(s.category, c);
  }

  const total_tokens = input_tokens + output_tokens;
  const cache_hit_pct = input_tokens > 0 ? r2((cached_tokens / input_tokens) * 100) : 0;
  const avg_rating = filtered.length ? r2(ratingSum / filtered.length) : 0;

  // daily ascending
  const daily = Array.from(dayMap.values()).sort((a, b) => a.date.localeCompare(b.date));
  // streak calculation from anchorDate
  let streak_days = 0;
  if (daily.length) {
    const activeSet = new Set(daily.map(d => d.date));
    let cursor = new Date(`${anchorDate}T00:00:00Z`);
    while (activeSet.has(cursor.toISOString().slice(0, 10))) {
      streak_days += 1;
      cursor = new Date(cursor.getTime() - 86400000);
    }
  }
  let peak_hour = 0;
  for (let h = 1; h < 24; h++) if (hours[h] > hours[peak_hour]) peak_hour = h;

  const models = Array.from(modelMap.values())
    .map(m => ({
      model: m.model,
      sessions: m.sessions,
      tokens: m.tokens,
      cost_usd: r2(m.cost_usd),
      avg_rating: r2(m.ratingSum / m.sessions),
      share_pct: total_tokens > 0 ? r2((m.tokens / total_tokens) * 100) : 0,
      cache_pct: m.inTok > 0 ? r2((m.cached / m.inTok) * 100) : 0,
    }))
    .sort((a, b) => b.tokens - a.tokens);

  const categories = Array.from(catMap.values())
    .map(c => ({
      category: c.category,
      sessions: c.sessions,
      tokens: c.tokens,
      cost_usd: r2(c.cost_usd),
      avg_rating: r2(c.ratingSum / c.sessions),
      share_pct: total_tokens > 0 ? r2((c.tokens / total_tokens) * 100) : 0,
    }))
    .sort((a, b) => b.tokens - a.tokens);

  // 月度预算口径：统计最近 30 天汇总
  const monthSessions = sorted.filter(s => {
    const diff = dateDiffDays(anchorDate, s.date);
    return diff >= 0 && diff < 30;
  });
  const monthCost = monthSessions.reduce((a, s) => a + s.cost_usd, 0);
  const monthTokens = monthSessions.reduce((a, s) => a + s.input_tokens + s.output_tokens, 0);
  const cost_used_pct = r2((monthCost / Math.max(0.01, config.monthly_cost_usd)) * 100);
  const token_used_pct = r2(((monthTokens / 1_000_000) / Math.max(0.01, config.monthly_tokens_m)) * 100);
  const peakPct = Math.max(cost_used_pct, token_used_pct);
  const alert_level = peakPct >= 90 ? 'critical' : peakPct >= 70 ? 'warn' : 'ok';

  return {
    range,
    kpis: {
      session_count: filtered.length,
      total_tokens,
      input_tokens,
      output_tokens,
      cached_tokens,
      cache_hit_pct,
      total_cost_usd: r2(total_cost_usd),
      total_minutes,
      total_turns,
      avg_rating,
      active_days: daily.length,
      streak_days,
      peak_hour,
    },
    budget: {
      monthly_cost_usd: config.monthly_cost_usd,
      monthly_tokens_m: config.monthly_tokens_m,
      cost_used_pct,
      token_used_pct,
      alert_level,
    },
    daily,
    models,
    categories,
    hours,
    sessions: filtered,
    latest_review: config.latest_review || '',
  };
}

function demoData() {
  const raw = [
    ['s-01', '2026-11-21', 19, 'Velai 旗舰原生插件套件架构与 Seatbelt 实测', 'coding', 'Gemini 2.5 Pro', 420000, 96000, 295000, 1.38, 28, 64, 5, '完成 10 个旗舰插件并通过真实 macOS QuickJS Seatbelt 验证', 'plugins,rust,quickjs'],
    ['s-02', '2026-11-21', 15, '股票 AI 投研终端回测策略与 DCF 模型推导', 'research', 'Claude Sonnet 4', 185000, 42000, 110000, 0.94, 16, 38, 5, '实现双均线/RSI/布林带回测与安全边际估值引擎', 'quant,finance'],
    ['s-03', '2026-11-20', 22, '长篇科幻《星渊回响》第一卷人物关系与伏笔设计', 'writing', 'Claude Sonnet 4', 142000, 58000, 88000, 1.10, 19, 45, 5, '确立林深/沈清秋/陆沉舟三角张力及 4 条核心伏笔', 'novel,creative'],
    ['s-04', '2026-11-20', 16, 'macOS 原生插件 GitHub Release 签名更新验收', 'ops', 'Gemini 2.5 Flash', 96000, 21000, 62000, 0.04, 11, 18, 4, '核对 ed25519 签名与代理回滚路径', 'release,ci'],
    ['s-05', '2026-11-19', 20, '桌面端 Session Store 分片压缩性能诊断', 'coding', 'Gemini 2.5 Pro', 310000, 68000, 215000, 0.96, 22, 52, 5, '定位 SQLite WAL 写入热点并将加载耗时降低 42%', 'sqlite,perf'],
    ['s-06', '2026-11-19', 11, 'Q4 桌面端产品路线图与 RICE 需求排期评审', 'planning', 'GPT-4.1', 88000, 26000, 45000, 0.40, 12, 24, 4, '完成 8 个重点需求打分与 12 周里程碑拆解', 'roadmap,prd'],
    ['s-07', '2026-11-18', 21, 'Agent Tool 沙箱权限模型安全论文精读与对比', 'research', 'Claude Sonnet 4', 215000, 49000, 148000, 1.05, 17, 42, 5, '对比 6 篇主流 Agent 隔离与工具调用协议论文', 'papers,security'],
    ['s-08', '2026-11-18', 14, '每日站会纪要提炼与客户跟进邮件起草', 'writing', 'Gemini 2.5 Flash', 42000, 14000, 24000, 0.02, 7, 10, 4, '生成 3 封高回复率 B2B 方案推进邮件', 'email,crm'],
    ['s-09', '2026-11-17', 19, 'React + Antd 插件页隔离 iframe 通信重构', 'coding', 'Gemini 2.5 Pro', 268000, 61000, 180000, 0.85, 21, 48, 5, '消除跨页 lease 竞争并补齐回归单测', 'frontend,ipc'],
    ['s-10', '2026-11-16', 17, '家庭资产配置再平衡与 20 年 FIRE 现金流测算', 'planning', 'DeepSeek R1', 124000, 38000, 72000, 0.12, 14, 30, 5, '制定股债 60/40 再平衡策略与房贷提前还款方案', 'finance,fire'],
    ['s-11', '2026-11-15', 22, 'QuickJS 内存限制与 Promise Rejection Tracker 排查', 'coding', 'Claude Sonnet 4', 240000, 52000, 165000, 1.12, 18, 41, 5, '解决未处理拒绝计数边界条件', 'rust,quickjs'],
    ['s-12', '2026-11-14', 15, 'Syncthing 跨端文件冲突排查脚本编写', 'ops', 'Gemini 2.5 Flash', 64000, 19000, 36000, 0.03, 9, 14, 4, '输出一键冲突文件扫描与归档命令', 'shell,sync'],
    ['s-13', '2026-11-12', 20, '公众号与小红书爆款技术长文一稿多改', 'writing', 'GPT-4.1', 112000, 44000, 58000, 0.62, 13, 28, 4, '产出公众号深度文 + 小红书卡片 + X 串推', 'content,growth'],
    ['s-14', '2026-11-10', 10, '分布式订单与风控微服务 OpenAPI 契约设计', 'coding', 'Gemini 2.5 Pro', 198000, 54000, 128000, 0.72, 16, 36, 5, '消除支付与风控循环依赖并生成 TS SDK 类型', 'api,arch'],
    ['s-15', '2026-11-08', 21, '日常技术概念速查与英语地道表达润色', 'chat', 'Gemini 2.5 Flash', 36000, 12000, 18000, 0.02, 8, 9, 3, '高频短问答与英文文档语法润色', 'quick,english'],
    ['s-16', '2026-11-05', 16, 'LLM Prompt Caching 成本优化方案测算', 'research', 'DeepSeek R1', 156000, 41000, 112000, 0.14, 14, 33, 5, '通过前缀稳定化将系统提示缓存命中率提升至 72%', 'llm,cache'],
    ['s-17', '2026-11-02', 19, 'Tauri 桌面应用安装包体积瘦身与签名排查', 'ops', 'Gemini 2.5 Pro', 175000, 39000, 115000, 0.56, 15, 34, 4, '优化产物打包流程并清理冗余依赖', 'tauri,macos'],
    ['s-18', '2026-10-29', 14, '季度 OKR 目标拆解与关键指标复盘', 'planning', 'GPT-4.1', 78000, 24000, 41000, 0.36, 10, 22, 4, '对齐 Q4 研发交付与插件生态建设核心 KR', 'okr,review'],
  ];

  const sessions = raw.map(([id, date, hour, title, category, model, input_tokens, output_tokens, cached_tokens, cost_usd, turns, minutes, rating, summary, tags]) => ({
    id, date, hour, title, category, model, input_tokens, output_tokens, cached_tokens, cost_usd, turns, minutes, rating, summary, tags,
  }));

  const config = {
    schema_version: 1,
    monthly_cost_usd: 15,
    monthly_tokens_m: 6,
    latest_review: '【近 30 天个人 AI 使用复盘】\n1. 效率亮点：编程与架构类会话占比最高（约 52%），且高价值（5 星）会话集中在晚间 19:00–22:00 深度专注时段。\n2. 成本控制：整体 Prompt 缓存命中率达 66%+，轻量任务合理分流至 Flash/DeepSeek，有效拉低综合千 Token 成本。\n3. 优化建议：可继续把常规摘要与润色固定在轻量模型，将高阶模型额度留给跨文件重构与深度投研。',
  };

  return { sessions, config };
}

export default async function (request) {
  const { kind, contribution, input } = request ?? {};

  if (kind === 'action') {
    if (contribution === 'usage.dashboard') {
      const sRes = await readKey('sessions', 'index', { schema_version: 1, items: [] });
      const gRes = await readKey('goals', 'config', DEFAULT_CONFIG);
      const data = aggregate(sRes.value.items || [], { ...DEFAULT_CONFIG, ...gRes.value }, input.range || '30d');
      return { revision: Math.max(sRes.revision, gRes.revision), ...data };
    }

    if (contribution === 'usage.session.save') {
      const sRes = await readKey('sessions', 'index', { schema_version: 1, items: [] });
      if (sRes.revision !== input.expected_revision) return { status: 'conflict', revision: sRes.revision };
      const rec = sanitizeSession(input, input.id);
      if (!rec) return { status: 'invalid_input', revision: sRes.revision };
      const list = sRes.value.items || [];
      const exists = list.some(s => s.id === rec.id);
      const next = sortSessions(exists ? list.map(s => (s.id === rec.id ? rec : s)) : [rec, ...list]).slice(0, MAX_SESSIONS);
      return writeKey('sessions', 'index', input.expected_revision, { schema_version: 1, items: next });
    }

    if (contribution === 'usage.session.batch_ingest') {
      const sRes = await readKey('sessions', 'index', { schema_version: 1, items: [] });
      if (sRes.revision !== input.expected_revision) return { status: 'conflict', revision: sRes.revision, ingested: 0 };
      if (!Array.isArray(input.items) || !input.items.length) return { status: 'invalid_input', revision: sRes.revision, ingested: 0 };
      const map = new Map((sRes.value.items || []).map(s => [s.id, s]));
      let ingested = 0;
      for (let i = 0; i < input.items.length; i++) {
        const rec = sanitizeSession(input.items[i], `s-${Date.now().toString(36)}-${i}`);
        if (!rec) continue;
        map.set(rec.id, rec);
        ingested += 1;
      }
      if (!ingested) return { status: 'invalid_input', revision: sRes.revision, ingested: 0 };
      const next = sortSessions(Array.from(map.values())).slice(0, MAX_SESSIONS);
      const w = await writeKey('sessions', 'index', input.expected_revision, { schema_version: 1, items: next });
      return { status: w.status, revision: w.revision, ingested: w.status === 'saved' ? ingested : 0 };
    }

    if (contribution === 'usage.session.delete') {
      const sRes = await readKey('sessions', 'index', { schema_version: 1, items: [] });
      if (sRes.revision !== input.expected_revision) return { status: 'conflict', revision: sRes.revision };
      const list = sRes.value.items || [];
      if (!list.some(s => s.id === input.id)) return { status: 'not_found', revision: sRes.revision };
      const w = await writeKey('sessions', 'index', input.expected_revision, { schema_version: 1, items: list.filter(s => s.id !== input.id) });
      return w.status === 'saved' ? { status: 'deleted', revision: w.revision } : { status: 'conflict', revision: w.revision };
    }

    if (contribution === 'usage.config.save') {
      const gRes = await readKey('goals', 'config', DEFAULT_CONFIG);
      if (gRes.revision !== input.expected_revision) return { status: 'conflict', revision: gRes.revision };
      const next = {
        schema_version: 1,
        monthly_cost_usd: r2(input.monthly_cost_usd),
        monthly_tokens_m: r2(input.monthly_tokens_m),
        latest_review: input.latest_review !== undefined ? input.latest_review.trim() : (gRes.value.latest_review || ''),
      };
      return writeKey('goals', 'config', input.expected_revision, next);
    }

    if (contribution === 'usage.seed_demo') {
      const sRes = await readKey('sessions', 'index', { schema_version: 1, items: [] });
      if (sRes.revision !== input.expected_revision) return { status: 'conflict', revision: sRes.revision };
      const d = demoData();
      const w1 = await writeKey('sessions', 'index', input.expected_revision, { schema_version: 1, items: d.sessions });
      if (w1.status !== 'saved') return { status: 'conflict', revision: w1.revision };
      const w2 = await writeKey('goals', 'config', w1.revision, d.config);
      if (w2.status !== 'saved') return { status: 'conflict', revision: w2.revision };
      return { status: 'seeded', revision: w2.revision };
    }

    if (contribution === 'document.list') {
      const sRes = await readKey('sessions', 'index', { items: [] });
      return { items: sRes.value.items?.length ? [{ id: 'telemetry', label: `个人会话与用量档案 (${sRes.value.items.length} 条)` }] : [] };
    }

    if (contribution === 'document.export') {
      if (input.id !== 'telemetry') return { error: 'not_found' };
      const sRes = await readKey('sessions', 'index', { items: [] });
      const gRes = await readKey('goals', 'config', DEFAULT_CONFIG);
      const text = JSON.stringify({ format: DOC_FORMAT, version: 1, sessions: sRes.value.items, config: gRes.value }, null, 2);
      return { filename: 'velai-usage-analytics.json', text };
    }

    if (contribution === 'document.import') {
      let parsed;
      try { parsed = JSON.parse(input.text); } catch { return { imported: false, reason: 'invalid_json' }; }
      if (parsed?.format !== DOC_FORMAT || parsed?.version !== 1 || !Array.isArray(parsed.sessions)) {
        return { imported: false, reason: 'invalid_document' };
      }
      const sRes = await readKey('sessions', 'index', { items: [] });
      const map = new Map((sRes.value.items || []).map(s => [s.id, s]));
      for (let i = 0; i < parsed.sessions.length; i++) {
        const rec = sanitizeSession(parsed.sessions[i], `imp-${Date.now().toString(36)}-${i}`);
        if (rec) map.set(rec.id, rec);
      }
      const next = sortSessions(Array.from(map.values())).slice(0, MAX_SESSIONS);
      const w1 = await writeKey('sessions', 'index', sRes.revision, { schema_version: 1, items: next });
      if (w1.status !== 'saved') return { imported: false, reason: w1.status };
      if (parsed.config) {
        await writeKey('goals', 'config', w1.revision, {
          schema_version: 1,
          monthly_cost_usd: Math.max(1, Number(parsed.config.monthly_cost_usd) || 45),
          monthly_tokens_m: Math.max(0.1, Number(parsed.config.monthly_tokens_m) || 12),
          latest_review: typeof parsed.config.latest_review === 'string' ? parsed.config.latest_review.slice(0, 1600) : '',
        });
      }
      return { imported: true };
    }
  }

  if (kind === 'tool') {
    if (contribution === 'usage.dashboard.summary') {
      const sRes = await readKey('sessions', 'index', { items: [] });
      const gRes = await readKey('goals', 'config', DEFAULT_CONFIG);
      const agg = aggregate(sRes.value.items || [], { ...DEFAULT_CONFIG, ...gRes.value }, input.range || '30d');
      return {
        success: true,
        status: agg.kpis.session_count ? 'ready' : 'empty',
        session_count: agg.kpis.session_count,
        total_tokens: agg.kpis.total_tokens,
        cache_hit_pct: agg.kpis.cache_hit_pct,
        total_cost_usd: agg.kpis.total_cost_usd,
        budget_alert: agg.budget.alert_level,
        top_model: agg.models[0]?.model || '暂无',
        top_category: agg.categories[0]?.category || '暂无',
        peak_hour: agg.kpis.peak_hour,
      };
    }

    if (contribution === 'usage.session.record') {
      const sRes = await readKey('sessions', 'index', { schema_version: 1, items: [] });
      const id = `s-${Date.now().toString(36)}`;
      const rec = sanitizeSession(input, id);
      if (!rec) return { success: false, status: 'invalid_input' };
      const next = sortSessions([rec, ...(sRes.value.items || [])]).slice(0, MAX_SESSIONS);
      const saved = await writeKey('sessions', 'index', sRes.revision, { schema_version: 1, items: next });
      return { success: saved.status === 'saved', status: saved.status, id };
    }

    if (contribution === 'usage.budget.status') {
      const sRes = await readKey('sessions', 'index', { items: [] });
      const gRes = await readKey('goals', 'config', DEFAULT_CONFIG);
      const agg = aggregate(sRes.value.items || [], { ...DEFAULT_CONFIG, ...gRes.value }, '30d');
      return {
        success: true,
        status: 'ready',
        alert_level: agg.budget.alert_level,
        cost_used_pct: agg.budget.cost_used_pct,
        token_used_pct: agg.budget.token_used_pct,
        monthly_cost_usd: agg.budget.monthly_cost_usd,
        spent_cost_usd: agg.kpis.total_cost_usd,
      };
    }
  }

  throw new Error(`不支持的调用: ${kind}/${contribution}`);
}
