import assert from 'node:assert/strict';

export async function verify({ createHarness }) {
  const h = await createHarness();
  const s1 = await h.action('snippet.save', {
    expected_revision: 0,
    id: 'git-clean',
    title: '清理已合并分支',
    tag: 'git',
    pinned: true,
    body: 'git branch --merged main | grep -v main | xargs git branch -d',
  });
  assert.equal(s1.status, 'saved');

  const s2 = await h.action('snippet.save', {
    expected_revision: 1,
    id: 'sql-top',
    title: '慢查询 Top 10',
    tag: 'sql',
    pinned: false,
    body: 'SELECT query, mean_exec_time FROM pg_stat_statements ORDER BY mean_exec_time DESC LIMIT 10;',
  });
  assert.equal(s2.status, 'saved');

  const found = await h.tool('snippet.search', { tag: 'git' });
  assert.equal(found.success, true);
  assert.equal(found.snippets.length, 1);
  assert.equal(found.snippets[0].pinned, true);

  const del = await h.action('snippet.delete', { expected_revision: 2, id: 'sql-top' });
  assert.equal(del.status, 'deleted');
}
