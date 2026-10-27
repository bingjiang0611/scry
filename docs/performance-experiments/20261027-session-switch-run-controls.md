# 20261027 切换会话不再等 Pi 运行权限探测

## 现象与证据

点击侧边栏会话时，发送框会先显示「默认审批」和「运行权限能力尚未确认，暂不能发送」，约 2 秒后才变成「本机完全访问」。用户把它当作多余的过渡页。

日常记录（快照 `~/scry-performance-archive/20261027-0220`，运行中的 packaged build `bfebcfdf19a125a0dcb85b0239a63939c632f04f9b279e3bf2e6e28b1d0561f7`，App 0.2.226，单会话 5113 条）：

| 路径 | 操作 | p50 | p95 | n |
|---|---|---:|---:|---:|
| providers | `ipc.agent:runControls` | 2074 ms | 4147 ms | 42 |
| providers | `pi.catalog.probe` | 1996 ms | 4146 ms | 46 |
| providers | `pi.catalog.probe · first_response` | 2081 ms（delta） | — | 46 |

`pi.catalog.probe` 的分阶段证据：`environment_ready` 11.5 ms、`spawned` 1.4 ms、`first_response` 2081 ms、四个 RPC 响应 0.5 ms、`closed` 30.6 ms。也就是说这 2 秒几乎全部是 Pi CLI 冷启动，不是 Scry 的解析或 SQL。

## 根因

1. 切换会话通常意味着 cwd 变化，renderer 的按 `provider + profile + cwd` 目录缓存 miss。
2. miss 时 `useIntegrations` 退回 `fallbackRunControlCatalog('default')`：发送框因此先显示占位权限「默认审批」，而 Pi 没有默认审批模式，`runControlSendBlockedReason` 对 Pi 一律 fail closed，于是出现「暂不能发送」。
3. 后台探测 2 秒后返回真实目录，界面才切成「本机完全访问」——这就是用户看到的过渡。

## 改动

- `src/renderer/hooks/integration-model.ts`
  - 新增 `cwdIndependentRunControlCatalog`（目前只有 `pi`）：运行控制目录只有模型、推理强度与权限，Pi 这三项来自 Pi 自身配置（`get_available_models` / `get_available_thinking_levels` / 静态权限），与 cwd 无关；OpenCode 的模型按 `directory` 请求，因此不纳入。
  - 新增 `lastKnownRunControlCatalog`：同一 Provider+Profile 的最后已知目录，标 `state: 'unknown'` 且 reason 保留「最后已知模型目录（读取时间）…正在复核」，与既有“最后已知目录”语义一致。
  - 新增 `resolveRunControlDisplay`：精确上下文缓存 → 跨目录最后已知目录 → 占位目录，三档统一出口，并给出 `persistSelection` 表明本次结果能否回写用户偏好。
- `src/renderer/hooks/useIntegrations.ts`：上下文切换与 Agent 切换都改用 `resolveRunControlDisplay`；跨目录的显示结果不回写偏好，避免把用户保存的权限/模型降级。
- 证据仍然诚实：目录来源与读取时间写在 `reason` 里（模型选择器的“自动”描述会显示），后台复核照常发起并覆盖；从未读过目录的冷启动仍用占位目录并 fail closed。

## 验证

- `npx vitest run src/renderer/hooks/useIntegrations`：6 文件 40 例通过。新增两例：
  - 「切换会话时不把 Pi 的发送界面退回占位权限」：同一 Profile 选最新目录；换 Profile 或 OpenCode 返回 `undefined`；无最后已知目录时仍返回「运行权限能力尚未确认，暂不能发送」。
  - 「切换会话时直接显示最后已知权限与模型，且不以占位选择覆盖已保存偏好」：跨目录显示 `full_access` 且 `runControlSendBlockedReason` 为 `null`；精确上下文 `persistSelection: true`；冷启动仍是占位目录 + 阻断。
- 反证（控制组）：把 `resolveRunControlDisplay` 里的跨目录分支改回 `cached ?? undefined` 后，第二例立即失败；还原后通过。
- `npm run typecheck`（node + web）通过。
- 全量 `npx vitest run` 见提交说明。

## 减少的工作去了哪里

移出关键路径：切换会话不再等待一次 Provider 目录探测（记录 p50 2074 ms / p95 4147 ms）。探测本身仍在后台执行，工作量没有减少，改变的是发送界面的可发送时机。

## 级别与后续

- L1：切换上下文时不再有“等目录”的发送阻断（未新增计数，改用既有 `ipc.agent:runControls` 与 `pi.catalog.probe` 观测；两者耗时不变，符合“移出关键路径”）。
- L2：未测。需要按 `timing-run.mjs` 在真实 App 重放「切换会话到 composer 可发送」；本轮没有独立 test 实例测量窗口。
- L3：待部署后按同场景 ≥30 样本、≥2 会话对比。
- 未解决：同一 Provider+Profile 的首次探测仍是 2 秒（Pi CLI 冷启动）。要做成毫秒级需要常驻/预热 RPC 进程池（架构级，需维护者决定），或放宽“不共享已巩固快照”的规则。
