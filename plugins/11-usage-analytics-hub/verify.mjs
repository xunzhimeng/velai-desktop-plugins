import assert from 'node:assert/strict';

export async function verify({ manifest, createHarness }) {
  // 负向契约检查：v2 宿主遥测插件不得包含 tasks.* 或 session.turn.*
  assert.equal(manifest.manifest_version, 2);
  assert.equal(manifest.host_api, 2);
  assert.ok(!manifest.permissions.some(p => p.startsWith('tasks.')));
  assert.ok(!manifest.actions.some(a => a.id.startsWith('session.turn')));

  const hostMock = {
    usageSummary: ({ days }) => ({
      as_of: '2026-11-22T12:00:00Z',
      timezone: 'Asia/Shanghai',
      windows: {
        '5m': { input_tokens: 12000, output_tokens: 3400, total_tokens: 15400, cached_input_tokens: 6000, cache_rate: 0.5, tokens_per_second: 42.5 },
        '1h': { input_tokens: 140000, output_tokens: 28000, total_tokens: 168000, cached_input_tokens: 92000, cache_rate: 0.657, tokens_per_second: 38.2 },
        today: { input_tokens: 480000, output_tokens: 95000, total_tokens: 575000, cached_input_tokens: 310000, cache_rate: 0.646, tokens_per_second: null },
        '7d': { input_tokens: 3100000, output_tokens: 620000, total_tokens: 3720000, cached_input_tokens: 2150000, cache_rate: 0.694, tokens_per_second: null },
        '30d': { input_tokens: 9800000, output_tokens: 2200000, total_tokens: 12000000, cached_input_tokens: 6800000, cache_rate: 0.694, tokens_per_second: null },
      },
      by_day: days === 7
        ? [
            { date: '2026-11-20', input_tokens: 420000, output_tokens: 90000, total_tokens: 510000 },
            { date: '2026-11-21', input_tokens: null, output_tokens: null, total_tokens: null },
            { date: '2026-11-22', input_tokens: 480000, output_tokens: 95000, total_tokens: 575000 },
          ]
        : [
            { date: '2026-11-01', input_tokens: 300000, output_tokens: 60000, total_tokens: 360000 },
            { date: '2026-11-15', input_tokens: null, output_tokens: null, total_tokens: null },
            { date: '2026-11-22', input_tokens: 480000, output_tokens: 95000, total_tokens: 575000 },
          ],
      by_model: [
        { model: 'gpt/gpt-6.2-astra', input_tokens: 6200000, output_tokens: 1400000, total_tokens: 7600000 },
        { model: 'anthropic/claude-sonnet-4', input_tokens: 3600000, output_tokens: 800000, total_tokens: 4400000 },
        { model: 'legacy/unmetered-model', input_tokens: null, output_tokens: null, total_tokens: null },
      ],
      models_truncated: true,
    }),
    sessions: [
      { id: 'sess-01', title: 'Velai V2 插件架构评审', status: 'active', created_at: '2026-11-22T09:10:00Z', is_archived: false },
      { id: 'sess-02', title: 'QuickJS 沙箱隔离排障', status: 'idle', created_at: '2026-11-21T20:30:00Z', is_archived: false },
      { id: 'sess-03', title: null, status: 'finished', created_at: null, is_archived: true },
    ],
    projects: [
      { id: 'proj-velai', name: 'velai-ai', status: 'active' },
      { id: 'proj-plugins', name: 'velai-desktop-plugins', status: 'active' },
    ],
  };

  const h = await createHarness({ hostMock });

  // 1. 宿主实时遥测大屏 (30d & 7d) + null 缺测不得伪造成 0
  const dash30 = await h.action('usage.dashboard', { days: 30 });
  assert.equal(dash30.days, 30);
  assert.equal(dash30.windows['30d'].total_tokens, 12000000);
  assert.equal(dash30.windows.today.tokens_per_second, null);
  assert.equal(dash30.by_day[1].total_tokens, null);
  assert.equal(dash30.by_model[2].total_tokens, null);
  assert.equal(dash30.by_model[2].share_pct, null);
  assert.equal(dash30.models_truncated, true);
  assert.equal(dash30.budget.token_used_pct, 80); // 12M / 15M = 80%
  assert.equal(dash30.budget.alert_level, 'warn');
  assert.equal(dash30.sessions.items.length, 3);
  assert.equal(dash30.sessions.items[2].title, null);
  assert.equal(dash30.projects.items.length, 2);

  const dash7 = await h.action('usage.dashboard', { days: 7 });
  assert.equal(dash7.days, 7);
  assert.equal(dash7.by_day[1].input_tokens, null);

  // 2. 宿主会话分页、归档筛选与单条元数据查询
  const activeSessions = await h.action('usage.host.sessions', { offset: 0, limit: 1, is_archived: false });
  assert.equal(activeSessions.items.length, 1);
  assert.equal(activeSessions.next_offset, 1);

  const detailOk = await h.action('usage.host.session_detail', { session_id: 'sess-03' });
  assert.equal(detailOk.found, true);
  assert.equal(detailOk.session.is_archived, true);
  assert.equal(detailOk.session.title, null);

  const detailMiss = await h.action('usage.host.session_detail', { session_id: 'non-existent' });
  assert.equal(detailMiss.found, false);
  assert.equal(detailMiss.session, null);

  const projs = await h.action('usage.host.projects', { offset: 0, limit: 1 });
  assert.equal(projs.items.length, 1);
  assert.equal(projs.next_offset, 1);

  // 3. data.write / data.list / data.delete 复盘笔记全生命周期
  const n1 = await h.action('usage.note.save', {
    expected_revision: dash30.revision,
    id: 'w47-cache',
    title: '第 47 周缓存命中复盘',
    range_days: 7,
    tags: 'cache,cost',
    body: '稳定系统提示前缀后，7 天缓存命中率提升至 69.4%。',
  });
  assert.equal(n1.status, 'saved');
  assert.equal(n1.key, 'note:w47-cache');

  const n2 = await h.action('usage.note.save', {
    expected_revision: n1.revision,
    id: 'w47-budget',
    title: '月度预算阈值调整记录',
    range_days: 30,
    tags: 'budget',
    body: '当前 30 天用量达 12M，将预算调至 20M 并保持 75% 预警。',
  });
  assert.equal(n2.status, 'saved');

  const page1 = await h.action('usage.note.list', { limit: 1 });
  assert.equal(page1.items.length, 1);
  assert.ok(typeof page1.next_cursor === 'string');

  const page2 = await h.action('usage.note.list', { limit: 1, cursor: page1.next_cursor });
  assert.equal(page2.items.length, 1);
  assert.equal(page2.next_cursor, null);

  // 删除 + CAS 冲突负向检查
  const delConflict = await h.action('usage.note.delete', { expected_revision: 0, key: 'note:w47-cache' });
  assert.equal(delConflict.status, 'conflict');

  const delInvalid = await h.action('usage.note.delete', { expected_revision: n2.revision, key: 'bad-prefix' });
  assert.equal(delInvalid.status, 'invalid_input');

  const delOk = await h.action('usage.note.delete', { expected_revision: n2.revision, key: 'note:w47-cache' });
  assert.equal(delOk.status, 'deleted');

  const delMiss = await h.action('usage.note.delete', { expected_revision: delOk.revision, key: 'note:w47-cache' });
  assert.equal(delMiss.status, 'not_found');

  // 4. 预算保存与负向校验
  const badBudget = await h.action('usage.budget.save', {
    expected_revision: delOk.revision,
    monthly_tokens_m: 20,
    warn_pct: 90,
    critical_pct: 80,
  });
  assert.equal(badBudget.status, 'invalid_input');

  const savedBudget = await h.action('usage.budget.save', {
    expected_revision: delOk.revision,
    monthly_tokens_m: 20,
    warn_pct: 75,
    critical_pct: 92,
    alert_note: '高频编码优先保留主模型额度',
  });
  assert.equal(savedBudget.status, 'saved');

  // 5. 3 个 v2 Agent Tools
  const tSummary = await h.tool('usage.get_host_summary', { days: 7 });
  assert.equal(tSummary.success, true);
  assert.equal(tSummary.status, 'ready');
  assert.equal(tSummary.window_total_tokens, 3720000);
  assert.equal(tSummary.token_used_pct, 60); // 12M / 20M = 60%
  assert.equal(tSummary.budget_alert_level, 'ok');
  assert.equal(tSummary.top_model, 'gpt/gpt-6.2-astra');

  const tSessions = await h.tool('usage.list_host_sessions', { limit: 10, is_archived: false });
  assert.equal(tSessions.success, true);
  assert.equal(tSessions.status, 'ready');
  assert.equal(tSessions.sessions.length, 2);
  assert.equal(tSessions.projects.length, 2);

  const tBudget = await h.tool('usage.update_budget_alert', {
    monthly_tokens_m: 10,
    warn_pct: 60,
    critical_pct: 85,
    alert_note: '严格控费模式',
  });
  assert.equal(tBudget.success, true);
  assert.equal(tBudget.status, 'saved');

  const tSummaryAfter = await h.tool('usage.get_host_summary', { days: 30 });
  assert.equal(tSummaryAfter.token_used_pct, 120);
  assert.equal(tSummaryAfter.budget_alert_level, 'critical');

  // 6. 缺测全 null 场景检查（严禁将 null 伪造成 0）
  const hMissing = await createHarness({
    hostMock: {
      usageSummary: () => ({
        as_of: '2026-11-22T12:00:00Z',
        timezone: 'UTC',
        windows: {
          '5m': { input_tokens: null, output_tokens: null, total_tokens: null, cached_input_tokens: null, cache_rate: null, tokens_per_second: null },
          '1h': { input_tokens: null, output_tokens: null, total_tokens: null, cached_input_tokens: null, cache_rate: null, tokens_per_second: null },
          today: { input_tokens: null, output_tokens: null, total_tokens: null, cached_input_tokens: null, cache_rate: null, tokens_per_second: null },
          '7d': { input_tokens: null, output_tokens: null, total_tokens: null, cached_input_tokens: null, cache_rate: null, tokens_per_second: null },
          '30d': { input_tokens: null, output_tokens: null, total_tokens: null, cached_input_tokens: null, cache_rate: null, tokens_per_second: null },
        },
        by_day: [],
        by_model: [],
        models_truncated: false,
      }),
    },
  });
  const missingSum = await hMissing.tool('usage.get_host_summary', { days: 30 });
  assert.equal(missingSum.success, true);
  assert.equal(missingSum.status, 'missing_metrics');
  assert.equal(missingSum.window_total_tokens, null);
  assert.equal(missingSum.token_used_pct, null);
  assert.equal(missingSum.budget_alert_level, 'unknown');

  // 7. 负向调用：已移除的 session.turn.request 与非法 days 参数必须被拒绝
  await assert.rejects(() => h.action('session.turn.request', { prompt: 'hi', work_id: '00000000-0000-4000-8000-000000000000' }));
  await assert.rejects(() => h.action('usage.dashboard', { days: 14 }));
}
