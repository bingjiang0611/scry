结论：需修改（4 项阻塞、10 项应修；默认路径安全）

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
