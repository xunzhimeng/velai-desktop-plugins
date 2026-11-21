# Velai Desktop 旗舰原生插件套件 (`velai-desktop-plugins`)

本仓库包含 **11 个高颜值、多视图、深业务闭环的 Velai Desktop 旗舰级工作台插件**（涵盖长篇小说开发 IDE、股票 AI 投研与量化终端、个人会话与用量统计大屏、产品需求与路线图、学术科研综述、CRM 销售管道、智能财务 CFO、间隔重复知识图谱、系统架构与 API 契约、全渠道内容工厂、安全审计与故障复盘作战室）。

每个插件均为自包含 `.nmas-plugin` 单文件归档，内置**纯原生高精 SVG 可视化图表**（零外部 CDN/三方库）、**明暗双色主题切换**、**一键加载行业演示工作区**、**CAS 乐观锁持久化**、**原生文档导出/导入**，并深度集成 Velai **Agent Tools** 与 **会话 AI 副驾 (`session.turn.*`)**。

## 11 个旗舰专业系统插件

| # | 插件 ID | 系统名称 | 作用域 & 展示面 | Agent Tools | 核心专业模块与可视化亮点 |
|---|---|---|---|---|---|
| 1 | `novel-studio` | **AI 长篇小说开发系统** | `account` · `workspace/chat/assistant` | `novel.outline`, `novel.chapter.read`, `novel.bible.upsert` | 分键存储支持多卷长篇、卷章树形写作台 + AI 续写/润色/OOC 体检副驾、SVG 人物关系星系图谱、SVG 全书张力曲线与伏笔预警板、世界观设定集（内置《星渊回响》演示长篇） |
| 2 | `stock-ai-terminal` | **股票 AI 投研与量化终端** | `account` · `workspace/chat/assistant` | `stock.portfolio`, `stock.analyze`, `stock.note.add` | 红涨绿跌/绿涨红跌切换、交互式 SVG 蜡烛 K 线图 (MA5/10/20 + 成交量)、双均线/RSI/布林带真实量化回测引擎与净值对比曲线、持仓环形配置图 + DCF 现金流折现估值计算器、AI 深度研报副驾 |
| 3 | `product-studio` | **产品需求与路线图设计台** | `project` · `workspace/chat` | `prd.list`, `prd.create` | RICE 四维自动打分引擎 + SVG 四象限气泡矩阵、多泳道交互式 SVG 甘特图路线图、5 段式结构化 PRD 编辑器与完整度评分、一键插入会话评审 |
| 4 | `research-lab` | **AI 学术科研与文献综述工作台** | `account` · `workspace/chat/assistant` | `paper.search`, `paper.read`, `paper.add` | 文献卡片库与阅读进度、SVG 按年份分层有向引用脉络图（点击高亮上下游引用链）、方法论横向对比矩阵、AI 自动生成 Related Work 综述与研究空白 |
| 5 | `crm-sales-os` | **AI 智能客户与商机管理系统** | `account` · `workspace/chat/assistant` | `crm.pipeline`, `crm.account.get`, `crm.activity.log` | 5 阶段商机看板 + SVG 转化漏斗与加权营收预测图、客户 360° 健康度环与互动时间轴（逾期提醒）、AI 销售军师（跟进邮件/异议应答/赢单复盘） |
| 6 | `finance-wealth-os` | **智能财务与资产配置 CFO 系统** | `account` · `workspace/chat/assistant` | `finance.summary`, `finance.tx.add` | 资产负债总览 + SVG 资产配置环形图 & 净资产/现金流双轨图、智能账本与红黄绿预算预警、FIRE 20 年三档复利推演 SVG + 房贷提前还款省息测算、AI 私人 CFO 诊断 |
| 7 | `course-knowledge-os` | **AI 知识图谱与间隔重复学习系统** | `account` · `workspace/chat/assistant` | `study.due`, `study.card.add` | 完整 SuperMemo **SM-2** 间隔重复闪卡复习引擎、SVG 双链知识图谱网络（点击透视相邻节点）、42 天学习热力图与掌握度柱图、AI 费曼导师与自动制卡 |
| 8 | `api-arch-studio` | **系统架构与 API 契约设计台** | `project` · `workspace/chat` | `arch.topology`, `arch.endpoint.upsert` | 微服务架构拓扑 SVG 画布 + **Tarjan SCC 循环依赖检测**与扇入/扇出耦合度分析、API 契约管理、实时编译输出 **OpenAPI 3.0.3 JSON & TypeScript Interface** |
| 9 | `content-growth-os` | **全渠道内容工厂与增长运营台** | `account` · `workspace/chat/assistant` | `content.pipeline`, `content.draft.save` | 多平台阅读/互动双轴趋势图 + 六渠道流量分布 SVG、选题排期四列看板、5 维度爆款标题诊断仪、AI 一稿多改矩阵（小红书/X Thread/知乎/短视频脚本） |
| 10 | `code-audit-warroom` | **安全审计与故障复盘作战室 (COE)** | `project` · `workspace/chat` | `audit.summary`, `audit.finding.add` | SVG 5×5 风险热力矩阵 + 五维安全雷达图、分级漏洞台账、SEV 故障时间线与 **5-Whys 根因分析树**、整改行动项闭环与一键生成 Markdown 复盘报告 |
| 11 | `usage-analytics-hub` | **个人会话与用量统计大屏** | `account` · `workspace/chat/assistant` | `usage.dashboard.summary`, `usage.session.record`, `usage.budget.status` | 7d/30d/全部时间窗切换；5 项发光 KPI + **SVG Token/缓存/费用双轴趋势图**、**24h 活跃高峰分布图**、**模型环形图**与场景条形图；模型性价比 ROI 表、预算预警、一键请当前会话/助手整理近期会话并批量导入大屏 |

> 全部 11 个旗舰系统合计提供 **27 个 Agent Tools**（低于 Velai Desktop 单账号 32 个工具上限），支持全部同时启用。

## 安装与使用

### 方式一：导入 `.nmas-plugin` 插件包

1. 从本仓库 [Releases](https://github.com/xunzhimeng/velai-desktop-plugins/releases) 或 `dist/` 目录下载任意 `<plugin_id>.nmas-plugin` 文件。
2. 在 **Velai Desktop → 插件管理** 中导入本地插件包，核对权限声明后启用，即可在工作台 / 聊天 / 助手侧栏中打开完整页面。
3. 每个插件界面均提供 **「✨ 加载演示数据」** 按钮，一键体验完整图表、数据与 AI 协作闭环。

### 方式二：配置 GitHub 更新源

本仓库每次正式 Release 均附带全部 10 个 `<plugin_id>.nmas-plugin` 资产文件：
- 来源类型：`github`
- 仓库位置：`xunzhimeng/velai-desktop-plugins`

## 本地构建与严格验收

要求 Node.js >= 20（零外部依赖）：

```bash
# 重新打包全部 10 个插件到 dist/ 并生成 catalog.json
npm run build

# 运行完整契约校验（Archive / Schema / macOS 准入 / 单在途串行 Broker 沙箱）与功能回归测试
npm run verify

# CI 同款一键全检
npm run check
```

## 许可协议

MIT License
