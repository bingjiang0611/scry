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
