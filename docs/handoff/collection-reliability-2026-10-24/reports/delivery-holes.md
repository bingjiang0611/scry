# VF2：投递空洞与丢失结果的恢复

从 [sequence 复用报告](sequence-reuse.md) 按职责拆出：这里是 VF2（号上有空洞时 ACK 抛错、投递整体卡死）及其两次跟进的完整记录。VF1（sequence 分配复用）留在原报告，审阅方的核验意见也在原报告。内容未删改。

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

## VF2 跟进：空洞计数去重 + 丢失结果显式恢复（2026-10-27）

两处小修，红测先提交（`673f7370`），修复单独提交（`410231d5`）。

### 1. 同一空洞被重复计数

`recordAbsent` 只用「最后一个保留区间」去重。区间样本满 32 段后，新空洞的区间会被裁掉，于是同一个 sequence 再被走过一次时会重新累加 `count`。红测：预置 `absentThrough: 39, count: 39, ranges` 为 1..32、`truncated: true`，对 40 连续调用两次 `advanceAck` → 修复前 `count: 41`，修复后 `count: 40`（`absentThrough: 40`、区间仍 32 段）。

修复：去重改为与账本水位比较——`if (sequence <= (previous?.absentThrough ?? 0)) return`。`absentThrough` 单调且覆盖已被裁掉的区间，因此「已记录过」与「样本里还留着」不再等同。

### 2. 「record 还在、投递结果丢失」没有恢复入口

上一轮把这种状态定为 fail closed 是对的，但没有出口：ACK 永久停在被阻塞的号，`doctor` 只说状态不可用。红测：seq1 失败进重试、seq2 投递成功，随后删掉 seq1 的 outcome → 状态查询抛 `missing delivery outcome in visited prefix`，`doctor` 只给通用文案。

修复：

- `advanceAck` 的 `UnresolvedDeliveryPrefixError` 现携带 `sequence`，消息文本不变（既有断言不受影响）。
- `scry recorder notify-retry --sequence N` 除活动死信外，也接受「该号有 record、没有 outcome」：在投递锁内校验后写入一条 `status: replay`、**不带** `historyKey` 的重放请求（没有隔离记录可释放，`finishReplay` 直接返回），下一次 drain 重新投递该 record，成功后 ACK 才能继续前进。接收方按 `recordId` 去重，这是它成立的前提。
- 自动 drain 仍然 fail closed：没有显式命令就绝不重新投递，也不会把该号标成 absent。
- 既不是活动死信、也没有丢失结果的号被拒绝，错误信息改为 `sequence N is neither an active dead letter nor a record whose delivery outcome is missing`（旧文案是 `is not an active dead letter`，仓库内没有测试或文档依赖旧文案）。
- `doctor` 的 `commitHook.delivery` 写明具体号与命令：`sequence 5 has a record file but no delivery outcome, so the ACK cannot advance; run \`scry recorder notify-retry --sequence 5\` to re-deliver it (the receiver dedupes by recordId)`。
- 文档：`packages/turn-recorder-cli/README.md` 与 `docs/integrations-and-updates.md` 各加一句，说明该命令的第二种用途与「接收方按 recordId 去重」的前提。

### 验证

| 检查 | 结果 | 证据 |
|---|---|---|
| 红测（修复前源码 + 最终测试重演） | 2 failed / 158 passed | `/tmp/scry-vf2b-red-replay.log` |
| 红测原始运行（当前源码，未修复时） | 2 failed / 158 passed | `/tmp/scry-vf2b-red.log` |
| 受影响单测（recorder / commit-delivery / doctor / records / hook-http） | 202 passed | `/tmp/scry-vf2b-affected.log` |
| `npm run typecheck` | 通过 | `/tmp/scry-vf2b-typecheck.log` |
| `npm run build:cli` | 通过 | `/tmp/scry-vf2b-build.log` |
| 构建 CLI 探针（扩展上一轮脚本） | 通过 | `/tmp/scry-vf2b-built.log` |

构建 CLI 探针在本轮新增段落：seq5 被拒进入重试 → 删掉 seq5 的 outcome → `doctor` 的投递检查列出 `sequence 5 … notify-retry --sequence 5`（该 workspace 还有已删除的 record 2，所以整体是 `corrupt`、退出 4，不是 `error`/5）→ `notify-retry --sequence 5` 返回 `requeued: 1, pending: 0`，seq5 被重新投递（调用序列 `[5, 5]`，第一次是失败、第二次是重放）→ ACK 前进到 5 → 新 record 6 正常投递，ACK 6。

### 未验证 / 限制

- 接收方「按 `recordId` 去重」是重放安全的前提，本轮用本地夹具模拟，没有真实 uploader 参与；真实去重语义仍取决于 uploader U1/U2。
- 只有显式 `--sequence N` 支持这种恢复；`--all-dead` 不扫描丢失结果（避免批量重投未经确认的号）。
- 重放请求写入后、drain 前崩溃时，该号仍是 `replay` 状态、`attempts: 0`，下次 drain 会继续处理；没有专门的崩溃注入测试。
- doctor 的文案写在 detail 里，没有新增结构化字段；依赖字符串匹配的脚本需要知道这一点。
