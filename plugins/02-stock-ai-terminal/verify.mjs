import assert from 'node:assert/strict';

export async function verify({ createHarness }) {
  const h = await createHarness();
  const seeded = await h.action('stock.seed_demo', { expected_revision: 0 });
  assert.equal(seeded.status, 'seeded');

  const boot = await h.action('stock.bootstrap', {});
  assert.equal(boot.watchlist.length, 5);
  assert.equal(boot.positions.length, 4);
  assert.ok(boot.summary.total_assets > 500000);

  const kl = await h.action('stock.kline.get', { symbol: 'NVDA' });
  assert.equal(kl.found, true);
  assert.equal(kl.bars.length, 42);
  assert.ok(kl.indicators.ma5 > 0 && kl.indicators.rsi14 >= 0 && kl.indicators.rsi14 <= 100);

  const bt = await h.action('stock.backtest', { symbol: 'NVDA', strategy: 'ma_cross', fast: 5, slow: 15 });
  assert.equal(bt.ok, true);
  assert.equal(bt.equity.length, 42);

  const dcf = await h.action('stock.dcf', {
    fcf_billion: 60, growth_pct: 20, terminal_pct: 3.5, wacc_pct: 9.5, shares_billion: 24.5, current_price: 146.8,
  });
  assert.ok(dcf.intrinsic_value > 0);

  const portTool = await h.tool('stock.portfolio', {});
  assert.equal(portTool.success, true);
  assert.equal(portTool.positions.length, 4);

  const analyzeTool = await h.tool('stock.analyze', { symbol: '00700' });
  assert.equal(analyzeTool.success, true);
  assert.equal(analyzeTool.name, '腾讯控股');

  const addNote = await h.tool('stock.note.add', {
    symbol: 'AAPL', rating: 'hold', target_price: 245, thesis: '服务业务高毛利稳健，等待端侧 AI 换机周期兑现。',
  });
  assert.equal(addNote.success, true);

  const exp = await h.action('document.export', { id: 'snapshot' });
  assert.equal(exp.filename, 'stock-ai-terminal.json');
  const imp = await h.action('document.import', { text: exp.text });
  assert.equal(imp.imported, true);
}
