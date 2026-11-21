const COL_PAPERS = 'papers';
const COL_MATRIX = 'matrix';
const COL_NOTES = 'notes';
const KEY_CATALOG = 'catalog';
const KEY_GRID = 'grid';
const KEY_NOTES_IDX = 'index';

const MAX_BYTES = 12 * 1024;
const MAX_PAPERS = 28;
const MAX_NOTES = 24;
const STATUSES = ['unread', 'reading', 'annotated', 'cited'];
const MODES = ['related_work', 'research_gaps', 'experiment_plan', 'peer_review', 'custom'];
const LIB_FORMAT = 'velai.research-lab.library';
const NOTE_FORMAT = 'velai.research-lab.note';

function jsonBytes(value) {
  let bytes = 0;
  const s = JSON.stringify(value);
  for (let i = 0; i < s.length; i++) {
    const cp = s.codePointAt(i);
    if (cp > 0xffff) i++;
    bytes += cp <= 0x7f ? 1 : cp <= 0x7ff ? 2 : cp <= 0xffff ? 3 : 4;
  }
  return bytes;
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function cleanStrList(arr, maxCount, maxLen) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  const seen = new Set();
  for (const item of arr) {
    if (typeof item !== 'string') continue;
    const t = item.trim().slice(0, maxLen);
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= maxCount) break;
  }
  return out;
}

function defaultMatrixRow(paper) {
  return {
    architecture: paper?.method || '',
    datasets: '',
    metrics: paper?.contribution || '',
    limitations: paper?.limitations || '',
    reusable: '',
  };
}

async function readPapers() {
  const r = await globalThis.nmas.data.read({ collection: COL_PAPERS, key: KEY_CATALOG });
  const doc = r.value === null ? { schema_version: 1, items: [] } : r.value;
  if (!doc || doc.schema_version !== 1 || !Array.isArray(doc.items)) {
    throw new Error('文献库数据格式无效');
  }
  return { revision: r.revision, items: doc.items };
}

async function readMatrix() {
  const r = await globalThis.nmas.data.read({ collection: COL_MATRIX, key: KEY_GRID });
  const doc = r.value === null ? { schema_version: 1, selected_ids: [], rows: {} } : r.value;
  if (!doc || doc.schema_version !== 1 || !Array.isArray(doc.selected_ids) || typeof doc.rows !== 'object' || doc.rows === null) {
    throw new Error('对比矩阵数据格式无效');
  }
  return { revision: r.revision, matrix: { selected_ids: doc.selected_ids, rows: doc.rows } };
}

async function readNotesIndex() {
  const r = await globalThis.nmas.data.read({ collection: COL_NOTES, key: KEY_NOTES_IDX });
  const doc = r.value === null ? { schema_version: 1, items: [] } : r.value;
  if (!doc || doc.schema_version !== 1 || !Array.isArray(doc.items)) {
    throw new Error('科研笔记索引格式无效');
  }
  return { revision: r.revision, items: doc.items };
}

async function readNoteDoc(id) {
  const r = await globalThis.nmas.data.read({ collection: COL_NOTES, key: `doc:${id}` });
  if (r.value === null) return { revision: r.revision, found: false };
  const n = r.value;
  return {
    revision: r.revision,
    found: true,
    note: {
      id: n.id || id,
      title: n.title || '未命名笔记',
      mode: MODES.includes(n.mode) ? n.mode : 'custom',
      paper_ids: Array.isArray(n.paper_ids) ? n.paper_ids : [],
      content: n.content || '',
      created_at: n.created_at || '',
    },
  };
}

async function safeWrite(collection, key, expectedRevision, value) {
  if (jsonBytes(value) > MAX_BYTES) {
    return { ok: false, status: 'limit', revision: expectedRevision };
  }
  try {
    const receipt = await globalThis.nmas.data.write({
      collection,
      key,
      expected_revision: expectedRevision,
      value,
    });
    return { ok: true, status: 'saved', revision: receipt.revision };
  } catch (err) {
    if (err?.code === 'conflict' && err.outcome_unknown === false) {
      return { ok: false, status: 'conflict', revision: expectedRevision };
    }
    if (err?.code === 'resource_limit') {
      return { ok: false, status: 'limit', revision: expectedRevision };
    }
    throw err;
  }
}

function computeKpi(papers, notes) {
  const total_papers = papers.length;
  const annotated_or_cited = papers.filter(p => p.status === 'annotated' || p.status === 'cited').length;
  const idSet = new Set(papers.map(p => p.id));
  let citation_edges = 0;
  for (const p of papers) {
    for (const c of p.cites || []) {
      if (idSet.has(c) && c !== p.id) citation_edges += 1;
    }
  }
  const avg_rating = total_papers === 0
    ? 0
    : Math.round((papers.reduce((s, p) => s + p.rating, 0) / total_papers) * 10) / 10;
  return {
    total_papers,
    annotated_or_cited,
    citation_edges,
    total_notes: notes.length,
    avg_rating,
  };
}

function buildDemoData() {
  const papers = [
    {
      id: 'lewis2020rag',
      title: 'Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks',
      authors: 'Patrick Lewis, Ethan Perez, Aleksandra Piktus et al.',
      year: 2020,
      venue: 'NeurIPS 2020',
      tags: ['RAG', 'Knowledge', 'Retrieval'],
      rating: 5,
      status: 'cited',
      method: '将稠密检索器 DPR 与 seq2seq 生成器 BART 端到端联合微调，通过边缘化隐变量文档分布实现非参数知识注入。',
      contribution: '奠定现代 RAG 范式，显著降低知识密集型问答幻觉并支持无需重训即可热更新外部知识库。',
      limitations: '固定 Top-K 检索难以应对多跳推理；检索噪声与生成器上下文截断容易导致信息失真。',
      cites: [],
    },
    {
      id: 'yao2023react',
      title: 'ReAct: Synergizing Reasoning and Acting in Language Models',
      authors: 'Shunyu Yao, Jeffrey Zhao, Dian Yu, Nan Du et al.',
      year: 2023,
      venue: 'ICLR 2023',
      tags: ['Agent', 'Reasoning', 'ToolUse'],
      rating: 5,
      status: 'cited',
      method: '交替生成 Thought 推理轨迹与 Action 工具调用，利用外部环境 Observation 闭环修正推理错误。',
      contribution: '首次系统证明推理与行动协同优于纯 CoT 或纯 Act，极大增强轨迹可解释性与事实接地能力。',
      limitations: '长链路任务易陷入重复循环并耗尽上下文窗口；对提示词格式与基础模型指令遵循敏感。',
      cites: ['lewis2020rag'],
    },
    {
      id: 'schick2023toolformer',
      title: 'Toolformer: Language Models Can Teach Themselves to Use Tools',
      authors: 'Timo Schick, Jane Dwivedi-Yu, Roberto Dessi et al.',
      year: 2023,
      venue: 'NeurIPS 2023',
      tags: ['ToolUse', 'Agent', 'SelfSup'],
      rating: 4,
      status: 'annotated',
      method: '基于自监督困惑度过滤机制，自动采样并筛选能降低后续 token 预测损失的 API 调用样本进行微调。',
      contribution: '证明中等规模语言模型无需大量人工标注即可学会自主判断何时、如何调用外部工具。',
      limitations: '仅支持单步无状态工具调用，缺乏链式组合、多轮交互与工具执行失败后的恢复机制。',
      cites: ['lewis2020rag'],
    },
    {
      id: 'asai2024selfrag',
      title: 'Self-RAG: Learning to Retrieve, Generate, and Critique through Self-Reflection',
      authors: 'Akari Asai, Zeqiu Wu, Yizhong Wang, Hannaneh Hajishirzi',
      year: 2024,
      venue: 'ICLR 2024',
      tags: ['RAG', 'Reflection', 'Critique'],
      rating: 5,
      status: 'annotated',
      method: '引入特殊反思令牌 (Retrieve/ISREL/ISSUP/ISUSE)，让模型按需触发检索并在生成阶段自评相关性与事实支撑度。',
      contribution: '突破固定检索瓶颈，在开放域问答与长文引用准确性上显著超越标准 RAG 与更大参数基线。',
      limitations: '反思令牌解码与树搜索带来推理延迟上升；训练依赖高质量评判模型蒸馏数据。',
      cites: ['lewis2020rag', 'schick2023toolformer'],
    },
    {
      id: 'wang2024voyager',
      title: 'Voyager: An Open-Ended Embodied Agent with Large Language Models',
      authors: 'Guanzhi Wang, Yuqi Xie, Yunfan Jiang, Linxi Fan et al.',
      year: 2024,
      venue: 'TMLR 2024',
      tags: ['Agent', 'Sandbox', 'CodeExec'],
      rating: 4,
      status: 'reading',
      method: '结合自动课程生成、可执行代码技能库与环境反馈自校验循环，在开放沙箱中持续积累可复用程序技能。',
      contribution: '提出以可执行代码作为长期记忆的终身学习智能体架构，显著提升探索广度与跨任务泛化。',
      limitations: '严重依赖强代码大模型与高成本闭环试错；沙箱执行安全隔离与技能版本漂移仍待治理。',
      cites: ['yao2023react', 'schick2023toolformer'],
    },
    {
      id: 'jimenez2024swebench',
      title: 'SWE-bench: Can Language Models Resolve Real-World GitHub Issues?',
      authors: 'Carlos E. Jimenez, John Yang, Alexander Wettig, Karthik Narasimhan',
      year: 2024,
      venue: 'ICLR 2024',
      tags: ['Sandbox', 'Benchmark', 'Agent'],
      rating: 5,
      status: 'annotated',
      method: '从 12 个真实 Python 开源仓库构建 2294 个 Issue-PR 评测任务，在隔离容器沙箱中运行单元测试客观验证补丁。',
      contribution: '建立软件工程 Agent 黄金评测基准，揭示长上下文跨文件定位、工具编排与测试驱动修复的真实瓶颈。',
      limitations: '容器镜像构建与执行开销大；部分旧 Issue 存在测试覆盖盲区及训练语料污染风险。',
      cites: ['lewis2020rag', 'yao2023react', 'wang2024voyager'],
    },
  ];

  const rows = {
    lewis2020rag: {
      architecture: 'DPR 稠密双塔检索 + BART-Large 生成器端到端边缘化',
      datasets: 'Natural Questions, TriviaQA, WebQuestions, FEVER',
      metrics: 'NQ EM 44.5%，开放域问答大幅领先纯参数模型',
      limitations: '固定 Top-K 检索，无法按需触发或自检证据冲突',
      reusable: '非参数索引热更新设计，适合企业私有知识库接入',
    },
    yao2023react: {
      architecture: 'Prompt 驱动的 Thought-Action-Observation 交替循环',
      datasets: 'HotpotQA, Fever, ALFWorld, WebShop',
      metrics: 'ALFWorld 成功率较纯 Act +34%，HotpotQA 显著降幻觉',
      limitations: '轨迹冗长易超上下文，缺乏显式回溯与预算控制',
      reusable: '标准化工具调用日志与可观测推理轨迹协议',
    },
    schick2023toolformer: {
      architecture: 'GPT-J 6B + 自监督困惑度收益过滤微调',
      datasets: 'ASDiv, SVAMP, LAMA, WebQS, TempLAMA',
      metrics: '6.7B 模型在计算/问答工具任务超越 175B GPT-3',
      limitations: '仅限单步无状态 API，不支持多工具组合编排',
      reusable: '基于损失下降量自动筛选高质量工具轨迹的数据飞轮',
    },
    asai2024selfrag: {
      architecture: 'Llama2-7B/13B + 自适应反思令牌 + 束搜索打分',
      datasets: 'PopQA, TriviaQA, PubHealth, ASQA, FactScore',
      metrics: 'FactScore 提升 15%+，长文引用精确度明显优于 ChatGPT+RAG',
      limitations: '多候选片段打分增加首字与整句延迟',
      reusable: '按需检索开关与生成后事实支撑度自检机制',
    },
    wang2024voyager: {
      architecture: '自动课程 + 向量检索代码技能库 + 执行反馈迭代修复',
      datasets: 'Minecraft 开放世界探索与科技树解锁基准',
      metrics: '解锁物品数 3.3× 于基线，科技树速度提升 15.3×',
      limitations: '高度依赖强推理模型 API 成本，缺乏沙箱安全策略',
      reusable: '把验证通过的脚本沉淀为可检索技能库的长期记忆模式',
    },
    jimenez2024swebench: {
      architecture: 'Docker 隔离代码执行沙箱 + 真实仓库 Git Patch 测试验证',
      datasets: 'SWE-bench (2294 tasks) / SWE-bench Lite (300 tasks)',
      metrics: '早期直接补丁仅 1.96%，推动 Agentic SWE 系统跃升至 50%+',
      limitations: '环境复现耗资源，部分任务存在隐式环境依赖',
      reusable: '基于确定性单元测试验收 Agent 输出的闭环评估框架',
    },
  };

  const stamp = today();
  const noteDocs = [
    {
      id: 'note-rw-agent-rag',
      title: 'Related Work：从静态 RAG 到沙箱验证型自主智能体',
      mode: 'related_work',
      paper_ids: ['lewis2020rag', 'yao2023react', 'asai2024selfrag', 'jimenez2024swebench'],
      created_at: stamp,
      content: [
        '## 相关工作脉络综述',
        '',
        '早期检索增强生成工作（Lewis et al., 2020）通过将非参数文档索引与预训练序列生成器解耦，有效缓解了知识密集型任务中的参数过时与幻觉问题。然而静态 Top-K 检索难以适配动态信息需求；Self-RAG（Asai et al., 2024）进一步引入反思令牌，使模型能够自适应决定检索时机并对证据支撑度进行细粒度自检。',
        '',
        '与此同时，语言模型智能体研究沿「推理—行动协同」方向迅速演进：ReAct（Yao et al., 2023）奠定了 Thought-Action-Observation 交替范式，Toolformer（Schick et al., 2023）探索了工具使用的自监督习得，Voyager（Wang et al., 2024）将可执行代码沉淀为可组合技能库。近期 SWE-bench（Jimenez et al., 2024）将上述能力推向真实软件工程沙箱，揭示了跨文件检索、受控工具执行与测试驱动验证深度融合的迫切需求。',
      ].join('\n'),
    },
    {
      id: 'note-gaps-sandbox',
      title: '核心研究空白：低延迟自反思检索与受控沙箱编排',
      mode: 'research_gaps',
      paper_ids: ['asai2024selfrag', 'wang2024voyager', 'jimenez2024swebench'],
      created_at: stamp,
      content: [
        '## 跨文献共性研究空白与切入点',
        '',
        '1. **证据自检与执行成本的帕累托权衡**：Self-RAG 与 ReAct 在多步决策中均面临高延迟与上下文膨胀问题，缺乏基于置信度预算的早停与轻量化校验机制。',
        '2. **可复用技能的沙箱安全边界**：Voyager 证明了代码技能库的威力，但未解决跨项目权限隔离、确定性回滚与版本漂移问题。',
        '3. **检索—推理—沙箱测试联合优化**：现有 SWE Agent 大多将代码检索与补丁验证割裂处理，未来可探索以单元测试反馈作为检索重排与技能提炼的统一奖励信号。',
      ].join('\n'),
    },
  ];

  const noteIndex = noteDocs.map(n => ({
    id: n.id,
    title: n.title,
    mode: n.mode,
    paper_ids: n.paper_ids,
    created_at: n.created_at,
    preview: n.content.replace(/\s+/g, ' ').trim().slice(0, 140),
  }));

  return {
    papers,
    matrix: {
      schema_version: 1,
      selected_ids: ['lewis2020rag', 'yao2023react', 'asai2024selfrag', 'jimenez2024swebench'],
      rows,
    },
    noteIndex,
    noteDocs,
  };
}

export default async function (request) {
  const { kind, contribution, input } = request ?? {};

  if (kind === 'action') {
    if (contribution === 'lab.load') {
      const pData = await readPapers();
      const mData = await readMatrix();
      const nData = await readNotesIndex();
      return {
        revision: nData.revision,
        kpi: computeKpi(pData.items, nData.items),
        papers: pData.items,
        matrix: mData.matrix,
        notes: nData.items,
      };
    }

    if (contribution === 'paper.save') {
      const { expected_revision, id, title, authors, year, venue, tags, rating, status, method, contribution: contrib, limitations, cites } = input;
      const cleanId = id.trim();
      const cleanTitle = title.trim();
      if (!cleanTitle || !/^[a-zA-Z0-9._-]+$/.test(cleanId) || !STATUSES.includes(status)) {
        return { status: 'invalid_input', revision: expected_revision };
      }
      const pData = await readPapers();
      if (pData.revision !== expected_revision) {
        return { status: 'conflict', revision: pData.revision };
      }
      const exists = pData.items.some(p => p.id === cleanId);
      if (!exists && pData.items.length >= MAX_PAPERS) {
        return { status: 'limit', revision: pData.revision };
      }
      const record = {
        id: cleanId,
        title: cleanTitle,
        authors: (authors || '').trim(),
        year,
        venue: (venue || '').trim(),
        tags: cleanStrList(tags, 6, 24),
        rating,
        status,
        method: (method || '').trim(),
        contribution: (contrib || '').trim(),
        limitations: (limitations || '').trim(),
        cites: cleanStrList(cites, 12, 40).filter(c => c !== cleanId),
      };
      const next = exists ? pData.items.map(p => (p.id === cleanId ? record : p)) : [...pData.items, record];
      const w = await safeWrite(COL_PAPERS, KEY_CATALOG, expected_revision, { schema_version: 1, items: next });
      return { status: w.status, revision: w.revision };
    }

    if (contribution === 'paper.delete') {
      const { expected_revision, id } = input;
      const pData = await readPapers();
      if (pData.revision !== expected_revision) return { status: 'conflict', revision: pData.revision };
      if (!pData.items.some(p => p.id === id)) return { status: 'not_found', revision: pData.revision };
      const mData = await readMatrix();

      const nextPapers = pData.items
        .filter(p => p.id !== id)
        .map(p => ({ ...p, cites: (p.cites || []).filter(c => c !== id) }));
      const w1 = await safeWrite(COL_PAPERS, KEY_CATALOG, expected_revision, { schema_version: 1, items: nextPapers });
      if (!w1.ok) return { status: 'conflict', revision: w1.revision };
      let rev = w1.revision;

      const nextSel = mData.matrix.selected_ids.filter(x => x !== id);
      const nextRows = { ...mData.matrix.rows };
      const hadRow = Object.prototype.hasOwnProperty.call(nextRows, id);
      delete nextRows[id];
      if (hadRow || nextSel.length !== mData.matrix.selected_ids.length) {
        const w2 = await safeWrite(COL_MATRIX, KEY_GRID, rev, { schema_version: 1, selected_ids: nextSel, rows: nextRows });
        if (w2.ok) rev = w2.revision;
      }
      return { status: 'deleted', revision: rev };
    }

    if (contribution === 'matrix.save') {
      const { expected_revision, selected_ids, paper_id, row } = input;
      const mData = await readMatrix();
      if (mData.revision !== expected_revision) return { status: 'conflict', revision: mData.revision };
      const nextSel = Array.isArray(selected_ids) ? cleanStrList(selected_ids, 8, 40) : mData.matrix.selected_ids;
      const nextRows = { ...mData.matrix.rows };
      if (paper_id && row) {
        nextRows[paper_id] = {
          architecture: (row.architecture || '').trim(),
          datasets: (row.datasets || '').trim(),
          metrics: (row.metrics || '').trim(),
          limitations: (row.limitations || '').trim(),
          reusable: (row.reusable || '').trim(),
        };
      }
      const w = await safeWrite(COL_MATRIX, KEY_GRID, expected_revision, {
        schema_version: 1,
        selected_ids: nextSel,
        rows: nextRows,
      });
      return { status: w.status, revision: w.revision };
    }

    if (contribution === 'note.get') {
      return readNoteDoc(input.id);
    }

    if (contribution === 'note.save') {
      const { expected_revision, id, title, mode, paper_ids, content } = input;
      const cleanId = id.trim();
      const cleanTitle = title.trim();
      const cleanContent = content.trim();
      if (!cleanTitle || !cleanContent || !/^[a-zA-Z0-9._-]+$/.test(cleanId) || !MODES.includes(mode)) {
        return { status: 'invalid_input', revision: expected_revision, id: cleanId };
      }
      const nIdx = await readNotesIndex();
      if (nIdx.revision !== expected_revision) return { status: 'conflict', revision: nIdx.revision, id: cleanId };
      const exists = nIdx.items.some(n => n.id === cleanId);
      if (!exists && nIdx.items.length >= MAX_NOTES) {
        return { status: 'limit', revision: nIdx.revision, id: cleanId };
      }
      const cleanPaperIds = cleanStrList(paper_ids, 8, 40);
      const stamp = today();
      const doc = {
        schema_version: 1,
        id: cleanId,
        title: cleanTitle,
        mode,
        paper_ids: cleanPaperIds,
        content: cleanContent,
        created_at: stamp,
      };
      const w1 = await safeWrite(COL_NOTES, `doc:${cleanId}`, expected_revision, doc);
      if (!w1.ok) return { status: w1.status, revision: w1.revision, id: cleanId };

      const entry = {
        id: cleanId,
        title: cleanTitle,
        mode,
        paper_ids: cleanPaperIds,
        created_at: stamp,
        preview: cleanContent.replace(/\s+/g, ' ').slice(0, 140),
      };
      const nextIdx = exists ? nIdx.items.map(n => (n.id === cleanId ? entry : n)) : [entry, ...nIdx.items];
      const w2 = await safeWrite(COL_NOTES, KEY_NOTES_IDX, w1.revision, { schema_version: 1, items: nextIdx });
      if (!w2.ok) return { status: w2.status, revision: w1.revision, id: cleanId };
      return { status: 'saved', revision: w2.revision, id: cleanId };
    }

    if (contribution === 'note.delete') {
      const { expected_revision, id } = input;
      const nIdx = await readNotesIndex();
      if (nIdx.revision !== expected_revision) return { status: 'conflict', revision: nIdx.revision };
      if (!nIdx.items.some(n => n.id === id)) return { status: 'not_found', revision: nIdx.revision };
      const nextIdx = nIdx.items.filter(n => n.id !== id);
      const w1 = await safeWrite(COL_NOTES, KEY_NOTES_IDX, expected_revision, { schema_version: 1, items: nextIdx });
      if (!w1.ok) return { status: 'conflict', revision: w1.revision };
      let rev = w1.revision;
      const w2 = await safeWrite(COL_NOTES, `doc:${id}`, rev, null);
      if (w2.ok) rev = w2.revision;
      return { status: 'deleted', revision: rev };
    }

    if (contribution === 'lab.seed_demo') {
      const { expected_revision } = input;
      const pData = await readPapers();
      if (pData.revision !== expected_revision) {
        return { status: 'conflict', revision: pData.revision, seeded_papers: 0, seeded_notes: 0 };
      }
      const demo = buildDemoData();
      let rev = expected_revision;
      const w1 = await safeWrite(COL_PAPERS, KEY_CATALOG, rev, { schema_version: 1, items: demo.papers });
      if (!w1.ok) return { status: w1.status, revision: w1.revision, seeded_papers: 0, seeded_notes: 0 };
      rev = w1.revision;

      const w2 = await safeWrite(COL_MATRIX, KEY_GRID, rev, demo.matrix);
      if (!w2.ok) return { status: w2.status, revision: rev, seeded_papers: 0, seeded_notes: 0 };
      rev = w2.revision;

      const w3 = await safeWrite(COL_NOTES, KEY_NOTES_IDX, rev, { schema_version: 1, items: demo.noteIndex });
      if (!w3.ok) return { status: w3.status, revision: rev, seeded_papers: 0, seeded_notes: 0 };
      rev = w3.revision;

      for (const n of demo.noteDocs) {
        const wn = await safeWrite(COL_NOTES, `doc:${n.id}`, rev, { schema_version: 1, ...n });
        if (!wn.ok) return { status: wn.status, revision: rev, seeded_papers: 0, seeded_notes: 0 };
        rev = wn.revision;
      }

      return { status: 'seeded', revision: rev, seeded_papers: demo.papers.length, seeded_notes: demo.noteDocs.length };
    }

    if (contribution === 'session.turn.request' || contribution === 'session.turn.result') {
      throw new Error(`${contribution} 需由 Velai Desktop 宿主页面桥接执行`);
    }

    if (contribution === 'document.list') {
      const pData = await readPapers();
      const nIdx = await readNotesIndex();
      const items = [];
      if (pData.items.length > 0) {
        items.push({ id: 'library', label: `文献库与方法论矩阵 (${pData.items.length} 篇论文)` });
      }
      for (const n of nIdx.items) {
        items.push({ id: `note:${n.id}`, label: `科研笔记: ${n.title.slice(0, 56)}` });
      }
      return { items };
    }

    if (contribution === 'document.export') {
      const id = input.id;
      if (id === 'library') {
        const pData = await readPapers();
        const mData = await readMatrix();
        const payload = { format: LIB_FORMAT, version: 1, papers: pData.items, matrix: mData.matrix };
        const text = JSON.stringify(payload, null, 2);
        if (jsonBytes(text) > MAX_BYTES) return { error: 'export_too_large' };
        return { filename: 'research-lab-library.json', text };
      }
      if (id.startsWith('note:')) {
        const noteId = id.slice(5);
        const doc = await readNoteDoc(noteId);
        if (!doc.found) return { error: 'not_found' };
        const payload = { format: NOTE_FORMAT, version: 1, note: doc.note };
        const text = JSON.stringify(payload, null, 2);
        if (jsonBytes(text) > MAX_BYTES) return { error: 'export_too_large' };
        return { filename: `research-note-${noteId}.json`, text };
      }
      return { error: 'not_found' };
    }

    if (contribution === 'document.import') {
      let parsed;
      try { parsed = JSON.parse(input.text); } catch { return { imported: false, reason: 'invalid_json', count: 0 }; }

      if (parsed?.format === LIB_FORMAT && parsed?.version === 1 && Array.isArray(parsed.papers)) {
        const pData = await readPapers();
        const mData = await readMatrix();
        const byId = new Map(pData.items.map(p => [p.id, p]));
        let count = 0;
        for (let i = 0; i < parsed.papers.length; i++) {
          const raw = parsed.papers[i];
          if (typeof raw?.title !== 'string' || !raw.title.trim()) continue;
          const pid = typeof raw.id === 'string' && /^[a-zA-Z0-9._-]+$/.test(raw.id)
            ? raw.id.slice(0, 40)
            : `paper-${Date.now().toString(36)}-${i}`;
          byId.set(pid, {
            id: pid,
            title: raw.title.trim().slice(0, 160),
            authors: typeof raw.authors === 'string' ? raw.authors.trim().slice(0, 120) : '',
            year: Number.isInteger(raw.year) && raw.year >= 1950 && raw.year <= 2100 ? raw.year : 2024,
            venue: typeof raw.venue === 'string' ? raw.venue.trim().slice(0, 48) : '',
            tags: cleanStrList(raw.tags, 6, 24),
            rating: Number.isInteger(raw.rating) && raw.rating >= 1 && raw.rating <= 5 ? raw.rating : 4,
            status: STATUSES.includes(raw.status) ? raw.status : 'unread',
            method: typeof raw.method === 'string' ? raw.method.trim().slice(0, 260) : '',
            contribution: typeof raw.contribution === 'string' ? raw.contribution.trim().slice(0, 260) : '',
            limitations: typeof raw.limitations === 'string' ? raw.limitations.trim().slice(0, 260) : '',
            cites: cleanStrList(raw.cites, 12, 40).filter(c => c !== pid),
          });
          count++;
        }
        const nextPapers = Array.from(byId.values());
        if (nextPapers.length > MAX_PAPERS) return { imported: false, reason: 'limit', count: 0 };
        const w1 = await safeWrite(COL_PAPERS, KEY_CATALOG, pData.revision, { schema_version: 1, items: nextPapers });
        if (!w1.ok) return { imported: false, reason: w1.status, count: 0 };

        if (parsed.matrix && typeof parsed.matrix.rows === 'object' && parsed.matrix.rows !== null) {
          const nextRows = { ...mData.matrix.rows };
          for (const [pid, row] of Object.entries(parsed.matrix.rows)) {
            if (!byId.has(pid) || typeof row !== 'object' || row === null) continue;
            nextRows[pid] = {
              architecture: String(row.architecture || '').trim().slice(0, 240),
              datasets: String(row.datasets || '').trim().slice(0, 180),
              metrics: String(row.metrics || '').trim().slice(0, 180),
              limitations: String(row.limitations || '').trim().slice(0, 240),
              reusable: String(row.reusable || '').trim().slice(0, 240),
            };
          }
          const nextSel = Array.isArray(parsed.matrix.selected_ids)
            ? cleanStrList(parsed.matrix.selected_ids, 8, 40).filter(id => byId.has(id))
            : mData.matrix.selected_ids;
          await safeWrite(COL_MATRIX, KEY_GRID, w1.revision, { schema_version: 1, selected_ids: nextSel, rows: nextRows });
        }
        return { imported: true, count };
      }

      if (parsed?.format === NOTE_FORMAT && parsed?.version === 1 && parsed?.note && typeof parsed.note.content === 'string') {
        const raw = parsed.note;
        const nid = typeof raw.id === 'string' && /^[a-zA-Z0-9._-]+$/.test(raw.id)
          ? raw.id.slice(0, 40)
          : `note-${Date.now().toString(36)}`;
        const title = typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim().slice(0, 100) : '导入的科研笔记';
        const content = raw.content.trim().slice(0, 6000);
        if (!content) return { imported: false, reason: 'invalid_document', count: 0 };
        const nIdx = await readNotesIndex();
        const mode = MODES.includes(raw.mode) ? raw.mode : 'custom';
        const paper_ids = cleanStrList(raw.paper_ids, 8, 40);
        const stamp = today();
        const doc = { schema_version: 1, id: nid, title, mode, paper_ids, content, created_at: stamp };
        const w1 = await safeWrite(COL_NOTES, `doc:${nid}`, nIdx.revision, doc);
        if (!w1.ok) return { imported: false, reason: w1.status, count: 0 };
        const entry = { id: nid, title, mode, paper_ids, created_at: stamp, preview: content.replace(/\s+/g, ' ').slice(0, 140) };
        const exists = nIdx.items.some(n => n.id === nid);
        const nextIdx = exists ? nIdx.items.map(n => (n.id === nid ? entry : n)) : [entry, ...nIdx.items];
        const w2 = await safeWrite(COL_NOTES, KEY_NOTES_IDX, w1.revision, { schema_version: 1, items: nextIdx });
        return w2.ok ? { imported: true, count: 1 } : { imported: false, reason: w2.status, count: 0 };
      }

      return { imported: false, reason: 'invalid_document', count: 0 };
    }
  }

  if (kind === 'tool') {
    if (contribution === 'paper.search') {
      const pData = await readPapers();
      const kw = (input.keyword || '').trim().toLowerCase();
      const tagQ = (input.tag || '').trim().toLowerCase();
      const filtered = pData.items
        .filter(p => {
          if (input.status && p.status !== input.status) return false;
          if (input.min_rating && p.rating < input.min_rating) return false;
          if (tagQ && !(p.tags || []).some(t => t.toLowerCase() === tagQ)) return false;
          if (kw) {
            const hay = `${p.id} ${p.title} ${p.authors} ${p.venue} ${(p.tags || []).join(' ')} ${p.method} ${p.contribution}`.toLowerCase();
            if (!hay.includes(kw)) return false;
          }
          return true;
        })
        .sort((a, b) => b.year - a.year || b.rating - a.rating)
        .map(p => ({
          id: p.id,
          title: p.title,
          authors: p.authors,
          year: p.year,
          venue: p.venue,
          rating: p.rating,
          status: p.status,
          tags: p.tags,
          cites_count: (p.cites || []).length,
        }));
      return { success: true, status: 'ready', total: filtered.length, papers: filtered };
    }

    if (contribution === 'paper.read') {
      const pData = await readPapers();
      const paper = pData.items.find(p => p.id === input.id);
      if (!paper) return { success: false, status: 'not_found' };
      const mData = await readMatrix();
      const cited_by = pData.items.filter(p => (p.cites || []).includes(paper.id)).map(p => p.id);
      const matrix_row = mData.matrix.rows[paper.id] || defaultMatrixRow(paper);
      return { success: true, status: 'ready', paper, cited_by, matrix_row };
    }

    if (contribution === 'paper.add') {
      const cleanTitle = (input.title || '').trim();
      const cleanAuthors = (input.authors || '').trim();
      if (!cleanTitle || !cleanAuthors) return { success: false, status: 'invalid_input' };
      const pData = await readPapers();
      if (pData.items.length >= MAX_PAPERS) return { success: false, status: 'limit' };
      const slug = cleanTitle.toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 12) || 'paper';
      const id = input.id && /^[a-zA-Z0-9._-]+$/.test(input.id.trim())
        ? input.id.trim().slice(0, 40)
        : `${slug}${input.year}-${pData.items.length + 1}`;
      const record = {
        id,
        title: cleanTitle,
        authors: cleanAuthors,
        year: input.year,
        venue: (input.venue || '').trim(),
        tags: cleanStrList(input.tags, 6, 24),
        rating: input.rating ?? 4,
        status: STATUSES.includes(input.status) ? input.status : 'unread',
        method: (input.method || '').trim(),
        contribution: (input.contribution || '').trim(),
        limitations: (input.limitations || '').trim(),
        cites: cleanStrList(input.cites, 12, 40).filter(c => c !== id),
      };
      const exists = pData.items.some(p => p.id === id);
      const next = exists ? pData.items.map(p => (p.id === id ? record : p)) : [...pData.items, record];
      const w = await safeWrite(COL_PAPERS, KEY_CATALOG, pData.revision, { schema_version: 1, items: next });
      return w.ok ? { success: true, status: 'saved', id } : { success: false, status: w.status };
    }
  }

  throw new Error(`不支持的调用: ${kind}/${contribution}`);
}
