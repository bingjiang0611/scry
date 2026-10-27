# 报告：删除记录文件后 sequence 复用导致静默丢上传

对应审查方在 [uploader 审阅](uploader-review.md) 里记的 **VF1**（E5 真机暴露）。分支 `reliability/collection`。提交：红测 `5839fcdc`，修复 `ba01a63a`（红测提交在修复前单独存在，两者分开；本轮不含任何纯拆分改动）。

## 问题

用户不走 `scry records archive`，直接删除或移走 `.scry/records` 里最新的记录文件后，`commitRecord` 用 `max(现存最大号, archivedThrough) + 1` 分配序号，会把已经投递过的 sequence 再发一次。

- drain 只处理 `sequence > processedThrough` 的 record，所以新 record 永远不会被通知。
- 如果该号已经有 outcome 文件，则抛出 identity 不匹配错误，后续投递全部卡住。

uploader 真机 E5 已经出现过 seq4 两次、`recordId` 不同的情况。根因不在投递侧：投递按「号码即游标」工作，是号码分配把已发放的号又发了一遍。

## 红测（提交 `5839fcdc`，先于修复）

新文件 `src/core/turn-recorder/recorder-tests/sequence-reuse.test.ts`，在 `recorder.test.ts` 注册为 suite 21，用临时 dataRoot 与本地 commit hook 接收器：

1. 提交 3 条并全部 ACK，手动删除第 3 条记录文件，再提交 1 条：断言新 record 的 sequence 是 4，并且会被通知（`delivered: 1`、接收器拿到 1,2,3,4、ACK 前进到 4）。
2. 删光 `records/` 但保留投递状态：断言下一条从 4 开始并被正常投递。
3. 老工作区（只有投递检查点、没有 watermark，记录文件也已删）：断言从检查点的 3 继续到 4。
4. doctor：删掉最新记录后必须 warn 且不再报 healthy。

在修复前的提交上重演（`git worktree` 检出 `5839fcdc`，同一份源码）：

```
Tests  4 failed | 148 passed (152)
  × allocates above an acknowledged sequence whose record file was deleted, and still delivers it
  × keeps allocating above the acknowledged floor when every record file is gone
  × initializes the issued floor from an existing delivery checkpoint (workspace written before the watermark)
  × doctor warns about records deleted outside archive instead of reporting healthy
```

第一条的实际失败是 `expected [ 1, 2, 3 ] to deeply equal [ 1, 2, 4 ]`：复用 3 号，正是静默丢投递的那条路径。第三条实际是 `expected [ 1 ] to deeply equal [ 4 ]`。

## 修复（提交 `ba01a63a`）

### 已发号高水位

新文件 `src/core/turn-recorder/sequence-watermark.ts`，权威状态是 `.scry/sequence-watermark.json`（`{ schemaVersion: 1, lastIssued }`）：

- `nextSequence()` 只计算候选号：`max(watermark, 现存最大号, archivedThrough) + 1`。
- `reserveSequence()` 在提交锁内、写 record 之前 durable 写入新水位（`writeJsonAtomic` 默认 fsync 文件与父目录），并拒绝小于等于当前水位的号。
- 先校验 record、再 `reserveSequence`、最后写 record。被拒绝的非法 draft 不会白占一个号，因为 `records/` 里出现无法解释的空洞会被当成 store 损坏。
- 崩溃在「已保留号、未写 record」之间只会跳号，不会复用号。

### 兼容老工作区

watermark 文件不存在时（旧 CLI 写过的工作区）按用户要求一次性初始化：

```
max(现存最大号, archivedThrough, 各指纹检查点的 ackedThrough 与 processedThrough)
```

之后分配只看 watermark，不再扫投递状态。检查点不可读时这一路径 fail closed（报 `cannot initialize sequence watermark: …`），不会用「读不到就当 0」把下限压低。

### doctor

新检查 `records.sequence`（`src/cli/doctor-command.ts`），用 `verifyStore` 新返回的 `maxSequence` 与 `archivedThrough` 对照已发号水位：

- 已发号（watermark 与当前指纹 `ackedThrough` 取大）大于 `max(现存最大号, archivedThrough)` → `warn`，并把 doctor 计入 degraded：detail 说明是「在 archive 之外删除 record，或提交在保留号后中断」，remediation 说明被删轮次不会再投递、只有 `scry turns archive` 是支持的移出方式、只有保留号时才可能是中断并建议先用 `scry turns list` 确认。
- watermark 损坏 → `fail`，明确要求不要手改或删除该文件。
- 正常时 detail 报告已发号与现存最大号，不用 0 冒充。

`verifyStore` 新增 `maxSequence`，但 `scry turns verify` 的 CLI 输出形状保持不变（`records-command.ts` 从可见输出里剔除该内部字段），冻结的团队 CI 契约不受影响。

### 为什么不是「扫描投递状态」

投递检查点按 fingerprint 隔离，可能滞后、可能隔离在死信里，也可能在迁移中；用它当日常分配依据会把「诊断证据」变成「分配权威」。所以只在 watermark 缺失的那一次初始化里读它，之后由 `sequence-watermark.json` 单调前进。

## 验证

| 检查 | 结果 | 证据 |
|---|---|---|
| 红测重演（修复前提交 `5839fcdc`，独立 worktree） | 4 failed / 148 passed | `/tmp/scry-seq-red-replay.log` |
| 目标分支受影响单测（recorder / doctor / records / commit-delivery / hook-http-outcome） | 195 passed | `/tmp/scry-seq2-affected.log` |
| `npm run typecheck` | 通过 | `/tmp/scry-seq2-typecheck.log` |
| `npm run build:cli` | 通过 | `/tmp/scry-seq2-build.log` |
| `npm run check:cli-release` | 778 passed（56 文件） | `/tmp/scry-seq2-release.log` |
| 全量 `npm run test:unit`（rebase 到 `19ed5718` 后重跑） | 4106 passed / 4 skipped，0 failed | `/tmp/scry-seq3-full-unit.log`（`19ed5718` 比旧基线少 244 个 perf/history 测试文件，属分支差异，不是本次改动） |
| 构建 CLI 端到端探针 | 通过 | `/tmp/scry-seq2-built.log`、脚本 `/tmp/scry-seq-built-probe.mjs` |

探针用真实构建产物 + 本地接收器 + 合成 Pi 生命周期，验证完整链路：

```
3 条记录投递 1,2,3 → doctor healthy，watermark=3
删除编号 3 的记录文件 → doctor exit 5、status degraded、records.sequence=warn（"issued sequence 3 is above live records (max 2)"）
再提交一轮 → 序号 4（不是 3），接收器收到 1,2,3,4，watermark=4
删光 records/ 再提交 → 序号 5，接收器收到 5
```

## 未验证 / 限制

- 没有真实上传器参与：探针只证明「号码不重复且通知确实到达本地接收器」，不证明 uploader 端去重后的最终结果。
- 没有断电/崩溃注入测试：水位的 durable 写入依赖 `writeJsonAtomic` 既有的 fsync 语义（与本仓库其它状态文件相同），未做真实掉电验证。
- 真机 E5 的 seq4 重复未在真实 uploader 上复测。
- 已知行为（有意保留）：删除记录文件后再提交下一轮，`records/` 出现无法解释的空洞，`store.integrity` 报 `sequence gap before: …`、doctor `status=corrupt`、退出码 4。删除发生在提交之前时是 `degraded` + `records.sequence` warn；提交之后空洞成为可证事实，因此升级为 corrupt。没有让 verifyStore 因 watermark 而容忍空洞，否则真实损坏也能藏在水位后面。
- 老工作区迁移只覆盖「watermark 缺失」的一次性路径；已经由新 CLI 写过水位的 store 不做回溯校验。

## 现场

`/tmp` 下的临时 workspace、worktree 与构建产物已清理；`git worktree list` 无遗留条目。未安装 CLI/App，未推送 main，未发布。

## 核验意见（审阅方，2026-10-27）

- **VF1 认可**。在 `3b21e70` 的独立 worktree 上重演红测，删除最新 record、删光 records、老工作区三个场景都失败（另一个是 doctor 用例，没有被 `-t` 过滤选中）；在 `1eaede0` 上跑 `recorder.test.ts` 和 `scry-doctor.test.ts`，160/160 通过。水位的设计没问题：先在 commit 锁内 durable 写入、再写 record；被拒绝的 draft 不占号；水位文件损坏时 fail closed；老工作区只在第一次用投递检查点初始化。
- **VF2（新，探针已确认）**：VF1 明确接受「崩溃可能跳过一个号」，但投递侧还不能容忍号上的空洞。`advanceAck`（`commit-delivery-ledger.ts:120-126`）按数字逐个遍历，遇到没有 outcome 的号就抛出 `missing delivery outcome in visited prefix`。只有在有更早的号处于重试中时（ackedThrough < processedThrough）才会遍历到空洞；而 contiguous 快速路径会直接跳过空洞，所以平时不出问题。
  - 探针步骤：seq1 hook 失败进入重试 → 水位写到 2，模拟 reserve 之后、写 record 之前崩溃 → seq3 投递成功 → 退避到期后 seq1 成功。结果 drain 抛错，drain 自己的 catch 里调用 `pendingCount` 又抛一次，错误漏出了 drain；之后每一次 drain 和 `commitNotificationStatus` 都抛同样的错，新 record 全部不再投递。
  - 在 archive 之外删除中间的 record（前面有号还在重试时）也走同一条路径，这是已有问题。
  - 探针文件：`/tmp/claude-0/-home-claude-scry/49e2dd49-143e-50a8-937e-f07e7c11568a/scratchpad/probe-gap.test.ts`（审阅方环境，已从仓库删除）。

## VF2：sequence 空洞让 ACK 抛错，投递整体卡死（2026-10-27）

审查方探针复现：seq1 失败进入重试 → 把水位写到 2 模拟 reserve 后崩溃 → 提交 seq3 并投递成功 → 退避到期后 seq1 成功。`advanceAck` 走到 seq2 找不到 outcome，抛 `missing delivery outcome in visited prefix`；drain 的 catch 再调 `pendingCount` 又抛一次，错误漏出 drain。此后每次 drain、`commit-hook status`、doctor 的投递查询都抛同一错，新 record 不再投递。

### 红测（提交 `b03ed21a`，先于修复）

新文件 `src/core/turn-recorder/recorder-tests/delivery-hole.test.ts`（suite 22，5 项），fixture 用可控的接收器（按序列拒绝）+ `Date.now` 桩控制退避：

1. 崩溃只保留号码的空洞：seq1 重试、水位 2、seq3 投递成功后 seq1 成功 → ACK 越过 2 前进到 3，之后新 record 4 照常投递，状态查询不抛错。
2. 在 archive 之外删除中间 record（前面有号在重试）：seq2 从未被 visit 就被删除，ACK 同样越过到 3，之后 4 正常。
3. 「record 还在但投递结果丢失」：删掉该号 outcome，drain 不抛错但 ACK 只停在已证明的前缀（1），不标记 absent。
4. 损坏的 outcome：drain 仍以 `invalid delivery outcome` 明确拒绝，doctor 报 error。
5. doctor 列出被越过的空洞（数量 1、区间 `[[2,2]]`）。

修复前源码 + 最终测试重演（`git worktree` 检出修复提交后，把 4 个实现文件回退到 `b03ed21a`）：

```
Tests  5 failed | 153 passed (158)
  × crosses the sequence reserved before a crash and keeps delivering after the retry succeeds
  × crosses a record deleted outside archive while an earlier sequence is retrying
  × stays fail closed when a record file exists but its delivery outcome is missing
  × keeps corrupt delivery evidence a loud rejection instead of reporting an unknown backlog
  × doctor shows the absent sequences the ACK crossed
```

修复前的实际错误正是 `Error: missing delivery outcome in visited prefix`（`advanceAck` → `store-notifications.ts`），第 4 项是 `drain` 把 catch 里的第二次失败漏出。红测文件在修复提交里还调整过 3 处断言/fixture（把 doctor 的 error 场景移到无 store 空洞的 fixture、把 fail-closed 的检查改为直接读检查点），原因写在下面「红测修正」。

### 修复（提交 `3eb293f5`）

**区分空洞与丢失结果。** `advanceAck` 只在「该号没有 record 文件」时才允许越过：

- 该号没有 outcome 且没有 record 文件 → 空洞，先写持久证据再前进。
- 该号没有 outcome 但 record 文件还在 → 投递结果丢失，仍然 fail closed，抛 `UnresolvedDeliveryPrefixError`，不改 ACK、不写 absent。

「是否有 record 文件」用 `recordFiles(..., { bypassIndex: true })` 一次建成集合，避免索引缓存把真实存在的 record 当成空洞。

**有上限的空洞证据。** `notifications/delivery-outcomes/<fingerprint-hash>/absent-sequences.json`：

- `absentThrough` 单调前进，`count` 精确，`ranges` 合并相邻号并最多保留 32 段；被丢弃时 `truncated: true`。大空洞只占一条区间，不逐号写文件。
- 读取时严格校验版本、指纹、区间有序不重叠、`spanned <= count`；损坏即 `invalid absent-sequence ledger`，不当 0。
- 写只在 drain 的投递锁内发生；诊断用的 `commit-notification status` 走只读 walk，读路径不会顺手写证据。

**drain 不再二次失败。** catch 里先取一次 backlog：

- 取不到且错误是 `UnresolvedDeliveryPrefixError` → 返回 `{ pending: null }`（积压未知，不是 0），日志已有原因；`notify-drain` 对 `null` 退出 3。
- 取不到且错误是检查点/凭据损坏 → 仍然抛出（保留既有 fail-closed 合同，VE2 的 4 个 corrupt-state 测试继续通过）。
- 其他投递错误维持原有的「记录日志并返回」行为（死信发布注入、锁超时等测试不变）。
- `advanceAck` 抛错前先持久化已证明的 ACK 前缀，避免每次重走已完成的号。

**doctor。** `commitHook.delivery` 的 detail 追加 `N absent sequence(s) acknowledged with no record file: 2, 7-9`（采样截断时标注），并把 `absentCount/absentRanges/absentTruncated` 放进 `commitNotifications`；投递状态读取失败时整体 `status` 从 `degraded` 升为 `error`（退出码仍为 5），不再可能报 healthy。

### 验证

| 检查 | 结果 | 证据 |
|---|---|---|
| 最终测试 + 修复前源码重演 | 5 failed / 153 passed | `/tmp/scry-vf2-red-replay.log` |
| 受影响单测（recorder / commit-delivery） | 174 passed | `/tmp/scry-vf2-affected5.log` |
| `npm run typecheck` | 通过 | `/tmp/scry-vf2-typecheck.log` |
| `npm run build:cli` | 通过 | `/tmp/scry-vf2-build.log` |
| `npm run check:cli-release` | 783 passed（56 文件） | `/tmp/scry-vf2-release.log` |
| 全量 `npm run test:unit` | 4115 passed / 3 failed / 4 skipped | `/tmp/scry-vf2-full-unit.log` |
| 构建 CLI 端到端探针 | 通过 | `/tmp/scry-vf2-built.log`，脚本 `/tmp/scry-vf2-built-probe.mjs` |

全量的 3 个失败都在 `src/main/providers/pi-lifecycle.test.ts`（`keeps async child ownership through parent idle` 的 continue/interrupt/transport-exit）。该文件在当前工作区有**不属于本次任务的未提交改动**（Pi 运行诊断 WIP），单独运行该文件 28/28 通过；本次改动不涉及 `src/main`。不能把这 3 个失败算作本次修复的通过项，也不能说它们是基线既有失败。

构建 CLI 探针（真实产物 + 本地接收器 + 合成 Pi 生命周期）：seq1 被拒后 drain 退出 3 → 记录 2 在投递前被删 → seq3 投递 → 把 seq1 的 `lastFailureAt` 改成 5 分钟前使退避到期 → drain 投递 seq1、退出 0，ACK 越过 2 到 3，`absent-sequences.json` 为 `{count:1, ranges:[[2,2]]}`，doctor 的 `commitHook.delivery` 列出该空洞且 `store.integrity` 报 gap（`status: corrupt`，退出 4）→ 新记录 4 正常投递，ACK 4。

### 红测修正（如实记录）

红测提交后有 3 处测试改动进了修复提交，都不是放宽对实现的断言：

- doctor 的 error 场景原来放在有 store 空洞的 fixture 上，而 `verifyStore` 的 gap 会先给出 `corrupt`（退出 4），`error` 永远到不了；改为独立、连续的 fixture，仍断言 `status: error`、退出 5、投递检查 fail。
- 「record 还在但结果丢失」原来断言状态查询能解析成功；实现上这条路径必须 fail closed，所以改为断言状态查询抛 `missing delivery outcome in visited prefix`、检查点 ACK 不前进、没有 absent 证据。drain 本身仍断言解析成功（`pending: null`）。
- 「损坏的 outcome」原先断言 drain 也能吞掉；改为断言 drain 明确拒绝 `invalid delivery outcome`，因为吞掉损坏证据等于把不可信状态当成未知积压。

### 未验证 / 限制

- `absent-sequences.json` 的 32 段上限只由单测与构造场景覆盖，没有跑过真实 32+ 段空洞的 workspace。
- 只读 walk 与 drain 的并发没有专门测试：drain 在投递锁内，诊断读取不加锁，理论上可能读到写入中的旧版本（原子 rename，只会读到旧的完整文件）。
- doctor 的 `error` 状态与既有 `degraded` 相比改变了对外状态值；退出码不变（5），但依赖 `status` 字符串的脚本需要知道这一点。
- 空洞只表示「该号没有 record 文件」，不表示投递成功；`store.integrity` 仍会因 record 空洞报 gap，这是有意的（删除不应被 ACK 掩盖）。
- 没有真实 uploader 参与本轮验证。

## VF2 核验意见（审阅方，2026-10-27）

- **VF2 认可**。审阅方的原探针在 `40e1891` 上通过：seq1 退避到期后投递成功，ACK 越过空洞 2 到达 3，`absentRanges [[2,2]]`；之后的 seq4 正常投递，ackedThrough 为 4。`recorder.test.ts` 和 `scry-doctor.test.ts` 共 165/165 通过。方案区分了「没有 record 的空洞」和「有 record 但 outcome 丢失」，前者留证越过、后者保持 fail closed；status 只读不写；drain 的 catch 不再二次抛错。这些都符合要求。
- 不阻塞，但建议发版前顺手处理的两点：
  1. `recordAbsent` 只和最后一个保留的区间比较去重（`sequence <= last[1]`）。样本已截断时，如果在写完 absent 账本、保存进度之前崩溃，重放会把同一个号再计一次，`count` 偏大。改成和 `previous.absentThrough` 比较即可。
  2. 「有 record 但 outcome 丢失」的 fail closed 发生在 drain 开头的 `advanceAck`（`store-notifications.ts:132`）。它一旦触发，后续所有 record 都不再投递，而且没有恢复命令，只能手工改状态。服务端按 recordId 去重，所以可以提供一个显式的重投入口（比如让 `notify-retry --sequence N` 也接受这种情况），doctor 的 error 信息里要写明是哪个号以及对应的命令。
- 说明：contiguous 快速路径越过空洞时不写 absent 账本，所以 `absentCount` 统计的不是全部空洞。records 里还在的中间空洞由 `store.integrity` 的 gap 检查负责。文档里不要把 `absentCount` 写成全部空洞数。
