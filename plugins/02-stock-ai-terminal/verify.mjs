import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function makeYahooMockPayload(symbol, closes) {
  const baseTs = Math.floor(Date.parse('2026-10-15T14:30:00Z') / 1000);
  const timestamp = closes.map((_, i) => baseTs + i * 86400);
  const open = closes.map(c => Number((c * 0.992).toFixed(2)));
  const high = closes.map(c => Number((c * 1.015).toFixed(2)));
  const low = closes.map(c => Number((c * 0.985).toFixed(2)));
  const volume = closes.map((_, i) => 28000000 + i * 350000);
  const last = closes[closes.length - 1];
  const prev = closes[closes.length - 2];
  return {
    chart: {
      result: [
        {
          meta: {
            currency: 'USD',
            symbol,
            exchangeName: 'NMS',
            shortName: `${symbol} Corp`,
            regularMarketPrice: last,
            previousClose: prev,
            chartPreviousClose: closes[0],
          },
          timestamp,
          indicators: {
            quote: [{ open, high, low, close: closes, volume }],
          },
        },
      ],
      error: null,
    },
  };
}

export async function verify({ pluginDir, manifest, createHarness }) {
  // 0. 静态核对 v2 契约与 UI 移除 session.turn.*
  assert.equal(manifest.manifest_version, 2);
  assert.equal(manifest.host_api, 2);
  assert.equal(manifest.version, '2.0.0');
  assert.ok(!manifest.permissions.some(p => p.startsWith('tasks.')));
  assert.ok(!manifest.actions.some(a => a.id.startsWith('session.turn')));
  const uiHtml = readFileSync(join(pluginDir, 'ui/index.html'), 'utf8');
  assert.ok(uiHtml.includes('lang="zh-CN"') && uiHtml.includes('data-theme="dark"'));
  assert.ok(!uiHtml.includes('session.turn'));
  assert.ok(uiHtml.includes('stock-ai-copilot'));

  // 1. 主流程 + settings.get()（不含 secret）+ Yahoo/Finnhub/FX HTTP v2 + Data List/Delete + 3 v2 Tools + 全部量化回归
  const seenYahooReqs = [];
  const seenFinnhubReqs = [];
  const seenFxReqs = [];

  const h = await createHarness({
    settingsMock: {
      default_market: 'HK',
      risk_profile: 'growth',
      enable_live_quotes: true,
      market_api_key: 'SHOULD_NEVER_LEAK_TO_SETTINGS',
    },
    secretsConfigured: {
      market_api_key: true,
    },
    httpMock: {
      0: req => {
        seenYahooReqs.push(req);
        if (req.path === '/v8/finance/chart/ERR503') {
          return { status: 503, content_type: 'application/json', body: null, json: { error: 'service_unavailable' } };
        }
        return makeYahooMockPayload('NVDA', [
          132.5, 134.0, 133.2, 135.8, 137.4, 136.9, 139.2, 141.0,
          140.4, 142.8, 144.6, 146.1, 145.5, 147.9, 151.2, 154.6,
        ]);
      },
      1: req => {
        seenFinnhubReqs.push(req);
        // 返回带有额外敏感/非投影字段的 JSON，验证宿主仅投影 c/d/dp/h/l/o/pc
        return {
          c: 238.45,
          d: 3.95,
          dp: 1.68,
          h: 240.1,
          l: 235.2,
          o: 236.0,
          pc: 234.5,
          t: 1763800000,
          secret_echo: 'MUST_BE_STRIPPED',
        };
      },
      2: req => {
        seenFxReqs.push(req);
        if (req.query?.base === 'ERR') {
          return { status: 502, content_type: 'application/json', body: null, json: { error: 'bad_gateway' } };
        }
        return {
          amount: 1.0,
          base: req.query?.base || 'USD',
          date: '2026-11-22',
          rates: { CNY: 7.2345, HKD: 7.7812, EUR: 0.9415 },
        };
      },
    },
  });

  // 1.1 演示组合初始化与 bootstrap（检查 settings.get() 且无 secret 泄漏）
  const seeded = await h.action('stock.seed_demo', { expected_revision: 0 });
  assert.equal(seeded.status, 'seeded');

  const boot = await h.action('stock.bootstrap', {});
  assert.equal(boot.watchlist.length, 5);
  assert.equal(boot.positions.length, 4);
  assert.ok(boot.summary.total_assets > 500000);
  assert.deepEqual(boot.settings, {
    default_market: 'HK',
    risk_profile: 'growth',
    enable_live_quotes: true,
  });
  assert.ok(!('market_api_key' in boot.settings));
  assert.ok(!JSON.stringify(boot).includes('SHOULD_NEVER_LEAK_TO_SETTINGS'));

  // 1.2 原有量化 K 线、3 种回测策略、DCF、自选/持仓/研报增改回归
  const kl = await h.action('stock.kline.get', { symbol: 'NVDA' });
  assert.equal(kl.found, true);
  assert.equal(kl.bars.length, 42);
  assert.ok(kl.indicators.ma5 > 0 && kl.indicators.rsi14 >= 0 && kl.indicators.rsi14 <= 100);

  for (const strategy of ['ma_cross', 'rsi_revert', 'bollinger']) {
    const bt = await h.action('stock.backtest', { symbol: 'NVDA', strategy, fast: 5, slow: 15 });
    assert.equal(bt.ok, true);
    assert.equal(bt.equity.length, 42);
    assert.equal(bt.benchmark.length, 42);
  }

  const dcf = await h.action('stock.dcf', {
    fcf_billion: 60, growth_pct: 20, terminal_pct: 3.5, wacc_pct: 9.5, shares_billion: 24.5, current_price: 146.8,
  });
  assert.ok(dcf.intrinsic_value > 0);
  assert.ok(['undervalued', 'fair', 'overvalued'].includes(dcf.verdict));

  const up = await h.action('stock.watchlist.upsert', {
    expected_revision: boot.revision,
    symbol: 'TSLA',
    name: '特斯拉',
    market: 'US',
    sector: '智能电动车与机器人',
    price: 342.5,
    change_pct: 4.12,
    pe: 82.0,
    pb: 14.5,
    roe: 18.2,
    rev_growth: 12.5,
  });
  assert.equal(up.status, 'saved');

  const psave = await h.action('stock.portfolio.save', {
    expected_revision: up.revision,
    cash: 150000,
    positions: [
      ...boot.positions,
      { symbol: 'TSLA', shares: 100, avg_cost: 310, stop_loss: 280, target_price: 420 },
    ],
  });
  assert.equal(psave.status, 'saved');

  const nsave = await h.action('stock.note.save', {
    expected_revision: psave.revision,
    id: 'n-tsla',
    symbol: 'TSLA',
    rating: 'buy',
    target_price: 420,
    thesis: 'FSD 端到端迭代加速与储能业务放量支撑估值中枢。',
    risks: '汽车价格战压缩毛利率。',
  });
  assert.equal(nsave.status, 'saved');

  // 1.3 V2 Data List / Delete 自定义快照键闭环
  const snapSaved = await h.action('stock.snapshot.save', {
    expected_revision: nsave.revision,
    key: 'snap:q4-plan',
    memo: 'Q4 跨市场调仓前备份',
  });
  assert.equal(snapSaved.status, 'saved');

  const listed = await h.action('stock.snapshot.list', { prefix: 'snap:', limit: 20 });
  assert.deepEqual(listed.keys, ['snap:q4-plan']);

  const badDel = await h.action('stock.record.delete', {
    expected_revision: listed.revision,
    collection: 'research',
    key: 'notes',
  });
  assert.equal(badDel.status, 'invalid_key');

  const delOk = await h.action('stock.record.delete', {
    expected_revision: listed.revision,
    collection: 'research',
    key: 'snap:q4-plan',
  });
  assert.equal(delOk.status, 'deleted');

  const listedAfter = await h.action('stock.snapshot.list', { prefix: 'snap:', limit: 20 });
  assert.deepEqual(listedAfter.keys, []);

  // 1.4 Yahoo HTTP v2 path_prefix + query + headers 实时行情与 persist 写回
  const yq = await h.action('stock.fetch_live_quote', {
    symbol: 'NVDA',
    source: 'yahoo',
    range: '1mo',
    persist: true,
  });
  assert.equal(yq.ok, true);
  assert.equal(yq.status, 'ok');
  assert.equal(yq.source, 'yahoo');
  assert.equal(yq.price, 154.6);
  assert.equal(yq.bars_count, 16);
  assert.equal(yq.persisted, true);
  assert.equal(seenYahooReqs[0].path, '/v8/finance/chart/NVDA');
  assert.deepEqual(seenYahooReqs[0].query, { interval: '1d', range: '1mo' });
  assert.deepEqual(seenYahooReqs[0].headers, { accept: 'application/json' });

  const klAfterLive = await h.action('stock.kline.get', { symbol: 'NVDA' });
  assert.equal(klAfterLive.found, true);
  assert.equal(klAfterLive.bars.length, 16);
  assert.equal(klAfterLive.bars[klAfterLive.bars.length - 1].c, 154.6);

  // Yahoo 非 2xx 显式错误
  const yErr = await h.action('stock.fetch_live_quote', { symbol: 'ERR503', source: 'yahoo' });
  assert.equal(yErr.ok, false);
  assert.equal(yErr.status, 'upstream_error');
  assert.equal(yErr.http_status, 503);

  // 1.5 Finnhub 密钥槽标量投影（Rule #1）
  const fq = await h.action('stock.fetch_live_quote', {
    symbol: 'AAPL',
    source: 'finnhub_secret',
    persist: true,
  });
  assert.equal(fq.ok, true);
  assert.equal(fq.status, 'ok');
  assert.equal(fq.source, 'finnhub_secret');
  assert.equal(fq.price, 238.45);
  assert.equal(fq.change, 3.95);
  assert.equal(fq.change_pct, 1.68);
  assert.equal(fq.high, 240.1);
  assert.equal(fq.low, 235.2);
  assert.equal(fq.open, 236.0);
  assert.equal(fq.prev_close, 234.5);
  assert.equal(fq.persisted, true);
  assert.equal(seenFinnhubReqs[0].path, '/api/v1/quote');
  assert.equal(seenFinnhubReqs[0].query, undefined);
  assert.equal(seenFinnhubReqs[0].headers, undefined);
  assert.ok(!JSON.stringify(fq).includes('MUST_BE_STRIPPED'));

  // 1.6 FX 实时汇率（Rule #2）及上游错误
  const fx = await h.action('stock.fetch_fx_rate', { base: 'USD', symbols: 'CNY,HKD' });
  assert.equal(fx.ok, true);
  assert.equal(fx.base, 'USD');
  assert.equal(fx.date, '2026-11-22');
  assert.equal(fx.rates.find(r => r.currency === 'CNY')?.rate, 7.2345);
  assert.equal(seenFxReqs[0].path, '/v1/latest');
  assert.deepEqual(seenFxReqs[0].query, { base: 'USD', symbols: 'CNY,HKD' });
  assert.deepEqual(seenFxReqs[0].headers, { accept: 'application/json' });

  const fxErr = await h.action('stock.fetch_fx_rate', { base: 'ERR', symbols: 'CNY' });
  assert.equal(fxErr.ok, false);
  assert.equal(fxErr.status, 'upstream_error');
  assert.equal(fxErr.http_status, 502);

  // 1.7 3 个 V2 Agent Tools
  const portTool = await h.tool('stock.get_portfolio_summary', {});
  assert.equal(portTool.success, true);
  assert.equal(portTool.status, 'ready');
  assert.equal(portTool.positions.length, 5);
  assert.equal(portTool.risk_profile, 'growth');

  const liveToolYahoo = await h.tool('stock.fetch_quote_live', { symbol: 'NVDA', source: 'yahoo', range: '1mo' });
  assert.equal(liveToolYahoo.success, true);
  assert.equal(liveToolYahoo.status, 'ready');
  assert.equal(liveToolYahoo.price, 154.6);
  assert.equal(liveToolYahoo.name, '英伟达');
  assert.ok(typeof liveToolYahoo.rsi14 === 'number' && liveToolYahoo.signal.length > 0);
  assert.ok(liveToolYahoo.latest_thesis.includes('Blackwell'));

  const liveToolFinnhub = await h.tool('stock.fetch_quote_live', { symbol: 'AAPL', source: 'finnhub_secret' });
  assert.equal(liveToolFinnhub.success, true);
  assert.equal(liveToolFinnhub.status, 'ready');
  assert.equal(liveToolFinnhub.price, 238.45);

  const addNoteTool = await h.tool('stock.record_research_note', {
    symbol: 'AAPL',
    rating: 'hold',
    target_price: 245,
    thesis: '服务业务高毛利稳健，等待端侧 AI 换机周期兑现。',
  });
  assert.equal(addNoteTool.success, true);
  assert.equal(addNoteTool.status, 'saved');

  // 1.8 文档导入导出回归
  const docList = await h.action('document.list', {});
  assert.ok(docList.items.some(i => i.id === 'snapshot'));
  const exp = await h.action('document.export', { id: 'snapshot' });
  assert.equal(exp.filename, 'stock-ai-terminal.json');
  const imp = await h.action('document.import', { text: exp.text });
  assert.equal(imp.imported, true);

  // 2. 未配置密钥槽时的显式错误（Action + Tool）与默认配置检查
  const hNoSecret = await createHarness({
    secretsConfigured: {},
    httpMock: {
      1: () => ({ c: 100, d: 1, dp: 1, h: 101, l: 99, o: 100, pc: 99 }),
    },
  });
  const bootDefault = await hNoSecret.action('stock.bootstrap', {});
  assert.deepEqual(bootDefault.settings, {
    default_market: 'US',
    risk_profile: 'balanced',
    enable_live_quotes: true,
  });

  const noSecAction = await hNoSecret.action('stock.fetch_live_quote', {
    symbol: 'NVDA',
    source: 'finnhub_secret',
  });
  assert.equal(noSecAction.ok, false);
  assert.equal(noSecAction.status, 'credential_missing');
  assert.ok(noSecAction.error.includes('market_api_key'));

  const noSecTool = await hNoSecret.tool('stock.fetch_quote_live', {
    symbol: 'NVDA',
    source: 'finnhub_secret',
  });
  assert.equal(noSecTool.success, false);
  assert.equal(noSecTool.status, 'credential_missing');

  // 3. enable_live_quotes = false 开关显式拒绝
  const hDisabled = await createHarness({
    settingsMock: { enable_live_quotes: false },
  });
  const disabledRes = await hDisabled.action('stock.fetch_live_quote', { symbol: 'NVDA', source: 'yahoo' });
  assert.equal(disabledRes.ok, false);
  assert.equal(disabledRes.status, 'live_quotes_disabled');
}
