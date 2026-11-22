const COL_CALENDAR = 'calendar';
const COL_DRAFTS = 'drafts';
const COL_METRICS = 'metrics';

const KEY_BOARD = 'board';
const KEY_DRAFTS_INDEX = 'index';
const KEY_METRICS = 'series';

const MAX_RECORD_BYTES = 240 * 1024;
const MAX_CALENDAR_ITEMS = 128;
const MAX_DRAFTS = 120;
const MAX_PERIODS = 52;

const STAGES = ['idea', 'drafting', 'scheduled', 'published'];
const CHANNELS = ['wechat', 'xiaohongshu', 'zhihu', 'x', 'youtube', 'bilibili'];
const MODES = ['xiaohongshu', 'x_thread', 'zhihu', 'short_video'];
const DOC_FORMAT = 'velai.content-growth-os';

const VALUE_KEYWORDS_ZH = [
  '实战', '避坑', '拆解', '复盘', '指南', '提效', '翻倍', '降本', '变现', '增长',
  '源码', '架构', '踩坑', '秘诀', '误区', '对比', '评测', '手把手', '终极', '清单',
  '方法论', '模板', '从0到1', '从零到一', '落地', '心法', '实测', '深度', '全链路', '工作流',
];
const VALUE_KEYWORDS_EN = [
  'how to', 'guide', 'playbook', 'teardown', 'mistakes', 'faster', 'framework',
  'benchmark', 'checklist', 'template', 'lessons', 'deep dive', 'architecture',
  'workflow', 'from scratch', 'case study', 'breakdown', 'blueprint',
];
const TENSION_KEYWORDS_ZH = [
  '为什么', '真相', '别再', '其实', '原来', '竟然', '颠覆', '逆袭', '血泪',
  '被低估', '没人告诉', '90%', '80%', '真正', '致命', '如何', '彻底', '终结', 'VS', 'vs',
];
const TENSION_KEYWORDS_EN = [
  'why', 'stop', 'truth', 'myth', 'never', 'actually', 'wrong', 'secret',
  'hidden', 'vs', 'versus', 'nobody', 'killed', 'beat',
];

function jsonBytes(v) {
  let bytes = 0;
  const s = JSON.stringify(v);
  for (let i = 0; i < s.length; i++) {
    const cp = s.codePointAt(i);
    if (cp > 0xffff) i += 1;
    bytes += cp <= 0x7f ? 1 : cp <= 0x7ff ? 2 : cp <= 0xffff ? 3 : 4;
  }
  return bytes;
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function validId(id) {
  return typeof id === 'string' && id.length >= 1 && id.length <= 48 && /^[a-zA-Z0-9._-]+$/.test(id);
}

function validDate(d) {
  return typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d);
}

function uniqueChannels(list) {
  const out = [];
  if (!Array.isArray(list)) return out;
  for (const ch of list) {
    if (CHANNELS.includes(ch) && !out.includes(ch)) out.push(ch);
  }
  return out;
}

function countWords(text) {
  const clean = (text || '').trim();
  if (!clean) return 0;
  const cjk = (clean.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length;
  const latin = (clean.replace(/[\u4e00-\u9fff\u3400-\u4dbf]/g, ' ').match(/[A-Za-z0-9_'-]+/g) || []).length;
  return cjk + latin;
}

function diagnoseHeadline(titleRaw, bodyRaw) {
  const title = (titleRaw || '').trim();
  const body = (bodyRaw || '').trim();
  const lowerTitle = title.toLowerCase();

  const chars = Array.from(title);
  const charLen = chars.length;
  const cjkCount = (title.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length;
  const isZh = charLen === 0 ? true : cjkCount / charLen >= 0.3;

  const highlights = [];
  const suggestions = [];

  // 1. 长度黄金区间 (0-20)
  let lengthScore = 0;
  if (charLen === 0) {
    suggestions.push('请先输入标题，建议控制在中文 14-28 字或英文 40-72 字符。');
  } else if (isZh) {
    if (charLen >= 14 && charLen <= 28) {
      lengthScore = 20;
      highlights.push(`黄金字数 (${charLen}字)`);
    } else if ((charLen >= 10 && charLen < 14) || (charLen > 28 && charLen <= 36)) {
      lengthScore = 14;
      suggestions.push(charLen < 14 ? `标题偏短(${charLen}字)，可补充具体结果或受众场景至 14-28 字。` : `标题偏长(${charLen}字)，信息流易被截断，建议精简至 28 字内。`);
    } else {
      lengthScore = 7;
      suggestions.push(charLen < 10 ? '标题过短，缺乏信息锚点，建议扩写核心痛点与收益。' : '标题过长，移动端首屏展示不完整，建议提炼核心钩子。');
    }
  } else {
    if (charLen >= 40 && charLen <= 72) {
      lengthScore = 20;
      highlights.push(`Optimal EN Length (${charLen} chars)`);
    } else if ((charLen >= 26 && charLen < 40) || (charLen > 72 && charLen <= 90)) {
      lengthScore = 14;
      suggestions.push('英文标题建议微调至 40-72 字符以获得最佳点击率。');
    } else {
      lengthScore = 7;
      suggestions.push('英文标题长度偏离最佳展示区间 (40-72 chars)。');
    }
  }

  // 2. 数字与量化锚点 (0-20)
  let numbersScore = 4;
  const hasArabic = /\d+/.test(title);
  const hasQuantUnit = /(\d+\s*(%|％|倍|x|X|天|周|月|年|分钟|秒|个|条|步|招|款|大|w|W|k|K|万|亿))/.test(title);
  const hasZhNum = /[一二三四五六七八九十百千万]/.test(title);
  if (hasQuantUnit) {
    numbersScore = 20;
    highlights.push('强量化锚点');
  } else if (hasArabic) {
    numbersScore = 16;
    highlights.push('包含数字锚点');
  } else if (hasZhNum) {
    numbersScore = 12;
    highlights.push('含序列/数量词');
  } else {
    suggestions.push('加入具体数字或量化结果（如“3 个架构误区”“提效 5 倍”“60 秒拆解”）可显著提升点击欲。');
  }

  // 3. 痛点 / 收益 / 承诺词 (0-20)
  const hitZhVal = VALUE_KEYWORDS_ZH.filter(w => title.includes(w));
  const hitEnVal = VALUE_KEYWORDS_EN.filter(w => lowerTitle.includes(w));
  const valHits = hitZhVal.length + hitEnVal.length;
  let valueScore = 4;
  if (valHits >= 2) {
    valueScore = 20;
    highlights.push(`强价值承诺 (${hitZhVal.concat(hitEnVal).slice(0, 2).join('/')})`);
  } else if (valHits === 1) {
    valueScore = 15;
    highlights.push(`价值词: ${hitZhVal[0] || hitEnVal[0]}`);
  } else {
    suggestions.push('缺少明确的读者收益或方法词（如“实战”“避坑”“拆解”“指南”“复盘”）。');
  }

  // 4. 情绪张力与悬念结构 (0-20)
  const hitZhTen = TENSION_KEYWORDS_ZH.filter(w => title.includes(w));
  const hitEnTen = TENSION_KEYWORDS_EN.filter(w => lowerTitle.includes(w));
  const hasPunct = /[？?！!：:｜|—【】「」]/.test(title);
  let tensionScore = 4;
  const tenHits = hitZhTen.length + hitEnTen.length;
  if (tenHits >= 1 && hasPunct) {
    tensionScore = 20;
    highlights.push('高情绪张力与节奏分隔');
  } else if (tenHits >= 1) {
    tensionScore = 15;
    highlights.push('包含悬念/反常识钩子');
  } else if (hasPunct) {
    tensionScore = 12;
    highlights.push('主副标题结构清晰');
  } else {
    suggestions.push('可用“主标题：副标题”或反问/对比结构（如“为什么…？”、“别再…”）增强停驻率。');
  }

  // 5. 正文可读性与结构分段 (0-20)
  const wordCount = countWords(body);
  const readMinutes = wordCount === 0 ? 0 : Math.max(0.5, Math.round((wordCount / 360) * 10) / 10);
  const paragraphs = body ? body.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean) : [];
  const paragraphCount = paragraphs.length;
  let readabilityScore = 10;

  if (!body) {
    readabilityScore = charLen >= 10 ? 11 : 6;
    suggestions.push('补充正文大纲或首段钩子后，可进一步诊断全文分段节奏与可读性。');
  } else {
    let rScore = 6;
    const hasHeadings = /(^|\n)\s*(#{1,3}\s|[一二三四五六七八九十]、|\d+[.、）)])/m.test(body);
    const hasBullets = /(^|\n)\s*([-*•>]\s)/m.test(body);
    const avgParaLen = paragraphCount > 0 ? body.length / paragraphCount : body.length;

    if (hasHeadings) {
      rScore += 5;
      highlights.push('小标题层级清晰');
    } else {
      suggestions.push('建议在正文中加入 2-4 个二级小标题（## 或 1. 2. 3.），提升移动端扫读体验。');
    }
    if (hasBullets) {
      rScore += 4;
    } else {
      suggestions.push('核心要点可用无序列表或引用块突出，降低阅读阻力。');
    }
    if (paragraphCount >= 3 && avgParaLen <= 220) {
      rScore += 5;
      highlights.push('段落节奏清爽');
    } else if (avgParaLen > 280) {
      rScore += 1;
      suggestions.push('单段文字偏长，建议每段控制在 3-5 行（约 120-180 字）并适当留白。');
    } else {
      rScore += 3;
    }
    readabilityScore = Math.min(20, rScore);
  }

  const score = Math.max(0, Math.min(100, lengthScore + numbersScore + valueScore + tensionScore + readabilityScore));
  const grade = score >= 85 ? 'S' : score >= 72 ? 'A' : score >= 55 ? 'B' : 'C';

  return {
    score,
    grade,
    word_count: wordCount,
    read_minutes: readMinutes,
    paragraph_count: paragraphCount,
    dimensions: {
      length: lengthScore,
      numbers: numbersScore,
      value_hook: valueScore,
      tension: tensionScore,
      readability: readabilityScore,
    },
    highlights: highlights.slice(0, 6),
    suggestions: suggestions.slice(0, 5),
  };
}

async function readCalendar() {
  const receipt = await globalThis.nmas.data.read({ collection: COL_CALENDAR, key: KEY_BOARD });
  const doc = receipt.value === null ? { schema_version: 1, items: [] } : receipt.value;
  if (!doc || doc.schema_version !== 1 || !Array.isArray(doc.items)) {
    throw new Error('排期看板数据格式损坏');
  }
  return { revision: receipt.revision, items: doc.items };
}

async function readDraftsIndex() {
  const receipt = await globalThis.nmas.data.read({ collection: COL_DRAFTS, key: KEY_DRAFTS_INDEX });
  const doc = receipt.value === null ? { schema_version: 1, items: [] } : receipt.value;
  if (!doc || doc.schema_version !== 1 || !Array.isArray(doc.items)) {
    throw new Error('文稿索引数据格式损坏');
  }
  return { revision: receipt.revision, items: doc.items };
}

async function readDraftDoc(id) {
  const receipt = await globalThis.nmas.data.read({ collection: COL_DRAFTS, key: `doc:${id}` });
  if (receipt.value === null) return { revision: receipt.revision, draft: null };
  const doc = receipt.value;
  if (!doc || doc.schema_version !== 1 || typeof doc.title !== 'string') {
    throw new Error(`文稿 ${id} 数据格式损坏`);
  }
  return {
    revision: receipt.revision,
    draft: {
      id: doc.id,
      title: doc.title,
      primary_channel: doc.primary_channel,
      updated_at: doc.updated_at,
      body: doc.body || '',
      variants: Array.isArray(doc.variants) ? doc.variants : [],
    },
  };
}

async function readMetrics() {
  const receipt = await globalThis.nmas.data.read({ collection: COL_METRICS, key: KEY_METRICS });
  const doc = receipt.value === null ? { schema_version: 1, periods: [] } : receipt.value;
  if (!doc || doc.schema_version !== 1 || !Array.isArray(doc.periods)) {
    throw new Error('增长指标数据格式损坏');
  }
  return { revision: receipt.revision, periods: doc.periods };
}

async function writeRecord(collection, key, expectedRevision, value) {
  if (jsonBytes(value) > MAX_RECORD_BYTES) {
    return { status: 'limit', revision: expectedRevision };
  }
  try {
    const receipt = await globalThis.nmas.data.write({
      collection,
      key,
      expected_revision: expectedRevision,
      value,
    });
    return { status: 'saved', revision: receipt.revision };
  } catch (err) {
    if (err?.code === 'conflict' && err.outcome_unknown === false) {
      return { status: 'conflict', revision: expectedRevision };
    }
    throw err;
  }
}

async function deleteRecord(collection, key, expectedRevision) {
  try {
    const receipt = await globalThis.nmas.data.delete({
      collection,
      key,
      expected_revision: expectedRevision,
    });
    return { status: 'deleted', revision: receipt.revision };
  } catch (err) {
    if (err?.code === 'conflict' && err.outcome_unknown === false) {
      return { status: 'conflict', revision: expectedRevision };
    }
    throw err;
  }
}

async function readPluginSettings() {
  const raw = await globalThis.nmas.settings.get();
  const brand_voice = typeof raw?.brand_voice === 'string' && raw.brand_voice.trim()
    ? raw.brand_voice.trim().slice(0, 48)
    : '专业务实';
  const goal = Number.isInteger(raw?.weekly_publish_goal) ? Math.max(1, Math.min(100, raw.weekly_publish_goal)) : 3;
  return { brand_voice, weekly_publish_goal: goal };
}

function computeChannelTotals(periods) {
  const sums = {};
  for (const ch of CHANNELS) sums[ch] = 0;
  let grandTotal = 0;
  for (const p of periods) {
    const byCh = p.by_channel || {};
    for (const ch of CHANNELS) {
      const v = Number.isInteger(byCh[ch]) && byCh[ch] > 0 ? byCh[ch] : 0;
      sums[ch] += v;
      grandTotal += v;
    }
  }
  return CHANNELS.map(channel => ({
    channel,
    views: sums[channel],
    share_pct: grandTotal > 0 ? Math.round((sums[channel] / grandTotal) * 1000) / 10 : 0,
  })).sort((a, b) => b.views - a.views);
}

function computeKpis(calendarItems, draftsIndex, periods) {
  const publishedFromCalendar = calendarItems.filter(i => i.stage === 'published').length;
  const publishedFromMetrics = periods.reduce((acc, p) => acc + (p.published_count || 0), 0);
  const totalPublished = Math.max(publishedFromCalendar, publishedFromMetrics);
  const totalViews = periods.reduce((acc, p) => acc + (p.views || 0), 0);
  const totalEng = periods.reduce((acc, p) => acc + (p.engagements || 0), 0);
  const avgEngagementRate = totalViews > 0 ? Math.round((totalEng / totalViews) * 1000) / 10 : 0;
  const weeklyScheduled = calendarItems.filter(i => i.stage === 'scheduled').length;
  return {
    total_published: totalPublished,
    total_views: totalViews,
    avg_engagement_rate: avgEngagementRate,
    weekly_scheduled: weeklyScheduled,
    total_drafts: draftsIndex.length,
  };
}

function buildDemoData() {
  const calendar = [
    {
      id: 'cnt-001',
      title: '为什么 90% 的 AI Agent 插件都死在沙箱安全？6 条桌面端实战避坑指南',
      stage: 'published',
      channels: ['wechat', 'zhihu', 'x'],
      publish_date: '2026-11-12',
      hook: '拆解 QuickJS + Seatbelt 零信任沙箱架构，用 6 个真实攻防案例讲清权限最小化。',
      viral_score: 94,
      draft_id: 'drf-001',
      tags: ['AI架构', '沙箱安全', '深度长文'],
    },
    {
      id: 'cnt-002',
      title: '1 人日更 6 大平台：我的全自动 AI 内容工厂工作流拆解（附 4 套 Prompt）',
      stage: 'scheduled',
      channels: ['xiaohongshu', 'wechat', 'bilibili'],
      publish_date: '2026-11-23',
      hook: '从主稿诊断到小红书/X 串推一稿多改，展示单人开发者如何用 40 分钟完成全渠道分发。',
      viral_score: 91,
      draft_id: 'drf-002',
      tags: ['效率工作流', '一稿多改', 'IP增长'],
    },
    {
      id: 'cnt-003',
      title: '别再把 Context 塞爆了！Context Cache 降本 68% 的 5 个工程细节实测',
      stage: 'scheduled',
      channels: ['zhihu', 'x', 'youtube'],
      publish_date: '2026-11-25',
      hook: '真实生产账单对比：固定前缀哈希、工具 Schema 稳态排序与分段摘要实测数据。',
      viral_score: 89,
      draft_id: 'drf-003',
      tags: ['LLM成本', '工程实测', '性能'],
    },
    {
      id: 'cnt-004',
      title: 'Local-First 桌面端 AI 应用为什么正在回归？Rust + WebView 架构复盘',
      stage: 'drafting',
      channels: ['wechat', 'bilibili', 'youtube'],
      publish_date: '2026-11-28',
      hook: '对比 Electron 与原生 Rust 宿主在冷启动、内存占用与离线隐私上的 4 组基准数据。',
      viral_score: 86,
      draft_id: '',
      tags: ['Rust', '桌面端', '架构对比'],
    },
    {
      id: 'cnt-005',
      title: '从 0 到 1 万技术粉丝：开发者做个人 IP 最容易踩的 5 个内容误区',
      stage: 'idea',
      channels: ['xiaohongshu', 'zhihu'],
      publish_date: '2026-12-02',
      hook: '为什么干货越硬阅读越低？讲清“技术深度”与“认知情绪钩子”的黄金平衡点。',
      viral_score: 84,
      draft_id: '',
      tags: ['开发者IP', '选题方法论'],
    },
    {
      id: 'cnt-006',
      title: '60 秒看懂多智能体协作 vs 单体长思考：什么场景该拆 Subagent？',
      stage: 'published',
      channels: ['bilibili', 'youtube', 'xiaohongshu'],
      publish_date: '2026-11-16',
      hook: '用厨房主厨与配菜师的直观比喻，讲清上下文隔离与并行探索的边界。',
      viral_score: 88,
      draft_id: '',
      tags: ['短视频', 'Multi-Agent', '科普'],
    },
  ];

  const drafts = [
    {
      id: 'drf-001',
      title: '为什么 90% 的 AI Agent 插件都死在沙箱安全？6 条桌面端实战避坑指南',
      primary_channel: 'wechat',
      updated_at: '2026-11-18',
      body:
        '过去半年，我们在构建桌面端原生插件运行时过程中，审计了超过 40 个社区扩展原型，发现一个残酷的规律：功能做得越炫，越容易在安全准入阶段直接被拦下。\n\n' +
        '## 1. 为什么传统插件模式在 AI 时代失效？\n\n' +
        '传统 IDE 插件默认完全信任本地进程，可以直接读写任意磁盘目录、执行 Shell 命令甚至读取环境变量里的 API Key。但在 Agent 可以自主触发工具调用的背景下，一次 Prompt 注入就可能演变为数据外泄。\n\n' +
        '## 2. 桌面端零信任沙箱的 6 条硬核设计\n\n' +
        '- 权限声明最小化：仅授予 data.read / data.write 或受限静态 HTTPS GET，杜绝通配符外联。\n' +
        '- 乐观锁 CAS 并发控制：所有持久化写入必须携带 expected_revision，彻底消除多窗口静默覆盖。\n' +
        '- 严格 JSON Schema 校验：在宿主侧对工具入参与出参做强类型拦截，防止模型幻觉污染状态。\n' +
        '- 作用域物理隔离：project 级数据按项目隔离，绝不跨库泄漏到全局助手会话。\n' +
        '- 单包 SHA-256 绑定：归档与后端源码做摘要绑定，分发链路不可篡改。\n' +
        '- 无外链纯净 UI：前端页面零第三方 CDN 依赖，离线同样秒开且无 XSS 供应链风险。\n\n' +
        '## 3. 结语：安全不是体验的敌人\n\n' +
        '当你把权限边界设计得足够清晰，用户才会真正放心地把日常工作流交给桌面端 AI 插件长期运行。',
      variants: [
        {
          mode: 'xiaohongshu',
          updated_at: '2026-11-18',
          content:
            '🚨做 AI 插件千万别裸奔！90% 开发者踩过的 6 个安全大坑整理好了👇\n\n' +
            '最近审计了 40+ 个 AI 插件原型，发现最致命的不是模型笨，而是安全边界没画清！一旦遇到 Prompt 注入，本地文件直接裸奔😱\n\n' +
            '✅ 6 条桌面端沙箱保命法则：\n' +
            '1️⃣ 权限最小化：拒绝万能网络与任意文件读写\n' +
            '2️⃣ 写入带 CAS 乐观锁：多窗口操作绝不互相覆盖\n' +
            '3️⃣ 强校验 JSON Schema：拦住 AI 幻觉脏数据\n' +
            '4️⃣ 项目级物理隔离：A 项目机密绝不串到 B 项目\n' +
            '5️⃣ SHA-256 单包防篡改：离线也能验明正身\n' +
            '6️⃣ UI 零外链零 CDN：秒开还防供应链投毒\n\n' +
            '💬 你们在用 AI 插件时，最担心哪一类权限？评论区聊聊！\n' +
            '#AI开发者 #独立开发 #架构设计 #软件安全 #生产力工具',
        },
        {
          mode: 'x_thread',
          updated_at: '2026-11-18',
          content:
            '1/ Why do 90% of AI Agent plugins fail security review? After auditing 40+ prototypes on desktop, here are the 6 sandbox patterns that actually work in production. 🧵👇\n\n' +
            '2/ Classic plugins assume full local trust. In the Agent era, prompt injection turns overly broad file/shell permissions into instant exfiltration.\n\n' +
            '3/ Rule #1: Capability-based least privilege. Separate read/write storage, forbid wildcard HTTP, and bind every action to explicit permissions.\n\n' +
            '4/ Rule #2: Enforce CAS optimistic locking (expected_revision) on every write so concurrent views & tools never silently clobber user data.\n\n' +
            '5/ Rule #3: Strict host-side JSON Schema validation on both tool inputs AND outputs. Never trust raw LLM payloads.\n\n' +
            '6/ Rule #4: Hard project-scope isolation + zero external CDN assets in plugin UIs. Fast offline, zero supply-chain surprises.\n\n' +
            '7/ Safe defaults unlock user trust. Bookmark this checklist if you are shipping desktop AI extensions!',
        },
      ],
    },
    {
      id: 'drf-002',
      title: '1 人日更 6 大平台：我的全自动 AI 内容工厂工作流拆解（附 4 套 Prompt）',
      primary_channel: 'xiaohongshu',
      updated_at: '2026-11-20',
      body:
        '很多技术博主不是写不出好内容，而是写完一篇公众号长文后，再也没有精力去改写小红书图文、X 串推、知乎回答和短视频口播。\n\n' +
        '## 1. 核心原则：一次深度思考，六次平台原生表达\n\n' +
        '切忌把同一段文字原封不动复制到各个平台。不同平台的阅读心智完全不同：公众号看逻辑纵深，小红书看情绪钩子与清单感，X 看节奏与金句密度，短视频看前 3 秒完播留存。\n\n' +
        '## 2. 我的 40 分钟全渠道生产流水线\n\n' +
        '- 第 1 步（15 分钟）：在主稿编辑器写清核心论点、3 组真实数据与 1 个反常识结论。\n' +
        '- 第 2 步（5 分钟）：用实时标题诊断仪把标题打磨到 85 分以上，补齐量化锚点。\n' +
        '- 第 3 步（10 分钟）：通过 AI 一稿多改矩阵，按平台语感生成 4 套衍生版本并人工微调。\n' +
        '- 第 4 步（10 分钟）：进入排期看板定档发布，每周一复盘互动率反哺下一轮选题。\n\n' +
        '## 3. 30 天实测结果\n\n' +
        '坚持这套工作流 6 周后，总曝光提升了 3.2 倍，单篇平均制作耗时从 4.5 小时压缩到 40 分钟，互动率稳定在 6.5% 以上。',
      variants: [
        {
          mode: 'short_video',
          updated_at: '2026-11-20',
          content:
            '【0-3秒 黄金钩子｜语速快、直视镜头】\n' +
            '别再傻傻地一篇文章复制粘贴发 6 个平台了！播放量低根本不是内容差，是平台语感全错了。\n\n' +
            '【4-25秒 痛点与方法｜切工作台录屏】\n' +
            '作为全职写代码的开发者，我每周只花 40 分钟就能稳定更新 6 大平台，秘密就是「1 篇主稿 + 4 套原生改写」。先用标题诊断仪把点击率打到 85 分以上，补齐数字锚点和反常识钩子。\n\n' +
            '【26-48秒 流程拆解｜字幕弹出关键词】\n' +
            '接着一键拆给 AI：小红书要清单加情绪，X 串推要短句加干货，知乎要深度框架，短视频要前 3 秒留人！6 周实测下来，我的全网阅读直接涨了 3.2 倍。\n\n' +
            '【49-60秒 结尾 CTA｜微笑手势】\n' +
            '这套 4 合 1 的提示词工作流我都整理好了，点个收藏，评论区扣「工作流」我把完整框架分享给你！',
        },
      ],
    },
    {
      id: 'drf-003',
      title: '别再把 Context 塞爆了！Context Cache 降本 68% 的 5 个工程细节实测',
      primary_channel: 'zhihu',
      updated_at: '2026-11-21',
      body:
        '在高频 Agent 场景下，90% 的 Token 账单其实花在重复发送系统提示词、工具定义与历史对话前缀上。\n\n' +
        '## 1. 为什么你的 Prompt Cache 命中率总是不稳定？\n\n' +
        '只要前缀中混入一个动态时间戳、随机 UUID 或排序漂移的工具定义列表，整段缓存就会瞬间失效。\n\n' +
        '## 2. 实测最有效的 5 个降本工程细节\n\n' +
        '- 严格固定 System Prompt 与 Tools JSON 键序，将动态时间移至最新一条 User 消息尾部。\n' +
        '- 采用分段锚点策略，将长文档知识库置顶于稳定前缀区。\n' +
        '- 在子代理探索任务中隔离高频工具输出，避免把 50KB 日志直接灌回主会话上下文。\n' +
        '- 对超过 12 轮的历史对话做结构化摘要压缩，保留关键决策而非冗余过程。\n' +
        '- 在网关层记录每次请求的 cache_read_tokens 比例，跌破 65% 自动告警。',
      variants: [],
    },
  ];

  const periods = [
    {
      period: 'W42',
      label: '10/14',
      views: 18400,
      engagements: 990,
      engagement_rate: 5.4,
      published_count: 3,
      by_channel: { wechat: 4800, xiaohongshu: 5200, zhihu: 3100, x: 2400, youtube: 1300, bilibili: 1600 },
    },
    {
      period: 'W43',
      label: '10/21',
      views: 24600,
      engagements: 1450,
      engagement_rate: 5.9,
      published_count: 4,
      by_channel: { wechat: 6200, xiaohongshu: 7100, zhihu: 4100, x: 3200, youtube: 1800, bilibili: 2200 },
    },
    {
      period: 'W44',
      label: '10/28',
      views: 31200,
      engagements: 1965,
      engagement_rate: 6.3,
      published_count: 4,
      by_channel: { wechat: 7900, xiaohongshu: 8900, zhihu: 5200, x: 4300, youtube: 2100, bilibili: 2800 },
    },
    {
      period: 'W45',
      label: '11/04',
      views: 28900,
      engagements: 1994,
      engagement_rate: 6.9,
      published_count: 3,
      by_channel: { wechat: 7400, xiaohongshu: 8200, zhihu: 4800, x: 4000, youtube: 1900, bilibili: 2600 },
    },
    {
      period: 'W46',
      label: '11/11',
      views: 42800,
      engagements: 3124,
      engagement_rate: 7.3,
      published_count: 5,
      by_channel: { wechat: 10800, xiaohongshu: 12400, zhihu: 6900, x: 5800, youtube: 3100, bilibili: 3800 },
    },
    {
      period: 'W47',
      label: '11/18',
      views: 51600,
      engagements: 4025,
      engagement_rate: 7.8,
      published_count: 5,
      by_channel: { wechat: 12900, xiaohongshu: 15100, zhihu: 8400, x: 6900, youtube: 3700, bilibili: 4600 },
    },
  ];

  return { calendar, drafts, periods };
}

function makeDraftIndexEntry(draft, diag) {
  return {
    id: draft.id,
    title: draft.title,
    primary_channel: draft.primary_channel,
    updated_at: draft.updated_at,
    word_count: diag.word_count,
    read_minutes: diag.read_minutes,
    headline_score: diag.score,
    variants_count: Array.isArray(draft.variants) ? draft.variants.length : 0,
  };
}

function nextId(prefix, existingIds) {
  let maxN = 0;
  const re = new RegExp(`^${prefix}-(\\d+)$`);
  for (const id of existingIds) {
    const m = re.exec(id);
    if (m) maxN = Math.max(maxN, Number(m[1]));
  }
  return `${prefix}-${String(maxN + 1).padStart(3, '0')}`;
}

export default async function (request) {
  const { kind, contribution, input } = request ?? {};

  if (kind === 'action') {
    if (contribution === 'growth.dashboard') {
      const cal = await readCalendar();
      const idx = await readDraftsIndex();
      const met = await readMetrics();
      const settings = await readPluginSettings();
      const channelTotals = computeChannelTotals(met.periods);
      const kpis = computeKpis(cal.items, idx.items, met.periods);
      return {
        revision: met.revision,
        kpis,
        calendar: cal.items,
        drafts: idx.items,
        periods: met.periods,
        channel_totals: channelTotals,
        settings,
      };
    }

    if (contribution === 'draft.diagnose') {
      return diagnoseHeadline(input.title, input.body);
    }

    if (contribution === 'calendar.save') {
      const title = (input.title || '').trim();
      const channels = uniqueChannels(input.channels);
      if (!title || !STAGES.includes(input.stage) || channels.length === 0 || !validDate(input.publish_date)) {
        return { status: 'invalid_input', revision: input.expected_revision };
      }
      const cal = await readCalendar();
      if (cal.revision !== input.expected_revision) {
        return { status: 'conflict', revision: cal.revision };
      }
      const finalId = input.id === 'NEW' ? nextId('cnt', cal.items.map(i => i.id)) : input.id;
      if (!validId(finalId)) return { status: 'invalid_input', revision: cal.revision };

      const diag = diagnoseHeadline(title, input.hook || '');
      const viralScore = Number.isInteger(input.viral_score) ? Math.max(0, Math.min(100, input.viral_score)) : diag.score;
      const tags = Array.isArray(input.tags)
        ? input.tags.map(t => String(t).trim().slice(0, 24)).filter(Boolean).slice(0, 5)
        : [];

      const record = {
        id: finalId,
        title,
        stage: input.stage,
        channels,
        publish_date: input.publish_date,
        hook: (input.hook || '').trim().slice(0, 240),
        viral_score: viralScore,
        draft_id: (input.draft_id || '').trim().slice(0, 48),
        tags,
      };

      const exists = cal.items.some(i => i.id === finalId);
      const next = exists ? cal.items.map(i => (i.id === finalId ? record : i)) : [record, ...cal.items];
      if (next.length > MAX_CALENDAR_ITEMS) return { status: 'limit', revision: cal.revision };
      const res = await writeRecord(COL_CALENDAR, KEY_BOARD, input.expected_revision, { schema_version: 1, items: next });
      return res.status === 'saved'
        ? { status: 'saved', revision: res.revision, id: finalId, viral_score: viralScore }
        : res;
    }

    if (contribution === 'calendar.move') {
      if (!STAGES.includes(input.stage) || !validId(input.id)) {
        return { status: 'invalid_input', revision: input.expected_revision };
      }
      const cal = await readCalendar();
      if (cal.revision !== input.expected_revision) return { status: 'conflict', revision: cal.revision };
      if (!cal.items.some(i => i.id === input.id)) return { status: 'not_found', revision: cal.revision };
      const next = cal.items.map(i => (i.id === input.id ? { ...i, stage: input.stage } : i));
      const res = await writeRecord(COL_CALENDAR, KEY_BOARD, input.expected_revision, { schema_version: 1, items: next });
      return res.status === 'saved' ? { status: 'saved', revision: res.revision } : { status: 'conflict', revision: res.revision };
    }

    if (contribution === 'calendar.delete') {
      const cal = await readCalendar();
      if (cal.revision !== input.expected_revision) return { status: 'conflict', revision: cal.revision };
      if (!cal.items.some(i => i.id === input.id)) return { status: 'not_found', revision: cal.revision };
      const next = cal.items.filter(i => i.id !== input.id);
      const res = await writeRecord(COL_CALENDAR, KEY_BOARD, input.expected_revision, { schema_version: 1, items: next });
      return res.status === 'saved' ? { status: 'deleted', revision: res.revision } : { status: 'conflict', revision: res.revision };
    }

    if (contribution === 'draft.read') {
      if (!validId(input.id)) return { found: false, revision: 0 };
      const { revision, draft } = await readDraftDoc(input.id);
      if (!draft) return { found: false, revision };
      return {
        found: true,
        revision,
        draft,
        diagnosis: diagnoseHeadline(draft.title, draft.body),
      };
    }

    if (contribution === 'draft.save') {
      const title = (input.title || '').trim();
      const body = (input.body || '').trim();
      if (!title || !CHANNELS.includes(input.primary_channel)) {
        return { status: 'invalid_input', revision: input.expected_revision };
      }
      const idx = await readDraftsIndex();
      if (idx.revision !== input.expected_revision) return { status: 'conflict', revision: idx.revision };

      const finalId = input.id === 'NEW' ? nextId('drf', idx.items.map(d => d.id)) : input.id;
      if (!validId(finalId)) return { status: 'invalid_input', revision: idx.revision };

      const existingDoc = idx.items.some(d => d.id === finalId) ? (await readDraftDoc(finalId)).draft : null;
      const draftObj = {
        schema_version: 1,
        id: finalId,
        title,
        primary_channel: input.primary_channel,
        updated_at: todayStr(),
        body,
        variants: existingDoc ? existingDoc.variants : [],
      };
      const diag = diagnoseHeadline(title, body);
      const entry = makeDraftIndexEntry(draftObj, diag);
      const nextIdx = existingDoc
        ? idx.items.map(d => (d.id === finalId ? entry : d))
        : [entry, ...idx.items];

      if (nextIdx.length > MAX_DRAFTS) return { status: 'limit', revision: idx.revision };

      const w1 = await writeRecord(COL_DRAFTS, `doc:${finalId}`, input.expected_revision, draftObj);
      if (w1.status !== 'saved') return w1;
      const w2 = await writeRecord(COL_DRAFTS, KEY_DRAFTS_INDEX, w1.revision, { schema_version: 1, items: nextIdx });
      if (w2.status !== 'saved') return w2;

      return {
        status: 'saved',
        revision: w2.revision,
        id: finalId,
        headline_score: diag.score,
        word_count: diag.word_count,
      };
    }

    if (contribution === 'draft.delete') {
      const idx = await readDraftsIndex();
      if (idx.revision !== input.expected_revision) return { status: 'conflict', revision: idx.revision };
      if (!idx.items.some(d => d.id === input.id)) return { status: 'not_found', revision: idx.revision };
      const nextIdx = idx.items.filter(d => d.id !== input.id);
      const w1 = await writeRecord(COL_DRAFTS, KEY_DRAFTS_INDEX, input.expected_revision, { schema_version: 1, items: nextIdx });
      if (w1.status !== 'saved') return { status: 'conflict', revision: w1.revision };
      const w2 = await deleteRecord(COL_DRAFTS, `doc:${input.id}`, w1.revision);
      return w2.status === 'deleted' ? { status: 'deleted', revision: w2.revision } : { status: 'conflict', revision: w2.revision };
    }

    if (contribution === 'draft.variant.save') {
      const content = (input.content || '').trim();
      if (!validId(input.draft_id) || !MODES.includes(input.mode) || !content) {
        return { status: 'invalid_input', revision: input.expected_revision };
      }
      const idx = await readDraftsIndex();
      if (idx.revision !== input.expected_revision) return { status: 'conflict', revision: idx.revision };
      const { draft } = await readDraftDoc(input.draft_id);
      if (!draft) return { status: 'not_found', revision: idx.revision };

      const updatedAt = todayStr();
      const filtered = draft.variants.filter(v => v.mode !== input.mode);
      const nextVariants = [...filtered, { mode: input.mode, content, updated_at: updatedAt }];
      const nextDoc = { schema_version: 1, ...draft, updated_at: updatedAt, variants: nextVariants };

      const w1 = await writeRecord(COL_DRAFTS, `doc:${draft.id}`, input.expected_revision, nextDoc);
      if (w1.status !== 'saved') return w1;

      const nextIdx = idx.items.map(d =>
        d.id === draft.id ? { ...d, updated_at: updatedAt, variants_count: nextVariants.length } : d,
      );
      const w2 = await writeRecord(COL_DRAFTS, KEY_DRAFTS_INDEX, w1.revision, { schema_version: 1, items: nextIdx });
      if (w2.status !== 'saved') return w2;

      return { status: 'saved', revision: w2.revision, variants_count: nextVariants.length };
    }

    if (contribution === 'metrics.record') {
      const period = (input.period || '').trim();
      const label = (input.label || '').trim();
      if (!period || !label) return { status: 'invalid_input', revision: input.expected_revision };
      const met = await readMetrics();
      if (met.revision !== input.expected_revision) return { status: 'conflict', revision: met.revision };

      const byCh = {};
      let views = 0;
      for (const ch of CHANNELS) {
        const val = Number.isInteger(input.by_channel[ch]) && input.by_channel[ch] >= 0 ? input.by_channel[ch] : 0;
        byCh[ch] = val;
        views += val;
      }
      const engagements = Math.max(0, input.engagements);
      const rate = views > 0 ? Math.min(100, Math.round((engagements / views) * 1000) / 10) : 0;
      const entry = {
        period,
        label,
        views,
        engagements,
        engagement_rate: rate,
        published_count: Math.max(0, input.published_count),
        by_channel: byCh,
      };
      const exists = met.periods.some(p => p.period === period);
      const next = exists ? met.periods.map(p => (p.period === period ? entry : p)) : [...met.periods, entry];
      if (next.length > MAX_PERIODS) return { status: 'limit', revision: met.revision };

      const res = await writeRecord(COL_METRICS, KEY_METRICS, input.expected_revision, { schema_version: 1, periods: next });
      return res;
    }

    if (contribution === 'demo.seed') {
      const cal = await readCalendar();
      if (cal.revision !== input.expected_revision) return { status: 'conflict', revision: cal.revision };
      const demo = buildDemoData();

      let rev = input.expected_revision;
      const wCal = await writeRecord(COL_CALENDAR, KEY_BOARD, rev, { schema_version: 1, items: demo.calendar });
      if (wCal.status !== 'saved') return { status: wCal.status === 'limit' ? 'limit' : 'conflict', revision: wCal.revision };
      rev = wCal.revision;

      const idxEntries = [];
      for (const d of demo.drafts) {
        const diag = diagnoseHeadline(d.title, d.body);
        idxEntries.push(makeDraftIndexEntry(d, diag));
        const wDoc = await writeRecord(COL_DRAFTS, `doc:${d.id}`, rev, { schema_version: 1, ...d });
        if (wDoc.status !== 'saved') return { status: wDoc.status === 'limit' ? 'limit' : 'conflict', revision: wDoc.revision };
        rev = wDoc.revision;
      }

      const wIdx = await writeRecord(COL_DRAFTS, KEY_DRAFTS_INDEX, rev, { schema_version: 1, items: idxEntries });
      if (wIdx.status !== 'saved') return { status: wIdx.status === 'limit' ? 'limit' : 'conflict', revision: wIdx.revision };
      rev = wIdx.revision;

      const wMet = await writeRecord(COL_METRICS, KEY_METRICS, rev, { schema_version: 1, periods: demo.periods });
      if (wMet.status !== 'saved') return { status: wMet.status === 'limit' ? 'limit' : 'conflict', revision: wMet.revision };
      rev = wMet.revision;

      return {
        status: 'seeded',
        revision: rev,
        calendar_count: demo.calendar.length,
        drafts_count: demo.drafts.length,
        periods_count: demo.periods.length,
      };
    }

    if (contribution === 'document.list') {
      const storedKeys = await globalThis.nmas.data.list({ collection: COL_DRAFTS, prefix: 'doc:', limit: 50 });
      const existingDocIds = new Set(storedKeys.keys.map(k => k.slice(4)));
      const idx = await readDraftsIndex();
      const items = [
        { id: 'CALENDAR', label: '全渠道排期看板与复盘指标包' },
        ...idx.items
          .filter(d => existingDocIds.size === 0 || existingDocIds.has(d.id))
          .map(d => ({ id: d.id, label: `主稿 ${d.id} · ${d.title}` })),
      ];
      return { items };
    }

    if (contribution === 'document.export') {
      const serializeDoc = payload => {
        const pretty = JSON.stringify(payload, null, 2);
        return jsonBytes(pretty) <= 235 * 1024 ? pretty : JSON.stringify(payload);
      };
      if (input.id === 'CALENDAR') {
        const cal = await readCalendar();
        const met = await readMetrics();
        const text = serializeDoc({ format: DOC_FORMAT, version: 1, kind: 'calendar_metrics', calendar: cal.items, periods: met.periods });
        if (jsonBytes(text) > MAX_RECORD_BYTES) return { error: 'too_large' };
        return { filename: 'content-growth-calendar.json', text };
      }
      const { draft } = await readDraftDoc(input.id);
      if (!draft) return { error: 'not_found' };
      const text = serializeDoc({ format: DOC_FORMAT, version: 1, kind: 'draft', draft });
      if (jsonBytes(text) > MAX_RECORD_BYTES) return { error: 'too_large' };
      return { filename: `${draft.id.toLowerCase()}.json`, text };
    }

    if (contribution === 'document.import') {
      let parsed;
      try { parsed = JSON.parse(input.text); } catch { return { imported: false, reason: 'invalid_json' }; }
      if (parsed?.format !== DOC_FORMAT || parsed?.version !== 1) {
        return { imported: false, reason: 'invalid_document' };
      }
      if (parsed.kind === 'draft' && parsed.draft && typeof parsed.draft.title === 'string' && parsed.draft.title.trim()) {
        const idx = await readDraftsIndex();
        const newId = nextId('drf', idx.items.map(d => d.id));
        const src = parsed.draft;
        const primaryChannel = CHANNELS.includes(src.primary_channel) ? src.primary_channel : 'wechat';
        const body = typeof src.body === 'string' ? src.body.slice(0, 6000) : '';
        const variants = Array.isArray(src.variants)
          ? src.variants
              .filter(v => v && MODES.includes(v.mode) && typeof v.content === 'string')
              .slice(0, 4)
              .map(v => ({ mode: v.mode, content: v.content.slice(0, 2600), updated_at: todayStr() }))
          : [];
        const doc = {
          schema_version: 1,
          id: newId,
          title: src.title.trim().slice(0, 120),
          primary_channel: primaryChannel,
          updated_at: todayStr(),
          body,
          variants,
        };
        const diag = diagnoseHeadline(doc.title, doc.body);
        const w1 = await writeRecord(COL_DRAFTS, `doc:${newId}`, idx.revision, doc);
        if (w1.status !== 'saved') return { imported: false, reason: w1.status };
        const nextIdx = [makeDraftIndexEntry(doc, diag), ...idx.items];
        if (nextIdx.length > MAX_DRAFTS) return { imported: false, reason: 'limit' };
        const w2 = await writeRecord(COL_DRAFTS, KEY_DRAFTS_INDEX, w1.revision, { schema_version: 1, items: nextIdx });
        return w2.status === 'saved' ? { imported: true, id: newId } : { imported: false, reason: w2.status };
      }
      if (parsed.kind === 'calendar_metrics' && Array.isArray(parsed.calendar)) {
        const cal = await readCalendar();
        const existingIds = new Set(cal.items.map(i => i.id));
        const merged = [...cal.items];
        for (const item of parsed.calendar) {
          if (!item || typeof item.title !== 'string' || !item.title.trim()) continue;
          const id = validId(item.id) && !existingIds.has(item.id) ? item.id : nextId('cnt', merged.map(x => x.id));
          existingIds.add(id);
          const channels = uniqueChannels(item.channels);
          merged.push({
            id,
            title: item.title.trim().slice(0, 120),
            stage: STAGES.includes(item.stage) ? item.stage : 'idea',
            channels: channels.length ? channels : ['wechat'],
            publish_date: validDate(item.publish_date) ? item.publish_date : todayStr(),
            hook: typeof item.hook === 'string' ? item.hook.trim().slice(0, 240) : '',
            viral_score: Number.isInteger(item.viral_score) ? Math.max(0, Math.min(100, item.viral_score)) : 75,
            draft_id: typeof item.draft_id === 'string' ? item.draft_id.slice(0, 48) : '',
            tags: Array.isArray(item.tags) ? item.tags.map(t => String(t).slice(0, 24)).slice(0, 5) : [],
          });
        }
        if (merged.length > MAX_CALENDAR_ITEMS) return { imported: false, reason: 'limit' };
        const w1 = await writeRecord(COL_CALENDAR, KEY_BOARD, cal.revision, { schema_version: 1, items: merged });
        if (w1.status !== 'saved') return { imported: false, reason: w1.status };
        if (Array.isArray(parsed.periods) && parsed.periods.length > 0) {
          const validPeriods = parsed.periods.slice(0, MAX_PERIODS).filter(p => p && typeof p.period === 'string' && typeof p.label === 'string');
          if (validPeriods.length > 0) {
            const w2 = await writeRecord(COL_METRICS, KEY_METRICS, w1.revision, { schema_version: 1, periods: validPeriods });
            if (w2.status !== 'saved') return { imported: false, reason: w2.status };
          }
        }
        return { imported: true, id: 'CALENDAR' };
      }
      return { imported: false, reason: 'invalid_document' };
    }
  }

  if (kind === 'tool') {
    if (contribution === 'content.pipeline') {
      const cal = await readCalendar();
      const idx = await readDraftsIndex();
      const met = await readMetrics();
      const kw = (input.keyword || '').trim().toLowerCase();
      const filtered = cal.items.filter(item => {
        if (input.stage && item.stage !== input.stage) return false;
        if (input.channel && !item.channels.includes(input.channel)) return false;
        if (kw && !`${item.title} ${item.hook} ${(item.tags || []).join(' ')}`.toLowerCase().includes(kw)) return false;
        return true;
      });
      const kpis = computeKpis(cal.items, idx.items, met.periods);
      const channelTotals = computeChannelTotals(met.periods);
      return {
        success: true,
        status: 'ready',
        summary: {
          total_published: kpis.total_published,
          total_views: kpis.total_views,
          avg_engagement_rate: kpis.avg_engagement_rate,
          weekly_scheduled: kpis.weekly_scheduled,
          total_items: cal.items.length,
        },
        items: filtered.slice(0, 20).map(({ id, title, stage, channels, publish_date, viral_score, draft_id }) => ({
          id,
          title,
          stage,
          channels,
          publish_date,
          viral_score,
          draft_id,
        })),
        channel_totals: channelTotals,
      };
    }

    if (contribution === 'content.draft.save') {
      const title = (input.title || '').trim();
      const body = (input.body || '').trim();
      if (!title || !body || !CHANNELS.includes(input.primary_channel)) {
        return { success: false, status: 'invalid_input' };
      }
      const idx = await readDraftsIndex();
      const cal = await readCalendar();
      const finalId = input.id && validId(input.id) ? input.id : nextId('drf', idx.items.map(d => d.id));
      const existingDoc = idx.items.some(d => d.id === finalId) ? (await readDraftDoc(finalId)).draft : null;

      const draftObj = {
        schema_version: 1,
        id: finalId,
        title,
        primary_channel: input.primary_channel,
        updated_at: todayStr(),
        body,
        variants: existingDoc ? existingDoc.variants : [],
      };
      const diag = diagnoseHeadline(title, body);
      const entry = makeDraftIndexEntry(draftObj, diag);
      const nextIdx = existingDoc ? idx.items.map(d => (d.id === finalId ? entry : d)) : [entry, ...idx.items];
      if (nextIdx.length > MAX_DRAFTS) return { success: false, status: 'limit' };

      const w1 = await writeRecord(COL_DRAFTS, `doc:${finalId}`, cal.revision, draftObj);
      if (w1.status !== 'saved') return { success: false, status: w1.status };
      const w2 = await writeRecord(COL_DRAFTS, KEY_DRAFTS_INDEX, w1.revision, { schema_version: 1, items: nextIdx });
      if (w2.status !== 'saved') return { success: false, status: w2.status };

      // 同步排期看板
      const stage = STAGES.includes(input.stage) ? input.stage : 'drafting';
      const pubDate = validDate(input.publish_date) ? input.publish_date : todayStr();
      const hook = (input.hook || body.slice(0, 100)).trim().slice(0, 240);
      const existingCard = cal.items.find(c => c.draft_id === finalId);
      let nextCal;
      if (existingCard) {
        nextCal = cal.items.map(c =>
          c.id === existingCard.id
            ? {
                ...c,
                title,
                stage: input.stage ? stage : c.stage,
                publish_date: input.publish_date ? pubDate : c.publish_date,
                hook: input.hook ? hook : c.hook,
                viral_score: diag.score,
              }
            : c,
        );
      } else {
        const cardId = nextId('cnt', cal.items.map(c => c.id));
        nextCal = [
          {
            id: cardId,
            title,
            stage,
            channels: [input.primary_channel],
            publish_date: pubDate,
            hook,
            viral_score: diag.score,
            draft_id: finalId,
            tags: ['AI协同'],
          },
          ...cal.items,
        ];
      }
      if (nextCal.length <= MAX_CALENDAR_ITEMS) {
        const w3 = await writeRecord(COL_CALENDAR, KEY_BOARD, w2.revision, { schema_version: 1, items: nextCal });
        if (w3.status === 'saved') {
          return {
            success: true,
            status: 'saved',
            id: finalId,
            headline_score: diag.score,
            word_count: diag.word_count,
            revision: w3.revision,
          };
        }
      }
      return {
        success: true,
        status: 'saved',
        id: finalId,
        headline_score: diag.score,
        word_count: diag.word_count,
        revision: w2.revision,
      };
    }
  }

  throw new Error(`不支持的调用: ${kind}/${contribution}`);
}
