const COL_FINDINGS = 'findings';
const COL_INCIDENTS = 'incidents';
const COL_ACTIONS = 'actions';

const KEY_FINDINGS = 'registry';
const KEY_INCIDENTS = 'coe-log';
const KEY_ACTIONS = 'tracker';

const MAX_RECORD_BYTES = 13 * 1024;
const MAX_FINDINGS = 40;
const MAX_INCIDENTS = 12;
const MAX_ACTIONS = 48;

const CATEGORIES = ['owasp', 'architecture', 'performance', 'compliance'];
const DIMENSIONS = ['auth', 'isolation', 'validation', 'supply_chain', 'observability'];
const SEVERITIES = ['critical', 'high', 'medium', 'low'];
const FINDING_STATUSES = ['open', 'mitigating', 'verified', 'wontfix'];
const INC_SEVS = ['SEV1', 'SEV2', 'SEV3', 'SEV4'];
const INC_STATUSES = ['investigating', 'mitigated', 'closed'];
const ACT_PRIORITIES = ['P0', 'P1', 'P2'];
const ACT_STATUSES = ['todo', 'in_progress', 'verified'];
const DOC_FORMAT = 'velai.code-audit-warroom';

const DIM_LABELS = {
  auth: '认证鉴权',
  isolation: '数据隔离',
  validation: '输入校验',
  supply_chain: '依赖安全',
  observability: '可观测性',
};

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
  return typeof id === 'string' && id.length >= 1 && id.length <= 24 && /^[a-zA-Z0-9._-]+$/.test(id);
}

function validDate(d) {
  return typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d);
}

function nextSeqId(prefix, items) {
  let maxN = 0;
  const re = new RegExp(`^${prefix}-(\\d+)$`);
  for (const it of items) {
    const m = re.exec(it.id);
    if (m) maxN = Math.max(maxN, Number(m[1]));
  }
  return `${prefix}-${String(maxN + 1).padStart(3, '0')}`;
}

function inferDimension(category) {
  if (category === 'owasp') return 'validation';
  if (category === 'architecture') return 'isolation';
  if (category === 'performance') return 'observability';
  return 'supply_chain';
}

async function readFindings() {
  const r = await globalThis.nmas.data.read({ collection: COL_FINDINGS, key: KEY_FINDINGS });
  const doc = r.value === null ? { schema_version: 1, items: [] } : r.value;
  if (!doc || doc.schema_version !== 1 || !Array.isArray(doc.items)) throw new Error('安全发现台账损坏');
  return { revision: r.revision, items: doc.items };
}

async function readIncidents() {
  const r = await globalThis.nmas.data.read({ collection: COL_INCIDENTS, key: KEY_INCIDENTS });
  const doc = r.value === null ? { schema_version: 1, items: [] } : r.value;
  if (!doc || doc.schema_version !== 1 || !Array.isArray(doc.items)) throw new Error('故障复盘台账损坏');
  return { revision: r.revision, items: doc.items };
}

async function readActions() {
  const r = await globalThis.nmas.data.read({ collection: COL_ACTIONS, key: KEY_ACTIONS });
  const doc = r.value === null ? { schema_version: 1, items: [] } : r.value;
  if (!doc || doc.schema_version !== 1 || !Array.isArray(doc.items)) throw new Error('整改行动台账损坏');
  return { revision: r.revision, items: doc.items };
}

async function writeCollection(collection, key, expectedRevision, items) {
  const value = { schema_version: 1, items };
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

function computePosture(findings, incidents, actions) {
  const openP0P1 = findings.filter(
    f => (f.status === 'open' || f.status === 'mitigating') && (f.severity === 'critical' || f.severity === 'high'),
  ).length;

  const mttrMin = incidents.length > 0
    ? Math.round(incidents.reduce((sum, inc) => sum + (inc.duration_min || 0), 0) / incidents.length)
    : 0;

  const verifiedActions = actions.filter(a => a.status === 'verified').length;
  const closureRate = actions.length > 0 ? Math.round((verifiedActions / actions.length) * 1000) / 10 : 100;

  // 总体安全健康分 (0-100)
  const sevPenalty = { critical: 16, high: 9, medium: 4, low: 1.5 };
  let penalty = 0;
  for (const f of findings) {
    if (f.status === 'verified' || f.status === 'wontfix') continue;
    const base = sevPenalty[f.severity] ?? 3;
    penalty += f.status === 'mitigating' ? base * 0.5 : base;
  }
  const bonus = actions.length > 0 ? Math.round((verifiedActions / actions.length) * 6) : 0;
  const healthScore = Math.max(0, Math.min(100, Math.round(100 - penalty + bonus)));

  // 5 维安全雷达分 (0-100)
  const radarScores = {};
  for (const dim of DIMENSIONS) {
    const dimFindings = findings.filter(f => f.dimension === dim);
    let dimPenalty = 0;
    for (const f of dimFindings) {
      if (f.status === 'verified' || f.status === 'wontfix') continue;
      const riskWeight = Math.round(f.risk_score * 1.45);
      dimPenalty += f.status === 'mitigating' ? riskWeight * 0.5 : riskWeight;
    }
    const baseScore = dimFindings.length === 0 ? 88 : 96;
    radarScores[dim] = Math.max(15, Math.min(100, Math.round(baseScore - dimPenalty)));
  }

  return {
    kpis: {
      open_p0_p1: openP0P1,
      mttr_min: mttrMin,
      closure_rate: closureRate,
      health_score: healthScore,
      total_findings: findings.length,
      total_incidents: incidents.length,
      total_actions: actions.length,
    },
    radar_scores: radarScores,
  };
}

function buildDemoData() {
  const findings = [
    {
      id: 'SEC-001',
      title: '插件网关透传未校验自定义 HTTP Host 重定向，存在 SSRF 风险',
      category: 'owasp',
      dimension: 'isolation',
      severity: 'critical',
      impact: 5,
      likelihood: 4,
      risk_score: 20,
      status: 'open',
      component: 'plugin-gateway / http-broker',
      remediation: '禁用 3xx 自动跟随重定向；强制在 DNS 解析后校检目标 IP 非私网/环回段，并严格绑定静态规则白名单。',
      created_at: '2026-11-14',
    },
    {
      id: 'SEC-002',
      title: '桌面端 WebView 桥接调用缺少请求来源 Origin 与会话 Token 双向核验',
      category: 'owasp',
      dimension: 'auth',
      severity: 'critical',
      impact: 5,
      likelihood: 3,
      risk_score: 15,
      status: 'mitigating',
      component: 'desktop-host / ipc-bridge',
      remediation: '在宿主启动阶段注入一次性 Nonce 令牌，所有 bridge.invoke 须校验来源 frame origin 与声明权限集合。',
      created_at: '2026-11-15',
    },
    {
      id: 'SEC-003',
      title: 'Agent Tool 出参嵌套深度未设上限，恶意构造 JSON 可触发校验器栈耗尽',
      category: 'architecture',
      dimension: 'validation',
      severity: 'high',
      impact: 4,
      likelihood: 4,
      risk_score: 16,
      status: 'open',
      component: 'schema-validator / quickjs-runtime',
      remediation: '将迭代校验深度硬限制为 16 层、总节点数上限 16384，并在反序列化前拦截超过 16 KiB 载荷。',
      created_at: '2026-11-16',
    },
    {
      id: 'SEC-004',
      title: '第三方插件包安装阶段未校检归档内文件 SHA-256 绑定摘要',
      category: 'compliance',
      dimension: 'supply_chain',
      severity: 'high',
      impact: 4,
      likelihood: 3,
      risk_score: 12,
      status: 'verified',
      component: 'plugin-installer / archive-verifier',
      remediation: '安装与冷启动加载双阶段均重新计算 canonical archive digest 与 backend 绑定前缀，不匹配即拒绝执行。',
      created_at: '2026-11-12',
    },
    {
      id: 'SEC-005',
      title: '高并发 CAS 写入冲突仅记录 debug 日志，缺少 P99 冲突率监控告警',
      category: 'performance',
      dimension: 'observability',
      severity: 'medium',
      impact: 3,
      likelihood: 4,
      risk_score: 12,
      status: 'open',
      component: 'storage-broker / telemetry',
      remediation: '暴露 broker_cas_conflict_total 与 broker_latency_ms 指标，5 分钟冲突率超过 5% 触发告警。',
      created_at: '2026-11-18',
    },
    {
      id: 'SEC-006',
      title: 'project 作用域插件缓存键未拼接 tenant_id 前缀，存在冷清理遗漏隐患',
      category: 'architecture',
      dimension: 'isolation',
      severity: 'low',
      impact: 2,
      likelihood: 2,
      risk_score: 4,
      status: 'verified',
      component: 'desktop-storage / namespace',
      remediation: '统一存储键命名规范为 tenant/project/plugin/collection/key，并补齐切换账号清理单测。',
      created_at: '2026-11-11',
    },
  ];

  const incidents = [
    {
      id: 'INC-001',
      title: '插件沙箱网关超时雪崩导致桌面端会话响应中断 38 分钟',
      severity: 'SEV1',
      duration_min: 38,
      status: 'closed',
      occurred_at: '2026-11-15',
      impact_summary: '约 18% 启用网络型插件的桌面端会话在工具调用阶段卡死超过 30 秒，触发主线程池队列积压。',
      timeline: [
        { time: '14:02', event: '上游公开汇率 API 出现 TLS 握手挂起，单次请求耗时飙升至 45s' },
        { time: '14:09', event: '网关连接池打满，普通本地数据插件调用同步排队超时' },
        { time: '14:17', event: '值班研发介入，开启网关熔断开关并隔离 http-broker 线程池' },
        { time: '14:40', event: '积压队列排空，P99 延迟回落至 42ms，全量恢复' },
      ],
      five_whys: [
        { level: 1, question: '为什么所有桌面端插件调用都出现大面积超时？', answer: '因为网关的 HTTP 代理与本地存储 broker 共享同一个异步工作队列。' },
        { level: 2, question: '为什么上游慢请求能把共享队列完全占满？', answer: 'HTTP 出站客户端未配置独立的连接超时与总超时硬上限，默认等待操作系统 TCP 超时。' },
        { level: 3, question: '为什么没有在慢请求堆积初期自动熔断？', answer: '网关缺少按目标域名维度的并发信号量与半开熔断器机制。' },
        { level: 4, question: '为什么上线前压测没有暴露出该问题？', answer: 'CI 沙箱测试只 Mock 了 200 OK 极速返回，未注入高延迟与黑洞连接故障演练。' },
        { level: 5, question: '为什么准入检查清单未强制覆盖网络故障演练？', answer: '缺少针对网关 I/O 隔离与超时预算的强制架构评审门禁（根本原因）。' },
      ],
      lessons: '任何外部网络 I/O 必须与本地存储/UI 桥接物理隔离线程池，强制设定 3s 连接 / 8s 总超时与域名级熔断器。',
    },
    {
      id: 'INC-002',
      title: 'QuickJS 沙箱内存回收延迟引发多标签页插件 OOM 重启',
      severity: 'SEV2',
      duration_min: 22,
      status: 'mitigated',
      occurred_at: '2026-11-19',
      impact_summary: '同时打开 5 个数据型插件工作台时，单个 QuickJS Runtime 占用峰值突破 190MB 触发宿主主动回收。',
      timeline: [
        { time: '09:35', event: '监控捕获桌面端插件进程 RSS 内存呈阶梯式增长' },
        { time: '09:44', event: '定位为高频诊断动作每次创建临时大正则数组且未限制入参体积' },
        { time: '09:57', event: '发布热修将单次入参收紧至 14 KiB 并在每轮调用后触发增量 GC' },
      ],
      five_whys: [
        { level: 1, question: '为什么插件运行时会触发宿主 OOM 保护？', answer: '单实例内存占用在 10 分钟内线性上涨超过 190MB。' },
        { level: 2, question: '为什么内存没有被及时回收？', answer: '高频轮询动作持续分配短生命周期大对象，而宿主仅在空闲超时后才运行完整 GC。' },
        { level: 3, question: '为什么单次调用会分配大量内存？', answer: '未对前端输入防抖，且后端未拦截超大文本载荷。' },
        { level: 4, question: '为什么压测没发现内存泄漏趋势？', answer: '单元测试只验证单次调用正确性，缺少连续 500 次调用的常驻内存水位断言。' },
        { level: 5, question: '为什么插件准入缺少资源配额红线？', answer: '尚未在验证链路中固化单次载荷 14 KiB 与运行时内存上限基线（根本原因）。' },
      ],
      lessons: '所有插件调用严格执行 <= 14 KiB 载荷预算与前端输入防抖，宿主需为每个 QuickJS 实例配置独立内存上限与周期 GC。',
    },
  ];

  const actions = [
    {
      id: 'ACT-001',
      title: '在 http-broker 中禁止 3xx 自动重定向并落地私有网段 IP 拦截器',
      source_type: 'finding',
      source_id: 'SEC-001',
      owner: '林骁 (Gateway)',
      due_date: '2026-11-25',
      priority: 'P0',
      status: 'in_progress',
      verification_note: '已提交 PR #412，待补全 IPv6 环回地址测试用例。',
    },
    {
      id: 'ACT-002',
      title: '为桌面端 IPC Bridge 接入每窗口唯一 Nonce 与 Origin 双重校验',
      source_type: 'finding',
      source_id: 'SEC-002',
      owner: '陈默 (Desktop)',
      due_date: '2026-11-24',
      priority: 'P0',
      status: 'in_progress',
      verification_note: 'macOS WebView 注入逻辑已完成，正在做回归自测。',
    },
    {
      id: 'ACT-003',
      title: '将 JSON Schema 校验器改为显式栈迭代并固化 16 层深度上限',
      source_type: 'finding',
      source_id: 'SEC-003',
      owner: '周颖 (Runtime)',
      due_date: '2026-11-27',
      priority: 'P1',
      status: 'todo',
      verification_note: '排期进入下周迭代，需同步补充深嵌套 Fuzz 用例。',
    },
    {
      id: 'ACT-004',
      title: '拆分 http-broker 与 storage-broker 线程池并上线 8s 硬超时熔断',
      source_type: 'incident',
      source_id: 'INC-001',
      owner: '林骁 (Gateway)',
      due_date: '2026-11-20',
      priority: 'P0',
      status: 'verified',
      verification_note: '已在预发注入 30s 黑洞故障验证，本地插件 P99 保持 18ms。',
    },
    {
      id: 'ACT-005',
      title: '接入 CAS 冲突率与 Broker 延迟 Prometheus 指标及 5% 告警规则',
      source_type: 'finding',
      source_id: 'SEC-005',
      owner: '赵衡 (SRE)',
      due_date: '2026-11-29',
      priority: 'P1',
      status: 'todo',
      verification_note: '待确认看板命名规范与告警静默窗口。',
    },
    {
      id: 'ACT-006',
      title: '归档安装与加载双阶段强制校验 canonical SHA-256 绑定摘要',
      source_type: 'finding',
      source_id: 'SEC-004',
      owner: '周颖 (Runtime)',
      due_date: '2026-11-18',
      priority: 'P1',
      status: 'verified',
      verification_note: '篡改单字节归档回归用例已 100% 拦截。',
    },
  ];

  return { findings, incidents, actions };
}

function buildMarkdownReport(findings, incidents, actions, posture, targetIncidentId) {
  const { kpis, radar_scores } = posture;
  const openHigh = findings
    .filter(f => (f.status === 'open' || f.status === 'mitigating') && (f.severity === 'critical' || f.severity === 'high'))
    .sort((a, b) => b.risk_score - a.risk_score);
  const chosenIncidents = targetIncidentId
    ? incidents.filter(i => i.id === targetIncidentId)
    : incidents.slice(0, 2);
  const pendingActions = actions.filter(a => a.status !== 'verified');

  const lines = [
    `# 安全审计与故障复盘 (COE) 作战报告`,
    ``,
    `> 生成日期：${todayStr()} ｜ 项目安全健康分：**${kpis.health_score} / 100** ｜ P0/P1 未闭环：**${kpis.open_p0_p1}** ｜ MTTR：**${kpis.mttr_min} 分钟** ｜ 整改闭环率：**${kpis.closure_rate}%**`,
    ``,
    `## 1. 五维安全态势评分`,
    ...DIMENSIONS.map(d => `- **${DIM_LABELS[d]}**：${radar_scores[d]} / 100`),
    ``,
    `## 2. 未闭环高危审计发现 (${openHigh.length})`,
  ];

  if (openHigh.length === 0) {
    lines.push(`- 当前无未闭环的高危/严重漏洞。`);
  } else {
    for (const f of openHigh) {
      lines.push(`- **[${f.id}] (${f.severity.toUpperCase()} · 风险分 ${f.risk_score}/25 · ${f.status})** ${f.title}`);
      lines.push(`  - 组件：\`${f.component}\` ｜ 方案：${f.remediation || '待补充'}`);
    }
  }

  lines.push(``, `## 3. 故障复盘与 5-Whys 根因摘要 (${chosenIncidents.length})`);
  if (chosenIncidents.length === 0) {
    lines.push(`- 暂无故障复盘记录。`);
  } else {
    for (const inc of chosenIncidents) {
      lines.push(`### ${inc.id} · ${inc.title} (${inc.severity}, 持续 ${inc.duration_min} 分钟)`);
      lines.push(`- **影响**：${inc.impact_summary}`);
      const root = inc.five_whys[inc.five_whys.length - 1];
      if (root) lines.push(`- **根因 (Why ${root.level})**：${root.answer}`);
      lines.push(`- **固化教训**：${inc.lessons}`);
    }
  }

  lines.push(``, `## 4. 待闭环整改行动项 (${pendingActions.length})`);
  if (pendingActions.length === 0) {
    lines.push(`- 全部整改行动项均已验证闭环。`);
  } else {
    for (const a of pendingActions) {
      lines.push(`- [ ] **${a.id} [${a.priority}]** ${a.title}（负责人：${a.owner}，截止：${a.due_date}，关联：${a.source_id || '无'}）`);
    }
  }

  return lines.join('\n').slice(0, 9800);
}

export default async function (request) {
  const { kind, contribution, input } = request ?? {};

  if (kind === 'action') {
    if (contribution === 'warroom.state') {
      const f = await readFindings();
      const inc = await readIncidents();
      const act = await readActions();
      const posture = computePosture(f.items, inc.items, act.items);
      return {
        revision: act.revision,
        kpis: posture.kpis,
        radar_scores: posture.radar_scores,
        findings: f.items,
        incidents: inc.items,
        actions: act.items,
      };
    }

    if (contribution === 'finding.save') {
      const title = (input.title || '').trim();
      const component = (input.component || '').trim();
      if (
        !title || !component ||
        !CATEGORIES.includes(input.category) ||
        !DIMENSIONS.includes(input.dimension) ||
        !SEVERITIES.includes(input.severity) ||
        !FINDING_STATUSES.includes(input.status)
      ) {
        return { status: 'invalid_input', revision: input.expected_revision };
      }
      const f = await readFindings();
      if (f.revision !== input.expected_revision) return { status: 'conflict', revision: f.revision };
      const finalId = input.id === 'NEW' ? nextSeqId('SEC', f.items) : input.id;
      if (!validId(finalId)) return { status: 'invalid_input', revision: f.revision };

      const existing = f.items.find(x => x.id === finalId);
      const riskScore = input.impact * input.likelihood;
      const record = {
        id: finalId,
        title,
        category: input.category,
        dimension: input.dimension,
        severity: input.severity,
        impact: input.impact,
        likelihood: input.likelihood,
        risk_score: riskScore,
        status: input.status,
        component,
        remediation: (input.remediation || '').trim().slice(0, 420),
        created_at: existing?.created_at || todayStr(),
      };
      const next = existing ? f.items.map(x => (x.id === finalId ? record : x)) : [record, ...f.items];
      if (next.length > MAX_FINDINGS) return { status: 'limit', revision: f.revision };
      const res = await writeCollection(COL_FINDINGS, KEY_FINDINGS, input.expected_revision, next);
      return res.status === 'saved' ? { status: 'saved', revision: res.revision, id: finalId, risk_score: riskScore } : res;
    }

    if (contribution === 'finding.delete') {
      const f = await readFindings();
      if (f.revision !== input.expected_revision) return { status: 'conflict', revision: f.revision };
      if (!f.items.some(x => x.id === input.id)) return { status: 'not_found', revision: f.revision };
      const res = await writeCollection(COL_FINDINGS, KEY_FINDINGS, input.expected_revision, f.items.filter(x => x.id !== input.id));
      return res.status === 'saved' ? { status: 'deleted', revision: res.revision } : { status: 'conflict', revision: res.revision };
    }

    if (contribution === 'incident.save') {
      const title = (input.title || '').trim();
      if (
        !title ||
        !INC_SEVS.includes(input.severity) ||
        !INC_STATUSES.includes(input.status) ||
        !validDate(input.occurred_at)
      ) {
        return { status: 'invalid_input', revision: input.expected_revision };
      }
      const inc = await readIncidents();
      if (inc.revision !== input.expected_revision) return { status: 'conflict', revision: inc.revision };
      const finalId = input.id === 'NEW' ? nextSeqId('INC', inc.items) : input.id;
      if (!validId(finalId)) return { status: 'invalid_input', revision: inc.revision };

      const timeline = (input.timeline || [])
        .filter(t => t && t.time.trim() && t.event.trim())
        .slice(0, 8)
        .map(t => ({ time: t.time.trim().slice(0, 24), event: t.event.trim().slice(0, 160) }));
      const fiveWhys = (input.five_whys || [])
        .filter(w => w && w.question.trim() && w.answer.trim())
        .slice(0, 5)
        .map((w, idx) => ({
          level: idx + 1,
          question: w.question.trim().slice(0, 140),
          answer: w.answer.trim().slice(0, 200),
        }));

      const record = {
        id: finalId,
        title,
        severity: input.severity,
        duration_min: Math.max(0, input.duration_min),
        status: input.status,
        occurred_at: input.occurred_at,
        impact_summary: (input.impact_summary || '').trim().slice(0, 240),
        timeline,
        five_whys: fiveWhys,
        lessons: (input.lessons || '').trim().slice(0, 300),
      };
      const exists = inc.items.some(x => x.id === finalId);
      const next = exists ? inc.items.map(x => (x.id === finalId ? record : x)) : [record, ...inc.items];
      if (next.length > MAX_INCIDENTS) return { status: 'limit', revision: inc.revision };
      const res = await writeCollection(COL_INCIDENTS, KEY_INCIDENTS, input.expected_revision, next);
      return res.status === 'saved' ? { status: 'saved', revision: res.revision, id: finalId } : res;
    }

    if (contribution === 'incident.delete') {
      const inc = await readIncidents();
      if (inc.revision !== input.expected_revision) return { status: 'conflict', revision: inc.revision };
      if (!inc.items.some(x => x.id === input.id)) return { status: 'not_found', revision: inc.revision };
      const res = await writeCollection(COL_INCIDENTS, KEY_INCIDENTS, input.expected_revision, inc.items.filter(x => x.id !== input.id));
      return res.status === 'saved' ? { status: 'deleted', revision: res.revision } : { status: 'conflict', revision: res.revision };
    }

    if (contribution === 'action_item.save') {
      const title = (input.title || '').trim();
      const owner = (input.owner || '').trim();
      if (
        !title || !owner ||
        !['finding', 'incident'].includes(input.source_type) ||
        !ACT_PRIORITIES.includes(input.priority) ||
        !ACT_STATUSES.includes(input.status) ||
        !validDate(input.due_date)
      ) {
        return { status: 'invalid_input', revision: input.expected_revision };
      }
      const act = await readActions();
      if (act.revision !== input.expected_revision) return { status: 'conflict', revision: act.revision };
      const finalId = input.id === 'NEW' ? nextSeqId('ACT', act.items) : input.id;
      if (!validId(finalId)) return { status: 'invalid_input', revision: act.revision };

      const record = {
        id: finalId,
        title,
        source_type: input.source_type,
        source_id: (input.source_id || '').trim().slice(0, 24),
        owner,
        due_date: input.due_date,
        priority: input.priority,
        status: input.status,
        verification_note: (input.verification_note || '').trim().slice(0, 240),
      };
      const exists = act.items.some(x => x.id === finalId);
      const next = exists ? act.items.map(x => (x.id === finalId ? record : x)) : [record, ...act.items];
      if (next.length > MAX_ACTIONS) return { status: 'limit', revision: act.revision };
      const res = await writeCollection(COL_ACTIONS, KEY_ACTIONS, input.expected_revision, next);
      return res.status === 'saved' ? { status: 'saved', revision: res.revision, id: finalId } : res;
    }

    if (contribution === 'action_item.delete') {
      const act = await readActions();
      if (act.revision !== input.expected_revision) return { status: 'conflict', revision: act.revision };
      if (!act.items.some(x => x.id === input.id)) return { status: 'not_found', revision: act.revision };
      const res = await writeCollection(COL_ACTIONS, KEY_ACTIONS, input.expected_revision, act.items.filter(x => x.id !== input.id));
      return res.status === 'saved' ? { status: 'deleted', revision: res.revision } : { status: 'conflict', revision: res.revision };
    }

    if (contribution === 'report.generate') {
      const f = await readFindings();
      const inc = await readIncidents();
      const act = await readActions();
      const posture = computePosture(f.items, inc.items, act.items);
      const markdown = buildMarkdownReport(f.items, inc.items, act.items, posture, input.incident_id || '');
      return { markdown, health_score: posture.kpis.health_score };
    }

    if (contribution === 'demo.seed') {
      const f = await readFindings();
      if (f.revision !== input.expected_revision) return { status: 'conflict', revision: f.revision };
      const demo = buildDemoData();
      const w1 = await writeCollection(COL_FINDINGS, KEY_FINDINGS, input.expected_revision, demo.findings);
      if (w1.status !== 'saved') return { status: w1.status === 'limit' ? 'limit' : 'conflict', revision: w1.revision };
      const w2 = await writeCollection(COL_INCIDENTS, KEY_INCIDENTS, w1.revision, demo.incidents);
      if (w2.status !== 'saved') return { status: w2.status === 'limit' ? 'limit' : 'conflict', revision: w2.revision };
      const w3 = await writeCollection(COL_ACTIONS, KEY_ACTIONS, w2.revision, demo.actions);
      if (w3.status !== 'saved') return { status: w3.status === 'limit' ? 'limit' : 'conflict', revision: w3.revision };
      return {
        status: 'seeded',
        revision: w3.revision,
        findings_count: demo.findings.length,
        incidents_count: demo.incidents.length,
        actions_count: demo.actions.length,
      };
    }

    if (contribution === 'document.list') {
      const f = await readFindings();
      const inc = await readIncidents();
      const items = [
        { id: 'SNAPSHOT', label: '作战室完整审计与 COE 快照' },
        ...f.items.map(x => ({ id: x.id, label: `发现 ${x.id} · ${x.title}` })),
        ...inc.items.map(x => ({ id: x.id, label: `复盘 ${x.id} · ${x.title}` })),
      ];
      return { items };
    }

    if (contribution === 'document.export') {
      const serializeDoc = payload => {
        const pretty = JSON.stringify(payload, null, 2);
        return jsonBytes(pretty) <= 11800 ? pretty : JSON.stringify(payload);
      };
      const f = await readFindings();
      const inc = await readIncidents();
      if (input.id === 'SNAPSHOT') {
        const act = await readActions();
        const text = serializeDoc({ format: DOC_FORMAT, version: 1, kind: 'snapshot', findings: f.items, incidents: inc.items, actions: act.items });
        if (jsonBytes(text) > 12000) return { error: 'too_large' };
        return { filename: 'audit-warroom-snapshot.json', text };
      }
      const finding = f.items.find(x => x.id === input.id);
      if (finding) {
        return {
          filename: `${finding.id.toLowerCase()}.json`,
          text: serializeDoc({ format: DOC_FORMAT, version: 1, kind: 'finding', record: finding }),
        };
      }
      const incident = inc.items.find(x => x.id === input.id);
      if (incident) {
        return {
          filename: `${incident.id.toLowerCase()}.json`,
          text: serializeDoc({ format: DOC_FORMAT, version: 1, kind: 'incident', record: incident }),
        };
      }
      return { error: 'not_found' };
    }

    if (contribution === 'document.import') {
      let parsed;
      try { parsed = JSON.parse(input.text); } catch { return { imported: false, reason: 'invalid_json' }; }
      if (parsed?.format !== DOC_FORMAT || parsed?.version !== 1) return { imported: false, reason: 'invalid_document' };

      if (parsed.kind === 'finding' && parsed.record && typeof parsed.record.title === 'string' && parsed.record.title.trim()) {
        const f = await readFindings();
        const src = parsed.record;
        const id = nextSeqId('SEC', f.items);
        const impact = Number.isInteger(src.impact) ? Math.max(1, Math.min(5, src.impact)) : 3;
        const likelihood = Number.isInteger(src.likelihood) ? Math.max(1, Math.min(5, src.likelihood)) : 3;
        const cat = CATEGORIES.includes(src.category) ? src.category : 'owasp';
        const record = {
          id,
          title: src.title.trim().slice(0, 120),
          category: cat,
          dimension: DIMENSIONS.includes(src.dimension) ? src.dimension : inferDimension(cat),
          severity: SEVERITIES.includes(src.severity) ? src.severity : 'medium',
          impact,
          likelihood,
          risk_score: impact * likelihood,
          status: FINDING_STATUSES.includes(src.status) ? src.status : 'open',
          component: typeof src.component === 'string' && src.component.trim() ? src.component.trim().slice(0, 80) : 'unspecified',
          remediation: typeof src.remediation === 'string' ? src.remediation.trim().slice(0, 420) : '',
          created_at: todayStr(),
        };
        const next = [record, ...f.items];
        if (next.length > MAX_FINDINGS) return { imported: false, reason: 'limit' };
        const res = await writeCollection(COL_FINDINGS, KEY_FINDINGS, f.revision, next);
        return res.status === 'saved' ? { imported: true, id } : { imported: false, reason: res.status };
      }

      if (parsed.kind === 'incident' && parsed.record && typeof parsed.record.title === 'string' && parsed.record.title.trim()) {
        const inc = await readIncidents();
        const src = parsed.record;
        const id = nextSeqId('INC', inc.items);
        const record = {
          id,
          title: src.title.trim().slice(0, 120),
          severity: INC_SEVS.includes(src.severity) ? src.severity : 'SEV2',
          duration_min: Number.isInteger(src.duration_min) && src.duration_min >= 0 ? src.duration_min : 15,
          status: INC_STATUSES.includes(src.status) ? src.status : 'mitigated',
          occurred_at: validDate(src.occurred_at) ? src.occurred_at : todayStr(),
          impact_summary: typeof src.impact_summary === 'string' ? src.impact_summary.slice(0, 240) : '',
          timeline: Array.isArray(src.timeline)
            ? src.timeline.slice(0, 8).filter(t => t && typeof t.time === 'string' && typeof t.event === 'string')
                .map(t => ({ time: t.time.slice(0, 24), event: t.event.slice(0, 160) }))
            : [],
          five_whys: Array.isArray(src.five_whys)
            ? src.five_whys.slice(0, 5).filter(w => w && typeof w.question === 'string' && typeof w.answer === 'string')
                .map((w, idx) => ({ level: idx + 1, question: w.question.slice(0, 140), answer: w.answer.slice(0, 200) }))
            : [],
          lessons: typeof src.lessons === 'string' ? src.lessons.slice(0, 300) : '',
        };
        const next = [record, ...inc.items];
        if (next.length > MAX_INCIDENTS) return { imported: false, reason: 'limit' };
        const res = await writeCollection(COL_INCIDENTS, KEY_INCIDENTS, inc.revision, next);
        return res.status === 'saved' ? { imported: true, id } : { imported: false, reason: res.status };
      }

      if (parsed.kind === 'snapshot' && Array.isArray(parsed.findings)) {
        const f = await readFindings();
        let rev = f.revision;
        const w1 = await writeCollection(COL_FINDINGS, KEY_FINDINGS, rev, parsed.findings.slice(0, MAX_FINDINGS));
        if (w1.status !== 'saved') return { imported: false, reason: w1.status };
        rev = w1.revision;
        if (Array.isArray(parsed.incidents)) {
          const w2 = await writeCollection(COL_INCIDENTS, KEY_INCIDENTS, rev, parsed.incidents.slice(0, MAX_INCIDENTS));
          if (w2.status !== 'saved') return { imported: false, reason: w2.status };
          rev = w2.revision;
        }
        if (Array.isArray(parsed.actions)) {
          const w3 = await writeCollection(COL_ACTIONS, KEY_ACTIONS, rev, parsed.actions.slice(0, MAX_ACTIONS));
          if (w3.status !== 'saved') return { imported: false, reason: w3.status };
        }
        return { imported: true, id: 'SNAPSHOT' };
      }

      return { imported: false, reason: 'invalid_document' };
    }
  }

  if (kind === 'tool') {
    if (contribution === 'audit.summary') {
      const f = await readFindings();
      const inc = await readIncidents();
      const act = await readActions();
      const posture = computePosture(f.items, inc.items, act.items);
      const includeClosed = Boolean(input.include_closed);
      const highRisk = f.items
        .filter(x => (includeClosed || (x.status !== 'verified' && x.status !== 'wontfix')))
        .sort((a, b) => b.risk_score - a.risk_score)
        .slice(0, 12)
        .map(({ id, title, severity, risk_score, status, component }) => ({
          id, title, severity, risk_score, status, component,
        }));
      const incidentLessons = inc.items.slice(0, 8).map(({ id, title, severity, duration_min, lessons }) => ({
        id, title, severity, duration_min, lessons,
      }));
      return {
        success: true,
        status: 'ready',
        health_score: posture.kpis.health_score,
        open_p0_p1: posture.kpis.open_p0_p1,
        mttr_min: posture.kpis.mttr_min,
        closure_rate: posture.kpis.closure_rate,
        radar_scores: posture.radar_scores,
        high_risk_findings: highRisk,
        incident_lessons: incidentLessons,
        pending_actions_count: act.items.filter(a => a.status !== 'verified').length,
      };
    }

    if (contribution === 'audit.finding.add') {
      const title = (input.title || '').trim();
      const component = (input.component || '').trim();
      if (!title || !component || !CATEGORIES.includes(input.category) || !SEVERITIES.includes(input.severity)) {
        return { success: false, status: 'invalid_input' };
      }
      const f = await readFindings();
      const id = nextSeqId('SEC', f.items);
      const riskScore = input.impact * input.likelihood;
      const dimension = DIMENSIONS.includes(input.dimension) ? input.dimension : inferDimension(input.category);
      const record = {
        id,
        title,
        category: input.category,
        dimension,
        severity: input.severity,
        impact: input.impact,
        likelihood: input.likelihood,
        risk_score: riskScore,
        status: 'open',
        component,
        remediation: (input.remediation || '').trim().slice(0, 420),
        created_at: todayStr(),
      };
      const next = [record, ...f.items];
      if (next.length > MAX_FINDINGS) return { success: false, status: 'limit' };
      const res = await writeCollection(COL_FINDINGS, KEY_FINDINGS, f.revision, next);
      return res.status === 'saved'
        ? { success: true, status: 'saved', id, risk_score: riskScore, revision: res.revision }
        : { success: false, status: res.status };
    }
  }

  throw new Error(`不支持的调用: ${kind}/${contribution}`);
}
