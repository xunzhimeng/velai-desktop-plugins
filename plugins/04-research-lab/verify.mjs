import assert from 'node:assert/strict';

export async function verify({ createHarness }) {
  const h = await createHarness();

  // 1. Initial empty state
  const empty = await h.action('lab.load', {});
  assert.equal(empty.revision, 0);
  assert.equal(empty.kpi.total_papers, 0);

  // 2. Seed demo dataset (6 classic LLM Agent / RAG / Sandbox papers + 2 notes)
  const seeded = await h.action('lab.seed_demo', { expected_revision: 0 });
  assert.equal(seeded.status, 'seeded');
  assert.equal(seeded.seeded_papers, 6);
  assert.equal(seeded.seeded_notes, 2);

  const loaded = await h.action('lab.load', {});
  assert.equal(loaded.papers.length, 6);
  assert.equal(loaded.notes.length, 2);
  assert.ok(loaded.kpi.citation_edges >= 8);
  assert.equal(loaded.matrix.selected_ids.length, 4);

  // 3. CAS conflict protection
  const conflict = await h.action('paper.save', {
    expected_revision: 0,
    id: 'stale2024',
    title: 'Stale Write Test',
    authors: 'Test Author',
    year: 2024,
    venue: 'ICLR 2024',
    tags: ['RAG'],
    rating: 4,
    status: 'unread',
    method: 'x',
    contribution: 'y',
    limitations: 'z',
    cites: [],
  });
  assert.equal(conflict.status, 'conflict');

  // 4. Add & edit paper via action
  const saved = await h.action('paper.save', {
    expected_revision: loaded.revision,
    id: 'shinn2023reflexion',
    title: 'Reflexion: Language Agents with Verbal Reinforcement Learning',
    authors: 'Noah Shinn, Federico Cassano, Ashwin Gopinath et al.',
    year: 2023,
    venue: 'NeurIPS 2023',
    tags: ['Agent', 'Reflection'],
    rating: 5,
    status: 'annotated',
    method: '通过自然语言自我反思缓冲记忆替代权重更新，实现跨轮试错强化。',
    contribution: '无需微调参数即可显著提升编码与决策任务成功率。',
    limitations: '高度依赖高质量外部验证信号，长程记忆易产生反思漂移。',
    cites: ['yao2023react'],
  });
  assert.equal(saved.status, 'saved');

  // 5. Matrix save (row + selection)
  const matSaved = await h.action('matrix.save', {
    expected_revision: saved.revision,
    selected_ids: ['lewis2020rag', 'yao2023react', 'shinn2023reflexion'],
    paper_id: 'shinn2023reflexion',
    row: {
      architecture: 'Actor + Evaluator + Self-Reflection 情景记忆闭环',
      datasets: 'HumanEval, AlfWorld, HotpotQA',
      metrics: 'HumanEval Pass@1 达 91%',
      limitations: '依赖显式外部测试反馈，单轮 token 成本较高',
      reusable: '失败轨迹压缩为情景反思记忆的轻量提示机制',
    },
  });
  assert.equal(matSaved.status, 'saved');

  // 6. Research note CRUD
  const noteSaved = await h.action('note.save', {
    expected_revision: matSaved.revision,
    id: 'note-exp-plan',
    title: '实验对比方案：自反思检索与沙箱 Agent',
    mode: 'experiment_plan',
    paper_ids: ['yao2023react', 'shinn2023reflexion', 'jimenez2024swebench'],
    content: '## 实验设计\n- Baseline: ReAct, Reflexion, Self-RAG\n- 基准: SWE-bench Lite & HotpotQA\n- 指标: Pass@1, FactScore, P95 Latency',
  });
  assert.equal(noteSaved.status, 'saved');

  const noteDoc = await h.action('note.get', { id: 'note-exp-plan' });
  assert.equal(noteDoc.found, true);
  assert.ok(noteDoc.note.content.includes('SWE-bench Lite'));

  // 7. Agent Tools: paper.search / paper.read / paper.add
  const searchRes = await h.tool('paper.search', { tag: 'Agent', min_rating: 5 });
  assert.equal(searchRes.success, true);
  assert.ok(searchRes.total >= 3);

  const readRes = await h.tool('paper.read', { id: 'yao2023react' });
  assert.equal(readRes.success, true);
  assert.equal(readRes.status, 'ready');
  assert.ok(readRes.cited_by.includes('shinn2023reflexion'));
  assert.ok(readRes.cited_by.includes('jimenez2024swebench'));
  assert.ok(readRes.matrix_row.architecture.length > 0);

  const readMissing = await h.tool('paper.read', { id: 'nonexistent-paper' });
  assert.equal(readMissing.success, false);
  assert.equal(readMissing.status, 'not_found');

  const toolAdded = await h.tool('paper.add', {
    id: 'yang2024sweagent',
    title: 'SWE-agent: Agent-Computer Interfaces Enable Automated Software Engineering',
    authors: 'John Yang, Carlos E. Jimenez, Alexander Wettig et al.',
    year: 2024,
    venue: 'NeurIPS 2024',
    tags: ['Sandbox', 'Agent'],
    rating: 5,
    status: 'reading',
    method: '设计面向大模型的 Agent-Computer Interface (ACI) 专用文件浏览与编辑原语。',
    contribution: '证明精心设计的工具接口比单纯扩大模型更能提升真实代码修复率。',
    limitations: 'ACI 规则针对代码仓高度定制，向通用桌面任务泛化需重新抽象。',
    cites: ['jimenez2024swebench', 'yao2023react'],
  });
  assert.equal(toolAdded.success, true);
  assert.equal(toolAdded.status, 'saved');
  assert.equal(toolAdded.id, 'yang2024sweagent');

  // 8. Document list / export / import
  const docs = await h.action('document.list', {});
  assert.ok(docs.items.some(i => i.id === 'library'));
  assert.ok(docs.items.some(i => i.id === 'note:note-exp-plan'));

  const expLib = await h.action('document.export', { id: 'library' });
  assert.equal(expLib.filename, 'research-lab-library.json');
  const impLib = await h.action('document.import', { text: expLib.text });
  assert.equal(impLib.imported, true);
  assert.equal(impLib.count, 8);

  const expNote = await h.action('document.export', { id: 'note:note-exp-plan' });
  assert.equal(expNote.filename, 'research-note-note-exp-plan.json');
  const impNote = await h.action('document.import', { text: expNote.text });
  assert.equal(impNote.imported, true);

  // 9. Delete note & delete paper (check dangling citation cleanup)
  const beforeDel = await h.action('lab.load', {});
  const delNote = await h.action('note.delete', { expected_revision: beforeDel.revision, id: 'note-exp-plan' });
  assert.equal(delNote.status, 'deleted');

  const delPaper = await h.action('paper.delete', { expected_revision: delNote.revision, id: 'shinn2023reflexion' });
  assert.equal(delPaper.status, 'deleted');

  const afterDel = await h.action('lab.load', {});
  assert.equal(afterDel.papers.some(p => p.id === 'shinn2023reflexion'), false);
  assert.equal(afterDel.matrix.selected_ids.includes('shinn2023reflexion'), false);
}
