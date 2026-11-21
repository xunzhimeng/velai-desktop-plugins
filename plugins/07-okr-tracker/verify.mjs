import assert from 'node:assert/strict';

export async function verify({ createHarness }) {
  const h = await createHarness();
  const saved = await h.action('okr.save', {
    expected_revision: 0,
    id: 'obj-plugins',
    cycle: '2026-Q4',
    title: '建设 Velai 桌面端插件生态',
    krs: [
      { id: 'kr-1', title: '交付首批实用插件', current: 8, target: 10, unit: '个' },
      { id: 'kr-2', title: '自动化契约验收通过率', current: 100, target: 100, unit: '%' },
    ],
  });
  assert.equal(saved.status, 'saved');

  const board = await h.action('okr.read', {});
  assert.equal(board.overall_pct, 90);
  assert.equal(board.objectives[0].progress_pct, 90);

  const summary = await h.tool('okr.summary', { cycle: '2026-Q4' });
  assert.equal(summary.success, true);
  assert.equal(summary.overall_pct, 90);
  assert.equal(summary.objectives[0].kr_count, 2);

  const exp = await h.action('document.export', { id: 'all' });
  assert.equal(exp.filename, 'okr-tracker.json');
  const imp = await h.action('document.import', { text: exp.text });
  assert.equal(imp.imported, true);
}
