# TASK-20260731 · Qoder / 四 Agent 会话数据一致性

## 基本信息

- 项目：Scry
- 级别：full
- 分支：`codex/fix-qoder-four-agent-parity`
- 工作树：`/private/tmp/scry-qoder-parity.uJGNDd`
- 用户目标：按优先级修复 Qoder 与 Scry CLI 除 token 外的数据不一致，并保证 Claude Code、Codex、Qoder、opencode 四端兼容。
- 非目标：伪造 Provider 未上报的 token；为单个样本硬编码；重做 Overview 信息架构。

## 已确认现象与根因

1. Qoder 同一个 `UserPromptSubmit` 经项目直连 hook 与全局 bridge 投递两次。两份 payload 因 bridge 包装而哈希不同，recorder 又不识别 Qoder `promptId`，因此误切成 interrupted + completed 两轮。
2. Qoder compact 后，通用 transcript parser 把 compact summary 当成新 user turn；无法按原始 slash prompt 精确匹配时又回退到最后一轮，导致 CLI 的 user/assistant 内容与 App 不一致。
3. Qoder 工具失败信息主要位于外层 `toolUseResult.isError/exitCode`，归一化遗漏；renderer 又把同一失败结果合并到共享 ID 的 hook 事件，导致截图时 Header `err 13`、Overview 1、CLI 快照 3。该 native turn 后续继续执行；完整 root + subagent 证据的最终普通工具失败真值为 6。
4. Codex 已有 managed canonical commit；Qoder 仍走 App archive 与 CLI lifecycle/transcript 两条独立证据路径，因此 compact、详情保真度和统计口径会继续漂移。

## 已否决方案与理由（append-only）

- 否决：只改 UI 数字。理由：底层轮次、消息选择和证据来源仍错，属于遮掩数据问题。
- 否决：仅按 prompt 文本去重。理由：用户可能合法地连续发送完全相同的 prompt，会吞掉真实轮次；必须优先使用 Provider 原生 turn/prompt identity，并限制时间/状态窗口。
- 否决：另起一套 Qoder 专用统计栈。理由：会扩大四端分叉；应扩展现有 canonical/evidence 抽象，并让非 Qoder provider 保持现有合同。
- 否决：把 compact summary 永久排除为普通消息。理由：summary 是证据的一部分；正确做法是识别 compact 边界并把其后 continuation 归入原生 turn，而不是删除证据。
- 否决：没有实测就宣称四端完全兼容。理由：至少需要 shared contract、quick 及真实 runtime 分层验证；未跑的昂贵 full regression 必须明确披露。

## Phase 0 · Intake

- 2026-07-31：完成截图、目标 Qoder session、App archive、CLI records、Qoder transcript/log 的交叉核对。
- 2026-07-31：确认 token 暂不在本任务内；优先级为轮次/compact/error → canonical evidence → 四端回归。
- 2026-07-31：发现主工作树存在用户的 UI 改动，创建独立 worktree 隔离本任务。

## Phase 1 · 理解

- 状态：完成。
- managed canonical 链路：`Provider adapter → index.ts buildTraceArchiveTurn → managed-turn-commit.ts → turn-recorder/managed.ts → archive + CLI record`；当前仅 Codex 接入。
- Qoder 权威身份：session 使用 SDK `session_id`；turn 使用 transcript `promptId` 或同一 Qoder 进程日志里的 `turn=`。消息 `uuid` 只是单条消息身份，不能代替 turn identity。
- 四端边界：Codex 保持既有 managed 路径；Qoder扩展相同协议；Claude Code/opencode 继续既有 recorder 路径，不改变公开记录 schema。
- 充分性闸门：
  - [x] 用户可见正确性：一条 Qoder native turn 只生成一轮，compact 前后仍属于同一轮。
  - [x] 数据口径：App/CLI 共享同一 `TurnEvidence`；错误只统计失败 `tool_result`。
  - [x] 身份与恢复：明确 session/turn key、重复 start、pending journal 与强停边界。
  - [x] 兼容面：四 provider 的改变/不改变范围及 quick/runtime 验证入口均已定位。
  - [x] 老数据策略：不改写历史记录；修复作用于新会话，旧 archive 仍可读取。

## Phase 2 · 方案

- 状态：完成。
- 方案类型：gap-analysis。
- 方案文件：`docs/rfc/scry/qoder-four-agent-parity-gap.md`。
- 关键决策：Qoder 接入 Codex 的既有 canonical 协议，同时保留 legacy recorder 的 identity/compact 防御；Claude/opencode 不迁移。
- Critic 结果：5 个漏洞，采纳 5，驳回 0。
  - 非 completed 缺 assistant/result timing 会残留 pending：采纳，放宽非 completed assistant，并使用共享 App 观测边界 timing。
  - SDK/log turn ID 来源不唯一：采纳，SDK `promptId` 优先，日志只接受唯一 root candidate。
  - Qoder provider failure 被记为 completed：采纳，显式回传 status。
  - recovery 未按 provider 过滤：采纳，三层恢复均加入 provider scope。
  - recorder 关闭时无条件校验 CLI：采纳，只在 enablement 开启时注入 managed env。
- 开放问题：无阻塞项；历史 session 不自动迁移，40 轮昂贵长回归另过配置 checkpoint。

## Phase 3 · 代码

- 状态：完成。
- Scry：
  - Qoder direct hook 与 bridge payload 统一按原生 `promptId` 识别，同一 native turn 不再被拆轮；相同文本但不同 ID 仍保留为独立轮次。
  - Qoder 标准 hook 未暴露 promptId 时，managed lifecycle 先建立并去重唯一 provisional open；运行结束后只从 root SDK prompt 日志绑定唯一 native ID，不把 hook 的 session turn 当作 promptId。
  - transcript parser 按 `providerTurnId` 优先选轮，并把 compact summary 后的 continuation 归回原轮；slash command envelope 可与原始 prompt hash 匹配。
  - Qoder `toolUseResult.isError/exitCode` 进入普通工具错误口径；renderer 只把 result 合并到 tool/skill/agent，Header 与 Overview 共用普通 `tool_result` selector。
  - managed canonical provider 从 Codex 扩为 `codex | qoder`；恢复按 provider 隔离，Qoder 只有在 recorder 真正启用时才进入 strict managed 路径。
  - Qoder adapter 回传唯一 native turn ID 与 `completed | failed | interrupted`；仅 Qoder 非完成态允许缺少 assistant/result timing，并复用 App 观测边界，避免永久 pending；Codex 原有严格语义不放宽。
  - Qoder stream/close 异常先保留原始 terminal error，再完成日志身份提取后原样抛出；失败和中断路径也不会因提前 rethrow 丢失 native turn ID。
  - CLI 版本升至 `0.2.9`，README 与 release contract 同步。
- rate-native：
  - managed Stop uploader 按 `SCRY_PROVIDER_ID` 扫描对应 provider runtime；缺省仍为 Codex，保持旧调用兼容。
  - adapter generator 给 Codex/Qoder 异步 uploader 分别注入 provider ID，并同步生成 `.codex/hooks.json`、`.qoder/settings.json`。
  - durable async job 保存 CLI path/provider/managed/upload-session 四个身份变量的存在与缺失，worker 执行时恢复或清除，避免复用其他 provider worker 环境。
  - telemetry contract 明确 managed canonical 同时覆盖 Scry 启动且具权威 turn identity 的 Codex/Qoder。
- 测试策略：Scry 先补定向回归测试再实现；rate-native 遵守仓库“禁止 Agent 新写单元测试”约束，只运行既有测试与临时只读行为探针。

## Phase 4 · 验证与交付

- 状态：完成到 L2；L3 四端真实调用受当前 opencode 环境阻塞，未宣称通过。

### 交付提交

- Scry 实现与 RFC：`2b1e9fc`（`codex/fix-qoder-four-agent-parity`）。
- rate-native 适配器：`ffcc909`（`codex/fix-scry-qoder-managed-uploader`）。

### Scry L1

- `npm test`：Test Files 60 passed / 3 skipped；Tests 668 passed / 3 skipped（671 total）。
- `npm run typecheck`：通过。
- `npm run build`：CLI、main、preload、renderer 全部通过。
- `npm run check:cli-release`：15 files、164 tests 全部通过，`build:cli` 通过。
- `git diff --check`：通过。
- 最终 tarball：`ali-scry-turn-recorder-0.2.9.tgz` 可安装，隔离 prefix 中 `scry --version` 为 `0.2.9`。

### 目标 Qoder 证据重放

- session：`af998d16-817c-4836-a87f-cffc6b4d10ab`。
- native turn：`f866b334-e73c-4f98-90d5-12c2f685fd3f`。
- 修复后 root transcript 重放仍为同一个 native turn；错误证据为 root 5 个外层 `toolUseResult` 失败，加 subagent 1 个显式失败 `tool_result`，完整真值为 6。
- 截图时 CLI 的 3 errors 是当时已落盘且本身漏采的中途快照；该 native turn 后续在 compact 后继续运行。修复目标是 App/CLI 对同一完成边界共享 canonical evidence，不把旧快照的 3 硬编码为最终值。
- 老 archive/record 不自动迁移。新 renderer 重开该旧会话时只会消除 hook 放大，使 Header `13 → 1`；缺失的 outer failures 不会回填，因此旧 App 1 与旧 CLI 3 仍不一致。新会话走 canonical 后才会在同一完成边界统一（本样本完整真值为 6）。

### rate-native / 四端合同验证

- `agent-adapters/scripts/sync.py`：PASS，112 adapter files；只产生预期的 Codex/Qoder uploader 配置变化。
- Python compile、workflow dry-run、dual-id smoke、managed bridge 既有测试（5/5）、recorder smoke、uploader smoke：全部通过。
- 临时行为探针：Qoder pending 可见，Codex 不会读取 Qoder pending；durable worker 可恢复 Qoder CLI path/provider/managed/session 身份，并会清除 job 中明确缺失的四个身份变量。
- `four_agent_validate.py quick --skip-sync`：7 个 quick gate 中 6 通过；唯一失败为 `runtime-smoke` 的 opencode 检查超时。
- 同一 opencode 命令在未修改的 rate-native 主工作树也超时；本机 `opencode 1.17.18` 访问 `models.dev` 同样超时，因此判定为当前环境/外部依赖阻塞，不是本次 provider uploader diff 引入。
- 按 four-agent-validation 闸门，quick 未全绿时不继续 runtime/e2e，所以没有声称四端真实模型调用通过。

### Scry L2

- 使用隔离安装的 CLI `0.2.9` 启动真实 Electron 构建产物。
- CDP 确认页面来自本 worktree 的 `out/renderer/index.html`，窗口标题为 Scry，无 ErrorBoundary、无遗留 active run。
- 四个 provider descriptor 均可发现；未发起付费模型调用。

### 未执行与残余边界

- 未执行 scry-provider-regression 的 40-turn 四 provider 长回归：该流程会备份/改写真实 provider 配置并产生模型成本，skill 明确要求单独 checkpoint，本任务未获得该授权。
- CLI `0.2.9` 仅在隔离 prefix 验证，尚未发布或覆盖用户全局安装；部署新版本后，新 Qoder managed 会话才会使用本次协议。
