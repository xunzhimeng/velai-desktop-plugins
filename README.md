# Velai Desktop 原生插件合集 (`velai-desktop-plugins`)

本仓库包含 **10 个面向 Velai Desktop 原生插件运行时的实用插件**，覆盖日常 AI 协作、项目管理、文档工作流、开发调试与公开只读数据源查询，所有插件均遵循 `nmas-plugin` v1 归档规范与 macOS Seatbelt / QuickJS 沙箱准入策略。

## 插件清单

| # | 插件 ID | 名称 | 展示位置 (Surfaces) | 数据隔离 | Agent Tools | 核心能力 |
|---|---|---|---|---|---|---|
| 1 | `prompt-vault` | 提示词模板库 | `workspace`, `chat`, `assistant` | 账号级 (`account`) | `prompt.list`, `prompt.render` | 分类管理 Prompt、`{{变量}}` 动态填充、一键插入会话输入框、JSON 导入导出 |
| 2 | `project-checklist` | 项目任务清单 | `workspace`, `chat` | 项目级 (`project`) | `checklist.list`, `checklist.add` | 按项目隔离的待办与里程碑看板、优先级与状态流转、达成率统计、JSON 导入导出 |
| 3 | `decision-log` | 项目决策记录 (ADR) | `workspace`, `chat` | 项目级 (`project`) | `decision.list`, `decision.record` | 自动编号 `ADR-NNN` 记录架构背景/结论/权衡、供 AI 检索历史技术决策、JSON 导入导出 |
| 4 | `snippet-box` | 常用片段剪贴箱 | `workspace`, `chat`, `assistant` | 账号级 (`account`) | `snippet.search` | 跨项目收藏常用命令/SQL/话术、一键读入选中回复 (`host.selection.read`) 或填回输入框 |
| 5 | `meeting-minutes` | 会议纪要工作台 | `workspace`, `chat`, `assistant` | 账号级 (`account`) | `minutes.list` | 记录会议速记，通过 `session.turn.request` / `session.turn.result` 交由当前会话提炼纪要并审阅采纳 |
| 6 | `glossary-hub` | 项目术语表 | `workspace`, `chat` | 项目级 (`project`) | `glossary.lookup`, `glossary.upsert` | 维护项目专属缩写、别名与标准定义，减少团队和 AI 理解歧义、JSON 导入导出 |
| 7 | `okr-tracker` | 目标进度追踪器 (OKR) | `workspace`, `chat` | 账号级 (`account`) | `okr.summary` | 管理多周期 Objective 与 KR 进度，自动计算达成率、辅助 AI 生成周报摘要、JSON 导入导出 |
| 8 | `reply-polisher` | 回复改写与格式助手 | `workspace`, `chat`, `assistant` | 无持久化 | — | 读入选中回复、本地清洗（去 Markdown/转要点/引用块）、按指定风格发给当前会话改写并回填 |
| 9 | `json-workbench` | JSON 与结构化数据工坊 | `workspace`, `chat`, `assistant` | 无持久化 | `json.analyze` | 零权限纯本地计算：JSON 美化/压缩/键排序 (Canonical)、路径提取、结构 Diff 对比 |
| 10 | `fx-market-board` | 实时汇率换算看板 | `workspace`, `chat` | 无持久化 | — | 公开只读 HTTPS (`api.frankfurter.dev`) 获取欧央行参考汇率、多币种交叉换算与一键回填 |

> 全部 10 个插件合计声明 **12 个 Agent Tools**（远低于 Velai Desktop 单账号 32 个工具上限），可同时全部启用。

## 安装方式

### 方式一：直接导入 `.nmas-plugin` 文件

1. 从本仓库的 [Releases](https://github.com/xunzhimeng/velai-desktop-plugins/releases) 或 `dist/` 目录下载任意 `<plugin_id>.nmas-plugin` 文件。
2. 在 **Velai Desktop → 插件管理** 中点击导入本地插件包，核对权限声明后确认安装并启用。

### 方式二：配置 GitHub 更新源

本仓库每次正式 Release 均会附带全部 10 个 `<plugin_id>.nmas-plugin` 资产文件。在 Velai Desktop 中为已安装的插件配置更新源：

- 来源类型：`github`
- 仓库位置：`xunzhimeng/velai-desktop-plugins`

## 本地构建与验收

要求 Node.js >= 20（零外部 npm 依赖）：

```bash
# 重新打包全部 10 个插件到 dist/ 并更新 catalog.json
npm run build

# 运行完整契约校验（Archive / Schema / macOS 准入策略）与沙箱功能测试
npm run verify

# 一次性检查 dist/ 归档一致性并执行全部测试（CI 同款命令）
npm run check
```

## 目录结构

```text
velai-desktop-plugins/
├── catalog.json                 # 10 个插件的统一索引与 SHA-256 清单
├── dist/                        # 已打包的 .nmas-plugin 单文件归档
├── plugins/                     # 10 个插件的源码、manifest 与 verify.mjs 测试
│   ├── 01-prompt-vault/
│   ├── 02-project-checklist/
│   ├── 03-decision-log/
│   ├── 04-snippet-box/
│   ├── 05-meeting-minutes/
│   ├── 06-glossary-hub/
│   ├── 07-okr-tracker/
│   ├── 08-reply-polisher/
│   ├── 09-json-workbench/
│   └── 10-fx-market-board/
└── scripts/
    ├── pack-all.mjs             # 统一 canonical JSON 打包与 catalog 生成
    ├── verify-all.mjs           # 批量契约与沙箱验证入口
    └── lib/                     # archive / validator / sandbox 工具库
```

## 许可协议

MIT License
