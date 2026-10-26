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
