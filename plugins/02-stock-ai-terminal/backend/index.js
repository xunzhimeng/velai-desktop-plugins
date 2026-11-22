const MAX_RECORD_BYTES = 240 * 1024;
const DOC_FORMAT = 'velai.stock-ai-terminal';
const VALID_MARKETS = new Set(['US', 'HK', 'CN']);

const r2 = n => Math.round(n * 100) / 100;
const r4 = n => Math.round(n * 10000) / 10000;

function jsonBytes(v) {
  let b = 0;
  for (const ch of JSON.stringify(v)) {
    const cp = ch.codePointAt(0);
    b += cp <= 0x7f ? 1 : cp <= 0x7ff ? 2 : cp <= 0xffff ? 3 : 4;
  }
  return b;
}

function clipText(val, maxLen) {
  return String(val ?? '').trim().slice(0, maxLen);
}

function inferMarket(symbol, currency, defaultMarket) {
  if (symbol.endsWith('.HK') || currency === 'HKD') return 'HK';
  if (symbol.endsWith('.SS') || symbol.endsWith('.SZ') || currency === 'CNY') return 'CN';
  if (currency === 'USD') return 'US';
  return VALID_MARKETS.has(defaultMarket) ? defaultMarket : 'US';
}

async function readPublicSettings() {
  const raw = await globalThis.nmas.settings.get();
  const defaultMarket = typeof raw?.default_market === 'string' && raw.default_market.trim()
    ? raw.default_market.trim().slice(0, 32)
    : 'US';
  const riskProfile = typeof raw?.risk_profile === 'string' && raw.risk_profile.trim()
    ? raw.risk_profile.trim().slice(0, 32)
    : 'balanced';
  const enableLiveQuotes = typeof raw?.enable_live_quotes === 'boolean'
    ? raw.enable_live_quotes
    : true;
  return {
    default_market: defaultMarket,
    risk_profile: riskProfile,
    enable_live_quotes: enableLiveQuotes,
  };
}

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

async function deleteKey(collection, key, expectedRevision) {
  try {
    const res = await globalThis.nmas.data.delete({ collection, key, expected_revision: expectedRevision });
    return { status: 'deleted', revision: res.revision };
  } catch (e) {
    if (e?.code === 'conflict' && e.outcome_unknown === false) return { status: 'conflict', revision: expectedRevision };
    throw e;
  }
}

// 确定性伪随机 K 线生成器（支持新建自选股及高质量演示 K 线）
function synthBars(symbol, endPrice, drift = 0.0025, vol = 0.022, count = 42) {
  let seed = 0;
  for (const ch of symbol) seed = (seed * 131 + ch.charCodeAt(0)) % 2147483647;
  const rand = () => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  };
  const closes = [100];
  for (let i = 1; i < count; i++) {
    const wave = Math.sin(i / 4.2) * (vol * 0.45);
    const shock = (rand() - 0.48) * vol * 1.9;
    closes.push(Math.max(10, closes[i - 1] * (1 + drift + wave + shock)));
  }
  const scale = endPrice / closes[closes.length - 1];
  const bars = [];
  const baseDate = new Date('2026-09-25T00:00:00Z');
  for (let i = 0; i < count; i++) {
    const dt = new Date(baseDate.getTime() + i * 86400000);
    const c = r2(closes[i] * scale);
    const prev = i === 0 ? c * (1 - drift) : r2(closes[i - 1] * scale);
    const o = r2(prev * (1 + (rand() - 0.5) * vol * 0.45));
    const spread = Math.max(Math.abs(c - o) * (0.4 + rand() * 0.7), c * vol * 0.35);
    const h = r2(Math.max(o, c) + spread * (0.4 + rand() * 0.6));
    const l = r2(Math.max(0.01, Math.min(o, c) - spread * (0.4 + rand() * 0.6)));
    const v = Math.round((12 + rand() * 38 + Math.abs(c - o) / c * 600) * 100000);
    bars.push({ d: dt.toISOString().slice(5, 10), o, h, l, c, v });
  }
  return bars;
}

function sma(arr, period) {
  if (!arr.length) return 0;
  const slice = arr.slice(-Math.min(period, arr.length));
  return r2(slice.reduce((a, b) => a + b, 0) / slice.length);
}

function calcRSI(closes, period = 14) {
  if (closes.length < 3) return 50;
  const n = Math.min(period, closes.length - 1);
  let gains = 0, losses = 0;
  for (let i = closes.length - n; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }
  if (losses === 0) return 100;
  const rs = gains / losses;
  return r2(100 - 100 / (1 + rs));
}

function calcIndicators(bars) {
  const closes = bars.map(b => b.c);
  if (!closes.length) return { ma5: 0, ma10: 0, ma20: 0, rsi14: 50, volatility_pct: 0, signal: '无数据' };
  const ma5 = sma(closes, 5), ma10 = sma(closes, 10), ma20 = sma(closes, 20);
  const rsi14 = calcRSI(closes, 14);
  const rets = [];
  for (let i = 1; i < closes.length; i++) rets.push((closes[i] - closes[i - 1]) / closes[i - 1]);
  const mean = rets.reduce((a, b) => a + b, 0) / Math.max(1, rets.length);
  const variance = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, rets.length);
  const volatility_pct = r2(Math.sqrt(variance) * Math.sqrt(252) * 100);
  let signal = '中性震荡';
  if (ma5 > ma10 && ma10 > ma20 && rsi14 < 72) signal = '多头排列 · 趋势偏强';
  else if (rsi14 >= 72) signal = 'RSI 高位超买 · 警惕回调';
  else if (rsi14 <= 32) signal = 'RSI 超卖区间 · 关注反弹';
  else if (ma5 < ma10 && ma10 < ma20) signal = '空头排列 · 防守为主';
  return { ma5, ma10, ma20, rsi14, volatility_pct, signal };
}

function runBacktest(bars, strategy, fast, slow) {
  if (bars.length < 10) {
    return {
      ok: false,
      metrics: { strategy_return_pct: 0, benchmark_return_pct: 0, alpha_pct: 0, max_drawdown_pct: 0, win_rate_pct: 0, sharpe: 0, trade_count: 0 },
      equity: [],
      benchmark: [],
      trades: [],
    };
  }
  const closes = bars.map(b => b.c);
  let cash = 1, shares = 0, entryPrice = 0;
  let wins = 0, closedTrades = 0;
  const equity = [], benchmark = [], trades = [];
  const startClose = closes[0];

  const avgAt = (idx, win) => {
    const from = Math.max(0, idx - win + 1);
    let s = 0;
    for (let j = from; j <= idx; j++) s += closes[j];
    return s / (idx - from + 1);
  };
  const stdAt = (idx, win, mean) => {
    const from = Math.max(0, idx - win + 1);
    let s = 0;
    for (let j = from; j <= idx; j++) s += (closes[j] - mean) ** 2;
    return Math.sqrt(s / (idx - from + 1));
  };

  for (let i = 0; i < bars.length; i++) {
    const price = closes[i];
    benchmark.push(r4(price / startClose));
    let buySig = false, sellSig = false;

    if (i >= Math.max(fast, slow, 5)) {
      if (strategy === 'ma_cross') {
        const fNow = avgAt(i, fast), sNow = avgAt(i, slow);
        const fPrev = avgAt(i - 1, fast), sPrev = avgAt(i - 1, slow);
        buySig = fPrev <= sPrev && fNow > sNow;
        sellSig = fPrev >= sPrev && fNow < sNow;
      } else if (strategy === 'rsi_revert') {
        const rsi = calcRSI(closes.slice(0, i + 1), Math.max(6, fast));
        buySig = rsi < 38;
        sellSig = rsi > 65;
      } else if (strategy === 'bollinger') {
        const win = Math.max(10, slow);
        const m = avgAt(i, win);
        const sd = stdAt(i, win, m);
        buySig = price <= m - 1.5 * sd;
        sellSig = price >= m + 1.5 * sd;
      }
    }

    if (buySig && shares === 0) {
      shares = cash / price;
      cash = 0;
      entryPrice = price;
      trades.push({ date: bars[i].d, side: 'BUY', price, pnl_pct: 0 });
    } else if (sellSig && shares > 0) {
      cash = shares * price;
      const pnlPct = r2(((price - entryPrice) / entryPrice) * 100);
      if (pnlPct > 0) wins += 1;
      closedTrades += 1;
      shares = 0;
      trades.push({ date: bars[i].d, side: 'SELL', price, pnl_pct: pnlPct });
    }
    equity.push(r4(cash + shares * price));
  }

  let peak = equity[0], maxDd = 0;
  const dailyRets = [];
  for (let i = 0; i < equity.length; i++) {
    if (equity[i] > peak) peak = equity[i];
    const dd = (peak - equity[i]) / peak;
    if (dd > maxDd) maxDd = dd;
    if (i > 0) dailyRets.push((equity[i] - equity[i - 1]) / equity[i - 1]);
  }
  const meanR = dailyRets.reduce((a, b) => a + b, 0) / Math.max(1, dailyRets.length);
  const sdR = Math.sqrt(dailyRets.reduce((a, b) => a + (b - meanR) ** 2, 0) / Math.max(1, dailyRets.length));
  const sharpe = sdR > 0 ? r2((meanR / sdR) * Math.sqrt(252)) : 0;
  const stratRet = r2((equity[equity.length - 1] - 1) * 100);
  const benchRet = r2((benchmark[benchmark.length - 1] - 1) * 100);
  const winRate = closedTrades > 0 ? r2((wins / closedTrades) * 100) : (stratRet > 0 ? 100 : 0);

  return {
    ok: true,
    metrics: {
      strategy_return_pct: stratRet,
      benchmark_return_pct: benchRet,
      alpha_pct: r2(stratRet - benchRet),
      max_drawdown_pct: r2(maxDd * 100),
      win_rate_pct: winRate,
      sharpe,
      trade_count: trades.length,
    },
    equity,
    benchmark,
    trades: trades.slice(-16),
  };
}

function summarizePortfolio(cash, watchlist, positions) {
  const priceMap = new Map(watchlist.map(w => [w.symbol, w.price]));
  let market_value = 0, total_cost = 0;
  for (const p of positions) {
    const px = priceMap.get(p.symbol) ?? p.avg_cost;
    market_value += px * p.shares;
    total_cost += p.avg_cost * p.shares;
  }
  const total_assets = r2(cash + market_value);
  const unrealized_pnl = r2(market_value - total_cost);
  const pnl_pct = total_cost > 0 ? r2((unrealized_pnl / total_cost) * 100) : 0;
  const cash_pct = total_assets > 0 ? r2((cash / total_assets) * 100) : 100;
  return { total_assets, market_value: r2(market_value), total_cost: r2(total_cost), unrealized_pnl, pnl_pct, cash_pct };
}

function parseYahooChart(json, sym) {
  if (json?.chart?.error) {
    const errMsg = json.chart.error.description || json.chart.error.code || 'Yahoo chart 返回错误';
    return { ok: false, status: 'upstream_error', error: clipText(errMsg, 320) };
  }
  const result = json?.chart?.result?.[0];
  if (!result || typeof result !== 'object') {
    return { ok: false, status: 'parse_error', error: 'Yahoo 行情响应缺少 chart.result[0]' };
  }
  const meta = result.meta || {};
  const timestamps = Array.isArray(result.timestamp) ? result.timestamp : [];
  const quote = result.indicators?.quote?.[0] || {};
  const opens = Array.isArray(quote.open) ? quote.open : [];
  const highs = Array.isArray(quote.high) ? quote.high : [];
  const lows = Array.isArray(quote.low) ? quote.low : [];
  const closes = Array.isArray(quote.close) ? quote.close : [];
  const volumes = Array.isArray(quote.volume) ? quote.volume : [];

  const bars = [];
  for (let i = 0; i < timestamps.length; i++) {
    const ts = timestamps[i];
    const o = opens[i], h = highs[i], l = lows[i], c = closes[i];
    if (!Number.isFinite(ts) || !Number.isFinite(o) || !Number.isFinite(h) || !Number.isFinite(l) || !Number.isFinite(c) || c <= 0) {
      continue;
    }
    const v = Number.isFinite(volumes[i]) && volumes[i] >= 0 ? Math.round(volumes[i]) : 0;
    const d = new Date(ts * 1000).toISOString().slice(5, 10);
    bars.push({ d, o: r2(o), h: r2(h), l: r2(l), c: r2(c), v });
  }
  const trimmedBars = bars.slice(-120);
  const lastBar = trimmedBars.length ? trimmedBars[trimmedBars.length - 1] : null;
  const prevBar = trimmedBars.length >= 2 ? trimmedBars[trimmedBars.length - 2] : null;

  const rawPrice = Number.isFinite(meta.regularMarketPrice) && meta.regularMarketPrice > 0
    ? meta.regularMarketPrice
    : lastBar?.c;
  if (!Number.isFinite(rawPrice) || rawPrice <= 0) {
    return { ok: false, status: 'parse_error', error: '无法从 Yahoo 响应中解析有效现价' };
  }

  const prevCloseCandidates = [
    meta.regularMarketPreviousClose,
    meta.previousClose,
    prevBar?.c,
    meta.chartPreviousClose,
  ];
  const rawPrevClose = prevCloseCandidates.find(v => Number.isFinite(v) && v > 0) ?? rawPrice;
  const price = r2(rawPrice);
  const prevClose = r2(rawPrevClose);
  const change = r2(price - prevClose);
  const changePct = prevClose > 0 ? r2((change / prevClose) * 100) : 0;
  const open = r2(lastBar?.o ?? (Number.isFinite(meta.regularMarketOpen) ? meta.regularMarketOpen : price));
  const high = r2(lastBar?.h ?? (Number.isFinite(meta.regularMarketDayHigh) ? meta.regularMarketDayHigh : price));
  const low = r2(lastBar?.l ?? (Number.isFinite(meta.regularMarketDayLow) ? meta.regularMarketDayLow : price));

  return {
    ok: true,
    status: 'ok',
    name: clipText(meta.shortName || meta.longName || sym, 64),
    currency: clipText(meta.currency || 'USD', 12),
    price,
    change,
    change_pct: changePct,
    open,
    high,
    low,
    prev_close: prevClose,
    bars: trimmedBars,
  };
}

async function fetchLiveQuoteCore(symbolRaw, sourceRaw = 'yahoo', rangeRaw = '1mo') {
  const source = sourceRaw === 'finnhub_secret' ? 'finnhub_secret' : 'yahoo';
  const range = rangeRaw === '5d' || rangeRaw === '3mo' ? rangeRaw : '1mo';
  const sym = String(symbolRaw || '').trim().toUpperCase();
  if (!sym || sym.length > 16 || !/^[A-Z0-9._-]+$/.test(sym) || sym.includes('..')) {
    return { ok: false, status: 'invalid_symbol', source, symbol: sym.slice(0, 16), error: '无效股票代码格式' };
  }

  const settings = await readPublicSettings();
  if (!settings.enable_live_quotes) {
    return {
      ok: false,
      status: 'live_quotes_disabled',
      source,
      symbol: sym,
      error: '实时行情已在插件设置中关闭（enable_live_quotes = false）。',
    };
  }

  if (source === 'yahoo') {
    let res;
    try {
      res = await globalThis.nmas.http.request({
        rule: 0,
        method: 'GET',
        path: `/v8/finance/chart/${sym}`,
        query: { interval: '1d', range },
        headers: { accept: 'application/json' },
        responseType: 'json',
      });
    } catch (e) {
      return {
        ok: false,
        status: clipText(e?.code || 'http_error', 48),
        source,
        symbol: sym,
        error: clipText(e?.message || 'Yahoo 实时行情请求失败', 320),
      };
    }

    if (typeof res?.status === 'number' && (res.status < 200 || res.status >= 300)) {
      return {
        ok: false,
        status: 'upstream_error',
        source,
        symbol: sym,
        http_status: res.status,
        error: `Yahoo 行情上游返回非 2xx 状态码: HTTP ${res.status}`,
      };
    }

    const parsed = parseYahooChart(res?.json, sym);
    if (!parsed.ok) {
      return {
        ok: false,
        status: parsed.status,
        source,
        symbol: sym,
        http_status: typeof res?.status === 'number' ? res.status : 200,
        error: parsed.error,
      };
    }
    return {
      ok: true,
      status: 'ok',
      source,
      symbol: sym,
      name: parsed.name,
      currency: parsed.currency,
      price: parsed.price,
      change: parsed.change,
      change_pct: parsed.change_pct,
      open: parsed.open,
      high: parsed.high,
      low: parsed.low,
      prev_close: parsed.prev_close,
      bars: parsed.bars,
      bars_count: parsed.bars.length,
      settings,
    };
  }

  // source === 'finnhub_secret'（Rule #1：宿主加密密钥槽注入 + 窄标量投影）
  let res;
  try {
    res = await globalThis.nmas.http.request({
      rule: 1,
      method: 'GET',
      responseType: 'json',
    });
  } catch (e) {
    const code = clipText(e?.code || 'http_error', 48);
    const msg = code === 'credential_missing'
      ? '密钥槽 market_api_key 未配置或未确认，请在插件设置中填写 Finnhub API Key 后重试。'
      : clipText(e?.message || 'Finnhub 密钥槽行情请求失败', 320);
    return {
      ok: false,
      status: code,
      source,
      symbol: sym,
      error: msg,
    };
  }

  if (typeof res?.status === 'number' && (res.status < 200 || res.status >= 300)) {
    return {
      ok: false,
      status: 'upstream_error',
      source,
      symbol: sym,
      http_status: res.status,
      error: `Finnhub 上游返回非 2xx 状态码: HTTP ${res.status}`,
    };
  }

  const j = res?.json;
  if (
    !j ||
    typeof j !== 'object' ||
    !Number.isFinite(j.c) ||
    !Number.isFinite(j.d) ||
    !Number.isFinite(j.dp) ||
    !Number.isFinite(j.h) ||
    !Number.isFinite(j.l) ||
    !Number.isFinite(j.o) ||
    !Number.isFinite(j.pc)
  ) {
    return {
      ok: false,
      status: 'parse_error',
      source,
      symbol: sym,
      http_status: typeof res?.status === 'number' ? res.status : 200,
      error: 'Finnhub 标量投影缺少预期数值字段 (c/d/dp/h/l/o/pc)',
    };
  }
  if (j.c <= 0) {
    return {
      ok: false,
      status: 'empty_quote',
      source,
      symbol: sym,
      http_status: typeof res?.status === 'number' ? res.status : 200,
      error: 'Finnhub 返回当前价格 <= 0，未获取到有效行情',
    };
  }

  return {
    ok: true,
    status: 'ok',
    source,
    symbol: sym,
    name: sym,
    currency: 'USD',
    price: r2(j.c),
    change: r2(j.d),
    change_pct: r2(j.dp),
    open: r2(j.o),
    high: r2(j.h),
    low: r2(j.l),
    prev_close: r2(j.pc),
    bars: [],
    bars_count: 0,
    settings,
  };
}

function demoData() {
  const watchlist = [
    { symbol: 'NVDA', name: '英伟达', market: 'US', sector: 'AI 算力芯片', price: 146.8, change_pct: 2.84, pe: 48.2, pb: 38.5, roe: 112.4, rev_growth: 94.2 },
    { symbol: 'AAPL', name: '苹果', market: 'US', sector: '消费电子与生态', price: 234.5, change_pct: 0.92, pe: 34.1, pb: 49.2, roe: 147.8, rev_growth: 6.4 },
    { symbol: '00700', name: '腾讯控股', market: 'HK', sector: '互联网与 AI 应用', price: 428.6, change_pct: 1.65, pe: 19.4, pb: 4.1, roe: 21.8, rev_growth: 10.5 },
    { symbol: '600519', name: '贵州茅台', market: 'CN', sector: '高端消费', price: 1568.0, change_pct: -0.42, pe: 22.8, pb: 8.6, roe: 36.2, rev_growth: 13.8 },
    { symbol: '300750', name: '宁德时代', market: 'CN', sector: '新能源与储能', price: 268.4, change_pct: 3.15, pe: 24.5, pb: 5.3, roe: 24.1, rev_growth: 16.2 },
  ];
  const klines = {
    NVDA: synthBars('NVDA', 146.8, 0.0055, 0.032, 42),
    AAPL: synthBars('AAPL', 234.5, 0.0022, 0.016, 42),
    '00700': synthBars('00700', 428.6, 0.0031, 0.023, 42),
    '600519': synthBars('600519', 1568.0, -0.0008, 0.015, 42),
    '300750': synthBars('300750', 268.4, 0.0042, 0.026, 42),
  };
  const portfolio = {
    schema_version: 1,
    cash: 128000,
    positions: [
      { symbol: 'NVDA', shares: 1200, avg_cost: 118.5, stop_loss: 125.0, target_price: 175.0 },
      { symbol: '00700', shares: 400, avg_cost: 372.0, stop_loss: 360.0, target_price: 510.0 },
      { symbol: '300750', shares: 500, avg_cost: 224.0, stop_loss: 215.0, target_price: 320.0 },
      { symbol: '600519', shares: 60, avg_cost: 1610.0, stop_loss: 1450.0, target_price: 1850.0 },
    ],
  };
  const notes = [
    { id: 'n-nvda', symbol: 'NVDA', rating: 'strong_buy', target_price: 175, thesis: 'Blackwell 机架出货爬坡带动数据中心毛利率维持高位，CUDA 与 NVLink 生态护城河短期难以被替代。', risks: '云厂商资本开支增速见顶预期、出口管制政策扰动。', date: '2026-11-20' },
    { id: 'n-00700', symbol: '00700', rating: 'buy', target_price: 510, thesis: '微信生态视频号广告与高毛利长青游戏共振，持续大额回购提供极强估值底保护。', risks: '宏观消费恢复斜率偏缓。', date: '2026-11-18' },
    { id: 'n-300750', symbol: '300750', rating: 'buy', target_price: 320, thesis: '海外储能大单放量与神行电池渗透率提升，单位瓦时盈利维持行业断层第一。', risks: '欧美关税壁垒与碳酸锂价格剧烈波动。', date: '2026-11-15' },
  ];
  return { watchlist, klines, portfolio, notes };
}

export default async function (request) {
  const { kind, contribution, input } = request ?? {};

  if (kind === 'action') {
    if (contribution === 'stock.bootstrap') {
      const settings = await readPublicSettings();
      const wRes = await readKey('watchlist', 'list', { schema_version: 1, items: [] });
      const pRes = await readKey('portfolio', 'book', { schema_version: 1, cash: 200000, positions: [] });
      const rRes = await readKey('research', 'notes', { schema_version: 1, notes: [] });
      const sList = await globalThis.nmas.data.list({ collection: 'research', prefix: 'snap:', limit: 50 });
      const watchlist = wRes.value.items || [];
      const positions = pRes.value.positions || [];
      const cash = pRes.value.cash ?? 200000;
      return {
        revision: sList.revision,
        cash,
        settings,
        snapshots: sList.keys || [],
        watchlist,
        positions,
        notes: rRes.value.notes || [],
        summary: summarizePortfolio(cash, watchlist, positions),
      };
    }

    if (contribution === 'stock.fetch_live_quote') {
      const quote = await fetchLiveQuoteCore(input.symbol, input.source, input.range);
      if (!quote.ok) {
        const out = {
          ok: false,
          status: quote.status,
          source: quote.source,
          symbol: quote.symbol,
          error: quote.error,
        };
        if (quote.http_status !== undefined) out.http_status = quote.http_status;
        return out;
      }

      let persisted = false;
      let latestRevision;
      if (input.persist === true) {
        const wRes = await readKey('watchlist', 'list', { schema_version: 1, items: [] });
        let rev = wRes.revision;
        const items = wRes.value.items || [];
        const existing = items.find(x => x.symbol === quote.symbol);
        const clampedPrice = Math.min(1000000, Math.max(0.01, quote.price));
        const clampedChg = Math.min(1000, Math.max(-100, quote.change_pct));
        const nextItem = existing
          ? { ...existing, price: clampedPrice, change_pct: clampedChg }
          : {
              symbol: quote.symbol,
              name: clipText(quote.name || quote.symbol, 48),
              market: inferMarket(quote.symbol, quote.currency, quote.settings?.default_market),
              sector: '实时行情标的',
              price: clampedPrice,
              change_pct: clampedChg,
              pe: 0,
              pb: 0,
              roe: 0,
              rev_growth: 0,
            };
        const nextList = existing
          ? items.map(x => (x.symbol === quote.symbol ? nextItem : x))
          : [...items, nextItem];
        const w1 = await writeKey('watchlist', 'list', rev, { schema_version: 1, items: nextList });
        if (w1.status === 'saved') {
          rev = w1.revision;
          persisted = true;
          if (Array.isArray(quote.bars) && quote.bars.length >= 2) {
            const w2 = await writeKey('strategies', `k:${quote.symbol}`, rev, { schema_version: 1, bars: quote.bars });
            if (w2.status === 'saved') rev = w2.revision;
          }
        }
        latestRevision = rev;
      }

      const out = {
        ok: true,
        status: 'ok',
        source: quote.source,
        symbol: quote.symbol,
        name: quote.name,
        currency: quote.currency,
        price: quote.price,
        change: quote.change,
        change_pct: quote.change_pct,
        open: quote.open,
        high: quote.high,
        low: quote.low,
        prev_close: quote.prev_close,
        bars_count: quote.bars_count,
        persisted,
      };
      if (latestRevision !== undefined) out.revision = latestRevision;
      return out;
    }

    if (contribution === 'stock.fetch_fx_rate') {
      const base = String(input.base || 'USD').trim().toUpperCase();
      const symbols = String(input.symbols || 'CNY,HKD,EUR').trim().toUpperCase();
      if (!/^[A-Z]{3}$/.test(base) || !/^[A-Z]{3}(,[A-Z]{3})*$/.test(symbols)) {
        return { ok: false, status: 'invalid_input', base: base.slice(0, 8), rates: [], error: '货币代码格式无效（需 3 位 ISO 币种，如 USD / CNY,HKD）' };
      }

      let res;
      try {
        res = await globalThis.nmas.http.request({
          rule: 2,
          method: 'GET',
          path: '/v1/latest',
          query: { base, symbols },
          headers: { accept: 'application/json' },
          responseType: 'json',
        });
      } catch (e) {
        return {
          ok: false,
          status: clipText(e?.code || 'http_error', 48),
          base,
          rates: [],
          error: clipText(e?.message || '实时汇率请求失败', 320),
        };
      }

      if (typeof res?.status === 'number' && (res.status < 200 || res.status >= 300)) {
        return {
          ok: false,
          status: 'upstream_error',
          base,
          rates: [],
          http_status: res.status,
          error: `汇率上游返回非 2xx 状态码: HTTP ${res.status}`,
        };
      }

      const rawRates = res?.json?.rates;
      if (!rawRates || typeof rawRates !== 'object' || Array.isArray(rawRates)) {
        return {
          ok: false,
          status: 'parse_error',
          base,
          rates: [],
          http_status: typeof res?.status === 'number' ? res.status : 200,
          error: '汇率上游响应缺少 rates 字段',
        };
      }

      const rates = Object.entries(rawRates)
        .filter(([k, v]) => typeof k === 'string' && /^[A-Z]{3}$/.test(k) && Number.isFinite(v))
        .map(([currency, rate]) => ({ currency, rate: r4(rate) }))
        .sort((a, b) => a.currency.localeCompare(b.currency));

      if (!rates.length) {
        return {
          ok: false,
          status: 'parse_error',
          base,
          rates: [],
          http_status: typeof res?.status === 'number' ? res.status : 200,
          error: '未解析到有效汇率条目',
        };
      }

      return {
        ok: true,
        status: 'ok',
        base: clipText(res.json.base || base, 8),
        date: clipText(res.json.date || '', 16),
        rates,
      };
    }

    if (contribution === 'stock.kline.get') {
      const kRes = await readKey('strategies', `k:${input.symbol.toUpperCase()}`, null);
      if (!kRes.value || !Array.isArray(kRes.value.bars)) {
        return { found: false, bars: [], indicators: calcIndicators([]) };
      }
      return { found: true, bars: kRes.value.bars, indicators: calcIndicators(kRes.value.bars) };
    }

    if (contribution === 'stock.backtest') {
      const kRes = await readKey('strategies', `k:${input.symbol.toUpperCase()}`, null);
      const bars = kRes.value?.bars || [];
      return runBacktest(bars, input.strategy, input.fast, input.slow);
    }

    if (contribution === 'stock.dcf') {
      const { fcf_billion, growth_pct, terminal_pct, wacc_pct, shares_billion, current_price } = input;
      const g = growth_pct / 100, tg = terminal_pct / 100, r = wacc_pct / 100;
      const effR = Math.max(r, tg + 0.01);
      let pv = 0, fcf = fcf_billion;
      for (let yr = 1; yr <= 5; yr++) {
        fcf *= (1 + g);
        pv += fcf / ((1 + effR) ** yr);
      }
      const tv = (fcf * (1 + tg)) / (effR - tg);
      const pvTv = tv / ((1 + effR) ** 5);
      const ev = r2(pv + pvTv);
      const intrinsic = r2(ev / shares_billion);
      const mos = r2(((intrinsic - current_price) / intrinsic) * 100);
      const verdict = mos >= 15 ? 'undervalued' : mos <= -15 ? 'overvalued' : 'fair';
      return { intrinsic_value: intrinsic, margin_of_safety_pct: mos, enterprise_value_billion: ev, verdict };
    }

    if (contribution === 'stock.watchlist.upsert') {
      const sym = input.symbol.trim().toUpperCase();
      if (!sym || !/^[A-Z0-9._-]+$/.test(sym)) return { status: 'invalid_input', revision: input.expected_revision };
      const wRes = await readKey('watchlist', 'list', { schema_version: 1, items: [] });
      if (wRes.revision !== input.expected_revision) return { status: 'conflict', revision: wRes.revision };
      const item = {
        symbol: sym, name: input.name.trim(), market: input.market, sector: input.sector.trim(),
        price: r2(input.price), change_pct: r2(input.change_pct), pe: r2(input.pe),
        pb: r2(input.pb), roe: r2(input.roe), rev_growth: r2(input.rev_growth),
      };
      const items = wRes.value.items || [];
      const exists = items.some(x => x.symbol === sym);
      const next = exists ? items.map(x => (x.symbol === sym ? item : x)) : [...items, item];
      const w1 = await writeKey('watchlist', 'list', input.expected_revision, { schema_version: 1, items: next });
      if (w1.status !== 'saved') return w1;
      const bars = synthBars(sym, item.price, 0.002, 0.022, 42);
      const w2 = await writeKey('strategies', `k:${sym}`, w1.revision, { schema_version: 1, bars });
      return w2.status === 'saved' ? { status: 'saved', revision: w2.revision } : w2;
    }

    if (contribution === 'stock.portfolio.save') {
      const pRes = await readKey('portfolio', 'book', { schema_version: 1, cash: 200000, positions: [] });
      if (pRes.revision !== input.expected_revision) return { status: 'conflict', revision: pRes.revision };
      return writeKey('portfolio', 'book', input.expected_revision, {
        schema_version: 1,
        cash: r2(input.cash),
        positions: input.positions.filter(p => p.shares > 0),
      });
    }

    if (contribution === 'stock.note.save') {
      const rRes = await readKey('research', 'notes', { schema_version: 1, notes: [] });
      if (rRes.revision !== input.expected_revision) return { status: 'conflict', revision: rRes.revision };
      const rec = {
        id: input.id, symbol: input.symbol.trim().toUpperCase(), rating: input.rating,
        target_price: r2(input.target_price), thesis: input.thesis.trim(), risks: input.risks.trim(),
        date: new Date().toISOString().slice(0, 10),
      };
      const list = rRes.value.notes || [];
      const exists = list.some(n => n.id === rec.id);
      const next = exists ? list.map(n => (n.id === rec.id ? rec : n)) : [rec, ...list];
      return writeKey('research', 'notes', input.expected_revision, { schema_version: 1, notes: next });
    }

    if (contribution === 'stock.snapshot.save') {
      const key = String(input.key || '').trim();
      if (!/^(snap|note):[A-Za-z0-9._-]{1,56}$/.test(key)) {
        return { status: 'invalid_key', revision: input.expected_revision };
      }
      const wRes = await readKey('watchlist', 'list', { schema_version: 1, items: [] });
      if (wRes.revision !== input.expected_revision) return { status: 'conflict', revision: wRes.revision };
      const pRes = await readKey('portfolio', 'book', { schema_version: 1, cash: 200000, positions: [] });
      const rRes = await readKey('research', 'notes', { schema_version: 1, notes: [] });
      const payload = {
        schema_version: 1,
        saved_at: new Date().toISOString(),
        memo: clipText(input.memo || '', 400),
        watchlist: wRes.value.items || [],
        portfolio: pRes.value,
        notes: rRes.value.notes || [],
      };
      const wr = await writeKey('research', key, input.expected_revision, payload);
      return { status: wr.status, revision: wr.revision, key };
    }

    if (contribution === 'stock.snapshot.list') {
      const prefix = typeof input.prefix === 'string' ? input.prefix : 'snap:';
      const limit = Number.isInteger(input.limit) ? input.limit : 20;
      const listed = await globalThis.nmas.data.list({ collection: 'research', prefix, limit });
      return {
        keys: listed.keys || [],
        next_cursor: listed.next_cursor ?? null,
        revision: listed.revision,
      };
    }

    if (contribution === 'stock.record.delete') {
      const collection = input.collection;
      const key = String(input.key || '').trim();
      const allowed =
        (collection === 'research' && /^(snap|note):[A-Za-z0-9._-]{1,56}$/.test(key)) ||
        (collection === 'strategies' && /^k:[A-Z0-9._-]{1,16}$/.test(key));
      if (!allowed) {
        return { status: 'invalid_key', revision: input.expected_revision };
      }
      const cur = await readKey(collection, key, null);
      if (cur.revision !== input.expected_revision) {
        return { status: 'conflict', revision: cur.revision };
      }
      const del = await deleteKey(collection, key, input.expected_revision);
      return { status: del.status, revision: del.revision, key };
    }

    if (contribution === 'stock.seed_demo') {
      const wRes = await readKey('watchlist', 'list', { schema_version: 1, items: [] });
      if (wRes.revision !== input.expected_revision) return { status: 'conflict', revision: wRes.revision };
      const d = demoData();
      let rev = input.expected_revision;
      for (const [sym, bars] of Object.entries(d.klines)) {
        const wr = await writeKey('strategies', `k:${sym}`, rev, { schema_version: 1, bars });
        if (wr.status !== 'saved') return { status: 'conflict', revision: wr.revision };
        rev = wr.revision;
      }
      const wp = await writeKey('portfolio', 'book', rev, d.portfolio);
      if (wp.status !== 'saved') return { status: 'conflict', revision: wp.revision };
      rev = wp.revision;
      const wn = await writeKey('research', 'notes', rev, { schema_version: 1, notes: d.notes });
      if (wn.status !== 'saved') return { status: 'conflict', revision: wn.revision };
      rev = wn.revision;
      const ww = await writeKey('watchlist', 'list', rev, { schema_version: 1, items: d.watchlist });
      if (ww.status !== 'saved') return { status: 'conflict', revision: ww.revision };
      return { status: 'seeded', revision: ww.revision };
    }

    if (contribution === 'document.list') {
      const wRes = await readKey('watchlist', 'list', { schema_version: 1, items: [] });
      const sList = await globalThis.nmas.data.list({ collection: 'research', prefix: 'snap:', limit: 20 });
      const items = [];
      if (wRes.value.items?.length) {
        items.push({ id: 'snapshot', label: `投研组合与研报快照 (${wRes.value.items.length} 标的)` });
      }
      for (const k of sList.keys || []) {
        items.push({ id: k, label: `自定义快照 ${k}` });
      }
      return { items };
    }

    if (contribution === 'document.export') {
      if (input.id === 'snapshot') {
        const w = await readKey('watchlist', 'list', { items: [] });
        const p = await readKey('portfolio', 'book', { cash: 0, positions: [] });
        const r = await readKey('research', 'notes', { notes: [] });
        const text = JSON.stringify({ format: DOC_FORMAT, version: 1, watchlist: w.value.items, portfolio: p.value, notes: r.value.notes }, null, 2);
        return { filename: 'stock-ai-terminal.json', text };
      }
      if (/^snap:[A-Za-z0-9._-]{1,56}$/.test(input.id)) {
        const s = await readKey('research', input.id, null);
        if (!s.value) return { error: 'not_found' };
        const text = JSON.stringify({ format: DOC_FORMAT, version: 1, ...s.value }, null, 2);
        const safeName = input.id.replace(/[^A-Za-z0-9._-]/g, '_');
        return { filename: `${safeName}.json`, text };
      }
      return { error: 'not_found' };
    }

    if (contribution === 'document.import') {
      let parsed;
      try { parsed = JSON.parse(input.text); } catch { return { imported: false, reason: 'invalid_json' }; }
      if (parsed?.format !== DOC_FORMAT || parsed?.version !== 1 || !Array.isArray(parsed.watchlist)) {
        return { imported: false, reason: 'invalid_document' };
      }
      const wRes = await readKey('watchlist', 'list', { schema_version: 1, items: [] });
      let rev = wRes.revision;
      const w1 = await writeKey('watchlist', 'list', rev, { schema_version: 1, items: parsed.watchlist.slice(0, 50) });
      if (w1.status !== 'saved') return { imported: false, reason: w1.status };
      rev = w1.revision;
      if (parsed.portfolio) {
        const w2 = await writeKey('portfolio', 'book', rev, { schema_version: 1, cash: Number(parsed.portfolio.cash) || 0, positions: parsed.portfolio.positions || [] });
        if (w2.status !== 'saved') return { imported: false, reason: w2.status };
        rev = w2.revision;
      }
      if (Array.isArray(parsed.notes)) {
        const w3 = await writeKey('research', 'notes', rev, { schema_version: 1, notes: parsed.notes.slice(0, 100) });
        if (w3.status !== 'saved') return { imported: false, reason: w3.status };
      }
      return { imported: true };
    }
  }

  if (kind === 'tool') {
    if (contribution === 'stock.get_portfolio_summary') {
      const settings = await readPublicSettings();
      const wRes = await readKey('watchlist', 'list', { items: [] });
      const pRes = await readKey('portfolio', 'book', { cash: 200000, positions: [] });
      const wl = wRes.value.items || [];
      const pos = pRes.value.positions || [];
      const cash = pRes.value.cash ?? 200000;
      const sum = summarizePortfolio(cash, wl, pos);
      const map = new Map(wl.map(x => [x.symbol, x]));
      const detail = pos.map(p => {
        const info = map.get(p.symbol);
        const price = info?.price ?? p.avg_cost;
        const mv = price * p.shares;
        return {
          symbol: p.symbol,
          name: info?.name || p.symbol,
          shares: p.shares,
          price,
          avg_cost: p.avg_cost,
          pnl_pct: r2(((price - p.avg_cost) / p.avg_cost) * 100),
          weight_pct: sum.total_assets > 0 ? r2((mv / sum.total_assets) * 100) : 0,
          stop_loss: p.stop_loss ?? 0,
          target_price: p.target_price ?? 0,
        };
      });
      return {
        success: true,
        status: detail.length ? 'ready' : 'empty',
        total_assets: sum.total_assets,
        market_value: sum.market_value,
        cash,
        cash_pct: sum.cash_pct,
        unrealized_pnl: sum.unrealized_pnl,
        pnl_pct: sum.pnl_pct,
        risk_profile: settings.risk_profile,
        default_market: settings.default_market,
        positions: detail,
      };
    }

    if (contribution === 'stock.fetch_quote_live') {
      const quote = await fetchLiveQuoteCore(input.symbol, input.source, input.range);
      if (!quote.ok) {
        const out = {
          success: false,
          status: quote.status,
          source: quote.source,
          symbol: quote.symbol,
          error: quote.error,
        };
        if (quote.http_status !== undefined) out.http_status = quote.http_status;
        return out;
      }

      const wRes = await readKey('watchlist', 'list', { items: [] });
      const rRes = await readKey('research', 'notes', { notes: [] });
      const localStock = (wRes.value.items || []).find(x => x.symbol === quote.symbol);
      const localNote = (rRes.value.notes || []).find(n => n.symbol === quote.symbol);

      let barsForInd = quote.bars;
      if (!barsForInd.length) {
        const kRes = await readKey('strategies', `k:${quote.symbol}`, null);
        barsForInd = kRes.value?.bars || [];
      }
      const ind = barsForInd.length ? calcIndicators(barsForInd) : null;

      const out = {
        success: true,
        status: 'ready',
        source: quote.source,
        symbol: quote.symbol,
        name: localStock?.name || quote.name,
        currency: quote.currency,
        price: quote.price,
        change: quote.change,
        change_pct: quote.change_pct,
        open: quote.open,
        high: quote.high,
        low: quote.low,
        prev_close: quote.prev_close,
        bars_count: quote.bars_count,
        latest_thesis: localNote?.thesis || '暂无投研笔记',
      };
      if (ind) {
        out.rsi14 = ind.rsi14;
        out.signal = ind.signal;
      }
      if (localStock) {
        out.pe = localStock.pe;
        out.roe = localStock.roe;
      }
      return out;
    }

    if (contribution === 'stock.record_research_note') {
      const rRes = await readKey('research', 'notes', { schema_version: 1, notes: [] });
      const id = `n-${Date.now().toString(36)}`;
      const rec = {
        id,
        symbol: input.symbol.trim().toUpperCase(),
        rating: input.rating,
        target_price: r2(Number(input.target_price) || 0),
        thesis: input.thesis.trim(),
        risks: (input.risks || '').trim(),
        date: new Date().toISOString().slice(0, 10),
      };
      const saved = await writeKey('research', 'notes', rRes.revision, { schema_version: 1, notes: [rec, ...(rRes.value.notes || [])] });
      return { success: saved.status === 'saved', status: saved.status, id };
    }
  }

  throw new Error(`不支持的调用: ${kind}/${contribution}`);
}
