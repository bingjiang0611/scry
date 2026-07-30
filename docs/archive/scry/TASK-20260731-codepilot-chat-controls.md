# TASK-20260731-codepilot-chat-controls — 对齐 CodePilot 聊天壳与运行控制

> 本文档由 vibe-workflow 自动生成和维护，记录任务从摄入到交付的全过程。

## 基本信息

| 字段 | 值 |
|------|-----|
| 任务 | 现有 UI 与交互设计对齐 CodePilot；把 Skill/MCP 移到右上角；增加模型、effort 与权限选择 |
| 项目 | scry |
| 级别 | full |
| 开始时间 | 2026-07-31 00:09 CST |
| 状态 | 已完成 |

## 已否决方案与理由（持续追加，跨 Phase 不清空）

> 任何“考虑过但否决”的技术选择都记在这里，重点记录为什么否决。

| # | 否决的方案 | 为什么否决（实测 / 约束 / 事故 / 成本） | 记录于 | 日期 |
|---|-----------|----------------------------------------|--------|------|
| 1 | 静态硬编码模型列表 | Provider 目录会变化，且 effort 能力绑定具体模型；静态表会过期并制造错误选择 | P2 | 2026-07-31 |
| 2 | 只加 renderer 选择器，不改 Provider run request | UI 与真实运行状态分叉，权限仍会固定 bypass | P2 | 2026-07-31 |
| 3 | 为运行选择迁移 session store | 逐轮请求已能完整下发，权威结果已有 trace；迁移超出本次目标 | P2 | 2026-07-31 |
| 4 | 默认权限继续映射 full access | 标签与真实风险语义相反，会把高风险状态伪装成默认审批 | P2 | 2026-07-31 |

## Phase 1 · 理解

### Prior Art Check

- 既有 Skill/MCP 状态 owner：`src/renderer/hooks/useIntegrations.ts`；弹窗 owner：`src/renderer/App.tsx`。
- 既有入口只在 `src/renderer/components/Sidebar.tsx` 左下角；右上 chrome 在
  `src/renderer/components/ViewChrome.tsx`。
- 既有 composer 位于 `src/renderer/components/ChatView.tsx`，Agent/backend picker 位于
  `src/renderer/components/Pickers.tsx`。
- `AgentStartRequest`、`ProviderRunRequest` 尚未承载 model / effort / permission；四个 Provider
  adapter 都没有接收 UI 运行控制。
- 当前 Claude/Qoder 固定 `bypassPermissions`，Codex 固定
  `approvalPolicy=never + sandbox=danger-full-access`，不是可选择状态。

结论：本任务是搬迁并扩展既有链路，不新建第二套 Skill/MCP 或旁路运行器。

### CodePilot 0.62 对照

- CodePilot 原实现的 Skill/MCP 实际仍由左侧“插件”入口进入；用户要求 Scry 放到右上角是明确偏离，
  以用户指令为准。
- 模型和 effort 位于 composer 内；effort 仅在所选模型声明支持时显示。
- 权限位于 composer 下方，核心档位为默认审批、自动审查、完全访问。
- 参考 commit：`bd59856366320ed600a6de286c0f69ceee5cbda9`。

### Provider 原生能力

| Provider | 模型目录 | effort | 权限 |
|---|---|---|---|
| Claude | Agent SDK `supportedModels()` | 模型返回支持档位；运行参数 `effort` | 默认审批 / `auto` / `bypassPermissions`；可用现有用户问答通道承接审批 |
| Codex | app-server `model/list` | `supportedReasoningEfforts`；`turn/start.effort` | app-server 原生 approval reviewer / sandbox；默认审批需补 server request 响应 |
| Qoder | SDK `getAvailableModels()` | 模型返回 `efforts/defaultEffort`；用 model policy parameters 下发 | 默认 / `auto` / `bypassPermissions` |
| OpenCode | `v2.model.list()` | 模型 `variants` | session permission rules + permission reply |

### Explore agent 原始结论与采纳情况

| Explore | 原始结论 | 采纳 / 修正 |
|---|---|---|
| UI 热路 | 状态 owner 为 `useIntegrations`；搬位改 Sidebar/ViewChrome/App；composer 热路为 ChatView→Pickers；测试在 `render.test.tsx` | 全部采纳 |
| Provider 链路 | shared request 与四个 adapter 都缺三项字段；四端原生目录/控制接口均可用 | 全部采纳；不扩展 app-store，选择按 Provider 保持在 renderer，发送时逐轮显式下发 |
| CodePilot | Skill/MCP 不在右上；模型/effort 在 composer 内，权限在下方 | 全部采纳；Skill/MCP 右移按用户明确指令覆盖蓝本 |

### 充分性闸门

- [x] 现有 UI owner、状态 owner、提交热路
- [x] 四 Provider 的真实模型 / effort / 权限能力
- [x] CodePilot 0.62 精确组件位置与交互层级
- [x] 权限默认档位所需的用户审批闭环
- [x] 受影响测试与 Scry L1/L2/L3 验证 profile
- [x] 响应式边界（1024px 与右栏折叠）

Phase 1 通过，无待补信息。

## Phase 2 · 方案

- **方案类型**: RFC
- **方案文件**: `docs/rfc/scry/codepilot-chat-controls.md`
- **关键决策**: 原生动态 catalog；结构化 model ref；权限三档按 Provider 支持矩阵映射；
  复用 inline 问答并由 adapter 翻译原生响应；排队项保存完整运行快照。
- **Critic 结果**: 6 个漏洞；采纳 5，纠偏 1（broker 无需承载原生 id，但 adapter 必须保留并翻译）。
- **开放问题**: 无。

## Phase 3 · 代码 & CR 循环

- **实现链路**: `AgentStartRequest` → ProviderRegistry → 四个原生 Provider adapter → IPC/preload →
  `useIntegrations` → composer；权威选择随每轮请求显式下发，并写入 `runtime:controls` trace。
- **Provider**:
  - Claude：原生 `supportedModels()`，model/effort 与 default/auto/bypass 权限映射。
  - Codex：app-server `model/list`、reasoning effort、三档 approval/sandbox，并补 server request 审批回复。
  - Qoder：原生 `getAvailableModels()`、model policy effort、三档权限。
  - OpenCode：`v2.model.list()`、结构化 provider/model、variant、session permission rules，
    同时兼容 `permission.asked` 与 `permission.v2.asked`。
- **Renderer**: Skill/MCP 从 Sidebar 左下迁至 ViewChrome 右上；composer 改为单一圆角输入壳，
  model/effort 在壳内，Agent/权限在壳下；运行中锁定选择器。
- **队列**: 每个排队项深拷贝完整 run request，FIFO 出队时使用原快照，不读取当前 UI。
- **降级**: `SCRY_RUN_CONTROLS=0` 恢复升级前 full-access 行为；旧 preload 缺 API 时只展示
  full-access 兼容态，不伪造可用控制。
- **CR Round 1（协议）**: 修复 Codex app-server request mock/响应闭环；补 OpenCode v2 权限事件、
  stop 时中断审批、slash command 的 model/variant 下发；修正文案“取消提问”→“拒绝操作”。
- **CR Round 2（状态/UI）**: Provider 切换时同步进入 loading catalog，避免旧 Provider 模型短暂串入；
  catalog 变化清除失效 model/effort；OpenCode 模型标签增加 provider 消歧。
- **廉价 oracle**:
  - Node 22.22.1 `typecheck` 通过。
  - 9 个改动面测试文件 194/194 通过。
  - 全量测试在沙箱内仅 6 个 `/private/tmp` socket 用例因 EPERM 失败；同命令在允许 socket
    的环境重跑后 60 files / 646 tests 通过，3 个既有 real/integration 用例按配置 skip。
  - `git diff --check` 通过。

## Phase 4 · 验证

- **L1 静态 oracle（Node 22.22.1）**:
  - `npm run typecheck`：通过。
  - `npm test`：60 files / 646 tests 通过；3 个既有 real/integration 测试按配置 skip。
  - `npm run build`：main/preload/renderer/CLI 全部构建通过。
  - `git diff --check`：通过。
- **L2 真实 Electron smoke**:
  - `npm run dev -- --remoteDebuggingPort 9444` 成功启动真实 Electron，CDP target 为 `Scry`，
    preload 中 `start/stop/activeRun/.../runControls` 全部存在，页面无 ErrorBoundary。
  - 验收结束后停止本次 Electron 与专用 browser-harness daemon，9444 已关闭。
- **L3 受影响用户路径（Browser/CDP runtime probe）**:
  - 从侧栏点击已有 Codex 会话；确认左下 Skill/MCP footer 不再存在，右上顺序为
    `技能 / MCP / 文件 / 面板`。
  - 真实加载 Claude/Codex/Qoder/OpenCode 四端原生模型目录；Codex/Qoder/Claude 显示三档权限，
    OpenCode 只显示其真实支持的默认审批/完全访问。
  - 选择 Codex `GPT-5.6-Sol` 后出现原生 effort 档位；切换至 `Ultra` 与完全访问时 state 和 danger
    视觉态同步，随后复位默认审批。
  - Skill 弹窗从新入口打开；MCP 弹窗也能打开，并诚实展示本机 Codex
    `mcpServerStatus/list` timeout 降级原因。
  - 1440px 三栏与 1024px 响应式两档均满足 `scrollWidth === clientWidth`；无页面、顶栏或 composer
    横向溢出。
  - 视觉复核时发现 Claude 多个 alias 的 displayName 重名，已改为仅在重名时追加 model id；
    发现 Skill pill 被压成竖排，已补 `nowrap` 并复拍通过。
- **真实桌面窗口操作边界**: Electron 窗口已真实启动；Computer Use 因 macOS 处于锁屏态而无法执行
  物理鼠标/焦点操作，未绕过锁屏。上述点击为该真实 Electron renderer 的 CDP 输入，不冒充
  Computer Use 证据。
- **四 Provider regression 边界**: 按 `scry-provider-regression` 的模式门禁，本次只做无模型
  catalog/preload preflight；用户未明确授权 4 家 × 10 轮及真实 Provider 配置 backup/sanitize，
  因此未启动昂贵完整协议，也未用 UI 选择器发真实模型 turn。

## 交付摘要

- **最终状态**: 已完成
- **完成时间**: 2026-07-31 01:15 CST
- **Commit**: 本文所在交付提交
- **总耗时**: 约 1 小时 6 分钟

## 复盘

- **最浪费时间**: 待用户回顾；执行侧主要耗时为四端首次 native catalog 冷启动与真实 UI 视觉复查。
- **无用的子 agent**: 待用户回顾。
- **晋升的教训**: 本轮未新增 hook；“模型 displayName 必须检测重名并消歧”暂留项目实现与回归测试，
  尚不满足“出过多次事故”的升 hook 条件。
