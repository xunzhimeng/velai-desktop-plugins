import assert from 'node:assert/strict';

export async function verify({ createHarness }) {
  const h = await createHarness();
  const empty = await h.action('vault.list', {});
  assert.equal(empty.revision, 0);
  assert.deepEqual(empty.templates, []);

  const saved = await h.action('vault.save', {
    expected_revision: 0,
    id: 'code-review',
    title: '严格代码审查',
    category: 'coding',
    content: '请用 {{language}} 规范审查以下变更：\n{{diff}}',
  });
  assert.equal(saved.status, 'saved');
  assert.equal(saved.revision, 1);
  assert.deepEqual(saved.variables, ['language', 'diff']);

  // CAS 冲突校验
  const conflict = await h.action('vault.save', {
    expected_revision: 0,
    id: 'code-review',
    title: '过期写入',
    category: 'coding',
    content: 'test',
  });
  assert.equal(conflict.status, 'conflict');

  // Agent Tool 查询与渲染
  const listed = await h.tool('prompt.list', { category: 'coding', keyword: '审查' });
  assert.equal(listed.success, true);
  assert.equal(listed.templates.length, 1);

  const rendered = await h.tool('prompt.render', {
    id: 'code-review',
    values: [{ name: 'language', value: 'Rust' }],
  });
  assert.equal(rendered.success, true);
  assert.ok(rendered.rendered.includes('Rust'));
  assert.deepEqual(rendered.missing, ['diff']);

  // 文档导出与导入
  const exported = await h.action('document.export', { id: 'code-review' });
  assert.equal(exported.filename, 'prompt-code-review.json');
  const imported = await h.action('document.import', { text: exported.text });
  assert.equal(imported.imported, true);

  const afterImport = await h.action('vault.list', {});
  assert.equal(afterImport.templates.length, 2);
}
