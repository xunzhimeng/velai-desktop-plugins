const MAX_RECORD_BYTES = 13 * 1024;
const DOC_FORMAT = 'velai.stock-ai-terminal';

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
    return { ok: false, metrics: { strategy_return_pct: 0, benchmark_return_pct: 0, alpha_pct: 0, max_drawdown_pct: 0, win_rate_pct: 0, sharpe: 0, trade_count: 0 }, equity: [], benchmark: [], trades: [] };
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
      const wRes = await readKey('watchlist', 'list', { schema_version: 1, items: [] });
      const pRes = await readKey('portfolio', 'book', { schema_version: 1, cash: 200000, positions: [] });
      const rRes = await readKey('research', 'notes', { schema_version: 1, notes: [] });
      const watchlist = wRes.value.items || [];
      const positions = pRes.value.positions || [];
      const cash = pRes.value.cash ?? 200000;
      return {
        revision: wRes.revision,
        cash,
        watchlist,
        positions,
        notes: rRes.value.notes || [],
        summary: summarizePortfolio(cash, watchlist, positions),
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
      return { items: wRes.value.items?.length ? [{ id: 'snapshot', label: `投研组合与研报快照 (${wRes.value.items.length} 标的)` }] : [] };
    }

    if (contribution === 'document.export') {
      if (input.id !== 'snapshot') return { error: 'not_found' };
      const w = await readKey('watchlist', 'list', { items: [] });
      const p = await readKey('portfolio', 'book', { cash: 0, positions: [] });
      const r = await readKey('research', 'notes', { notes: [] });
      const text = JSON.stringify({ format: DOC_FORMAT, version: 1, watchlist: w.value.items, portfolio: p.value, notes: r.value.notes }, null, 2);
      return { filename: 'stock-ai-terminal.json', text };
    }

    if (contribution === 'document.import') {
      let parsed;
      try { parsed = JSON.parse(input.text); } catch { return { imported: false, reason: 'invalid_json' }; }
      if (parsed?.format !== DOC_FORMAT || parsed?.version !== 1 || !Array.isArray(parsed.watchlist)) {
        return { imported: false, reason: 'invalid_document' };
      }
      const wRes = await readKey('watchlist', 'list', { schema_version: 1, items: [] });
      let rev = wRes.revision;
      const w1 = await writeKey('watchlist', 'list', rev, { schema_version: 1, items: parsed.watchlist.slice(0, 20) });
      if (w1.status !== 'saved') return { imported: false, reason: w1.status };
      rev = w1.revision;
      if (parsed.portfolio) {
        const w2 = await writeKey('portfolio', 'book', rev, { schema_version: 1, cash: Number(parsed.portfolio.cash) || 0, positions: parsed.portfolio.positions || [] });
        if (w2.status !== 'saved') return { imported: false, reason: w2.status };
        rev = w2.revision;
      }
      if (Array.isArray(parsed.notes)) {
        const w3 = await writeKey('research', 'notes', rev, { schema_version: 1, notes: parsed.notes.slice(0, 20) });
        if (w3.status !== 'saved') return { imported: false, reason: w3.status };
      }
      return { imported: true };
    }
  }

  if (kind === 'tool') {
    if (contribution === 'stock.portfolio') {
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
        };
      });
      return {
        success: true,
        status: detail.length ? 'ready' : 'empty',
        total_assets: sum.total_assets,
        unrealized_pnl: sum.unrealized_pnl,
        positions: detail,
      };
    }

    if (contribution === 'stock.analyze') {
      const sym = input.symbol.trim().toUpperCase();
      const wRes = await readKey('watchlist', 'list', { items: [] });
      const kRes = await readKey('strategies', `k:${sym}`, null);
      const rRes = await readKey('research', 'notes', { notes: [] });
      const stock = (wRes.value.items || []).find(x => x.symbol === sym);
      if (!stock) return { success: false, status: 'not_found' };
      const ind = calcIndicators(kRes.value?.bars || []);
      const note = (rRes.value.notes || []).find(n => n.symbol === sym);
      return {
        success: true,
        status: 'ready',
        name: stock.name,
        price: stock.price,
        pe: stock.pe,
        roe: stock.roe,
        rsi14: ind.rsi14,
        signal: ind.signal,
        latest_thesis: note?.thesis || '暂无投研笔记',
      };
    }

    if (contribution === 'stock.note.add') {
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
