# Velai Desktop 旗舰原生插件套件 V2 (`velai-desktop-plugins`)

本仓库包含 **13 个全面升级至 Velai Desktop V2（`manifest_version: 2 / host_api: 2`，IPC v8）的旗舰级原生插件**，完整覆盖插件平台 V2 全部 5 个能力切片（Slice 1–5B）：

- **Slice 1（单文档 HTML 沙箱与可靠桥）**：保留 `<html data-theme="dark">` 原生暗色主题、确定性错误不杀页、滑动去重；
- **Slice 2（宿主只读遥测与元数据 `nmas.host.*`）**：直连本机权威 Token/缓存/TPS 聚合、会话列表与项目列表；
- **Slice 3（8192 滑动账本与存储 v2 `nmas.data.list/delete`）**：252 KiB 单条记录预算、16 MiB 存储上限、可分页列举与 CAS 删除；
- **Slice 4A/4B（受控 HTTP v2 + `manifest.settings` 公开配置 & 宿主加密密钥槽）**：`path_prefix`、`query_keys`、受限同源跳转、以及宿主加密 Vault 注入 + 窄标量投影；
- **Slice 5A（受控项目工作区文件 `nmas.fs.*`）**：固定目录 FD 只读面与本机 APFS 原子 CAS 写同步，自动拒绝 `.git`、符号链接逃逸与敏感凭据文件；
- **Slice 5B（受管流式 AI `nmas.ai.*` + 真实 SSE + v2 Agent Tools 解绑）**：严格隔离的独立流式 AI + `nmasPlugin.onAiEvent` 伴生插件，以及允许按需授权 `http.request`、`host.*.read`、`workspace.fs.*` 的 v2 Agent Tools（单账号预留上限 96）。

> **安全隔离说明**：macOS Velai Desktop V2 对 `ai.complete`（受管付费流式 AI）执行严格单能力隔离（禁止与 `workspace.fs.*`、`http.request`、`data.*`、`settings` 同包组合），因此小说创作与股票投研的实时流式 AI 能力由两个独立的 Slice 5B 伴生插件 `novel-ai-writer` 与 `stock-ai-copilot` 提供，可与主插件同屏协作。

## 13 个 V2 旗舰插件清单（均可直接在 macOS Velai Desktop 安装测试）

| # | 插件 ID | 系统名称 | 版本 | 作用域 & 展示面 | 权限 & V2 能力 | Agent Tools | 归档文件 |
|---|---|---|---|---|---|---|---|
| 1 | `novel-studio` | **AI 长篇小说开发系统** | `v2.0.0` | `project` · `workspace/chat` | `data.*` + `workspace.fs.read/write`（252 KiB 分章存储 + 项目手稿原子 CAS 同步） | 3（含 `workspace.fs.read`） | `dist/novel-studio.nmas-plugin` |
| 2 | `stock-ai-terminal` | **股票 AI 投研与量化终端** | `v2.0.0` | `account` · `workspace/chat/assistant` | `data.*` + `http.request` + `settings`（Yahoo 实时行情 + Finnhub 加密密钥槽标量投影 + Frankfurter 汇率） | 3（含 `http.request`） | `dist/stock-ai-terminal.nmas-plugin` |
| 3 | `usage-analytics-hub` | **个人会话与用量统计大屏** | `v2.0.0` | `account` · `workspace/chat/assistant` | `host.usage/sessions/projects.read` + `data.*`（直连宿主实时遥测、会话与项目元数据） | 3（含 `host.*.read`） | `dist/usage-analytics-hub.nmas-plugin` |
| 4 | `novel-ai-writer` | **小说 AI 流式写作助手** | `v2.0.0` | `none` · `workspace` | `ai.complete`（Slice 5B `nmas.ai.stream_start/complete/cancel` + 真实 SSE `onAiEvent`） | 0 | `dist/novel-ai-writer.nmas-plugin` |
| 5 | `stock-ai-copilot` | **股票 AI 流式投研副驾驶** | `v2.0.0` | `none` · `workspace` | `ai.complete`（Slice 5B 实时 SSE 研报流 + 结构化 JSON 多空评级） | 0 | `dist/stock-ai-copilot.nmas-plugin` |
| 6 | `code-audit-warroom` | **安全审计与故障复盘作战室 (COE)** | `v2.0.0` | `project` · `workspace/chat` | `data.*` + 纯只读 `workspace.fs.read`（本机项目文件静态安全扫描） | 3（含 `workspace.fs.read`） | `dist/code-audit-warroom.nmas-plugin` |
| 7 | `product-studio` | **产品需求与路线图设计台** | `v2.0.0` | `project` · `workspace/chat` | `data.*` + `workspace.fs.read/write`（项目 PRD / 路线图 Markdown CAS 同步） | 2 | `dist/product-studio.nmas-plugin` |
| 8 | `api-arch-studio` | **系统架构与 API 契约设计台** | `v2.0.0` | `project` · `workspace/chat` | `data.*` + `workspace.fs.read/write`（OpenAPI / TypeScript / ADR 工作区同步） | 2 | `dist/api-arch-studio.nmas-plugin` |
| 9 | `research-lab` | **AI 学术科研与文献综述工作台** | `v2.0.0` | `account` · `workspace/chat/assistant` | `data.*` + `http.request` + `settings`（Crossref 联网文献检索） | 4（含 `http.request`） | `dist/research-lab.nmas-plugin` |
| 10 | `finance-wealth-os` | **智能财务与资产配置 CFO 系统** | `v2.0.0` | `account` · `workspace/chat/assistant` | `data.*` + `http.request` + `settings`（Frankfurter 多币种实时汇率） | 2 | `dist/finance-wealth-os.nmas-plugin` |
| 11 | `crm-sales-os` | **AI 智能客户与商机管理系统** | `v2.0.0` | `account` · `workspace/chat/assistant` | `data.*`（v2 252 KiB + `list/delete`）+ `settings` | 3 | `dist/crm-sales-os.nmas-plugin` |
| 12 | `course-knowledge-os` | **AI 知识图谱与间隔重复学习系统** | `v2.0.0` | `account` · `workspace/chat/assistant` | `data.*`（v2 252 KiB + `list/delete`）+ `settings` | 2 | `dist/course-knowledge-os.nmas-plugin` |
| 13 | `content-growth-os` | **全渠道内容工厂与增长运营台** | `v2.0.0` | `account` · `workspace/chat/assistant` | `data.*`（v2 252 KiB + `list/delete`）+ `settings` | 2 | `dist/content-growth-os.nmas-plugin` |

> 全部 13 个 V2 插件合计提供 **29 个 Agent Tools**（远低于 Velai Desktop v2 单账号 96 个工具预留上限），支持全部同时启用。

## 安装与使用

### 方式一：在 macOS Velai Desktop 导入本地 `.nmas-plugin`
1. 从本仓库 `dist/` 目录或 [Releases](https://github.com/xunzhimeng/velai-desktop-plugins/releases) 获取任意 `<plugin_id>.nmas-plugin` 文件。
2. 在 **Velai Desktop → 插件管理** 中导入插件包，核对权限/网络/密钥槽/AI 额度声明后确认安装并启用。
3. 使用 `project` 作用域文件类插件（`novel-studio`、`code-audit-warroom`、`product-studio`、`api-arch-studio`）或流式 AI 插件（`novel-ai-writer`、`stock-ai-copilot`）时，请在已绑定本机工作目录的项目中打开 Workspace 页面；其中流式 AI 插件每次生成将由宿主 UI 弹出单次付费确认。

### 方式二：配置 GitHub 更新源
- 来源类型：`github`
- 仓库位置：`xunzhimeng/velai-desktop-plugins`

## 本地构建与 V2 契约校验

要求 Node.js >= 20（零外部依赖）：

```bash
# 打包全部 13 个 V2 插件到 dist/ 并生成 catalog.json
npm run build

# 运行完整 V2 契约校验（Archive / Schema v2 / macOS 准入 / 串行 Broker 沙箱）与功能测试
npm run verify

# CI 同款一键全检
npm run check
```

## 许可协议

MIT License
