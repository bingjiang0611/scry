# R3 后续：attention 发布与清理竞态

基线：`ec44ffa1`。本轮用户批准修复 PR 就绪检查中发现的竞态，并补回归、同步状态说明。
不扩大到 G2、增量解析或 D；不改 `.scry/records` 格式、去重、序号、trust 或 Provider 权限。

## 根因与修复

旧实现的合法并发时序：

```text
queueHook 写 / 复用 attention 标记
  → cleanup 检查时尚无 inbox / open
  → cleanup 删除标记
  → queueHook 原子发布 inbox
  → 队列有真实事件，但 daemon / pending-health 看不到它
```

实际生产函数的隔离复现得到：可重试 inbox=1、标记=0、daemonHasWork=false、pendingCount=0；
调用一次 `recoverRecorder` 后事件仍在。证据文件没有被删，但普通索引恢复无法发现它。
同类时序也存在于 `beginOpenTurn` 与索引重建之间。

复用已有 `withDirectoryLock`，增加每会话的短锁：
`locks/attention/<provider>/<sessionKey>.lock`。

- `queueHook`、`beginOpenTurn` 从写标记直到状态原子发布完成，一直持有该锁。
- `releaseStaleAttention`、索引重建在锁内检查真实证据，再决定保留 / 删除标记。
- finalize 复用同一清理入口，连同 quarantine 证据一起检查，不另写一套删除条件。
- 重建中，初次目录列表未包含的会话也必须锁内重查；返回时重新读取标记，包含期间新发布的会话。
- 锁顺序只允许 session → attention；attention 回调不获取 session / commit 锁，不包住 Git、
  transcript 解析或记录提交。队列写入不依赖那个已经繁忙的 session 锁。
- 保留 index-first 顺序、文件与父目录同步。崩溃最多留下需清理的标记，不以省 fsync 换速度。

`recorder-hook-locked.ts` 原为 19,975 字节，已接近 20KB 门禁。因此把独立的队列发布职责移到
`recorder-hook-queue.ts`，更新实际调用方；没有为单一实现添加接口、兼容导出或注册表。

## 回归证据

### 确定性并发与进程崩溃

`recorder-attention-race.test.ts` 用屏障停在标记已写、状态未发布的位置，不靠 sleep 赌时序。
五个场景在旧实现上全部因标记丢失而失败：恢复清理、普通重建、会话目录尚不存在时的重建、
finalize、新 open 发布。修复后检查标记、daemon 可见性、pending 语义和真实 inbox 重放；
重建用例还断言返回值包含新会话，而不只检查磁盘标记。

`recorder-attention-process.test.ts` 使用实际 fork 子进程、child-owned owner token、真实 mkdir
`EEXIST` 竞争。覆盖正常发布、发布前 SIGKILL、状态已同步但尚未释放锁时 SIGKILL。
已发布事件必须保留并能重放；未发布事件不能被伪造为 open turn；死进程的锁可被正常回收。

### Linux 暴露的原有 oracle fixture 问题

Linux 初次完整 recorder 回归为 561 passed / 1 failed。失败在 clean discovery baseline 的
`git write-tree`：测试只设置私有 `GIT_OBJECT_DIRECTORY`，漏了生产 capture 使用的
`GIT_ALTERNATE_OBJECT_DIRECTORIES`。未改动的 `ec44ffa1` 上同样失败；dirty baseline 通过。
未变化 blob 可只存在于原仓库，不能假定它已经被复制到私有对象库。

独立提交 `f2ba78d3` 只补齐测试命令的对象视图。仍断言 discovery tree 等于 beforeTree，所有 targeted/full、patch、
真实索引与对象库隔离断言保留；生产 Git 代码未改。修复后 Linux 同组 562 项全部通过。

### 命令与结果

| 检查 | 结果 | 完整日志 |
|---|---|---|
| 旧实现 + 新并发用例 | 5 failed，均复现丢标记 | `/tmp/scry-attention-race-negative.log` |
| macOS focused：race、process、attention、runtime-state、doctor | 5 文件 / 31 passed | `/tmp/scry-attention-focused.log` |
| macOS 最终 oracle + race | 5 文件 / 28 passed；包含加强后的重建返回值断言 | `/tmp/scry-attention-oracle-mac.log` |
| Linux 未改基线的 discovery oracle | 1 failed / 1 passed，9 个非目标用例按筛选未执行 | `/tmp/scry-attention-linux-baseline-oracle.log` |
| Linux 最终 recorder 全目录 + CLI scry / doctor | 51 文件 / 562 passed | `/tmp/scry-attention-linux-focused-final.log` |
| macOS 全量 `npm run test:unit -- --maxWorkers=1` | 581 文件 / 5491 passed，4 个原有 opt-in skipped，0 failed；退出 0，1278.70 s | `/tmp/scry-attention-unit.log`、`.exit` |
| `npm run typecheck` | 最终测试改动后补验通过 | `/tmp/scry-attention-typecheck-final.log` |
| `npm run build:cli`（macOS / Linux） | 通过 | `/tmp/scry-attention-build-cli.log`、`/tmp/scry-attention-linux-build-cli.log` |
| `npm run build`（macOS） | 通过 | `/tmp/scry-attention-build.log` |
| 构建后真实 CLI（macOS / Linux） | queue → pending=1 → recover → commit 一条 sequence=1 记录 → verify；prompt 保留，最终无标记 | `/tmp/scry-attention-cli-{mac,linux}.log` |
| 构建后 doctor / status（macOS / Linux） | 健康退出 0；pending、status 先读、无 transcript 旧 open 报警退出 5；源证据逐字节不变 | 同上 |

实际命令：

```sh
npm run test:unit -- src/core/turn-recorder/recorder-attention-race.test.ts src/core/turn-recorder/recorder-attention-process.test.ts src/core/turn-recorder/recorder-attention.test.ts src/core/turn-recorder/runtime-state.test.ts src/cli/scry-doctor.test.ts --maxWorkers=1
npm run test:unit -- src/core/turn-recorder/git-snapshot-oracle.test.ts src/core/turn-recorder/git-snapshot-oracle-edge.test.ts src/core/turn-recorder/git-snapshot-oracle-between-turns.test.ts src/core/turn-recorder/git-raw-numstat.test.ts src/core/turn-recorder/recorder-attention-race.test.ts --maxWorkers=1
# Linux:
npm run test:unit -- src/core/turn-recorder src/cli/scry.test.ts src/cli/scry-doctor.test.ts --maxWorkers=1
python3 /tmp/scry-attention-cli-check.py packages/turn-recorder-cli/dist/cli/scry.js
python3 /tmp/scry-doctor-cli-check.py packages/turn-recorder-cli/dist/cli/scry.js
```

均用临时 workspace / HOME / state。构建后 CLI 通过内部 daemon-tried 标志测试排队路径，不启动
日常 daemon，也不调用真实 Provider。macOS arm64 Node 24.18.0；Colima Linux arm64 Node 24.22.2。
十个受影响源码 / 测试文件在两端 SHA-256 完全一致，清单为 `/tmp/scry-attention-{mac,linux}-sources.sha256`。

保留首轮失败：`/tmp/scry-attention-linux-focused.log` 是 oracle 环境缺失的初次失败；
`/tmp/scry-attention-race-focused.log` 暴露新测试把正常 active open 误计为 pending-finalize，
随后按现有合同改为 active open pending=0、daemon 有工作=true；标记断言未放宽。
临时 CLI 检查初版误把成功终态写成 `recorded`，实际合同为 `committed`，日志保留在
`/tmp/scry-attention-cli-mac-first.log`；只纠正检查脚本并用新临时工作区重跑，未改生产返回值。

## 工作量与必要成本

使用未修改的 `scripts/recorder-engine.measurement.test.ts`，与临时 worktree 的 `ec44ffa1`
比较。只采用计数，不用并行验证期间的毫秒证明速度。

```sh
npm run test:unit -- scripts/recorder-engine.measurement.test.ts -t 'measures one real turn|measures recovery cost|measures hook-path' --maxWorkers=1
npm run performance:measure -- --scenario source-control.diff --compare HEAD --out /tmp/scry-attention-performance
```

上述 compare 执行时 HEAD 为 `ec44ffa1`，candidate 是本轮 dirty production diff。

| 场景 / 指标 | 基线 | 修复后 |
|---|---:|---:|
| 单轮 fsync | 41 | 43 |
| 单轮 readdir / readFile | 15 / 50 | 16 / 55 |
| start fsync / readFile | 10 / 13 | 11 / 15 |
| 恢复 readdir（0 / 200 / 1000 个已完成目录） | 7 / 7 / 7 | 7 / 7 / 7 |
| 恢复 readFile（同上） | 12 / 12 / 12 | 14 / 14 / 14 |
| pending-health readdir / readFile（同上每种规模） | 4 / 2 | 4 / 2 |
| 标准 `source-control.diff` Git / total subprocess | 8 / 8 | 8 / 8 |

增加来自 attention 锁的 owner 同步 / 读取，以及 finalize 对 quarantine 的证据检查，是避免漏
记录的必要工作，不是性能收益。正常恢复仍不随已完成会话目录数增长；全量索引重建仍是 O(历史
会话数)，现在也承担逐会话锁成本，不能声称冷重建成本不变。
日志：`/tmp/scry-attention-{baseline-counters,counters,performance}.log`；标准 ratchet 通过，
机器输出在 `/tmp/scry-attention-performance/measure.json`，没有放宽门限或修改 collector。
标准 source-control 场景不覆盖新锁成本；新锁成本以上面的 recorder 定向计数为准。

对 0 / 100 / 1000 个同会话 quarantined turns，各做一次“清理持锁 + 排队发布”积压检查：均
正常入队、标记保留，没有 2 秒 admission timeout。通过宿主 `timing-run.mjs` 加锁执行；
宿主 10 核，load 15.26→16.20，`highLoad=true`。日志 `/tmp/scry-attention-backlog.log`。
这些样本不建立延迟基线，也不保证任意积压 / 慢盘下不会超时。若出现 attention `ELOCKTIMEOUT`
或超过样本规模的积压，应先测同会话检查的临界区，再缩短证据存在性检查；不以增大超时刷绿。

## 自查、限制与交付

只读第二意见未发现阻塞问题，指出重建返回值缺少断言；本轮已补齐并通过两端回归。
这不替代正式 PR 独立评审。自查范围仅为本次竞态、必要的 oracle fixture 修正、回归和状态说明；
未改变记录合同或权限边界。所有本次改动文件均低于 20KB，diff 无空白错误；提交只包含本次改动。
全量测试的四个原有 opt-in 跳过项为 performance-correlation、billing-admin-real、p0-integration、p1-integration。

- SIGKILL 只验证进程崩溃，不代表断电恢复；未做真实 Provider / App 端到端或安装版本验收。
- Linux arm64 guest 不是发行版 x86_64 目标机验收；宿主高负载，不宣称新 L2 / L3 收益。
- 所有参与者必须使用更新后的 core；旧 CLI / daemon 不遵守新锁。升级前已经缺损的索引仍
  依赖现有重建机制，本轮没有操作用户真实工作区或迁移记录。
- Linux 两个临时 worktree 已删除，Colima 已恢复停止；夹具自动删除，日志保留在上述 `/tmp`。
- 仅本地提交；未 push、未建 PR、未安装日常 App / CLI、未发布 npm、未重启日常 daemon。
