import assert from 'node:assert/strict';

export async function verify({ createHarness }) {
  const h = await createHarness();
  const empty = await h.action('usage.dashboard', { range: '30d' });
  assert.equal(empty.kpis.session_count, 0);

  const seeded = await h.action('usage.seed_demo', { expected_revision: 0 });
  assert.equal(seeded.status, 'seeded');

  const dash = await h.action('usage.dashboard', { range: '30d' });
  assert.equal(dash.kpis.session_count, 18);
  assert.ok(dash.kpis.total_tokens > 3_000_000);
  assert.ok(dash.kpis.cache_hit_pct > 50);
  assert.ok(dash.models.length >= 4);
  assert.ok(dash.categories.length >= 5);
  assert.equal(dash.hours.length, 24);

  const dash7 = await h.action('usage.dashboard', { range: '7d' });
  assert.ok(dash7.kpis.session_count > 0 && dash7.kpis.session_count < 18);

  // Batch ingest
  const batch = await h.action('usage.session.batch_ingest', {
    expected_revision: dash.revision,
    items: [
      {
        date: '2026-11-21',
        hour: 21,
        title: '测试批量导入会话统计',
        category: 'coding',
        model: 'Gemini 2.5 Pro',
        input_tokens: 50000,
        output_tokens: 12000,
        cached_tokens: 30000,
        rating: 5,
        summary: '验证批量归档能力',
      },
    ],
  });
  assert.equal(batch.status, 'saved');
  assert.equal(batch.ingested, 1);

  // Agent Tools
  const toolSum = await h.tool('usage.dashboard.summary', { range: '30d' });
  assert.equal(toolSum.success, true);
  assert.equal(toolSum.session_count, 19);

  const toolRec = await h.tool('usage.session.record', {
    title: '通过 Agent Tool 自动归档的会话',
    category: 'research',
    model: 'Claude Sonnet 4',
    input_tokens: 60000,
    output_tokens: 15000,
    summary: '验证 AI 自动归档',
  });
  assert.equal(toolRec.success, true);

  const budget = await h.tool('usage.budget.status', {});
  assert.equal(budget.success, true);
  assert.ok(budget.cost_used_pct > 0);

  // Document export/import
  const exp = await h.action('document.export', { id: 'telemetry' });
  assert.equal(exp.filename, 'velai-usage-analytics.json');
  const imp = await h.action('document.import', { text: exp.text });
  assert.equal(imp.imported, true);
}
