# B4-L4 只读查询经 daemon

上级状态见 [b4-l4](b4-l4.md)；路由见 [P3-ipc-matrix](../P3-ipc-matrix.md)。本段不改路由，`scripts/daemon-ipc-routing.json` 未动。

## 已迁移（本机 op，均 `read: true`）

| channel | op:method | daemon 侧数据来源 |
|---|---|---|
| `agent:usageStats` | `usage:usageStats` | daemon 的 userData 下 usage JSONL |
| `agent:usageAnalytics` / `agent:usageCredits` / `agent:stats` | `usage:*` | daemon 打开的 SQLite 账本；Credit 投影读原生 transcript |
| `agent:llmPerformanceHistory` | `llmPerformance:llmPerformanceHistory` | daemon 的 usage JSONL |
| `agent:llmPerformanceSummary` | `llmPerformance:llmPerformanceSummary` | daemon 自己的 run 登记表（开关打开时 run 在 daemon） |
| `agent:gitDiff` / `gitDiffSnapshot` / `gitDiffCommits` / `gitCommitDiffSnapshot` | `workspaceDiff:*` | 每次经 daemon 的 `resolveKnownProjectDirectory` 授权后读 git |
| `agent:listSkills` | `skills:listSkills` | daemon 的 Provider registry，在该 Provider 的操作队列内读取 |

一份实现：`src/main/bootstrap/query-channels.ts` 导出 `usageChannelHandlers`、`llmPerformanceChannelHandlers`、`workspaceDiffChannelHandlers`、`skillChannelHandlers`，不含 Electron 值（userData 与 run 列表由调用方传入）。main 用 `registerChannelHandlers` 注册（原 `index.ts` 的 `agent:usageStats`、`agent-runtime-ipc.ts` 的用量/LLM 性能/diff、`provider-handlers.ts` 的 `agent:listSkills` 内联实现已删除），daemon 用同一组工厂在 `src/daemon/local-ops/queries.ts` 构造本机 op 表。main 的行为保持不变：参数、范围校验（`分析时间范围无效`）、`cwd ?? ''` 过滤语义、diff 的进行中请求共享与授权顺序都在同一份代码里。

缺失保持显式：没有 usage 记录时 totals 为 `null`，不是 0；SQLite 不可用时 `status: 'unavailable'`；Provider 没有 Skill 读取接口时回答 `state: 'unsupported', data: null` 的 envelope，不是空数组。

## 仍拒绝（`daemon_capability_unavailable:<channel>`）

| channel | 原因 | 需要的决定 |
|---|---|---|
| `agent:recorderContentPage` | 授权依据是本窗口当前工作区（main 的 `currentCwd`，由 `agent:setCwd` 设置，只留在 App 进程）。renderer 请求里没有 cwd，daemon 不知道这个选择，无法授权读取；daemon 的 `currentCwd` 恒为空，直接迁移只会一律回答 `recorder_workspace_unavailable` | 二选一：闸门支持本机 op 由 App 追加参数（App 附上当前 cwd，daemon 用 `resolveKnownProjectDirectory` 重验），或改 renderer 合同让请求自带 cwd。闸门逻辑不属于本组 |
| `agent:listCommands`（forward `commands`） | daemon 的宿主确实接了 `commands`（`host-runtime.ts` 的 `listCommands`）。但这个 op 给设备的是清洗后的 `{ commands, reason }`：丢掉 main 返回的 `CapabilityEnvelope`（`state`/`mode`/`observedAt`），把 `data: null` 变成 `[]`（不可用会显示成「没有命令」），按 `MAX_COMMANDS` 截断、去重、截断描述；要求非空 cwd 并按远程项目根授权，而 main 允许不带 cwd 的上下文。直接转发违反「unavailable ≠ 空」 | 矩阵已记「按 scope 选策略」：需要 `commands` op 对 `scope: local` 回答完整 envelope（改远程宿主的 catalog/gateway/host-runtime，属设备协议），或把该行改为 new-op 并复用 `skillChannelHandlers` 同样的写法 |

## 测试（先失败，再做控制实验）

| 测试 | 断言 |
|---|---|
| `src/daemon/host-process-queries.test.ts`（真实 daemon、本机 socket、临时 userData/workspace） | usage 来自 daemon 的 userData，与 `readUsageStats` 同形；别的工作区 totals 为 null；省略 context（`absent`）读全部；`stats` 与进程内 `statsQuery()` 一致；范围校验在 daemon 执行；LLM 历史读 daemon 的文件，摘要来自 daemon 的 run 表；git diff、快照、提交页、单提交快照与 main 的同一工厂结果一致；未授权目录与无效 scope 被拒；Skill 不可用时是显式 envelope |
| `src/main/bootstrap/query-channels.test.ts` | 各工厂的过滤、逐次读取 userData、范围校验先于账本查询、`stats` 不接收 renderer 参数、diff 授权先于 git、Skill 在 Provider 队列内；main 的 `registerAgentRuntimeHandlers` / `registerProviderHandlers` 注册的正是这些表 |

首次运行：表未接入时 daemon 测试 4 条全部失败（本机 op 未提供，`result` 为空）；工厂不存在时两份测试都因模块缺失失败。控制实验：daemon 的 diff 授权换成 `(cwd) => cwd` → 未授权目录用例失败；daemon 的 usage 读另一个 userData → usage 用例失败；工厂去掉 `cwd ?? ''`、去掉 Provider 队列 → 对应两条单测失败。恢复后全部通过。

## 门禁（Linux 容器，root）

- `npm run typecheck` 通过。
- `npx vitest run src/daemon src/main scripts/daemon-ipc-matrix.test.ts scripts/performance-feedback.test.ts`：3227 passed / 2 failed / 3 skipped；两条失败是 root 下既有的不可读目录用例（`db-outbox`、`desktop-directory-picker`）。
- 改了 `performance-paths.json` 列出的 `src/main/index.ts`（只删一段注册），`npm run performance:measure`：无 `worse`，Ratchet passed；`analytics.sqlite/*` 在本容器 Electron 下因 better-sqlite3 ABI 不匹配记为 unavailable（环境原因，与本改动无关）。
- 未做：真实 App 在开关打开时的渲染层验证。
