# 批次 B 回报：inbox 与 recover 失败隔离

基线：`a21110c4`；分支：`reliability/collection`。仅做 B1 / B2，未开始 C。
实现与本地验证完成，**待用户核验**。没有执行真实 Provider 请求、安装日常 CLI、构建安装 App、开 PR 或合入 main。

## 结论与提交

| 条目 | 结论 | 证实测试提交 | 修复提交 |
|---|---|---|---|
| B1 / H4 | **已修复**：重放/读取失败不再删除原事件；隔离、有限重试，后续条目继续处理 | `549b928a` | `15fd68e2` |
| B2 / M1 | **已修复**：恢复逐会话隔离；通知投递进入 finally；daemon 后台异常写日志 | `52a0a90c` | `c93f081a` |

所有提交 author / committer 均为 `bingjiang0611 <307659028+bingjiang0611@users.noreply.github.com>`。用户另行明确授权了 **仅批次 B** 的既有大文件 pre-commit 大小门禁豁免；提交使用临时 `core.hooksPath=/dev/null`，没有修改持久配置、大小检查脚本或 recorder commit hook 的 trust gate。

## 旧实现失败证据

### B1

在只有测试的 `549b928a` 上执行：

```sh
npm run test:unit -- src/core/turn-recorder/recorder-inbox.test.ts
```

首次 6 项失败；补齐“可读首条后的 EACCES”及 ENOENT 对照后，提交前 8 项全部失败。以下为 `/tmp/scry-B1-before.log` 的输出节选，省略临时目录随机前缀：

```text
preserves a failed apply verbatim and still applies the next arrival
  ENOENT: .../inbox-failed/001792901926847-1.json
retries a failed event on the next recover and removes it only after success
  ENOENT: .../open.json
stops after five failed attempts, counts one drop, but retains the evidence and pending warning
  AssertionError: expected 1 to be 5
retains EACCES instead of deleting it, and does not block the next file
  ENOENT: .../open.json
retains invalid JSON instead of deleting it, and does not block the next file
  ENOENT: .../open.json
does not delete a non-ENOENT read failure after a readable first entry
  ENOENT: .../inbox-failed/001792901927199-2.json
skips ENOENT without a failure or drop when an entry has disappeared
  AssertionError: expected 1 to be +0
keeps a quarantine-only session eligible for daemon recovery and counts its pending age
  ENOENT: .../inbox-failed/001792901927366-1.json
Test Files  1 failed (1)
Tests       8 failed (8)
```

首次 apply 用真实 recorder / 锁 / 临时文件，只对目标 `open.json` 写入注入异常。读取测试只对指定 inbox 文件注入 EACCES；另有真实损坏 JSON。旧实现不仅删失败事件，还用首条 JSON 取得 session id，导致首条不可读时整个 inbox 不执行。ENOENT 对照证实旧实现把已消失文件也计为 dropped。

测试提交前全量：`8 failed | 3913 passed | 4 skipped`，失败均为上述新增测试；typecheck 通过。

### B2

在 B1 已修复、只有 B2 测试的 `52a0a90c` 上执行：

```sh
npm run test:unit -- src/core/turn-recorder/recorder-recovery-isolation.test.ts src/core/turn-recorder/daemon.test.ts
```

`/tmp/scry-B2-before.log` 节选：

```text
logs sync background recovery failures without stopping the daemon
  promise rejected "Error: injected sync recovery failure" instead of resolving
logs async background recovery failures without stopping the daemon
  ENOENT: .../logs/daemon.log
continues after S1 finalize fails, commits S2 and drains its trusted callback
  promise rejected "Error: injected s1 finalize failure" instead of resolving
  at commitRecord (.../recorder-recovery-isolation.test.ts:15:64)
  at finalizeOpenTurn (.../recorder.ts:2685:27)
  at Module.recoverRecorder (.../recorder.ts:3310:20)
counts a live session lock deadline as pending and continues with S2
  promise rejected "Error: lock timeout: ..." instead of resolving
  Serialized Error: { code: 'ELOCKTIMEOUT' }
drains already committed notifications even when the final health refresh throws
  ENOENT: .../notifications.jsonl
Test Files  2 failed (2)
Tests       5 failed | 19 passed (24)
```

S1 为 Claude、S2 为 Codex，使用生产遍历顺序保证先到 S1，不依赖目录排序。两者都在临时目录构造有终态边界的 closing 状态；最终提交故障只注入 S1。锁测试真实持有当前活进程的 session 锁，等待生产 10 秒 deadline；新测试从一开始就使用 15 秒预算，没有提高已有测试超时。callback 是临时脚本，经生产 activation / fingerprint gate 执行。

测试提交前全量：`5 failed | 3922 passed | 4 skipped`；typecheck 通过。没有修复原有失败。

## 改动后的行为

### B1：原事件保留在哪里

- 新增纯 Node `src/core/turn-recorder/inbox.ts`；没有改通用 `readJson` 的语义。inbox 读取仅 ENOENT 跳过；EACCES、损坏 JSON、无效事件身份均进入失败处理。
- 原文件按原名移至 `.scry/runtime/<provider>/<safeKey(sessionId)>/inbox-failed/<name>.json`，保留原始字节。旁边 `<name>.json.failure.json` 保存 `attempts`、`lastError`、`lastFailedAt`；不是正式 turn record。
- 先原子持久化失败次数，再 rename 原文件并同步源/目标目录；隔离失败时不删除源文件，写 WARN 并继续处理后续条目。未删除任何既有 fsync。
- 普通 live hook 仍重放 inbox；显式/daemon recover 合并 inbox 与 inbox-failed，按原文件名的到达序排序，每轮每条最多尝试一次。首条损坏也能按目录 session key 取得与 live hook 相同的锁。
- **最多共 5 次失败尝试（含初次）**。前 4 次不增加 `droppedEvents`；第 5 次计一次 drop、记录错误，并永久保留原文件及元数据，之后不自动重试。修复了故障且未耗尽的事件，在下一次 recover 成功后才移除事件/元数据。
- 可重试隔离事件会让 daemon 保持 recovery 资格；只有耗尽文件且没有 open turn 时，不让 daemon 永久空转。耗尽文件仍计入 pending，不能假装积压消失。
- `recorderPendingHealth` 统计原 inbox、隔离文件及已有待恢复轮次；sidecar 不计数。age 使用队列文件名中的到达时间，不用修复后的 mtime 冒充到达时间。
- `recorder status` 新增 `health`（recorder 未启用时为 null），包括刷新后的 `pendingCount`；doctor 的 `turns.pending` 对积压报 warn，文案明确是“turns or queued hooks”，耗尽文件给出检查路径。
- `.scry/logs/recorder.log` 示例：`WARN inbox pi/<sessionKey>/<name>: injected inbox apply failure`；耗尽后有 `ERROR inbox retries exhausted ...`。

**顺序取舍**：保证每一轮按到达序尝试，但早到失败项重试时可能晚于已经成功的后续项。严格跨重试 FIFO 与“不阻塞后续条目”不能同时成立，本批选择文档要求的后者。成功 apply 后、删除队列前崩溃仍可能重放；沿用生命周期去重，未承诺 exactly-once。

### B2：一个会话不能打断后续会话

- `recoverRecorder` 的 inbox admission、open-turn 锁与 finalize 包在逐会话 try/catch 中。失败会话 `pending++`，继续处理下一个；不清掉它的 closing 状态。
- 非锁超时写 `health.lastError = { at, message }` 和 `recorder.log ERROR recovery <provider>/<sessionKey>: ...`；锁超时写 WARN 并计 pending。保留待恢复证据，不虚增 `droppedEvents`。
- `drainCommitNotifications` 移到 finally。即使最后 health 刷新或 managed recovery 抛错，也尝试投递之前已提交的通知。仍使用原 activation / fingerprint 校验与 durable ACK，没有旁路。
- `daemon.ts` 的 `runRecovery` 同步/异步异常都记录到 **socket 所在目录**的 `logs/daemon.log`：`ERROR recovery: ...`；保持原来的后台容错与退避。该路径不一定是 workspace 的 `.scry/logs`。
- 没有增加恢复并行度、缩短锁超时或伪造终态。真实锁持有者仍可让当前 recover 在该会话等待最多现有 10 秒，再继续。

### 是否需要 integrations repair

B 没改生成的 hook/plugin。A 已正确接入的 workspace 不需要为 B 重新 repair；必须加载本批 CLI 代码，已有 daemon 要在测试 workspace 内重启。旧 daemon 不会因文件更新自动变成新代码。

新测试仓库直接用本分支 CLI `init`。若沿用的是 A 之前的旧 hook/plugin，按 A 报告另行 repair；不要把这当作 B 的新增要求。

## 验证记录

环境：macOS arm64、Node `v24.18.0`、Vitest `3.2.7`。全部自动化数据、callback、socket 在临时 workspace/目录，清理在 afterEach/finally；未写日常 workspace 的 `.scry`。

| 检查 | 最终结果 | 证据 |
|---|---|---|
| B1 focused（5 文件） | 225 passed | `/tmp/scry-B1-focused.log` |
| B1 修复后全量 | 3922 passed / 4 skipped | `/tmp/scry-B1-unit.log` |
| B2 focused（2 文件） | 24 passed | `/tmp/scry-B2-after.log` |
| 最终 focused（下列 9 文件） | 266 passed | `/tmp/scry-B-final-focused.log` |
| `npm run typecheck` | node / web 均通过 | `/tmp/scry-B-final-typecheck.log` |
| `npm run build:cli` | 两个 CLI 编译目标均通过 | `/tmp/scry-B-final-build.log` |
| `npm run test:shell` | PASS setup-scry-workspace | `/tmp/scry-B-final-shell.log` |
| 提交前 `npm run test:unit` | 324 文件通过 / 4 跳过；3927 tests 通过 / 4 跳过 | `/tmp/scry-B-final-unit.log`，最后一轮 21:59:39 开始 |
| `git diff --check` | 通过 | 各次提交前及报告提交前 |

最终 focused 命令：

```sh
npm run test:unit -- \
  src/core/turn-recorder/recorder-inbox.test.ts \
  src/core/turn-recorder/recorder-recovery-isolation.test.ts \
  src/core/turn-recorder/recorder.test.ts \
  src/core/turn-recorder/daemon.test.ts \
  src/core/turn-recorder/recorder-durability.test.ts \
  src/core/turn-recorder/recorder-terminal-replay.test.ts \
  src/core/turn-recorder/hook-diagnostics.test.ts \
  src/cli/scry.test.ts src/cli/workspace-init.test.ts
```

四个既有 skip：`scripts/performance-correlation.test.ts`、`src/main/billing-admin-real.test.ts`、`src/main/p0-integration.test.ts`、`src/main/p1-integration.test.ts`。没有新增 skip，没有发现需另行报告的既有失败。

首次失败/修正如实记录：

1. B1 修复先通过 8 项；补充 CLI 集成检查时，测试错误地捕获 console.log，得到 `"undefined" is not valid JSON`。改用既有 CLI 的 stdout 捕获方式后，进一步发现 `recorder status` 根本不输出 health（`Cannot read properties of undefined (reading 'pendingCount')`），据此补齐真实输出。最后该新增第 9 项通过，原 8 项不变。
2. B2 行为测试通过后，第一次最终 typecheck/build 报 `TS2322: Type 'string' is not assignable to type '{ at: string; message: string; }'`。修复新代码以遵循既有 `RecorderHealth.lastError` 合同；新测试的 lastError 断言同步改为检查 `{ at, message }`，而不是错误的字符串预期。没有删断言或弱化 S1/S2/callback 检查。随后 typecheck、build、focused、全量全部重跑通过。
3. 红线回归：现有 generated-hook 测试仍证明 Provider 收到 exit 0；daemon 在线 shell 快路径命令仍只有 `dirname / cat / curl`。现有 durability、trust/指纹及 A 终态去重测试均包含在 focused/full 中。不是只靠源码搜索宣称通过。

## 用户验证：OpenCode / Qoder / Codex

按 [USER-VERIFY.md](../USER-VERIFY.md)，每个 Provider 各建一个临时 Git workspace。无需全局安装，也不要覆盖日常 CLI。真实 Provider 操作由用户执行，本次自动化未执行这些付费/账号路径。

在本分支仓库完成 `npm run build:cli` 后，每次选一个 Provider：

```sh
export SCRY_REPO=/绝对路径/scry
export CLI="$SCRY_REPO/packages/turn-recorder-cli/dist/cli/scry.js"
export SCRY_AUTO_UPDATE=0 SCRY_NO_UPDATE_CHECK=1
export PROVIDER=opencode # 下一次分别改 qoder、codex
export WS="$(mktemp -d /tmp/scry-B-verify.XXXXXX)"
git -C "$WS" init
node "$CLI" init --workspace "$WS" --providers "$PROVIDER"
```

| 步骤 | 操作 | 预期 |
|---|---|---|
| B-U1，三个 Provider 各做 | 从 `$WS` 启动对应 Provider，按其原生接入流程加载 hook/plugin；Codex 按需用 `/hooks` 检查/信任项目 hook。让它只回答一句话，等待终态 | Provider 正常结束；`node "$CLI" turns list --workspace "$WS"` 新增本轮记录，不能仅凭 Provider UI 显示完成判断采集成功 |
| B-U2，三个 Provider 各做 | `node "$CLI" recorder status --workspace "$WS"`；`node "$CLI" doctor --workspace "$WS"` | 有 `health.pendingCount`；没有故障/未终态任务时为 0，`turns.pending` 为 pass。若不是，保留报告和目录，不手动清零 health |
| B-U3，纯本地故障，不调用 Provider | 等正常轮次结束并退出该临时 Provider 后，`node "$CLI" recorder stop --workspace "$WS"`。在现有 `.scry/runtime/$PROVIDER/<sessionKey>/inbox/` 中新增一个原名形如 `00$(date +%s)000-verify.json` 的损坏 JSON 文件（内容 `{broken`）；目录不存在先创建。运行 `node "$CLI" recorder recover --workspace "$WS"` | 文件原样移到同 session 的 inbox-failed；同名 `.failure.json` 的 attempts 为 1；recorder.log 有错误原因。status 的 pending 比注入前增加 1，doctor 的 `turns.pending` 为 warn |
| B-U4，纯本地有限重试 | 对该临时 workspace 再执行 6 次 recover；前后分别保存 status | attempts 停在 5；`droppedEvents` 比注入前增加 1，而非每次都增加；原文件仍在，pending 不归零。超过上限不会因反复 recover 自动恢复或删除 |
| B-U5，恢复正常使用测试 | 保留 B-U3/U4 的故障目录供审查；另建干净临时 workspace，重做 B-U1/B-U2 | 正常采集仍能完成。不要通过删除故障文件来伪装旧 workspace 已恢复 |
| B-U6，B2 可复现故障控制 | 在 Scry 仓库执行下列 focused 命令，测试会自行创建/清理独立 workspace，不操作 B-U1 的真实 Provider 数据 | S1 finalize 抛错/真实活锁 deadline 后，S2 提交且临时 callback 收到 S2；S1 解故障后恢复且不重复通知；尾部 health 异常仍投递；daemon 日志检查通过 |

```sh
npm run test:unit -- src/core/turn-recorder/recorder-inbox.test.ts \
  src/core/turn-recorder/recorder-recovery-isolation.test.ts \
  src/core/turn-recorder/daemon.test.ts
```

B-U6 是本地故障注入验证，不冒充 OpenCode/Qoder/Codex 的真实会话故障验收。B1 的 EACCES、apply 抛错、后续条目不阻塞和修复后重试由该命令中的临时夹具验证；不要求用户破坏日常文件权限来重演。用户回报请附每个 Provider 的版本、步骤结果、status/doctor JSON，以及失败时的测试输出；先遮掉会话敏感内容。

完成后只停止各临时 `$WS` 的 daemon；保留异常目录供核验，不停止日常 workspace 的 daemon。现有 workspace 若要加载本批 daemon，用本分支绝对 CLI 对**临时 workspace**执行 `recorder restart`，不要在日常项目上做。

## 未验证项与边界

- 未运行真实 OpenCode/Qoder/Codex 会话、未做断电/掉盘实验、未做 Linux/Windows 本轮复验。上面的真实 Provider 步骤由用户核验；durability 测试不等于断电保证。
- 原始失败文件、失败 sidecar、health 是不同文件，不是跨文件事务：在失败计数持久化后、health 更新前崩溃/health 不可写，`droppedEvents` 可能少计；sidecar 的次数和原始事件仍是调查依据。没有用默认值补出“肯定丢了几条”。
- 隔离目录本身不可写时，源 inbox 保留；诊断尽力写入。底层磁盘同时拒绝所有写入时，无法承诺日志一定落盘。原始目录枚举与其他 runtime JSON 的通用读取语义未扩大修改。
- `pendingCount` 是待处理项目数（轮次 + 排队文件），不是去重后的 session 数；`recover` 返回的 pending 仍是本轮会话处理结果，不能与 health 的项目总数混同。
- 只持有 session 锁的 10 秒等待仍然存在；本批解决的是整个循环被异常终止，不是让有坏锁的恢复无等待。managed 模块内部循环、存储配额/GC、新的重试管理命令均不在本批扩展。
- 没有新建常驻测试进程。自动化临时目录已清理；本机 `/tmp/scry-B*.log` 保留供核验。生成的 `out/` 与 `packages/turn-recorder-cli/dist/` 是忽略产物，未安装到日常环境。

## 留给用户决定的事

1. 请核验并确认“每轮到达序 + 失败隔离后允许后续先成功”的顺序取舍。严格全局 FIFO 与无队头阻塞冲突，本批没有增加第二套调度器。
2. 当前采用文档建议的 5 次总尝试，耗尽后保留、告警、不自动清理/重置。若实际工作流需要更长窗口、人工重入队命令或积压保留上限，请另行确定策略再实施；没有擅自加配置或删除证据。
3. 如需故障瞬间 `droppedEvents` 也具备跨文件精确一次计数，需要另定持久化事务/派生计数范围。当前保留事件与次数证据，但不作该承诺。
4. 请按上述真实 Provider 清单核验 B1/B2；核验通过后再决定是否授权 C。执行方在 B 报告提交并推送后停止，不自动开始 C。

## 核验意见（审查方，2026-10-25）

核验对象：`e70b27e`（生产代码 `c93f081a`）。环境：Linux x86_64，Node 22.22.0。

- `549b928`（只有 B1 测试）上 `recorder-inbox.test.ts`：8/8 失败；`52a0a90`（只有 B2 测试）上两个文件：5 失败 / 19 通过。与报告一致。
- 修复后 9 个 focused 文件 266/266 通过。
- 逐行读了 `inbox.ts`、`recorder.ts`（`replayQueuedHooks`、`recoverRecorder`）、`runtime-state.ts`、`daemon.ts`、`scry.ts` 的 diff。

结论：**B2 已核验；B1 需修改一处（VB1），其余接受。**

### VB1（需修改）sidecar 读不出来时，daemon 永远不会空闲退出

`replayQueuedHooks` 遇到读不出来的 `.failure.json` 会 `continue` 跳过这一条，永远不重试；但 `recorderHasRetryableInbox` 遇到同样的情况返回 `true`（注释写的是「读错误不能证明尝试已耗尽」）。两边判断不一致：daemon 认为还有活要干，所以不进入空闲退出，也就不会做空闲时的自动更新，同时一直按退避间隔轮询 recover；而 recover 每次都跳过这一条，永远收敛不了。

复现（临时探针，未提交）：在 `inbox-failed/` 放一条合法事件，sidecar 写成 `{corrupt`，连续 `recoverRecorder` 三次，之后 `recorderHasOpenTurn` 仍然是 `true`。

sidecar 是原子写的，正常情况下很少损坏，但手工编辑、权限变化（EACCES）或磁盘错误都可能触发，触发后不会自愈。

修改要求：
1. daemon 的存活判断必须与 replay 的实际行为一致：replay 会跳过的条目（sidecar 读不出来、或已耗尽），`recorderHasRetryableInbox` 都不应返回 true。二选一：要么 replay 把读不出来的 sidecar 当作一次失败来处理（例如另存一份损坏副本，再重写一个计数），让它能继续计数直到耗尽；要么存活判断把它视为不可重试。不管哪种，这条都要继续计入 `pendingCount`，让 `doctor` 报 warn。
2. 补回归测试：sidecar 损坏（以及 sidecar EACCES）时，若干次 recover 后 `recorderHasOpenTurn` 为 false，`pendingCount` 仍 ≥ 1，原事件文件没有被删除。

### VB2（文档，随 VB1 一起改）已耗尽条目如何人工重试

耗尽的条目永久保留，但没有任何命令可以重新尝试。请在 README 写明人工重试的方法（例如：修好原因后删除对应的 `.failure.json`，下一次 `scry recorder recover` 会重新尝试），并让 `doctor` 的 remediation 指向这一说明。不需要新增命令。

### 接受的取舍（记录）

- 失败条目的重试可能晚于后续已经成功的条目。例如 `UserPromptSubmit` 进入隔离、随后的 `Stop` 先被应用：`Stop` 会按 A1 的逻辑记成 missing_start orphan；之后 `UserPromptSubmit` 重试成功，打开的这一轮等不到终态，只能被下一轮 superseded 或在 24 小时后过期。结果是同一轮被记了两次（一个 orphan、一个 interrupted record），但没有丢。报告已经写明这个取舍，接受。
- B 不需要 `integrations repair`，已有 daemon 需要重启才能加载新代码。

### 下一步

执行方按顺序做：VB1 + VB2 → V3（时间分级）→ 手验 A。完成 VB1 后在本报告末尾追加「VB1 修改记录」，STATUS 中 B1 改回「待核验」。C 等 B1 核验后再开始。

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
