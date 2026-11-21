import assert from 'node:assert/strict';

export async function verify({ createHarness }) {
  const h = await createHarness();
  const added = await h.tool('checklist.add', {
    title: '完成 Desktop 插件发布检查',
    milestone: 'M1',
    priority: 'high',
    note: '含 SHA-256 校验',
  });
  assert.equal(added.success, true);
  assert.equal(added.status, 'saved');

  const board = await h.action('tasks.list', {});
  assert.equal(board.revision, 1);
  assert.equal(board.summary.total, 1);
  assert.equal(board.summary.completion_pct, 0);

  const updated = await h.action('tasks.upsert', {
    expected_revision: 1,
    ...board.items[0],
    state: 'done',
  });
  assert.equal(updated.status, 'saved');

  const listTool = await h.tool('checklist.list', { state: 'done', milestone: 'M1' });
  assert.equal(listTool.success, true);
  assert.equal(listTool.completion_pct, 100);
  assert.equal(listTool.items.length, 1);

  const exp = await h.action('document.export', { id: 'all' });
  assert.equal(exp.filename, 'project-checklist.json');
  const imp = await h.action('document.import', { text: exp.text });
  assert.equal(imp.imported, true);
}
