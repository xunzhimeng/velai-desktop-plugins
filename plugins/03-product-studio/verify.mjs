import assert from 'node:assert/strict';

export async function verify({ createHarness }) {
  const h = await createHarness({
    fsInitial: {
      'docs/README.md': '# Product Docs\n',
    },
  });

  // 1. Empty initial state
  const empty = await h.action('studio.load', {});
  assert.equal(empty.revision, 0);
  assert.equal(empty.kpi.total, 0);
  assert.equal(empty.requirements.length, 0);

  // 2. One-click demo dataset seeding
  const seeded = await h.action('studio.seed_demo', { expected_revision: 0 });
  assert.equal(seeded.status, 'seeded');
  assert.equal(seeded.seeded_count, 8);
  assert.ok(seeded.revision > 0);

  // 3. Overview & KPI check
  const loaded = await h.action('studio.load', {});
  assert.equal(loaded.requirements.length, 8);
  assert.equal(loaded.kpi.total, 8);
  assert.equal(loaded.kpi.shipped, 2);
  assert.equal(loaded.kpi.in_progress, 3);
  assert.ok(loaded.kpi.avg_rice > 500);
  assert.ok(loaded.kpi.avg_spec_score >= 80);
  assert.equal(loaded.roadmap.lanes.length, 8);
  assert.equal(loaded.roadmap.milestones.length, 4);

  // 4. CAS conflict guard
  const stale = await h.action('req.save', {
    expected_revision: 0,
    id: 'req-conflict-test',
    title: '过期版本测试',
    module: '核心模块',
    status: 'backlog',
    reach: 1000,
    impact: 2,
    confidence: 80,
    effort: 2,
    owner: '测试',
    sprint: 'S1',
    summary: '应触发 CAS 冲突',
  });
  assert.equal(stale.status, 'conflict');

  // 5. Create requirement via action + RICE calculation
  const created = await h.action('req.save', {
    expected_revision: loaded.revision,
    id: 'req-telemetry-v2',
    title: '插件性能遥测与火焰图分析',
    module: '开发者工具',
    status: 'planned',
    reach: 2000,
    impact: 2,
    confidence: 90,
    effort: 2,
    owner: '陆川',
    sprint: 'S3 · 体验跃升',
    summary: '提供插件毫秒级耗时追踪与内存曲线。',
  });
  assert.equal(created.status, 'saved');
  assert.equal(created.rice, 1800);
  assert.equal(created.priority, 'P0');

  // 6. Save PRD spec & verify completeness score
  const specSaved = await h.action('spec.save', {
    expected_revision: created.revision,
    req_id: 'req-telemetry-v2',
    background: '开发者在排查插件卡顿时缺乏毫秒级耗时与内存快照工具，导致优化效率低下，需要内置零侵入遥测面板。',
    user_stories: '作为插件开发者，我希望一键开启性能录制并查看每次 Broker 读写的精确耗时，快速定位超过 12 KiB 的热点写入。',
    core_flow: '1. 在调试面板点击开始采样\n2. 运行目标 Action 自动记录每次 data.read/write 耗时与字节数\n3. 停止采样后生成时间轴与优化建议',
    acceptance_criteria: '1. 采样开启时额外开销 <= 1ms\n2. 准确展示每次调用的 Broker 次数与 JSON 字节数\n3. 关闭采样后零后台驻留开销',
    risks: '严禁在遥测日志中采集用户业务内容明文，仅记录 collection、耗时与字节体积。',
  });
  assert.equal(specSaved.status, 'saved');
  assert.equal(specSaved.score, 100);

  const specRead = await h.action('spec.get', { req_id: 'req-telemetry-v2' });
  assert.equal(specRead.spec.score, 100);

  // 7. Roadmap save
  const afterSpec = await h.action('studio.load', {});
  const mapSaved = await h.action('roadmap.save', {
    expected_revision: afterSpec.revision,
    total_weeks: 12,
    current_week: 6,
    milestones: afterSpec.roadmap.milestones,
    lanes: afterSpec.roadmap.lanes,
  });
  assert.equal(mapSaved.status, 'saved');

  // 8. Agent Tools: prd.list & prd.create
  const toolCreated = await h.tool('prd.create', {
    title: '快捷键命令面板集成',
    module: '运行时内核',
    status: 'backlog',
    reach: 3000,
    impact: 1,
    confidence: 80,
    effort: 1,
    owner: '林晓',
    sprint: 'S4 · 开发者生态',
    summary: '支持 Cmd+K 快速唤起已安装插件动作。',
  });
  assert.equal(toolCreated.success, true);
  assert.equal(toolCreated.status, 'saved');
  assert.equal(toolCreated.rice, 2400);
  assert.equal(toolCreated.priority, 'P0');

  const listed = await h.tool('prd.list', { priority: 'P0', keyword: '快捷键' });
  assert.equal(listed.success, true);
  assert.equal(listed.total, 1);
  assert.equal(listed.items[0].id, toolCreated.id);

  // 9. Document list / export / import
  const docs = await h.action('document.list', {});
  assert.ok(docs.items.some(i => i.id === 'all'));
  assert.ok(docs.items.some(i => i.id === 'prd:req-telemetry-v2'));

  const expAll = await h.action('document.export', { id: 'all' });
  assert.equal(expAll.filename, 'product-studio-roadmap.json');
  assert.ok(expAll.text && expAll.text.length > 100);

  const expPrd = await h.action('document.export', { id: 'prd:req-telemetry-v2' });
  assert.equal(expPrd.filename, 'prd-req-telemetry-v2.json');

  const impAll = await h.action('document.import', { text: expAll.text });
  assert.equal(impAll.imported, true);
  assert.ok(impAll.count >= 9);

  const impPrd = await h.action('document.import', { text: expPrd.text });
  assert.equal(impPrd.imported, true);

  // 10. Delete requirement & verify cleanup (via v2 data.delete)
  const beforeDel = await h.action('studio.load', {});
  const del = await h.action('req.delete', { expected_revision: beforeDel.revision, id: toolCreated.id });
  assert.equal(del.status, 'deleted');
  const afterDel = await h.action('studio.load', {});
  assert.equal(afterDel.requirements.some(r => r.id === toolCreated.id), false);
  assert.equal(afterDel.roadmap.lanes.some(l => l.req_id === toolCreated.id), false);

  // 11. V2 Workspace FS sync (fs_list / fs_export_doc create_only + CAS / fs_import_doc / sensitive path guard)
  const rootList = await h.action('fs_list', { path: '' });
  assert.equal(rootList.status, 'ok');
  assert.ok(rootList.entries.some(e => e.name === 'docs' && e.kind === 'dir'));

  const expNew = await h.action('fs_export_doc', {
    id: 'prd:req-telemetry-v2',
    path: 'docs/prd-telemetry.md',
    format: 'markdown',
    create_only: true,
  });
  assert.equal(expNew.status, 'written');
  assert.equal(expNew.sha256.length, 64);
  assert.ok(expNew.size_bytes > 50);

  const dupCreate = await h.action('fs_export_doc', {
    id: 'prd:req-telemetry-v2',
    path: 'docs/prd-telemetry.md',
    format: 'markdown',
    create_only: true,
  });
  assert.equal(dupCreate.status, 'conflict');

  const importedDoc = await h.action('fs_import_doc', { path: 'docs/prd-telemetry.md' });
  assert.equal(importedDoc.status, 'ok');
  assert.equal(importedDoc.format, 'markdown');
  assert.equal(importedDoc.sha256, expNew.sha256);
  assert.ok(importedDoc.content.includes('插件性能遥测与火焰图分析'));

  const casUpdate = await h.action('fs_export_doc', {
    id: 'all',
    path: 'docs/prd-telemetry.md',
    format: 'markdown',
    expected_sha256: importedDoc.sha256,
  });
  assert.equal(casUpdate.status, 'written');
  assert.notEqual(casUpdate.sha256, importedDoc.sha256);

  const staleCas = await h.action('fs_export_doc', {
    id: 'all',
    path: 'docs/prd-telemetry.md',
    format: 'markdown',
    expected_sha256: importedDoc.sha256,
  });
  assert.equal(staleCas.status, 'conflict');

  const blockedEnv = await h.action('fs_import_doc', { path: '.env' });
  assert.equal(blockedEnv.status, 'permission_denied');
}
