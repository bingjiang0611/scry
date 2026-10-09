# 点击会话时的 `workspace changed`

## 定位

用户操作：点击侧边栏已有会话，正文变为空状态，composer 报 `agent:loadSession: workspace changed`。

取消点在 `src/main/index.ts` 的 `agent:setCwd`：只有 cwd 真的变化才会中止正在进行的历史读取。这是防串会话保护，不应移除，也不能把取消转换成成功空历史。

只读检查 `/Applications/Scry.app/Contents/Resources/app.asar` 确认：已安装包版本仍为 `0.2.150`，renderer 为 `index-XyWBbn8N.js`，包含以下旧逻辑：

- 启动恢复 effect 依赖 `integrations.setSelectedId`；该回调随 Provider 选择变化而换 identity，触发恢复重新执行。
- `activeRun()` 返回时只检查 `cancelled`，没有检查用户是否已作出更新的会话选择。
- 旧 run 的恢复会调用 `setCwd(oldRun.cwd)`，可在新会话历史读取期间把工作区切回旧目录，进而触发主进程取消。
- `useAgentSession` 的启动快照也没有 selection generation 检查，可能把旧 live run 合并回已切换的正文。

仓库已有根因修复 `91e8b67`：保持订阅/启动恢复稳定，并分别用 selection sequence、resync generation 拒绝迟到快照。本次复用这项实现，不添加第二套状态、不吞异常、不取消 workspace guard。**根包 version 相同不代表已安装产物包含这个提交。**

## 本次补充验收

复用完整生产 `App` + 隔离 bridge 的 Electron fixture，在临时 HOME/userData 中通过 `sendInputEvent` 点击真实侧边栏控件：

1. `late-startup-loading`：目标历史保持 pending，先交付旧启动快照。目标 cwd 必须保持不变、取消数为 0；随后交付历史并验证正文和反向切换。
2. `rapid-switch`：新 → 旧 → 新，前两次历史读取仍 pending。必须实际取消两次旧读取，最终正文属于最新选择，不显示过期请求的 `workspace changed`；再验证反向切换。

首次运行通过。随后故意去掉 `canRestoreInitialSelection` 的 sequence 比较，新用例明确失败：`cwd=/fixture/old, historyReads=1, cancelledLoads=1`。恢复保护后再次通过。没有修改原有超时、没有自动重试；两个 animation frame 仅用于让已释放的 Promise/React effect 完成，而不是等待 Provider。

另一个并行任务扩展了同一 fixture 的 same-provider 场景和 `--selection-only` 入口；本次保留其改动并在组合工作区验证，但不将这些并行改动纳入本次提交。

## 实际检查

- `node scripts/session-capability-ui-smoke.mjs`：完整既有 UI smoke，加本次两个场景通过（5 个 selection 场景）。
- `node scripts/session-capability-ui-smoke.mjs --selection-only`：组合工作区 6 个 selection 场景通过，包括同 Pi/profile 跨项目切换。
- `npm run test:unit -- src/renderer/session-selection.test.ts src/renderer/components/render.test.tsx src/renderer/hooks/useAgentSession.test.ts`：268 项通过；保留已有 SSR `useLayoutEffect` warning，不以 SSR 代替上述原生输入验证。
- `npm run typecheck`、`npm run build`、`git diff --check`：通过。
- 环境：macOS arm64、Node v24.18.0。没有启动真实 Provider 或写入真实 session/DB。

## 交付范围

本次只提交新增时序回归和本报告；生产修复来自既有 `91e8b67`。安装包只读检查与隔离 Electron UI fixture，不等于当前完整 App/main/preload 的真实多 run 验收。未重启正在使用的安装 App，未跑完整发布门禁，未打包安装、未推送；旧安装版本仍可能触发原问题，源码修复需进入新安装产物才能生效。

## D-20261009-latest-turn-on-reopen

- Scope / status：project:scry / confirmed（需求；真实 Pi 截图时序待重放）。用户反馈“有时间点击进对话是上一次的会话”，两张截图中相同侧栏会话分别显示安装轮与上一轮修复结果。
- 定位：`agent:loadSession` 原先立即读取 archive；Provider 已结束但 Git diff / 归档仍收口时，`runState.done=true` 而 registry 的 `control.settled` 尚未完成。非 canonical lifecycle 可以提前发 turnDone，重新打开会得到只有上一轮的成功快照。只读解析目标会话两份 archive 的 runId / userText / ts，确认安装轮最终已持久化；不是整段 transcript 阅读，也未证明截图当时的精确先后关系。
- Applied：`src/main/index.ts` 按 Provider/profile/cwd/native session 身份筛选 run；`readSessionHistoryAfterCompletedRuns` 复用 `waitForCompletedRuns`，在已结束轮次收口后才读 archive。仍在运行的轮次不阻塞历史读取；等待期间切走则按原 AbortSignal 拒绝，不交付空的成功历史。不改变 Renderer、trust、录制策略或侧栏样式。
- 回归：临时 userData 的真实 archive 先有 A，B 的持久化被 deferred Promise 控制。未等待的旧读取行为明确触发两条失败：过早读取、切走后返回旧历史；加入 barrier 后三条测试通过，验证 A+B 的最新轮、运行中不阻塞及取消。
- 验证：Node 24 组合工作区与 Node 22 隔离源码分别通过 338 个 focused 测试；7 个原生输入 selection 场景通过；typecheck、build / build:cli、packaged resource/security checks 通过。包含改动的真实隔离 App 使用已有 Codex smoke adapter，经生产 IPC 连续两轮并重新打开两次，`historyReload.sameSession/firstLatest/reopenedLatest/bothTurns=true`。所有写入仅在临时 workspace/HOME/userData；没有启动真实 Provider。
- 首轮失败：隔离 Node 22 检查中一个既有 Git 重锚 fixture 返回空文件列表（337/338 通过），本次不改它的断言、超时或实现。确认测试进程已结束，临时诊断显示定向运行 baseline=ready、snapshot=captured；移除诊断后原样完整 focused 重跑 338/338 通过。首次失败原因未证实，不能以重跑抹掉；无生产自动重试。
- 产物范围：验证用 App 标记为 `0.2.154`，源码为 `ffc511b` 加本次冻结 patch；不是之前已安装的同版本产物。尚未安装此修复、未重启用户 App，未执行真实 Pi 的原始时序或归档失败验收；不把本轮 mock Provider App 验证称作 L3。
- Next use / revisit：完成后立即切走再打开 → 等待该会话的终态归档收口 → 最新成功发布轮次必须保留。若包含修复的新产物仍复现且最新 archive 在点击前已存在，则继续核对 Renderer 快照覆盖与归档顺序，不添加盲目重试。需求已确认，成品仍待用户验收。

## D-20261009-new-conversation-draft

- Scope / status：project:scry / confirmed（需求；已安装 App 验收待执行）。用户反馈“点击新建会话，输入了一些东西，切到其他会话就丢失了”。
- 根因 / rule：已有 `sessionComposerDraftKey` 将新会话草稿绑定 workspace，切换本身不会删除；再次点击新建时 `newConversation` 主动 delete 该 pending 草稿。新建入口应恢复同项目尚未发送的输入，而不是暗中丢弃；既有会话草稿与其他项目草稿继续隔离。
- Applied：`src/renderer/App.tsx` 删除 pending draft 的清空/释放操作，直接复用现有草稿 map、LRU、持久化与焦点行为。保留 pending 发送队列清空、Provider session reset 和 selection generation，不因恢复文本自动发送旧任务；不新增草稿列表、合成 session ID 或配置。
- 边界：仍是每 workspace 一份新会话草稿；既有全局最多 8 份 composer draft / LRU 淘汰规则不变。本轮修的是正常会话切换造成的主动删除，不承诺无限保留；若需要超过该上限，另按明确需求检查内存/存储预算后扩容，不添加隐藏备份状态。
- 回归：完整生产 `App` + 隔离 bridge，通过 native mouse / insertText 输入两行文本并执行 新建 A → 已有 A → 新建 A → 再次新建 → 项目 B → 新建 B → A/B 来回。旧删除逻辑在第 2 次新建明确丢失草稿（historyReads=1, newSessions=2）；修复后 A/B pending 与已有会话草稿都恢复，`starts=0`。
- 验证：274 个 focused unit / render 测试、完整 `npm run test:renderer:ui`（包含 8 个 selection 场景、Credits、preview / IME / 附件既有路径、background）、typecheck、build 与 diff-check 通过。Node 24 / macOS arm64；在当前组合工作区验证，仅提交本任务 renderer / fixture / 文档改动，不混入并行 iOS/remote WIP。
- 测试调试：首次新 fixture 使用了不存在的 aria/class selector，按实际 Sidebar / ChatView 控件修正；随后旧生产逻辑的草稿丢失被准确复现。修改生产逻辑后的一个 immediate focus 检查未等待 native dispatch，改为已有 frame 条件等待并显式 focus fixture contents，未删 focus 断言、未增加超时。无生产重试或固定 sleep。
- Acceptance / next use：隔离 Electron 证明文本选择路径；尚未安装/重启、未在用户真实 App 或带附件草稿上重放。输入未发送草稿后切走再返回新建 → 同 workspace 文本保持可编辑，历史 session / 其他 workspace 不串稿，恢复不触发 Provider start。需求确认不等于成品已获用户验收。

## D-20261009-first-click-live-evidence

- Scope / status：project:scry / confirmed（需求；原截图具体时序未证实）。用户截图选中 Pi 会话“优化scry ios的ui和…”却显示“这条会话没有可读的本机证据”，再次点击才出现内容。只读核对该 catalog 身份；没有把 catalog 元数据当作完整 transcript 或截图时序证据。
- 根因路径 / rule：`pickSession` 将 Sidebar 缓存的 `running=false` 当成权威结果跳过 `activeRuns`，或直接优先使用旧 `knownRunId`。因此真实实时内容可能被漏读，未完成归档的会话被报 unavailable。缓存活动标志只供展示；实际选择必须查询 main registry，并优先匹配当前 Provider/profile/cwd/session 的 run。
- Applied：`src/renderer/App.tsx` 复用 `activeRunForSession` 做一次权威查找，旧 runId 仅保留身份 hint；`Sidebar.tsx` 不再把 cached running 标志传入读取控制。`onHistoryLoaded` 携带已采用的 live 快照，有非空输入/事件时不将未归档标为无本机证据；空 live 占位仍保留缺失状态。selection generation、in-flight 重选保护、失败/取消拒绝及权限语义不变，无自动重试或 Provider start。
- 关键回归：完整生产 App + 隔离 bridge，bootstrap 后在 fake registry 增加 Pi run，但不广播 start/focus。侧栏仍显示未运行，archive 返回 null。旧逻辑第一次点击准确复现截图的 unavailable 页面，historyReads=1、adoptedRuns=[]；修复后一次点击显示实际 live 回复。相邻场景让 Sidebar 仍标记旧 run 为运行中且旧 archive 只有历史，验证优先采用当前 run 而非旧 hint。两场景都限定一次 registry 查找/历史读取、仅采用当前 run、无重新 bootstrap、starts=0。
- 终态邻接：只读安装包 `app.asar` 确认其 loadSession 尚未包含上轮 terminal barrier。本轮为已有 `readSessionHistoryAfterCompletedRuns` 补无 prior archive 的临时目录场景：首次归档尚未发布时不提前读成 null，待 settled 后得到最新轮。未修改 main handler 或并行 archive WIP，不以此声称截图必定来自终态 race。
- 验证：Node 24 / macOS arm64 当前组合工作区，295 个 focused 测试、完整 renderer UI（10 个 selection 场景及 Credits / preview / background）、typecheck、build、diff-check 通过。首次新增 unit 漏导入 `vi` 导致两条测试失败及 typecheck 报错，补导入后完整受影响检查通过；没有删断言、skip 或增大超时。保存 `/private/tmp/scry-stale-live-before.log`、`/private/tmp/scry-stale-live-ui-full.log`。
- Acceptance / next use：这是隔离 Electron 的生产 renderer/模拟 bridge 验证，不是已安装 App / 真实 Pi 的端到端证明。未升级、未重启现有任务、未调用真实 Provider。升级后复放 首次选择后台会话 → 尚无 archive 时 live 内容可读；终态归档中保持 loading，不能成功交付假空历史。若仍复现，记录同一身份的实际 registry/归档时间和 selection sequence，再定位，不添加盲目重试。

## 安装交付 · 0.2.155

- 用户明确要求安装；冻结 `afabff7` 加根 App version-only 补丁，隔离 worktree 复制独立 dependencies。包含 `a71084e`（终态归档等待）、`b0ab633`（新会话草稿恢复）、`95eafdd`（首击权威 live 查询）。私有 CLI 仍为 `0.2.47`；构建不混入后续 iOS/remote WIP。
- 完整 Node 22 gate：2422 tests passed / 3 skipped，shell、typecheck、build / build:cli 通过。CLI release checks 在 Node 20.20.2 / 22.22.2 / 24.18.0 各 563 通过，clean tarball smoke 通过；完整 renderer UI（含 10 个 selection 场景及 Credits）、packaged resource/security smoke 通过，隔离真实 App 的两轮 archive reopen / terminal recording 验证通过，未运行真实 Provider 探针。
- 首次失败保留：隔离目录先将 SQLite 重建为 Node ABI 127，复制的 `.forge-meta` 仍声明 Electron，自动 rebuild 跳过，导致 Credits 和首次包内 stats smoke 不可用。标准 `electron-rebuild --force --only better-sqlite3 --version 42.10.1 --arch arm64` 重建为 Electron ABI 146，重打包后原检查通过，无源码/断言变化。宿主旧 Node 20.17.0 有 1 条 OpenCode ESM plugin `node --check` fixture 失败（562/563）；按 CI 的当前 Node 20.20.2 重验全套 563/563，不声称旧环境通过。
- `scripts/install-macos.mjs` 按开发安装流程原子替换 `/Applications/Scry.app`，备份 `/Applications/.Scry.app.backup`。源包与安装后 bundle 的 strict/deep signature 有效（Apple Development，本机开发签名，非 Developer ID 公证发行包）；App `0.2.155`、私有 CLI `0.2.47` 已读回，源/目标 `app.asar` SHA-256 同为 `1d8794e590fe5d5281f783c219ce5b04eaf02a89370437775a8dacb9f7cd9c4b`。
- 原 App PID 53922（2026-10-08 22:20 启动）仍存活，没有退出、重载或重启用户任务；磁盘安装不等于当前进程已更新。等待任务结束后完全退出再打开，激活一致的 main/preload/renderer；原 Pi 截图操作仍待新版本用户验收。
- Evidence：`/private/tmp/scry-install-0.2.155-{gates,pack,artifact-final,install}.log`、`/private/tmp/scry-install-0.2.155-cli-node{20,20-current,24}.log`。首次环境失败与最终成功分别保留；仅提交版本与交付记录，不推送。
