import assert from 'node:assert/strict';

export async function verify({ createHarness }) {
  const h = await createHarness({
    fsInitial: {
      'manuscript/prologue.md': '# 序章 轨道残骸\n\n深空轨道带沉默地旋转，42Hz 的脉冲首次在星渊残骸深处亮起。\n',
      'manuscript/notes.txt': '世界观备忘：潮汐折叠窗口为 72 小时。',
    },
  });

  // 1. 初始空态与演示项目回归
  const boot0 = await h.action('novel.bootstrap', {});
  assert.equal(boot0.revision, 0);
  assert.deepEqual(boot0.stored_chapter_keys, []);

  const seeded = await h.action('novel.seed_demo', { expected_revision: 0 });
  assert.equal(seeded.status, 'seeded');
  assert.ok(seeded.revision > 0);

  const boot = await h.action('novel.bootstrap', {});
  assert.equal(boot.book.title, '星渊回响');
  assert.equal(boot.book.chapters.length, 5);
  assert.equal(boot.stored_chapter_keys.length, 5);
  assert.equal(boot.characters.length, 5);
  assert.equal(boot.relations.length, 6);
  assert.equal(boot.threads.length, 4);

  const ch1 = await h.action('novel.chapter.get', { id: 'ch-01' });
  assert.equal(ch1.found, true);
  assert.ok(ch1.body.includes('零号信标'));

  // 2. 长章节写入 + data.list / data.delete 清理验证
  const longBody = '星渊回响测试长正文段落。'.repeat(2000);
  const savedLong = await h.action('novel.chapter.save', {
    expected_revision: boot.revision,
    id: 'ch-long',
    volume: '第二卷 · 逆向潮汐',
    title: '第6章 超长手稿压力验证',
    status: 'draft',
    tension: 8,
    pov: '林深',
    summary: '验证 v2 240 KiB 记录容量与 data.delete 清理',
    beats: '1. 写入长章节\n2. 验证删除后键清理',
    notes: 'v2 regression',
    body: longBody,
  });
  assert.equal(savedLong.status, 'saved');
  assert.ok(savedLong.word_count > 10000);

  const bootAfterLong = await h.action('novel.bootstrap', {});
  assert.ok(bootAfterLong.stored_chapter_keys.includes('ch:ch-long'));

  const deleted = await h.action('novel.chapter.delete', {
    expected_revision: bootAfterLong.revision,
    id: 'ch-long',
  });
  assert.equal(deleted.status, 'deleted');

  const bootAfterDel = await h.action('novel.bootstrap', {});
  assert.ok(!bootAfterDel.stored_chapter_keys.includes('ch:ch-long'));
  const chLongGet = await h.action('novel.chapter.get', { id: 'ch-long' });
  assert.equal(chLongGet.found, false);

  // 3. 工作区 FS 浏览与 Stat
  const rootList = await h.action('novel.fs_list', { path: '' });
  assert.ok(rootList.entries.some(e => e.name === 'manuscript' && e.kind === 'dir'));

  const subList = await h.action('novel.fs_list', { path: 'manuscript' });
  assert.ok(subList.entries.some(e => e.name === 'prologue.md' && e.kind === 'file'));

  const st = await h.action('novel.fs_stat', { path: 'manuscript/prologue.md' });
  assert.equal(st.kind, 'file');
  assert.match(st.sha256, /^[0-9a-f]{64}$/);
  assert.ok(st.size_bytes > 0);

  // 4. 工作区导入章节并记录 fs_path & fs_sha256
  const impFs = await h.action('novel.fs_import_chapter', {
    expected_revision: bootAfterDel.revision,
    path: 'manuscript/prologue.md',
    volume: '序幕',
    pov: '林深',
  });
  assert.equal(impFs.status, 'imported');
  assert.equal(impFs.title, '序章 轨道残骸');
  assert.equal(impFs.fs_path, 'manuscript/prologue.md');
  assert.equal(impFs.fs_sha256, st.sha256);

  const impGet = await h.action('novel.chapter.get', { id: impFs.id });
  assert.equal(impGet.found, true);
  assert.equal(impGet.fs_path, 'manuscript/prologue.md');
  assert.equal(impGet.fs_sha256, st.sha256);

  // 5. 工作区原子导出 CAS：create_only 成功 + 重复 create_only 冲突 + expected_sha256 成功 + 错误 sha256 冲突
  const expCreate = await h.action('novel.fs_export_chapter', {
    id: 'ch-01',
    path: 'manuscript/ch-01.md',
    create_only: true,
  });
  assert.equal(expCreate.status, 'exported');
  assert.match(expCreate.sha256, /^[0-9a-f]{64}$/);
  assert.ok(h.getFsFile('manuscript/ch-01.md').includes('零号信标'));

  const expCreateDup = await h.action('novel.fs_export_chapter', {
    id: 'ch-01',
    path: 'manuscript/ch-01.md',
    create_only: true,
  });
  assert.equal(expCreateDup.status, 'conflict');

  const expCasOk = await h.action('novel.fs_export_chapter', {
    id: 'ch-02',
    path: 'manuscript/ch-01.md',
    expected_sha256: expCreate.sha256,
  });
  assert.equal(expCasOk.status, 'exported');
  assert.notEqual(expCasOk.sha256, expCreate.sha256);
  assert.ok(h.getFsFile('manuscript/ch-01.md').includes('静默档案室'));

  // 使用过期 sha256 必须返回 conflict，不得强行覆盖
  const expCasConflict = await h.action('novel.fs_export_chapter', {
    id: 'ch-03',
    path: 'manuscript/ch-01.md',
    expected_sha256: expCreate.sha256,
  });
  assert.equal(expCasConflict.status, 'conflict');
  assert.ok(h.getFsFile('manuscript/ch-01.md').includes('静默档案室'));

  // 同时传入 create_only 与 expected_sha256 拒绝
  const expInvalid = await h.action('novel.fs_export_chapter', {
    id: 'ch-01',
    path: 'manuscript/ch-bad.md',
    create_only: true,
    expected_sha256: expCasOk.sha256,
  });
  assert.equal(expInvalid.status, 'invalid_input');

  // 6. 敏感路径 .git / .env 负向拒绝测试
  await assert.rejects(
    () => h.action('novel.fs_stat', { path: '.env' }),
    err => err.code === 'permission_denied',
  );
  await assert.rejects(
    () => h.action('novel.fs_list', { path: '.git' }),
    err => err.code === 'permission_denied',
  );
  await assert.rejects(
    () => h.action('novel.fs_export_chapter', { id: 'ch-01', path: '.env', create_only: true }),
    err => err.code === 'permission_denied',
  );

  // 7. 3 个 v2 Agent Tools 验证
  const ctx = await h.tool('novel.get_story_context', { chapter_id: 'ch-02', include_body: true });
  assert.equal(ctx.success, true);
  assert.equal(ctx.status, 'ready');
  assert.equal(ctx.title, '星渊回响');
  assert.equal(ctx.chapter_detail.pov, '沈清秋');
  assert.ok(ctx.chapter_detail.body.includes('镜像探针'));
  assert.equal(ctx.open_threads.length, 4);

  const readFile = await h.tool('novel.read_manuscript_file', { path: 'manuscript/prologue.md' });
  assert.equal(readFile.success, true);
  assert.equal(readFile.status, 'ready');
  assert.equal(readFile.sha256, st.sha256);

  const readEnv = await h.tool('novel.read_manuscript_file', { path: '.env' });
  assert.equal(readEnv.success, false);
  assert.equal(readEnv.status, 'permission_denied');

  const upserted = await h.tool('novel.upsert_chapter_outline', {
    id: 'ch-06',
    volume: '第二卷 · 逆向潮汐',
    title: '第6章 镜像回廊',
    tension: 9,
    pov: '沈清秋',
    summary: '沈清秋在中继塔底层发现第二枚量子信标。',
    beats: '1. 潜入核心机房\n2. 解码巴赫校验码',
  });
  assert.equal(upserted.success, true);
  assert.equal(upserted.status, 'saved');
  assert.equal(upserted.id, 'ch-06');

  // 8. 书籍元信息、人物世界观、伏笔、document 导入导出回归
  const bootFinal = await h.action('novel.bootstrap', {});
  const bookSaved = await h.action('novel.book.save', {
    expected_revision: bootFinal.revision,
    title: '星渊回响 · 修订版',
    genre: '硬科幻 / 太空悬疑',
    logline: bootFinal.book.logline,
    target_words: 180000,
  });
  assert.equal(bookSaved.status, 'saved');

  const docList = await h.action('document.list', {});
  assert.ok(docList.items.some(i => i.id === 'bible'));
  assert.ok(docList.items.some(i => i.id === 'ch-01'));

  const exp = await h.action('document.export', { id: 'ch-01' });
  assert.equal(exp.filename, 'novel-ch-01.json');
  const imp = await h.action('document.import', { text: exp.text });
  assert.equal(imp.imported, true);
}
