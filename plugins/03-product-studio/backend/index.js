const COL_REQ = 'requirements';
const COL_MAP = 'roadmap';
const COL_SPEC = 'specs';
const KEY_REQ = 'list';
const KEY_MAP = 'plan';
const KEY_SPEC_IDX = 'index';

const MAX_RECORD_BYTES = 240 * 1024;
const MAX_BYTES = MAX_RECORD_BYTES;
const MAX_REQS = 80;
const STATUSES = ['backlog', 'planned', 'in_progress', 'review', 'shipped'];
const BUNDLE_FORMAT = 'velai.product-studio.bundle';
const PRD_FORMAT = 'velai.product-studio.prd';

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

function clampNum(v, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

function calcRice(reach, impact, confidence, effort) {
  const value_score = Math.round(reach * impact * (confidence / 100));
  const rice = Math.round(value_score / effort);
  const priority = rice >= 1200 ? 'P0' : rice >= 600 ? 'P1' : rice >= 250 ? 'P2' : 'P3';
  return { value_score, rice, priority };
}

function calcSpecScore(spec) {
  const len = s => (typeof s === 'string' ? Array.from(s.trim()).length : 0);
  const lines = s => (typeof s === 'string' ? s.trim().split(/\r?\n/).filter(l => l.trim().length > 0).length : 0);
  let score = 0;
  const bg = len(spec.background);
  if (bg >= 35) score += 20;
  else if (bg >= 15) score += 10;

  const us = len(spec.user_stories);
  if (us >= 35) score += 20;
  else if (us >= 15) score += 10;

  const cf = len(spec.core_flow);
  const cfLines = lines(spec.core_flow);
  if (cf >= 40 || cfLines >= 2) score += 20;
  else if (cf >= 15) score += 10;

  const ac = len(spec.acceptance_criteria);
  const acLines = lines(spec.acceptance_criteria);
  if (ac >= 40 || acLines >= 2) score += 25;
  else if (ac >= 15 || acLines >= 1) score += 12;

  const rk = len(spec.risks);
  if (rk >= 25) score += 15;
  else if (rk >= 10) score += 8;

  return Math.min(100, score);
}

function defaultRoadmap() {
  return {
    schema_version: 1,
    total_weeks: 12,
    current_week: 5,
    milestones: [],
    lanes: [],
  };
}

async function readReqs() {
  const r = await globalThis.nmas.data.read({ collection: COL_REQ, key: KEY_REQ });
  const doc = r.value === null ? { schema_version: 1, items: [] } : r.value;
  if (!doc || doc.schema_version !== 1 || !Array.isArray(doc.items)) {
    throw new Error('需求池数据格式无效');
  }
  return { revision: r.revision, items: doc.items };
}

async function readRoadmap() {
  const r = await globalThis.nmas.data.read({ collection: COL_MAP, key: KEY_MAP });
  const doc = r.value === null ? defaultRoadmap() : r.value;
  if (!doc || doc.schema_version !== 1 || !Array.isArray(doc.lanes)) {
    throw new Error('路线图数据格式无效');
  }
  return {
    revision: r.revision,
    roadmap: {
      total_weeks: doc.total_weeks || 12,
      current_week: doc.current_week || 5,
      milestones: Array.isArray(doc.milestones) ? doc.milestones : [],
      lanes: doc.lanes,
    },
  };
}

async function readSpecIndex() {
  const r = await globalThis.nmas.data.read({ collection: COL_SPEC, key: KEY_SPEC_IDX });
  const doc = r.value === null ? { schema_version: 1, scores: {} } : r.value;
  if (!doc || doc.schema_version !== 1 || typeof doc.scores !== 'object' || doc.scores === null) {
    throw new Error('PRD 索引数据格式无效');
  }
  return { revision: r.revision, scores: doc.scores };
}

async function readSpecDoc(reqId) {
  const r = await globalThis.nmas.data.read({ collection: COL_SPEC, key: `doc:${reqId}` });
  if (r.value === null) {
    return {
      revision: r.revision,
      spec: {
        req_id: reqId,
        background: '',
        user_stories: '',
        core_flow: '',
        acceptance_criteria: '',
        risks: '',
        score: 0,
        updated_at: '',
      },
    };
  }
  const s = r.value;
  return {
    revision: r.revision,
    spec: {
      req_id: reqId,
      background: s.background || '',
      user_stories: s.user_stories || '',
      core_flow: s.core_flow || '',
      acceptance_criteria: s.acceptance_criteria || '',
      risks: s.risks || '',
      score: typeof s.score === 'number' ? s.score : calcSpecScore(s),
      updated_at: s.updated_at || '',
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

async function safeDelete(collection, key, expectedRevision) {
  try {
    const receipt = await globalThis.nmas.data.delete({
      collection,
      key,
      expected_revision: expectedRevision,
    });
    return { ok: true, status: 'deleted', revision: receipt.revision };
  } catch (err) {
    if (err?.code === 'conflict' && err.outcome_unknown === false) {
      return { ok: false, status: 'conflict', revision: expectedRevision };
    }
    throw err;
  }
}

function formatPrdMarkdown(req, spec) {
  return [
    `# PRD: ${req.title}`,
    `- ID: \`${req.id}\` | 模块：${req.module} | 优先级：${req.priority} (RICE ${req.rice}) | 负责人：${req.owner || '-'} | 迭代：${req.sprint || '-'}`,
    '',
    '## 1. 背景与目标',
    spec.background || '（待补充）',
    '',
    '## 2. 用户故事',
    spec.user_stories || '（待补充）',
    '',
    '## 3. 核心业务流程',
    spec.core_flow || '（待补充）',
    '',
    '## 4. 验收标准 (AC)',
    spec.acceptance_criteria || '（待补充）',
    '',
    '## 5. 边界与风险',
    spec.risks || '（待补充）',
    '',
  ].join('\n');
}

function formatRoadmapMarkdown(items, roadmap) {
  const lines = [
    '# 产品需求与路线图总览',
    `- 周期：共 ${roadmap.total_weeks} 周（当前 W${roadmap.current_week}） | 需求总数：${items.length}`,
    '',
    '## 里程碑',
    ...(roadmap.milestones.length
      ? roadmap.milestones.map(m => `- W${m.week}: ${m.title}`)
      : ['- （暂无里程碑）']),
    '',
    '## 需求优先级列表 (按 RICE 降序)',
    '| ID | 需求 | 模块 | 状态 | 优先级 | RICE | 负责人 | 迭代 |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  const sorted = [...items].sort((a, b) => b.rice - a.rice);
  for (const r of sorted) {
    lines.push(`| ${r.id} | ${r.title} | ${r.module} | ${r.status} | ${r.priority} | ${r.rice} | ${r.owner || '-'} | ${r.sprint || '-'} |`);
  }
  return `${lines.join('\n')}\n`;
}

function buildKpi(items, scores) {
  const total = items.length;
  const in_progress = items.filter(i => i.status === 'in_progress' || i.status === 'review').length;
  const shipped = items.filter(i => i.status === 'shipped').length;
  const avg_rice = total === 0 ? 0 : Math.round(items.reduce((s, i) => s + i.rice, 0) / total);
  const avg_spec_score =
    total === 0
      ? 0
      : Math.round(
          items.reduce((s, i) => s + (typeof scores[i.id]?.score === 'number' ? scores[i.id].score : 0), 0) / total,
        );
  return { total, in_progress, shipped, avg_rice, avg_spec_score };
}

function buildDemoData() {
  const rawReqs = [
    {
      id: 'req-sandbox-qjs',
      title: 'QuickJS 零冷启动沙箱内核',
      module: '运行时内核',
      status: 'shipped',
      reach: 4200,
      impact: 3,
      confidence: 95,
      effort: 3,
      owner: '林晓',
      sprint: 'S1 · 内核筑基',
      summary: '预热 QuickJS 实例池并将单次插件 Action 调用冷启动延迟压至 8ms 以内。',
      lane: { start_week: 1, duration_weeks: 3, progress: 100 },
      spec: {
        background: 'v1 插件运行时每次调用重新初始化 JS 上下文，导致交互高频操作出现 60~120ms 卡顿，亟需构建可复用且严格隔离的沙箱内核。',
        user_stories: '作为插件用户，我希望点击按钮与切换视图几乎零延迟；作为安全审计员，我希望每次执行结束后彻底清理内存与全局状态。',
        core_flow: '1. 启动期预创建 4 个冻结全局原型的 QuickJS Runtime\n2. 收到 Action 请求时借出上下文并注入受限 Broker 代理\n3. 超时 2s 强杀并回收内存，归还池前校验无泄露',
        acceptance_criteria: '1. P95 Action 响应耗时 <= 12ms\n2. 单次调用内存硬上限 32 MiB，超限返回确定性 resource_limit\n3. 连续 1000 次调用零跨插件状态污染',
        risks: '需防止 Promise 微任务在归还池后残留触发；需与 macOS Seatbelt 沙箱协同验证。',
      },
    },
    {
      id: 'req-tool-bridge',
      title: 'Agent Tools 统一声明与权限确认流',
      module: 'AI 编排',
      status: 'shipped',
      reach: 3600,
      impact: 3,
      confidence: 90,
      effort: 2.5,
      owner: '陈默',
      sprint: 'S1 · 内核筑基',
      summary: '支持插件注册结构化 Agent Tools，自动校验 JSON Schema 并在写入时弹出明确授权提示。',
      lane: { start_week: 2, duration_weeks: 3, progress: 100 },
      spec: {
        background: '用户希望 Velai AI 助手能直接读写插件内项目数据，但缺乏统一工具注册、Schema 强校验及最小权限隔离机制。',
        user_stories: '作为开发者，我只需在 manifest.json 声明 tools 即可被会话调用；作为用户，我能清晰看到每个工具的读写权限并一键启停。',
        core_flow: '1. 安装阶段静态审计 tools Schema 与权限子集\n2. 会话加载时将启用插件的工具注入模型工具目录\n3. 调用前校验入参 Schema，调用后校验出参 success/status 字段',
        acceptance_criteria: '1. 单账号严格限制最多注册 32 个插件工具\n2. 非法 Schema 或越权声明在安装期 100% 拦截\n3. 工具调用失败时显式返回结构化错误而非静默降级',
        risks: '工具描述过长可能挤占上下文窗口，需要强制限制 description <= 512 字节。',
      },
    },
    {
      id: 'req-cas-kv',
      title: '分域 CAS 乐观锁本地数据引擎',
      module: '运行时内核',
      status: 'review',
      reach: 2800,
      impact: 2,
      confidence: 95,
      effort: 2,
      owner: '林晓',
      sprint: 'S2 · 存储与安全',
      summary: '提供 project / account 双域隔离 KV 存储，强制 expected_revision CAS 防止多窗口并发覆盖。',
      lane: { start_week: 4, duration_weeks: 3, progress: 88 },
      spec: {
        background: '同一插件可能同时在主工作区与聊天侧栏打开，若直接覆盖写入极易丢失用户编辑内容。',
        user_stories: '作为多窗口重度用户，当我同时在两个面板编辑数据时，系统应及时发现版本冲突并提示刷新，而不是静默覆盖。',
        core_flow: '1. 按 plugin_id + scope + collection 物理分库\n2. 每次写入强制校验 expected_revision 与当前修订号一致\n3. 冲突时返回确定性 conflict 错误且不递增修订号',
        acceptance_criteria: '1. project 域数据切换项目后 100% 不可见\n2. 单条记录超过 16 KiB 时明确拒绝并返回 resource_limit\n3. 并发写入压测下零数据损坏',
        risks: '插件开发者可能忘记拆分大对象，需在文档与校验器中给出 12 KiB 推荐阈值预警。',
      },
    },
    {
      id: 'req-market-verify',
      title: '插件市场签名验证与 GitHub 自动更新源',
      module: '插件生态',
      status: 'in_progress',
      reach: 3200,
      impact: 3,
      confidence: 85,
      effort: 5,
      owner: '周晴',
      sprint: 'S2 · 存储与安全',
      summary: '支持从 GitHub Release 拉取 .nmas-plugin 归档包，自动校验 SHA-256 摘要并灰度升级。',
      lane: { start_week: 4, duration_weeks: 4, progress: 62 },
      spec: {
        background: '目前用户只能手工下载本地插件包导入，升级流程繁琐且难以核验包完整性与权限变更。',
        user_stories: '作为团队管理员，我希望配置公司 GitHub 仓库作为更新源，一键安装并检查全员插件更新。',
        core_flow: '1. 定时拉取 catalog.json 并比对已安装版本与 package_digest\n2. 下载归档包并在临时隔离目录完成全量文件 SHA-256 校验\n3. 若新版本新增高危权限则弹窗等待用户重新确认',
        acceptance_criteria: '1. 摘要不匹配立即中止安装并清理临时文件\n2. 新增权限未获授权前保持旧版本运行\n3. 支持一键回滚至上一个已验证快照',
        risks: 'GitHub API 限流可能导致检查失败，需支持 ETag 条件请求与清晰错误提示。',
      },
    },
    {
      id: 'req-turn-orchestrator',
      title: '受管 AI 伴生与 Workspace FS 协同协议',
      module: 'AI 编排',
      status: 'in_progress',
      reach: 2400,
      impact: 2,
      confidence: 80,
      effort: 3.5,
      owner: '陈默',
      sprint: 'S3 · 体验跃升',
      summary: '支持独立 AI 伴生插件与项目工作区 FS CAS 双向同步，实现文档草稿审阅与确定性落盘。',
      lane: { start_week: 5, duration_weeks: 3, progress: 45 },
      spec: {
        background: '产品 PRD、架构 ADR 等深度文档场景需要结合工作区文件读写与受管 AI 伴生能力。',
        user_stories: '作为产品经理，我希望在工作区浏览并导入已有文档，经审阅后以 CAS 方式安全写回项目仓库。',
        core_flow: '1. 插件调用 nmas.fs.listDir/readText 读取项目工作区文件并获取 SHA-256\n2. 编辑或通过独立 AI 伴生插件完善内容\n3. 通过 expected_sha256 或 create_only 原子写回工作区',
        acceptance_criteria: '1. workspace.fs.* 仅限 project scope 插件且禁止 assistant surface\n2. 严禁访问 .env / .git / 密钥等敏感路径\n3. 并发写入冲突时返回确定性 conflict 错误',
        risks: '需校验父目录存在性且不自动建目录，避免误写至未预期路径。',
      },
    },
    {
      id: 'req-ui-kit-tokens',
      title: '插件宿主自适应主题令牌桥接',
      module: '开发者工具',
      status: 'planned',
      reach: 1800,
      impact: 1,
      confidence: 90,
      effort: 1,
      owner: '陆川',
      sprint: 'S3 · 体验跃升',
      summary: '向插件 WebView 注入统一明暗色阶与圆角间距变量，降低社区插件视觉割裂感。',
      lane: { start_week: 7, duration_weeks: 2, progress: 15 },
      spec: {
        background: '社区插件风格参差不齐，尤其在深浅色模式切换时易出现对比度不足问题。',
        user_stories: '作为插件作者，我希望开箱即用一套精致高对比 CSS 变量，自动跟随桌面端主题。',
        core_flow: '1. 宿主在 WebView 初始化时注入主题配色 token 与 color-scheme\n2. 主题切换时通过事件通知插件页面平滑过渡',
        acceptance_criteria: '1. 深浅色模式正文对比度均 >= 7:1 (WCAG AAA)\n2. 零外部字体与 CDN 依赖',
        risks: '需避免覆盖插件自定义主题切换开关的显式选择。',
      },
    },
    {
      id: 'req-sandbox-audit',
      title: '可视化沙箱权限与调用审计面板',
      module: '安全沙箱',
      status: 'planned',
      reach: 1500,
      impact: 2,
      confidence: 75,
      effort: 4.5,
      owner: '周晴',
      sprint: 'S3 · 体验跃升',
      summary: '实时记录每个插件的存储读写次数、HTTP 只读请求与 Broker 预算消耗，支持异常一键熔断。',
      lane: { start_week: 8, duration_weeks: 3, progress: 10 },
      spec: {
        background: '企业级用户安装第三方插件前需要明确的可观测性保障，实时掌握数据访问行为。',
        user_stories: '作为安全敏感用户，我希望随时查看插件最近 50 次调用的耗时、数据读写大小与被拒记录。',
        core_flow: '1. Broker 层汇总每次调用的延迟、读写字节数与错误码\n2. 审计面板按插件聚合展示趋势并支持导出诊断报告',
        acceptance_criteria: '1. 审计日志不记录敏感业务明文，仅记录脱敏元数据\n2. 异常插件可一键禁用并立即终止后续调用',
        risks: '高频日志写入不能拖慢主调用路径，需采用环形内存缓冲异步落盘。',
      },
    },
    {
      id: 'req-cli-debugger',
      title: '插件热重载 CLI 与模拟器套件',
      module: '开发者工具',
      status: 'backlog',
      reach: 650,
      impact: 1,
      confidence: 65,
      effort: 5.5,
      owner: '陆川',
      sprint: 'S4 · 开发者生态',
      summary: '提供本地热更新、Mock Broker 断点调试与自动化契约验收 CLI，缩短社区开发周期。',
      lane: { start_week: 10, duration_weeks: 3, progress: 0 },
      spec: {
        background: '外部开发者目前需要手工打包并导入桌面端验证 UI 效果，调试反馈链路较长。',
        user_stories: '作为社区开发者，我希望运行一条命令即可在本地预览 UI 并实时校验 Schema 与字节预算。',
        core_flow: '1. 监听 manifest/backend/ui 文件变化自动重跑校验器\n2. 本地启动沙箱代理模拟 nmasPlugin 桥与 CAS 存储',
        acceptance_criteria: '1. 错误精准定位到具体 Schema 字段与行号\n2. 零第三方重型依赖，支持 Node 20+ 开箱运行',
        risks: '本地模拟器行为必须与 macOS 真实宿主保持严格一致，避免误导开发者。',
      },
    },
  ];

  const reqItems = [];
  const lanes = [];
  const specScores = {};
  const specDocs = {};
  const stamp = today();

  for (const r of rawReqs) {
    const { value_score, rice, priority } = calcRice(r.reach, r.impact, r.confidence, r.effort);
    reqItems.push({
      id: r.id,
      title: r.title,
      module: r.module,
      status: r.status,
      reach: r.reach,
      impact: r.impact,
      confidence: r.confidence,
      effort: r.effort,
      value_score,
      rice,
      priority,
      owner: r.owner,
      sprint: r.sprint,
      summary: r.summary,
    });
    lanes.push({
      req_id: r.id,
      lane: r.module,
      start_week: r.lane.start_week,
      duration_weeks: r.lane.duration_weeks,
      progress: r.lane.progress,
    });
    const score = calcSpecScore(r.spec);
    specScores[r.id] = { score, updated_at: stamp };
    specDocs[r.id] = {
      schema_version: 1,
      req_id: r.id,
      ...r.spec,
      score,
      updated_at: stamp,
    };
  }

  const roadmap = {
    schema_version: 1,
    total_weeks: 12,
    current_week: 5,
    milestones: [
      { id: 'ms-1', title: 'M1 内核冻结', week: 3, color: '#10b981' },
      { id: 'ms-2', title: 'M2 商店内测', week: 6, color: '#6366f1' },
      { id: 'ms-3', title: 'M3 v2.0 GA', week: 10, color: '#f59e0b' },
      { id: 'ms-4', title: 'M4 生态发布', week: 12, color: '#22d3ee' },
    ],
    lanes,
  };

  return { reqItems, roadmap, specScores, specDocs };
}

export default async function (request) {
  const { kind, contribution, input } = request ?? {};

  if (kind === 'action') {
    if (contribution === 'studio.load') {
      const reqData = await readReqs();
      const mapData = await readRoadmap();
      const specIdx = await readSpecIndex();
      return {
        revision: specIdx.revision,
        kpi: buildKpi(reqData.items, specIdx.scores),
        requirements: reqData.items,
        roadmap: mapData.roadmap,
        spec_scores: specIdx.scores,
      };
    }

    if (contribution === 'req.save') {
      const { expected_revision, id, title, module, status, reach, impact, confidence, effort, owner, sprint, summary } = input;
      const cleanTitle = title.trim();
      const cleanId = id.trim();
      if (!cleanTitle || !/^[a-zA-Z0-9._-]+$/.test(cleanId) || !STATUSES.includes(status)) {
        return { status: 'invalid_input', revision: expected_revision };
      }
      const reqData = await readReqs();
      if (reqData.revision !== expected_revision) {
        return { status: 'conflict', revision: reqData.revision };
      }
      const mapData = await readRoadmap();
      const { value_score, rice, priority } = calcRice(reach, impact, confidence, effort);
      const record = {
        id: cleanId,
        title: cleanTitle,
        module: (module || '核心模块').trim() || '核心模块',
        status,
        reach,
        impact,
        confidence,
        effort,
        value_score,
        rice,
        priority,
        owner: (owner || '').trim(),
        sprint: (sprint || '').trim(),
        summary: (summary || '').trim(),
      };
      const exists = reqData.items.some(i => i.id === cleanId);
      if (!exists && reqData.items.length >= MAX_REQS) {
        return { status: 'limit', revision: reqData.revision };
      }
      const nextReqs = exists ? reqData.items.map(i => (i.id === cleanId ? record : i)) : [...reqData.items, record];
      const w1 = await safeWrite(COL_REQ, KEY_REQ, expected_revision, { schema_version: 1, items: nextReqs });
      if (!w1.ok) return { status: w1.status, revision: w1.revision };

      // Keep roadmap lane synced
      let nextRev = w1.revision;
      const existingLane = mapData.roadmap.lanes.find(l => l.req_id === cleanId);
      const wantLaneUpdate =
        !existingLane ||
        input.start_week !== undefined ||
        input.duration_weeks !== undefined ||
        input.progress !== undefined ||
        existingLane.lane !== record.module;
      if (wantLaneUpdate) {
        const defaultProg = status === 'shipped' ? 100 : status === 'review' ? 85 : status === 'in_progress' ? 45 : 0;
        const laneItem = {
          req_id: cleanId,
          lane: record.module,
          start_week: input.start_week ?? existingLane?.start_week ?? Math.min(mapData.roadmap.total_weeks, mapData.roadmap.current_week),
          duration_weeks: input.duration_weeks ?? existingLane?.duration_weeks ?? Math.max(1, Math.min(6, Math.ceil(effort))),
          progress: input.progress ?? existingLane?.progress ?? defaultProg,
        };
        const nextLanes = existingLane
          ? mapData.roadmap.lanes.map(l => (l.req_id === cleanId ? laneItem : l))
          : [...mapData.roadmap.lanes, laneItem];
        const w2 = await safeWrite(COL_MAP, KEY_MAP, nextRev, {
          schema_version: 1,
          ...mapData.roadmap,
          lanes: nextLanes,
        });
        if (!w2.ok) return { status: w2.status, revision: nextRev };
        nextRev = w2.revision;
      }
      return { status: 'saved', revision: nextRev, rice, priority };
    }

    if (contribution === 'req.delete') {
      const { expected_revision, id } = input;
      const reqData = await readReqs();
      if (reqData.revision !== expected_revision) return { status: 'conflict', revision: reqData.revision };
      if (!reqData.items.some(i => i.id === id)) return { status: 'not_found', revision: reqData.revision };
      const mapData = await readRoadmap();
      const specIdx = await readSpecIndex();

      const nextReqs = reqData.items.filter(i => i.id !== id);
      const w1 = await safeWrite(COL_REQ, KEY_REQ, expected_revision, { schema_version: 1, items: nextReqs });
      if (!w1.ok) return { status: 'conflict', revision: w1.revision };
      let nextRev = w1.revision;

      if (mapData.roadmap.lanes.some(l => l.req_id === id)) {
        const nextLanes = mapData.roadmap.lanes.filter(l => l.req_id !== id);
        const w2 = await safeWrite(COL_MAP, KEY_MAP, nextRev, { schema_version: 1, ...mapData.roadmap, lanes: nextLanes });
        if (w2.ok) nextRev = w2.revision;
      }

      if (Object.prototype.hasOwnProperty.call(specIdx.scores, id)) {
        const nextScores = { ...specIdx.scores };
        delete nextScores[id];
        const w3 = await safeWrite(COL_SPEC, KEY_SPEC_IDX, nextRev, { schema_version: 1, scores: nextScores });
        if (w3.ok) nextRev = w3.revision;
      }
      const w4 = await safeDelete(COL_SPEC, `doc:${id}`, nextRev);
      if (w4.ok) nextRev = w4.revision;

      return { status: 'deleted', revision: nextRev };
    }

    if (contribution === 'roadmap.save') {
      const { expected_revision, total_weeks, current_week, milestones, lanes } = input;
      const mapData = await readRoadmap();
      if (mapData.revision !== expected_revision) return { status: 'conflict', revision: mapData.revision };
      const cleanMilestones = milestones.slice(0, 10).map(m => ({
        id: m.id.trim(),
        title: m.title.trim(),
        week: clampNum(Math.round(m.week), 1, total_weeks),
        color: m.color.trim() || '#6366f1',
      }));
      const cleanLanes = lanes.slice(0, MAX_REQS).map(l => ({
        req_id: l.req_id.trim(),
        lane: (l.lane || '核心模块').trim(),
        start_week: clampNum(Math.round(l.start_week), 1, total_weeks),
        duration_weeks: clampNum(Math.round(l.duration_weeks), 1, 16),
        progress: clampNum(Math.round(l.progress), 0, 100),
      }));
      const w = await safeWrite(COL_MAP, KEY_MAP, expected_revision, {
        schema_version: 1,
        total_weeks,
        current_week: clampNum(current_week, 1, total_weeks),
        milestones: cleanMilestones,
        lanes: cleanLanes,
      });
      return { status: w.status, revision: w.revision };
    }

    if (contribution === 'spec.get') {
      const data = await readSpecDoc(input.req_id);
      return { revision: data.revision, spec: data.spec };
    }

    if (contribution === 'spec.save') {
      const { expected_revision, req_id, background, user_stories, core_flow, acceptance_criteria, risks } = input;
      const cleanId = req_id.trim();
      if (!/^[a-zA-Z0-9._-]+$/.test(cleanId)) {
        return { status: 'invalid_input', revision: expected_revision, score: 0 };
      }
      const specIdx = await readSpecIndex();
      if (specIdx.revision !== expected_revision) {
        return { status: 'conflict', revision: specIdx.revision, score: specIdx.scores[cleanId]?.score || 0 };
      }
      const doc = {
        schema_version: 1,
        req_id: cleanId,
        background: background.trim(),
        user_stories: user_stories.trim(),
        core_flow: core_flow.trim(),
        acceptance_criteria: acceptance_criteria.trim(),
        risks: risks.trim(),
        updated_at: today(),
      };
      const score = calcSpecScore(doc);
      doc.score = score;

      const w1 = await safeWrite(COL_SPEC, `doc:${cleanId}`, expected_revision, doc);
      if (!w1.ok) return { status: w1.status, revision: w1.revision, score };

      const nextScores = { ...specIdx.scores, [cleanId]: { score, updated_at: doc.updated_at } };
      const w2 = await safeWrite(COL_SPEC, KEY_SPEC_IDX, w1.revision, { schema_version: 1, scores: nextScores });
      if (!w2.ok) return { status: w2.status, revision: w1.revision, score };

      return { status: 'saved', revision: w2.revision, score };
    }

    if (contribution === 'studio.seed_demo') {
      const { expected_revision } = input;
      const reqData = await readReqs();
      if (reqData.revision !== expected_revision) {
        return { status: 'conflict', revision: reqData.revision, seeded_count: 0 };
      }
      const demo = buildDemoData();
      let rev = expected_revision;

      const w1 = await safeWrite(COL_REQ, KEY_REQ, rev, { schema_version: 1, items: demo.reqItems });
      if (!w1.ok) return { status: w1.status, revision: w1.revision, seeded_count: 0 };
      rev = w1.revision;

      const w2 = await safeWrite(COL_MAP, KEY_MAP, rev, demo.roadmap);
      if (!w2.ok) return { status: w2.status, revision: rev, seeded_count: 0 };
      rev = w2.revision;

      const w3 = await safeWrite(COL_SPEC, KEY_SPEC_IDX, rev, { schema_version: 1, scores: demo.specScores });
      if (!w3.ok) return { status: w3.status, revision: rev, seeded_count: 0 };
      rev = w3.revision;

      for (const reqId of Object.keys(demo.specDocs)) {
        const ws = await safeWrite(COL_SPEC, `doc:${reqId}`, rev, demo.specDocs[reqId]);
        if (!ws.ok) return { status: ws.status, revision: rev, seeded_count: 0 };
        rev = ws.revision;
      }

      return { status: 'seeded', revision: rev, seeded_count: demo.reqItems.length };
    }

    if (contribution === 'document.list') {
      const reqData = await readReqs();
      const specIdx = await readSpecIndex();
      const items = [];
      if (reqData.items.length > 0) {
        items.push({ id: 'all', label: `需求池与路线图总览 (${reqData.items.length} 条需求)` });
        for (const r of reqData.items) {
          const sc = specIdx.scores[r.id]?.score || 0;
          items.push({ id: `prd:${r.id}`, label: `PRD: ${r.title.slice(0, 48)} (${sc}分)` });
        }
      }
      return { items };
    }

    if (contribution === 'document.export') {
      const id = input.id;
      if (id === 'all') {
        const reqData = await readReqs();
        const mapData = await readRoadmap();
        const payload = {
          format: BUNDLE_FORMAT,
          version: 1,
          requirements: reqData.items,
          roadmap: mapData.roadmap,
        };
        const text = JSON.stringify(payload, null, 2);
        if (jsonBytes(text) > MAX_BYTES) return { error: 'export_too_large' };
        return { filename: 'product-studio-roadmap.json', text };
      }
      if (id.startsWith('prd:')) {
        const reqId = id.slice(4);
        const reqData = await readReqs();
        const req = reqData.items.find(i => i.id === reqId);
        if (!req) return { error: 'not_found' };
        const specData = await readSpecDoc(reqId);
        const payload = {
          format: PRD_FORMAT,
          version: 1,
          requirement: req,
          spec: specData.spec,
        };
        const text = JSON.stringify(payload, null, 2);
        if (jsonBytes(text) > MAX_BYTES) return { error: 'export_too_large' };
        return { filename: `prd-${reqId}.json`, text };
      }
      return { error: 'not_found' };
    }

    if (contribution === 'document.import') {
      let parsed;
      try {
        parsed = JSON.parse(input.text);
      } catch {
        return { imported: false, reason: 'invalid_json', count: 0 };
      }
      if (parsed?.format === BUNDLE_FORMAT && parsed?.version === 1 && Array.isArray(parsed.requirements)) {
        const reqData = await readReqs();
        const mapData = await readRoadmap();
        const byId = new Map(reqData.items.map(i => [i.id, i]));
        let importedCount = 0;
        for (let idx = 0; idx < parsed.requirements.length; idx++) {
          const raw = parsed.requirements[idx];
          if (typeof raw?.title !== 'string' || !raw.title.trim()) continue;
          const rid = typeof raw.id === 'string' && /^[a-zA-Z0-9._-]+$/.test(raw.id)
            ? raw.id.slice(0, 40)
            : `imp-${Date.now().toString(36)}-${idx}`;
          const reach = clampNum(Math.round(raw.reach ?? 500), 1, 100000);
          const impact = clampNum(raw.impact ?? 1, 0.25, 3);
          const confidence = clampNum(Math.round(raw.confidence ?? 80), 10, 100);
          const effort = clampNum(raw.effort ?? 2, 0.5, 52);
          const { value_score, rice, priority } = calcRice(reach, impact, confidence, effort);
          byId.set(rid, {
            id: rid,
            title: raw.title.trim().slice(0, 100),
            module: typeof raw.module === 'string' && raw.module.trim() ? raw.module.trim().slice(0, 32) : '核心模块',
            status: STATUSES.includes(raw.status) ? raw.status : 'backlog',
            reach,
            impact,
            confidence,
            effort,
            value_score,
            rice,
            priority,
            owner: typeof raw.owner === 'string' ? raw.owner.trim().slice(0, 32) : '',
            sprint: typeof raw.sprint === 'string' ? raw.sprint.trim().slice(0, 32) : '',
            summary: typeof raw.summary === 'string' ? raw.summary.trim().slice(0, 160) : '',
          });
          importedCount++;
        }
        const nextReqs = Array.from(byId.values());
        if (nextReqs.length > MAX_REQS) return { imported: false, reason: 'limit', count: 0 };
        const w1 = await safeWrite(COL_REQ, KEY_REQ, reqData.revision, { schema_version: 1, items: nextReqs });
        if (!w1.ok) return { imported: false, reason: w1.status, count: 0 };

        if (parsed.roadmap && Array.isArray(parsed.roadmap.lanes)) {
          const totalW = clampNum(Math.round(parsed.roadmap.total_weeks ?? mapData.roadmap.total_weeks), 4, 24);
          const curW = clampNum(Math.round(parsed.roadmap.current_week ?? mapData.roadmap.current_week), 1, totalW);
          const laneMap = new Map(mapData.roadmap.lanes.map(l => [l.req_id, l]));
          for (const l of parsed.roadmap.lanes) {
            if (typeof l?.req_id !== 'string' || !byId.has(l.req_id)) continue;
            laneMap.set(l.req_id, {
              req_id: l.req_id,
              lane: typeof l.lane === 'string' ? l.lane.slice(0, 32) : byId.get(l.req_id).module,
              start_week: clampNum(Math.round(l.start_week ?? 1), 1, totalW),
              duration_weeks: clampNum(Math.round(l.duration_weeks ?? 2), 1, 16),
              progress: clampNum(Math.round(l.progress ?? 0), 0, 100),
            });
          }
          const ms = Array.isArray(parsed.roadmap.milestones)
            ? parsed.roadmap.milestones.slice(0, 10).map((m, i) => ({
                id: typeof m?.id === 'string' && m.id ? m.id.slice(0, 24) : `ms-${i + 1}`,
                title: typeof m?.title === 'string' && m.title ? m.title.slice(0, 48) : `里程碑 ${i + 1}`,
                week: clampNum(Math.round(m?.week ?? 1), 1, totalW),
                color: typeof m?.color === 'string' ? m.color.slice(0, 16) : '#6366f1',
              }))
            : mapData.roadmap.milestones;
          await safeWrite(COL_MAP, KEY_MAP, w1.revision, {
            schema_version: 1,
            total_weeks: totalW,
            current_week: curW,
            milestones: ms,
            lanes: Array.from(laneMap.values()),
          });
        }
        return { imported: true, count: importedCount };
      }

      if (parsed?.format === PRD_FORMAT && parsed?.version === 1 && parsed?.spec && typeof parsed.spec.req_id === 'string') {
        const reqId = parsed.spec.req_id.trim().slice(0, 40);
        if (!/^[a-zA-Z0-9._-]+$/.test(reqId)) return { imported: false, reason: 'invalid_document', count: 0 };
        const specIdx = await readSpecIndex();
        const doc = {
          schema_version: 1,
          req_id: reqId,
          background: String(parsed.spec.background || '').trim().slice(0, 1400),
          user_stories: String(parsed.spec.user_stories || '').trim().slice(0, 1400),
          core_flow: String(parsed.spec.core_flow || '').trim().slice(0, 1400),
          acceptance_criteria: String(parsed.spec.acceptance_criteria || '').trim().slice(0, 1400),
          risks: String(parsed.spec.risks || '').trim().slice(0, 1000),
          updated_at: today(),
        };
        doc.score = calcSpecScore(doc);
        const w1 = await safeWrite(COL_SPEC, `doc:${reqId}`, specIdx.revision, doc);
        if (!w1.ok) return { imported: false, reason: w1.status, count: 0 };
        const nextScores = { ...specIdx.scores, [reqId]: { score: doc.score, updated_at: doc.updated_at } };
        const w2 = await safeWrite(COL_SPEC, KEY_SPEC_IDX, w1.revision, { schema_version: 1, scores: nextScores });
        return w2.ok ? { imported: true, count: 1 } : { imported: false, reason: w2.status, count: 0 };
      }

      return { imported: false, reason: 'invalid_document', count: 0 };
    }

    if (contribution === 'fs_list') {
      const relPath = typeof input.path === 'string' ? input.path.trim() : '';
      const limit = input.limit ?? 50;
      const cursor = input.cursor;
      try {
        const res = await globalThis.nmas.fs.listDir({ path: relPath, limit, cursor });
        return {
          status: 'ok',
          path: relPath,
          entries: res.entries || [],
          next_cursor: res.next_cursor ?? null,
        };
      } catch (err) {
        const code = err?.code === 'invalid_input' ? 'invalid_input' : 'permission_denied';
        return { status: code, path: relPath, entries: [], next_cursor: null, error: String(err?.message || code).slice(0, 160) };
      }
    }

    if (contribution === 'fs_import_doc') {
      const relPath = (input.path || '').trim();
      if (!relPath) {
        return { status: 'invalid_input', path: '', content: '', size_bytes: 0, sha256: '', format: 'text', error: '缺少文件路径' };
      }
      try {
        const res = await globalThis.nmas.fs.readText({ path: relPath });
        let format = relPath.toLowerCase().endsWith('.md') ? 'markdown' : 'text';
        try {
          const parsed = JSON.parse(res.content);
          if (parsed?.format === BUNDLE_FORMAT) format = 'bundle_json';
          else if (parsed?.format === PRD_FORMAT) format = 'prd_json';
        } catch {
          // non-JSON content
        }
        return {
          status: 'ok',
          path: relPath,
          content: res.content,
          size_bytes: res.size_bytes,
          sha256: res.sha256,
          format,
        };
      } catch (err) {
        const code = err?.code === 'resource_limit' ? 'resource_limit' : err?.code === 'invalid_input' ? 'invalid_input' : 'permission_denied';
        return { status: code, path: relPath, content: '', size_bytes: 0, sha256: '', format: 'text', error: String(err?.message || code).slice(0, 160) };
      }
    }

    if (contribution === 'fs_export_doc') {
      const docId = (input.id || '').trim();
      const relPath = (input.path || '').trim();
      const fmt = input.format === 'json' ? 'json' : 'markdown';
      const hasCreate = input.create_only === true;
      const hasSha = typeof input.expected_sha256 === 'string' && /^[0-9a-f]{64}$/.test(input.expected_sha256);
      if (!relPath || hasCreate === hasSha) {
        return {
          status: 'invalid_input',
          path: relPath,
          size_bytes: 0,
          sha256: '',
          error: 'create_only 与 expected_sha256 必须二选一',
        };
      }
      let content = '';
      if (docId === 'all') {
        const reqData = await readReqs();
        const mapData = await readRoadmap();
        content = fmt === 'json'
          ? JSON.stringify({ format: BUNDLE_FORMAT, version: 1, requirements: reqData.items, roadmap: mapData.roadmap }, null, 2)
          : formatRoadmapMarkdown(reqData.items, mapData.roadmap);
      } else if (docId.startsWith('prd:')) {
        const reqId = docId.slice(4);
        const reqData = await readReqs();
        const req = reqData.items.find(i => i.id === reqId);
        if (!req) {
          return { status: 'not_found', path: relPath, size_bytes: 0, sha256: '', error: '未找到指定需求' };
        }
        const specData = await readSpecDoc(reqId);
        content = fmt === 'json'
          ? JSON.stringify({ format: PRD_FORMAT, version: 1, requirement: req, spec: specData.spec }, null, 2)
          : formatPrdMarkdown(req, specData.spec);
      } else {
        return { status: 'not_found', path: relPath, size_bytes: 0, sha256: '', error: '不支持的文档标识' };
      }
      try {
        const writeReq = hasCreate
          ? { path: relPath, content, create_only: true }
          : { path: relPath, content, expected_sha256: input.expected_sha256 };
        const receipt = await globalThis.nmas.fs.writeText(writeReq);
        return { status: 'written', path: relPath, size_bytes: receipt.size_bytes, sha256: receipt.sha256 };
      } catch (err) {
        const mapCode = {
          conflict: 'conflict',
          resource_limit: 'resource_limit',
          invalid_input: 'invalid_input',
          permission_denied: 'permission_denied',
        };
        const status = mapCode[err?.code] || 'permission_denied';
        return { status, path: relPath, size_bytes: 0, sha256: '', error: String(err?.message || status).slice(0, 160) };
      }
    }
  }

  if (kind === 'tool') {
    if (contribution === 'prd.list') {
      const reqData = await readReqs();
      const specIdx = await readSpecIndex();
      const kw = (input.keyword || '').trim().toLowerCase();
      const filtered = reqData.items
        .filter(item => {
          if (input.status && item.status !== input.status) return false;
          if (input.priority && item.priority !== input.priority) return false;
          if (kw) {
            const hay = `${item.title} ${item.module} ${item.owner} ${item.sprint} ${item.summary}`.toLowerCase();
            if (!hay.includes(kw)) return false;
          }
          return true;
        })
        .sort((a, b) => b.rice - a.rice)
        .map(item => ({
          id: item.id,
          title: item.title,
          module: item.module,
          status: item.status,
          rice: item.rice,
          priority: item.priority,
          owner: item.owner,
          sprint: item.sprint,
          spec_score: specIdx.scores[item.id]?.score || 0,
        }));
      const avg_rice = filtered.length === 0 ? 0 : Math.round(filtered.reduce((s, i) => s + i.rice, 0) / filtered.length);
      return { success: true, status: 'ready', total: filtered.length, avg_rice, items: filtered };
    }

    if (contribution === 'prd.create') {
      const cleanTitle = (input.title || '').trim();
      if (!cleanTitle) return { success: false, status: 'invalid_input' };
      const reqData = await readReqs();
      if (reqData.items.length >= MAX_REQS) return { success: false, status: 'limit' };
      const mapData = await readRoadmap();
      const id = `req-${Date.now().toString(36)}-${reqData.items.length + 1}`;
      const status = STATUSES.includes(input.status) ? input.status : 'backlog';
      const { value_score, rice, priority } = calcRice(input.reach, input.impact, input.confidence, input.effort);
      const record = {
        id,
        title: cleanTitle,
        module: (input.module || '核心模块').trim() || '核心模块',
        status,
        reach: input.reach,
        impact: input.impact,
        confidence: input.confidence,
        effort: input.effort,
        value_score,
        rice,
        priority,
        owner: (input.owner || '').trim(),
        sprint: (input.sprint || '').trim(),
        summary: (input.summary || '').trim(),
      };
      const w1 = await safeWrite(COL_REQ, KEY_REQ, reqData.revision, {
        schema_version: 1,
        items: [...reqData.items, record],
      });
      if (!w1.ok) return { success: false, status: w1.status };

      const laneItem = {
        req_id: id,
        lane: record.module,
        start_week: Math.min(mapData.roadmap.total_weeks, mapData.roadmap.current_week),
        duration_weeks: Math.max(1, Math.min(6, Math.ceil(input.effort))),
        progress: status === 'shipped' ? 100 : status === 'in_progress' ? 30 : 0,
      };
      await safeWrite(COL_MAP, KEY_MAP, w1.revision, {
        schema_version: 1,
        ...mapData.roadmap,
        lanes: [...mapData.roadmap.lanes, laneItem],
      });

      return { success: true, status: 'saved', id, rice, priority };
    }
  }

  throw new Error(`不支持的调用: ${kind}/${contribution}`);
}
