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
