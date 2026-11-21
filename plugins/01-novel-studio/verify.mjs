import assert from 'node:assert/strict';

export async function verify({ createHarness }) {
  const h = await createHarness();
  const boot0 = await h.action('novel.bootstrap', {});
  assert.equal(boot0.revision, 0);

  const seeded = await h.action('novel.seed_demo', { expected_revision: 0 });
  assert.equal(seeded.status, 'seeded');
  assert.ok(seeded.revision > 0);

  const boot = await h.action('novel.bootstrap', {});
  assert.equal(boot.book.title, '星渊回响');
  assert.equal(boot.book.chapters.length, 5);
  assert.equal(boot.characters.length, 5);
  assert.equal(boot.relations.length, 6);
  assert.equal(boot.threads.length, 4);

  const ch1 = await h.action('novel.chapter.get', { id: 'ch-01' });
  assert.equal(ch1.found, true);
  assert.ok(ch1.body.includes('零号信标'));

  const outline = await h.tool('novel.outline', {});
  assert.equal(outline.success, true);
  assert.equal(outline.chapters.length, 5);
  assert.equal(outline.open_threads.length, 4);

  const readTool = await h.tool('novel.chapter.read', { id: 'ch-02' });
  assert.equal(readTool.success, true);
  assert.equal(readTool.pov, '沈清秋');

  const upsert = await h.tool('novel.bible.upsert', {
    kind: 'artifact',
    title: '镜像探针',
    detail: '沈清秋私下挂在轨管局底层总线上的物理日志监听硬件。',
  });
  assert.equal(upsert.success, true);

  const exp = await h.action('document.export', { id: 'ch-01' });
  assert.equal(exp.filename, 'novel-ch-01.json');
  const imp = await h.action('document.import', { text: exp.text });
  assert.equal(imp.imported, true);
}
