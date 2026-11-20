结论：第三轮需修改（N1 只修了一部分：旧台账镜像仍可能让 on 模式重启失败或回退 seq）

# W9 核验（核验方，2026-11-20，提交 `86709fbc`…`1bd2192b`）

## 默认路径确认安全

`SCRY_ORCHESTRATION` 未设、`off`、`shadow`，以及 `SCRY_HOST_DAEMON=0` 时，都不经过新的权威代码，A 和 B 的真机验证不受影响。依据：
- `mode.ts:18-23` 只有显式 `on` 才返回 `on`。
- `orchestration-authority.ts:74-75` 在非 `on` 时返回 `undefined`。
- `src/main/remote/*` 里新增的分支都先判断 `deps.orchestration`。
- 只有 `src/daemon/host-process.ts` 传入 `orchestration`。

shadow 模式的变化（空闲 PASSIVE 检查点、跳过已删会话的正文、8 ms 分片）都是任务单要求的。

**Linux 复跑**：
- orchestration 与 daemon 测试：默认、`shadow`、`on` 三种模式下都是 61 个文件 272 个用例通过。
- `typecheck` 通过；`check:cli-runtime` 112 个文件 1,222 个用例通过。
- S3 准备只新增文件，没有删除；CLI、recorder、协议均未改；所有文件都小于 20,000 字节。

## 阻塞（`on` 模式）

1. **8,192 个台账事件后停止接单，重启也恢复不了（已复现）**
   - `orchestration-authority.ts:164-176` 的内存 `LedgerStore` 没有实现 `compact`。
   - `session-ledger.ts:258-259` 到上限时抛 `ledger_capacity_exceeded`。复现中第 2,049 个 run 就失败了。
   - H1 镜像只追加不压缩，重启后会重新加载全部事件，一开机就卡住。
   - 修法：实现压缩，或让 `on` 模式不再依赖这个内存台账。补一个超过上限后重启的测试。
2. **pending TTL 只在重启时检查，重新排队的 run 没人再派发（已复现）**
   - `beforeDispatch`（`authority-engine.ts:176-238`）不检查 `expires_at`。复现：拨钟 3 小时后，过期的提示仍然被派发。
   - operation gate 释放后没有人调用 `pump()`，该会话会一直返回 `session_run_active`。
   - 修法：派发前检查 TTL，过期记为 `expired`；gate 释放时（或定时）重新调用 `pump`；TTL 不超过 60 s。
3. **生产代码的恢复流程从不查 recorder 证据**
   - `orchestration-authority.ts:127` 调用时没有传 `findRecorderEvidence`，所以已派发、没有终态的 run 一律记为 `interrupted`。
   - 这是 plan §9 的 P4-2 行与 core §2.4、§2.6 的明确要求。需要接上真实的证据查找，并补一个走 daemon 装配路径的测试。
4. **两本账对账在生产中不会生效，而且潜藏写入假会话 id 的缺陷**
   - `host-process.ts:195-203` 的 `runStartupRecovery` 先运行，已经把 `pending` 轮次全部改成 `unknown`；对账（`recovery.ts:332`）只看 `pending`，所以什么也找不到。
   - 另外，`recovery.ts:373` 在缺少 `session_bound` 时写入 `nativeSessionId: 'orch:<runId>'`，这个值会被写进会话绑定（`conversation-turns.ts:245`），下一轮会去恢复一个不存在的会话。
   - 按决定 G，原生会话绑定以会话文件为准，事件一侧不得写入。
   - 修法：调整两者的顺序或共用判定；去掉这个假 id。

## 应修

1. **trust gate 复核是占位**：`verifyTrustGate` 从未提供，`trustGatePassed` 恒为真（`authority-dispatch.ts:133`）。要接上现有的 trust gate，或在报告里写明它的位置。
2. **重启后提交者授权复核被绕过**：提交者身份取自内存里的 `runMeta`，丢失时变成 `'system'`，授权直接通过（`orchestration-authority.ts:222`）。应改用持久化的 `run.ownerActor`。
3. **先提交、后执行可能失败的副作用**：提交后 `gateway.submitIntent` 可能抛错（`host-controller-submit.ts:30-37`、`57-64`），留下已领取却没有 H1 intent 的 run。要有补偿事件，或调整顺序。
4. **回答先记账后校验**：`question.answer` 在 broker 校验之前就提交了（`host-controller-run-controls.ts:41-53`）。
5. **设备看到的结果和 orch 日志不一致**：
   - 复核失败时，H1 记为 cancelled，orch 记为 failed。
   - 重启后设备仍看到 `failed`（`resolveIntent` 把 `interrupted` 映射成 `failed`），「不记失败」在设备端不成立。
6. **旧台账镜像是内存队列，不可重放**（`legacy-mirror.ts:38-64`）：
   - 崩溃会丢失未写出的部分。
   - 队头一直失败时，后面全部卡住，队列无上限增长。
   - 写出时在主线程做同步 fsync，而且发生在首 token 之前。

   要按 plan 的要求改成可重放的 effect，并设上限。
7. **性能门禁**：
   - 场景只测了两次裸的 `EventSink.execute`（`performance-orchestration-scenario.ts:46-66`），没有覆盖真实的钩子路径（realpath、授权查询、正文准备）。
   - ABAB 拷贝清单（`performance-abab-harness.mjs:7-18`）没有包含新场景，而基线（main）里还没有 orchestration 模块，推测发往 main 的 PR 上 Performance 工作流会失败（未实跑）。
8. **台账解析停顿的数据测错了**：bench 在 `await` 后立即停止探针，漏掉了反序列化 worker 结果的那段停顿。Linux 实测 10 万条（300 B 提示）停顿 165–191 ms，不是 1.3 ms。要修正 bench 和报告，并把停顿压到 50 ms 以内（例如分块传回结果）。
9. **补导入单批停顿仍有 99–529 ms**（报告自己的数据），怀疑是大 WAL 的 PASSIVE 检查点在主线程执行，需要定位。
10. **小项**：
    - attach 失败时没有关闭 sink，也不释放锁（`orchestration-authority.ts:84-128`）。
    - stop 的 `commandId` 含时钟（`:313`），每次点击都会留下一条永久回执。
    - `deleteSession` 会删掉另一会话正在使用的同内容正文。
    - 决定 G 的顺序反了：应先写 `turn.record_delivery` 事件，再更新会话文件（`:312-336`）。
    - `ledgerToCanonical` 只增不删（`:194-208`）。

## 无法确认

macOS 上 S1、fullfsync 的数据和预算 P95 0.574 ms，Linux 无法复现，以报告为准。

## 需要维护者决定（核验方推荐，待维护者确认）

- fullfsync 保持「关 + checkpoint_fullfsync 开」。
- 大正文的 8 ms 门禁只算 SQLite 提交，外部正文的 fsync 单列记录。
- S3：开发构建和测试实例先改为默认走 daemon；逃生开关再保留一个发布版本，删除放到下一版。


## 复核（第二轮，2026-11-20，提交 `1db3ae9a`…`89560972`）

**原 4 项阻塞都已修复**，并且都由真实 daemon 装配路径上的测试覆盖。核验方逐项做了变异：去掉压缩、去掉 TTL 检查、去掉 gate 释放后的 re-pump、去掉重试计时器、去掉证据接线、去掉跳过 `recoverAll`，测试都会失败。

**默认路径不受影响**：`off` 模式和进程内模式没有行为变化。唯一的例外是 `host-controller-execution.ts:244` 释放 gate 后无条件 re-pump，这个操作本身是幂等的，无害，但应该只在开启编排时执行。

**应修项进展**：
- 应修 2、3、5、8 和 10a–e 已修复。
- 应修 8 的 Linux 复测：解析时主线程最大停顿 4.2–8.3 ms，满足 ≤ 50 ms。

### 新阻塞

1. **N1：旧台账镜像会丢事件，丢失后下次重启起不来（已复现）。**
   - 队列满 2,048 时丢掉最旧的事件（`legacy-mirror.ts:68-70`）；写入连续失败 5 次时丢掉队头（`:150-153`）。
   - 没有从 outbox 重放。重启时，`SessionLedger` 要求 seq 连续，于是抛出 `ledger_log_corrupt`，`on` 模式无法启动。
   - 修法：不能丢事件。写不出时要么封住（fail closed），要么立即用内存台账做一次压缩，写出完整快照。
   - `#drain` 同步执行，不让出线程，2,048 条约占 600 ms 主线程，要分段让出。
2. **N2：补导入期间暂停 WAL 检查点，导致 WAL 无限增长（`on` 与 `shadow` 都受影响）。**
   - 原因：`legacy-import.ts:412` 暂停了检查点，同时 `wal_autocheckpoint=0`。
   - Linux 实测（2 万个 run）：暂停时 WAL 涨到 2.58 GB，之后一次检查点卡住主线程 379 ms；不暂停时 WAL 只有 107 MB。
   - 10 万个 run 的数据集会把磁盘写满，触发封住（`orchestration_write_indeterminate`）。
   - 报告里「补导入最大停顿 ≤ 34 ms」靠的就是这个暂停，必须改：可以按 WAL 大小或批次数在批次之间做 PASSIVE 检查点，或者把检查点放进 worker，并给 WAL 设上限。

### 应修

1. **trust gate**：派发前的复核与现有门禁的核心检查相同（`buildMcpExecutionSnapshot` 对应 `ensureMcpExecutionAuthorized`），但有三处偏差，要对齐，或者复用现有的准入函数：
   - 包含了 `pi`，而现有门禁跳过 `pi`。
   - 环境取自 `options.env`，而不是 `shellEnv()`。
   - 不比对准备阶段的指纹，而且每次派发都在首 token 之前同步计算一次可执行文件的 SHA-256。
2. **性能场景口径不一致**：场景标注的是 `real-hooks+2-commits`（`performance-orchestration-scenario.ts:51`），预算里写的是 `2-commits`（`performance-budgets.json:221`），比对时会报 methodology 不一致；在 main 基线上，跳过时会报 counter coverage 不一致。
3. **`performance-abab.test.ts` 的 2 个失败由 `a74fe125` 引入**：`p95Ms: 8` 比测试夹具的 10 ms 样本还小。要修好测试或夹具，**不得放宽 8 ms 门限**。
4. **回答被拒后仍然送达**：`engine.answerQuestion` 返回 `rejected` 时被忽略，回答照样投递（fail-open），应改为 fail-closed。
5. **两本账对账的小缺口**：
   - `host-process.ts:203` 用 `=== 'on'` 判断，但 `mode.ts` 会先去空格、转小写，所以 ` ON` 这样的值会接上权威模式，却不会跳过 `recoverAll`。要统一使用 `parseOrchestrationMode`。
   - 对账在决定 G 的观察者安装之前就运行了，被对账的轮次不会写 `turn.record_delivery`。
   - 「pending 轮次没有对应的 orch run，就记为 `not_sent`」：延后导入还没完成时，可能误判（未复现，请确认）。
6. 导入的旧 run，`ownerActor` 为 `'system'`，仍会退回使用 `input.actor`，需要写明或处理。
7. 释放 gate 后的 re-pump 改为只在开启编排时执行。


## 复核（第三轮，2026-11-21，提交 `310e1133`…`cd0c7db6`）

**已成立：**
- **N2**：Linux 上 WAL 峰值 24–32 MiB。
- **单次提交合并**：不会重复派发，`illegal_transition` 会挡住。
- **应修 2–7**：全部核实。
- **fullfsync**：on 模式为「开 + 检查点开」，shadow 保持关，`off` 与未设置不变。预算只新增一项 8 ms 门禁，棘轮没有改动。
- **默认路径**：未受影响。
- **变异测试**：全部被拦下。

**Linux 复跑：**
- `typecheck` 通过。
- orchestration 与 daemon 在默认、`shadow`、`on` 三种模式下都是 75 个文件、328 个用例全过。
- `src/main/remote` 只有 1 个失败，是以 root 运行的已知用例。
- `check:cli-runtime` 1,222 个用例全过。
- abab 8/8，native 只剩先前就有的 1 个失败。

### 阻塞

1. **B1：写入失败后重试，H1 日志会损坏。**
   - 镜像失败后直接再调一次 `append`，但 `append` 不会撤回写了一半的内容（`legacy-mirror.ts:198-234`、`session-ledger-file.ts:124-142`）。ext4 磁盘写满时，常见情况是 write 成功、fsync 失败，重试后同一个 seq 写了两次。
   - 经真实 daemon 复现：seq 2 的 fsync 报一次 ENOSPC，重启时抛 `ledger_log_corrupt`；先写短、再重试成功，重启时抛 `ledger_file_corrupt`。
2. **B2：封住（fail closed）只停了镜像，daemon 还在继续接单。**
   - `assertAvailable` 和 `append` 都不看 `mirror.isFailedClosed()`（`orchestration-authority-ledger.ts:157-159`、`183-189`）。
   - 磁盘持续写满时，run 2 照样被接受并结束。重启后 watch 这个 run 返回 `unknown_run`，seq 从 11 退回到 3 并被重复使用，设备端的游标随之失效。
3. **B3：崩溃会丢失镜像还没写出的尾部。**
   - on 模式启动时，设备端台账是从落后的 H1 文件重建的（`:141`）。`legacy.mirror` 名义上是可重放的 effect，但从来没有写入对应的 outbox 行，`legacy-mirror.ts:250-252` 的 UPDATE 实际什么也不改。
   - 经真实 SIGKILL 复现：提交后立即杀进程，重启后 watch 返回 `unknown_run`，`resolveIntent` 返回 `cancelled`，seq 6 会被另一个事件重复使用。

**核验方要求的修法（不要再修补镜像本身）：** on 模式启动时，设备端台账一律从 orchestration DB（权威）重建，不再从 H1 读取。H1 降为纯下游镜像：
- 写入失败时，用 DB 生成快照，原子地重写 H1（临时文件 + fsync + rename + 目录 fsync），不对同一个 seq 重复追加。
- 重写也失败时，只把「H1 可用于回退」标记为不可用，并在报告和日志里写明。on 模式不受影响，继续工作。
- 切回 `off` 时，如果 H1 落后或已损坏，先用 DB 重新生成 H1，再启动。

这样 B1–B3 一起关闭，也符合 plan 里「旧台账镜像不是严格回退保证」的写法。

测试必须走真实 daemon，覆盖：一次 fsync ENOSPC、短写后重试成功、ENOSPC 持续不断、提交后立即 SIGKILL。每种情况下重启都要成功，seq 不回退，`watch` 能找到 run，`resolveIntent` 给出正确结果。

### 应修

1. **补导入时的检查点会在主线程卡住。** Linux 实测，10 万个 run 的数据集：
   - 检查点最长停顿 1.06–2.51 s，事件循环最长停顿 2.5 s。
   - 补导入期间每 50 ms 提交一次时，提交延迟 P95 68 ms，最长 1,078 ms；只算提交本身 P95 11.9 ms，超过 8 ms。

   要把检查点移到 worker（独立连接），或者有等价办法压低停顿。并按 plan §8.2 报告「检查点期间的提交 P99」。
2. **trust gate 每次提交都在首 token 前计算 MCP 可执行文件的 SHA-256。** 以 125 MB 的 node 为例，每次约 92 ms，冷启动 565 ms；只看文件状态则只要 0.45 ms。要按文件状态戳缓存指纹，跨 run 复用；并补测带 MCP 配置时的 S1。
3. **文件状态戳用的是 `lstatSync`（`orchestration-trust-gate.ts:23`）。** 配置文件是符号链接时，改了链接指向的文件也发现不了（已复现）。改用 `statSync`，或者链接和目标都记录。
4. **性能场景的计数是写死的**（`performance-orchestration-scenario.ts:117`），要改成实测；场景名里的 `fullfsync=true` 要按平台标注，Linux 上 SQLite 并不执行 fullfsync。
5. **更新设计文档。**
   - core §2.4（第 45、54 行）与 plan §8 表格（第 30 行）：改写合并提交后的语义。提交后、Provider 启动前崩溃，记为 `interrupted` + 送达 `unknown`，而不是 `not_sent`。
   - 写明 on 模式下旧的 pending run 不会被派发。
6. **文件余量**：`host-controller-surface.ts`、`orchestration-authority.ts`、`event-sink.ts`、`authority-engine.ts` 都在 19.8–19.96 KB，下次改动前先拆分。

### 无法确认

macOS 上的 5.66 ms、4.416 ms 和检查点 218–249 ms，推测都是在没有 MCP 可执行文件的配置下测的。
