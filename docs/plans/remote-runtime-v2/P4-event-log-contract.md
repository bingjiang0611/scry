# P4 · 编排事件日志契约（只设计，不含实现）

状态：设计稿。P4 尚未实现；本文定义表结构、事务边界、projection、订阅协议与迁移，并列出需要维护者决定的点。

## 1. 目标与范围

把「宿主决定什么发生了什么」从分散的轮询读取改为**一份只追加的事件日志**：命令进 → 串行决定事件 → 同一事务提交事件、projection、回执与 outbox → 副作用由 worker 执行并把结果写成新事件。客户端订阅「快照 + cursor」，不再自己拼顺序。

范围：宿主侧编排（`src/main/remote/`、daemon 内部）。
不在范围：`src/core/turn-recorder/`（Recorder Core 继续无 SQLite、只写 `.scry/records`），原始证据（transcript、Provider result、`.scry/records`）不改由事件替代。

## 2. 现状映射

| 现状 | 位置 | P4 中的位置 |
|---|---|---|
| 远程运行台账（`intent_recorded` → `dispatched` → `settled`/`failed`/`cancelled`，`since(cursor)` + 快照压缩） | `remote/session-ledger.ts`、`session-ledger-file.ts` | `event` 表的主体；`since()` 语义升级为统一订阅（§5） |
| 设备侧 intent 回执（`recorded`/`unknown`，加密状态文件） | `remote/desktop-client*`、`shared/desktop-remote.ts` 的 `DesktopRemoteIntent` | `receipt` 表（服务端权威）+ 客户端本地回执缓存 |
| 交互回调（提问/审批的分发与回答） | `remote/remote-interaction-broker.ts` | 提问与回答各是一条事件；回答写 `receipt` |
| run 输出流（shadow output） | `remote/run-output-log.ts` | **不进事件**；继续是独立内容通道，事件只引用 |
| liveRuns / watch / catalog 轮询 | `host-controller-watch.ts`、`host-controller-catalog-snapshot.ts` | 由 projection + `subscribe` 取代（§6） |
| 会话列表/详情/状态 | `remote/remote-gateway*.ts`、`history-reader.ts` | 四个 projection（§4） |

## 3. 表结构

SQLite（daemon 独占写；WAL；`synchronous=FULL`）。所有事件表只追加，不 UPDATE 业务字段（压缩除外，见 §3.5）。

### 3.1 `event`

| 列 | 类型 | 说明 |
|---|---|---|
| `seq` | INTEGER PK AUTOINCREMENT | 全局单调序号，客户端 cursor 即此值 |
| `at` | INTEGER | 毫秒时间戳，来自注入的 clock |
| `type` | TEXT | 见 §3.2 的事件类型白名单 |
| `aggregate` | TEXT | `run:<runId>`、`session:<sessionId>`、`device:<fingerprint>`、`host` |
| `run_id` | TEXT NULL | 便于按 run 读 |
| `session_id` | TEXT NULL | |
| `actor` | TEXT | `device:<certSHA256>`、`local:<certSHA256>`、`provider:<name>`、`system` |
| `command_id` | TEXT NULL | 触发它的命令；重复命令返回同一回执 |
| `payload` | BLOB | 规范化 JSON（key 排序、无 undefined） |
| `evidence` | TEXT NULL | 证据引用，见 §3.4 |
| `quality` | TEXT NULL | `exact` / `estimated` / `inferred` / `partial` / `unavailable` |

### 3.2 事件类型（第一批，够覆盖现有设备面）

- 会话：`session.opened`、`session.closed`、`session.renamed`、`session.pinned`、`session.archived`、`session.restored`、`session.deleted`、`session.forked`
- run：`intent.recorded`、`run.dispatched`、`run.progress`、`run.awaiting_input`、`run.answered`、`run.stop_requested`、`run.settled`、`run.failed`、`run.cancelled`
- 内容指针：`run.output.available`（只带偏移/长度/哈希，不带正文）、`trace.available`
- 设备/宿主：`device.paired`、`device.revoked`、`device.label_updated`、`host.started`、`host.restarting`
- 副作用结果：`effect.completed`、`effect.failed`（见 §3.6）

新增类型必须改白名单并同时更新 projection 与测试；未知类型的客户端必须报 `unknown_event_type` 而不是跳过（跳过会让 projection 悄悄缺一块）。

### 3.3 `command`

| 列 | 说明 |
|---|---|
| `command_id` TEXT PK | 客户端生成（UUID）；重复提交返回同一 `receipt` |
| `at`、`actor`、`type`、`payload` | 同 `event` 语义 |
| `receipt_id` TEXT | 指向 §3.4 |
| `status` | `committed` / `rejected` |

命令永不删除；`rejected` 也留痕（否则无法回答「为什么我的停止没生效」）。

### 3.4 `receipt` 与证据引用

| 列 | 说明 |
|---|---|
| `receipt_id` TEXT PK | |
| `command_id` TEXT UNIQUE | |
| `result` TEXT | `recorded` / `dispatched` / `settled` / `failed` / `cancelled` / `unknown` / `rejected:<code>` |
| `run_id`、`intent_id` | |
| `evidence` TEXT | 证据引用（下） |

证据引用格式（一行一个，不内联正文）：

```
scry-record:<recordId>@.scry/records/<file>#sha256=<hex>
transcript:<provider>:<sessionId>#seq=<n>
provider-result:<provider>:<runId>#sha256=<hex>
ledger-event:<seq>
```

规则：引用只描述**已存在**的证据；引用不上就写 `quality: unavailable` 并说明原因，绝不指向一个稍后才会有的文件。

### 3.5 `snapshot` / 压缩

保留现有语义：`session-ledger.ts` 的 `LedgerSnapshot`（`version`、`lastSeq`、状态副本、`retainedEvents`）继续有效，只是扩展到四个 projection。压缩只在 `shouldCompact()` 判定成立时进行，且**必须在同一事务内**写入快照与删除被压缩的事件；`minCursor` 随之上移，客户端 cursor 低于它时得到 `reset`（现有 `since()` 已有此行为，§5 沿用）。

### 3.6 `outbox`

| 列 | 说明 |
|---|---|
| `outbox_id` TEXT PK | |
| `event_seq` INTEGER | 触发它的已提交事件 |
| `kind` TEXT | `provider.run` / `provider.stop` / `session.fork` / `session.delete` / `attachment.persist` |
| `payload` BLOB | 执行副作用所需的完整参数 |
| `state` | `pending` / `running` / `done` / `failed` / `voided` |
| `attempt`、`lease_owner`、`lease_expires_at` | 租约；`recover-dead-lease.ts` 的现有语义迁移到这里 |
| `result_event_seq` | 完成后写回的事件 |

## 4. 四个 projection

每个 projection 都有 `revision`（其行内容与 `last_seq` 的哈希）与 `last_seq`，随事件在同一事务内更新；只读查询不写库。

1. **会话列表（侧栏）**：`RemoteSessionRef` 的字段集（`shared/desktop-remote.ts`），包括 `pendingQuestions`（父 run 未答完的提问数）、`lastRunId`、`lastRunOutcome`（宿主持久化的终态证据，缺失即 unknown，不写 0）。分页按 `ts` 降序 + 稳定键。
2. **会话详情（turn 列表）**：按 `seq` 顺序的 turn/item，`userText` + 有序内容块；顺序由日志决定，客户端不排序。
3. **活跃 run**：run 状态、待处理提问/审批、可停止性；取代 `liveRuns` 的组装逻辑，但事件源相同。
4. **设备面能力与目录**：设备 grant、项目/目录授权快照、workbench 根目录。

## 5. 订阅协议（快照 + cursor）

长轮询承载，复用现有 lane 与 `remote-protocol.ts` 的版本闸门：

```
subscribe { project: 'sessions'|'detail'|'activeRuns'|'device', scope?, known?: { revision, lastSeq }, waitMs }
→ { snapshot: { revision, lastSeq, rows }, cursor }            // 首帧或 reset
→ { unchanged: true, revision, lastSeq }                       // 已知且未变（窗口到期或确有变化都返回一次）
→ { events: [ { seq, type, ... } ], cursor, reset?: {...} }    // 增量
```

- 客户端保存 `{ revision, lastSeq }`；重连直接带它，宿主能据此返回增量或 `reset`。
- `waitMs` 上限沿用 20 s 宿主 / 15 s 设备窗口；唤醒信号沿用 `LiveWatchers.notify()` 的机制（事件提交即唤醒），不引入秒级 tick。
- 大块内容（history/trace/图片）**不进增量**：事件只带指针，客户端仍按现有分页读取，避免 IPC/envelope 无上限。

## 6. 被取代的轮询

| 现在 | 取代者 |
|---|---|
| `runState` + `poll`（`host-controller-watch.ts`） | `subscribe('activeRuns')` + 内容指针事件 |
| `liveRuns` revision 长轮询 | `subscribe('activeRuns')`（同源，多 projection 版本号） |
| `catalogSnapshot` 的 `info/projects/providers/sessionsPage` 合批 | `subscribe('sessions')` 首帧快照 + `subscribe('device')` |
| renderer 的 history 轮询（切会话/终态刷新） | 会话详情 projection 的 `known` 对比 |
| trace 变更探测 | `run.output.available` / `trace.available` 事件 |

保留不动：长轮询的传输形态（lane）、协议版本闸门、写操作的 unknown 语义。

## 7. 「进程丢失副作用作废」的具体规则

1. 副作用只在 `outbox` 提交之后执行；`event`、`projection`、`receipt`、`outbox` 在同一事务提交。事务失败则命令整体拒绝，客户端收到 `rejected:<code>`，不会出现「有事件但没有副作用」。
2. worker 取行用租约（`lease_owner` = daemon 实例 identity，`lease_expires_at`）。租约过期视为执行者已死。
3. 执行者已死的 `running` 行转为 `voided`，并写一条 `effect.failed`（`quality: inferred`），run 转 `failed`（detail `host_restarted` 或 `effect_voided`）。**不重放**，因为已写出的副作用可能已经生效。
4. 唯一例外：副作用被声明为幂等（`provider.stop`、`attachment.persist` 的最终写入）且原因为 `notStarted`（worker 从未取到租约）。这需要在 `kind` 上显式标注，不能靠字符串猜测。
5. 写操作的字节级重发规则不变（未写出可重发，已写出即 unknown），该规则在 lane 层，不因 P4 改变。

## 8. 迁移步骤

1. **影子写入**：`SessionLedger` 的 `#emit` 同时写 `event` 表；读取仍走旧路径。用现有测试对齐两边的 `seq`/状态。
2. **切换投影**：会话列表先由 projection 提供，`liveRuns` 保留作为对照；一致后再删。
3. **命令化**：submit/stop/answer 改为 `command` + `receipt`，`intent_recorded` 等事件由命令决定；客户端回执改读 `receipt`。
4. **outbox**：副作用从「命令处理中直接调用」改为「提交后由 worker 执行」；`remote-dispatcher.ts` 变成 `provider.run` 的执行器。
5. **订阅**：`subscribe` 取代剩余轮询；删除 `catalogSnapshot` 合批路径（保留分页读取）。
6. **清理**：删除旧 ledger 的读取 API、`liveRuns` 的旧组装、以及只为轮询存在的 revision 字段。

每一步都保持「设备面 envelope 与版本闸门不变」，因此不需要协议兼容层；不兼容的步骤直接改 `REMOTE_PROTOCOL_VERSION`。

## 9. 测试

| 类别 | 断言 |
|---|---|
| 幂等重放 | 同一 `command_id` 重复提交：只产生一组事件、回执相同、outbox 只有一行、副作用执行一次。故意让第一次在提交后崩溃，重启后仍是一次。 |
| 乱序 | 事件按 `seq` 交付；客户端带旧 `cursor` 时收到增量；cursor 低于 `minCursor` 时收到 `reset` 且客户端丢弃本地状态。 |
| 崩溃 | 提交前崩溃：无事件、无副作用；提交后执行前崩溃：`running` → `voided` → `effect.failed`，run 变 failed，不重放。 |
| 顺序与证据 | 每个 `run.settled` 都能通过 `evidence` 解析到真实 transcript/`.scry/records`；解析不到时 `quality` 必须为 `unavailable`。 |
| projection 一致 | 同一事件序列重放得到的四个 projection 与在线状态逐字段一致；`revision` 相同。 |
| 取代轮询 | 客户端在空闲 60 s 内 RPC 数保持个位数（沿用 T3 的计数方式）；宿主变化 250 ms～1 s 内可达。 |
| 门禁 | 现有 `src/main/remote` 全量测试迁移后仍通过；`scripts/performance-counters` 中新增订阅路径已登记，否则 `performance-feedback.test.ts` 失败。 |

## 10. 与 CLAUDE.md 五条不妥协项的关系

1. **证据不能说谎**：事件**引用**原始证据，不复制、不替代；`quality` 必填（或显式为 `unavailable` + 原因）。缺失的 token/cost/duration/文件证据不因 projection 存在就变成 0 或绿色。
2. **Provider 差异显式存在**：事件 payload 携带 provider/profile 身份；不支持的副作用在 `outbox.kind` 上直接不存在，而不是运行时空转；Pi 无 MCP 状态就仍然没有相关事件。
3. **权限与 trust 不是一回事**：每条命令带 `actor`（证书指纹），处理时重验 grant；trust gate 仍在执行副作用前校验 canonical cwd + 指纹，fail closed。事件日志不是授权缓存。
4. **renderer 不可信且无特权**：订阅走 main↔daemon 通道与 typed IPC；renderer 只收到 projection 快照/增量，不接触 SQLite、不拼顺序、不写库。
5. **Recorder Core 独立**：事件表属于 App/daemon，`src/core/turn-recorder/` 不引入 SQLite；`.scry/records` 仍是 recorder 的 canonical 一轮一文件事实源，事件引用它。

## 11. 需要维护者决定

1. **事件表与现有 ledger 的归属**：是让 `SessionLedger` 演进成唯一写者（推荐：不变式集中在一处），还是新建 `EventLog` 并让 ledger 变成它的 view？前者迁移小，后者概念更干净。
2. **`run.progress` 的粒度与保留策略**：progress 事件可能很多。方案 A（推荐）：progress 只在生命周期转折时记录，正文只作为内容指针事件；方案 B：记录每条 progress 但压缩更激进。两者对「evidence 不能丢」的影响不同，需要决定。
3. **projection 存放位置**：SQLite 表（默认）还是内存 + 快照文件？后台常驻进程用 SQLite 更稳，但 Linux 上没有额外依赖要求（Node 内置 `node:sqlite` 或已装依赖需确认）。
4. **客户端本地回执缓存**：继续用现有加密状态文件，还是也进事件日志？保持本地文件可离线，但重启后可能与服务端回执不一致，冲突规则需要明确。
5. **`subscribe` 是否取代 `catalogSnapshot`**：P4 目标是删掉合批路径；但 `catalogSnapshot` 对首屏仍是最省的一次 RPC。是否保留它作为「冷启动首帧」，而把后续更新交给订阅。
6. **outbox 幂等标注的责任人**：由每个副作用实现者声明是否需要可重放，还是由统一的 policy 表集中决定？集中更可审计，但每加一种副作用要改两处。
