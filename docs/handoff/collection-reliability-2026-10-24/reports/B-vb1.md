## VB1 修改记录

本次基线 `668effb2`，分支 `reliability/collection`；仅处理 VB1 + VB2。V3 与 A 手验已在此前完成并核验，本次未重做。B1 改回 **待核验**，B2 保持已核验；未开始 C 或其他批次。

| 提交 | 内容 |
|---|---|
| `8a29edf3`（原本地 `1c59d93c`） | 先提交失败测试：损坏/不可读 sidecar 的保活判断，以及 doctor 缺少重试说明；另加人工重试的正向合同检查 |
| `aaee8975`（原本地 `d248514a`） | 单独修复保活判断，更新 doctor 提示及 CLI README 的人工重试说明 |

推送前远端新增 `79fe062d`，只修改 uploader 核验文档及其 STATUS 行。已将本次未推送的三个提交 rebase 到该远端；保留其修改，不改写已推送历史。`git diff d248514a HEAD -- src packages/turn-recorder-cli/README.md` 为空，确认验证过的源码、测试和重试说明未变。同步后又重跑 inbox focused（12/12）及 node/web typecheck，均通过；日志为 `/tmp/scry-VB1-after-rebase-focused.log`、`/tmp/scry-VB1-after-rebase-typecheck.log`。

### 采用的方案与边界

采用核验意见允许的第二种方案：**sidecar 读不出来时不自动重试**，不创建新计数、不覆盖损坏内容。`src/core/turn-recorder/inbox.ts` 的 `recorderHasRetryableInbox` 与生产 replay 一样跳过该条目；不是返回整个目录不可重试，后面的有效条目仍可使返回值为 true。

- 原事件和 sidecar 保留原样，仍计入 pendingCount；doctor 的 `turns.pending` 继续 warn，不因 daemon 能退出而把 backlog 显示成健康。
- 已耗尽条目的原有行为不变。不可读 sidecar 不代表已执行了新尝试，因此不新增 droppedEvents。
- `src/cli/scry.ts` 的 remediation 指向 `scry-turn-recorder README: Retry quarantined hooks`；对应说明位于 [CLI README](../../../../packages/turn-recorder-cli/README.md#retry-quarantined-hooks)。没有新增命令。
- 文档要求先退出 Provider、停止 daemon 并确认 running=false，修复原因，备份事件和 sidecar，再**仅删除选中的 sidecar**，执行 recover 并读回结果。不能批量删除，不能覆盖事件或猜造字段。缺少 sidecar 会重新开始最多 5 次尝试；历史 droppedEvents 不会扣减。
- 原事件已损坏且没有权威恢复来源时，应保留证据，不承诺删除 sidecar 后必然成功。重放仍不是严格 FIFO/exactly-once，开始事件成功应用也可能只是打开一轮。
- 不改 replay、fsync、hook fail-open、curl 快路径、commit hook trust/指纹校验、B2 隔离与投递逻辑。升级 CLI 后，已有 daemon 需要 `scry recorder restart`；不需要 integrations repair。

### 当前旧实现上的失败证据

测试使用真实临时目录、生产 recover/锁/持久化与 CLI。JSON 损坏直接写入实际文件；unit 的 EACCES 只对目标 sidecar 的 readFile 注入，避免 root/跨平台权限差异。连续 recover 三次后，同时检查存活判断、pending、doctor、原事件及 sidecar 不变；再加入一个可重试事件，证明没有把整个目录判为不可重试。

```sh
npm run test:unit -- src/core/turn-recorder/recorder-inbox.test.ts
```

`/tmp/scry-VB1-before.log` 原始输出节选：

```text
× recorder inbox failure isolation > VB1: unreadable invalid JSON sidecar stays pending without keeping an idle daemon alive
  → expected true to be false // Object.is equality
× recorder inbox failure isolation > VB1: unreadable EACCES sidecar stays pending without keeping an idle daemon alive
  → expected true to be false // Object.is equality
× recorder inbox failure isolation > exposes quarantine backlog through real CLI status and doctor checks
  → expected [ …(8) ] to deeply equal ArrayContaining{…}

- "remediation": StringContaining "scry-turn-recorder README: Retry quarantined hooks"
+ "remediation": "run `scry recorder recover`; inspect runtime/*/*/inbox-failed for exhausted retries"

Test Files  1 failed (1)
Tests       3 failed | 9 passed (12)
```

另一个新测试在旧实现就通过：达到 5 次失败后，修复注入故障、备份事件与 sidecar、仅删除 sidecar；下一次 recover 成功应用原事件，清理队列文件，droppedEvents 仍为 1。这用于验证 VB2 文档依赖的既有能力，不冒充新增修复。

测试提交前 typecheck 通过；全量仅上述 3 项失败，其余 3934 通过、4 项既有跳过，见 `/tmp/scry-VB1-test-unit.log`。没有删除、跳过或弱化断言，也没有通过重跑掩盖首次失败。

### 修复后验证

环境：macOS arm64、Node v24.18.0、Vitest 3.2.7。自动化夹具均为临时 workspace，没有写日常 `.scry`。

| 检查 | 结果 | 证据 |
|---|---|---|
| inbox focused | 12/12 通过 | `/tmp/scry-VB1-after.log` |
| 10 个相关 focused 文件 | 276/276 通过 | `/tmp/scry-VB1-focused.log` |
| `npm run typecheck` | node / web 通过 | `/tmp/scry-VB1-typecheck.log` |
| `npm run build:cli` | 通过，未安装 | `/tmp/scry-VB1-build.log` |
| 修复提交前 `npm run test:unit` | 3937 通过、4 项既有跳过；325 文件通过 | `/tmp/scry-VB1-unit.log` |
| CLI README 引用与命令核对 | 标题与 remediation 一致；两个命令块 `sh -n` 通过，未在真实工作区执行 | 本次文档核对 |
| `git diff --check` | 通过 | 提交前检查 |

10 个 focused 文件为 recorder-inbox、recorder-recovery-isolation、recorder、daemon、recorder-durability、recorder-terminal-replay、hook-diagnostics，以及 CLI 的 scry、workspace-init、hook-skip-recency。四个既有跳过仍为 performance-correlation、billing-admin-real、p0-integration、p1-integration。未发现需要单列的既有失败。

另用**当前构建产物**运行独立本机探针 `node /tmp/scry-VB1-probe.mjs`，退出 0。该探针无 Vitest mock：在非 root 用户下对真实 sidecar 执行 chmod 000，并先确认 readFile 确实得到 EACCES。两种情况都连续 recover 三次，再启动真实 recorder daemon，等待其 closed，并调用构建后的 CLI doctor。原始输出 `/tmp/scry-VB1-probe.log`：

```jsonl
{"failure":"corrupt","recoverPasses":3,"hasOpenTurn":false,"pendingCount":1,"doctorStatus":"degraded","doctorExit":5,"pendingCheck":"warn","daemonClosed":true,"idleCallbacks":1,"eventPreserved":true,"sidecarPreserved":true}
{"failure":"EACCES","recoverPasses":3,"hasOpenTurn":false,"pendingCount":1,"doctorStatus":"degraded","doctorExit":5,"pendingCheck":"warn","daemonClosed":true,"idleCallbacks":1,"eventPreserved":true,"sidecarPreserved":true}
```

探针 idleMs=50 是隔离测试配置，不是生产默认或性能结论；idleUpdate 仅计数并返回 null，证明入口恢复可达，**没有执行实际下载/安装更新**。结束后 daemon 已关闭、临时 workspace 已删除。原始单元测试日志、探针脚本与输出保留在 `/tmp/scry-VB1-*`，未纳入 Git。

### 用户验证与交接

不需要真实 Provider 请求即可复验本项；也不能用此前 A 的真实 Provider 结果代替本次 VB1 验证。

1. 在本分支构建 CLI，使用绝对路径；只在专门的临时 workspace 操作。可先运行本节 focused 命令验证完整回归。
2. 对临时测试中已隔离的**单个**事件，先备份原文件与 sidecar，再使 sidecar 成为损坏 JSON（或在非 root 环境取消它的读权限）。此 workspace 不应另有 open turn 或可重试条目，否则它们按合同仍应保活。
3. 连续执行三次 `recorder recover`。确认原文件和 sidecar 未改变、pendingCount 至少为 1、doctor 的 turns.pending=warn。用 `SCRY_RECORDER_IDLE_MS=1000 SCRY_AUTO_UPDATE=0` 启动这个临时 recorder，超过该测试空闲周期后用 status 确认退出；不要在日常 daemon 上改测试参数。
4. 按 [Retry quarantined hooks](../../../../packages/turn-recorder-cli/README.md#retry-quarantined-hooks) 修复原因、备份并仅移除对应 sidecar，recover 后检查是否成功；不可用退出 0 或消失的 sidecar 单独替代业务读回，失败会重新生成 sidecar。历史 droppedEvents 保留。
5. 退出所有临时实例并保留需核验的证据。本次没有新增账号/费用授权，没有发起真实 Provider 请求、日常 CLI/App 安装或全局配置变更。

**留给用户决定的事**：无新增实现取舍；本次选择在核验意见明确允许的范围内。请审查方核验 VB1/VB2 后决定 B1 是否通过。B2 与已接受的乱序/非事务取舍不变，执行方到此停止，不开始 C。

## VB1 核验意见（审查方，2026-10-25）

**结论：VB1 和 VB2 已核验，B1 通过，批次 B 关闭，可以开始 C。**

- 复跑证实：在 `8a29edf` 的独立 worktree 上，`recorder-inbox.test.ts` 有 3 个失败、9 个通过，失败的正是两个 VB1 保活用例和 doctor 提示用例，与报告一致。VB2 的「只删 sidecar 后能重放」用例在旧实现上就能通过，报告如实说明它验证的是已有能力，没有当作新修复。
- 修复后（Linux/Node 22，HEAD `3034c21`）：`src/core/turn-recorder`、`hook-skip-recency`、`scry.test.ts` 共 26 个文件 427/427 通过。
- 代码：修复只有一行，把 `recorderHasRetryableInbox` 读 sidecar 失败时的处理从 `return true` 改成 `continue`，与 replay 的跳过逻辑一致；后面的有效条目仍然会让函数返回 true。条目仍计入 pendingCount，doctor 继续告警，不会把积压显示成健康。没有新增 droppedEvents，也不覆盖损坏的 sidecar，方向正确。
- VB2 文档：人工重试流程要求先停 daemon 并确认已停止、在 dataDir 之外备份、只删除单个 sidecar、recover 之后读回结果，并明确说明这不保证 FIFO 或 exactly-once、历史 droppedEvents 不扣减。`scry recorder stop` 命令确实存在（`scry.ts:462`）。可以接受。
- 生效方式：升级 CLI 后要执行 `scry recorder restart`，不需要 repair。
