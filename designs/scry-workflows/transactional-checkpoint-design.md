# Workflow 事务式检查点：设计评估

原设计提交时的状态：**仅设计，未实现、未迁移、未验证性能。** 维护者本轮授权到设计，不等于授权替换生产持久化。基于 `bea90c44500b35ce16265a56ea014b03f5267da7`，2026-10-28 本地时间。当前失败与证据见 [timeout-followup.md](timeout-followup.md)。

后续状态（2026-10-29 UTC）：维护者另行授权后已执行临时 namespace 的 Node SQLite/Worker 原型与同负载评估；原五例在候选内通过，但扩大合同未通过，未接入生产。实际实现、ABI 偏差、失败与下一决定见 [隔离原型报告](../../docs/performance-experiments/20261029-workflow-sqlite-checkpoint.md)。随后获授权的[双后端合同收口](../../docs/performance-experiments/20261029-workflow-checkpoint-contracts.md)已修复实验值缓存并曾通过 93 项；后续[阶段调查](../../docs/performance-experiments/20261029-workflow-checkpoint-boundaries.md)已补 A/B 真回滚。该轮 SQL 92/93，File 恢复仍超时，均高负载；随后 [mac2 复验](../../docs/performance-experiments/20261029-workflow-checkpoint-mac2.md)在低负载通过 File 共享 58/58、SQL 93/93，但扩大 File 仍 76/77，stable-map 单例也超时；不推广。下文保留原设计决策，不把设计承诺当作验证结果。

## 1. 结论与范围

不建议直接增加一个“root + frame 全成或全败”的通用 batch API。现有业务合同明确要求：**已提交的原生效果事实，必须在后续 frame CAS 失败后继续存在。** 将两者放进同一可回滚事务会丢失真实事实，违反 no-replay 的依据。

建议下一阶段仅做隔离原型：复用已安装的 `better-sqlite3`，在专用 Worker 中评估 root/frame 元数据事务；不可变 value、collection、output、governing artifact 仍是逐字节校验的文件。优先降低**一次既有提交**的开销，不跨越独立的业务证据边界。没有证据前，不承诺减少总 fsync，也不承诺通过 5000ms。

原型不接日常 App，不迁移真实 userData，不改 Recorder、Runner、slots、Provider、trust、预算或恢复授权。不上新 scheduler，不自写 WAL，不引入新依赖。原型结果不合格就停止，不以替换架构本身作为进展。

## 2. 当前实现：已从源码核实

| 位置 | 当前行为 | 对设计的约束 |
| --- | --- | --- |
| `src/main/workflow-store.ts:43–63` | 每个目标串行；temp 文件 flush，rename，目录 sync 后返回 | 承诺成功必须有 durable acknowledgement，不能提前返回 |
| 同文件 `122–141` | frame 目录锁内读取并执行 `nextWorkflowFrame`；value/frame 两文件 flush，共用最后的目录屏障 | CAS 不只是数字；已有合并能力不能被新方案退化 |
| 同文件 `158–182` | create/claim/save 在 root 锁内读取，核对 fingerprint/epoch/ownership | DB 排他锁不能代替旧 controller 退出证明 |
| 同文件 `196–229`、`272–303` | governing/output 独立 artifact；root 引用；每次 load 重读 governing hash | 索引、DB 行和温缓存不能掩盖 canonical bytes 损坏 |
| `workflow-store-contracts.ts:83–109` | 既有异步 Store API；frame/value checkpoint 只支持 resultRef/sourceRef | 不先为假想调用者扩充通用 transaction DSL |
| `workflow-runner-system.ts:55–80,103–114` | admission、输入冻结、实际结果分别提交 | 不能为合并 I/O 把真实执行移到 admission 之前 |
| `workflow-control.ts:156–173` | 原生结果已经持久化；终态 frame 使用其精确 resultRef | 保留事实与控制推进的独立失败边界 |
| `workflow-recovery.ts:125–198` | 业务 unknown 拒绝自动继续；活 owner/无法证明退出拒绝接管；claim 验证旧账本 | transaction committed 不等于业务成功，不等于允许重新派发 |
| `workflow-store-artifacts.ts:30–33` | 每文件 8 MiB 上限；引用命名含身份和 hash | 不新增更小的产品限额，不把超限转成空值 |

复用选择也有边界：

- `package.json` 已有 `better-sqlite3` 和对应类型，无需新增数据库依赖。
- `src/main/db.ts:262–278` 的既有统计 DB 加载失败会降级 no-op。**不得复用这个失败策略或将 Workflow 权威状态混入统计表。** 其 Electron 胶水也不适合独立 controller 测试。
- `terminal-recording-backend.ts` 已有 Worker 的单 in-flight、有界背压、异常关闭模式。只借鉴其生命周期；不为 Workflow 套一层通用 Worker 工厂，不复用 append 的不等待语义。
- `workflow-app-runtime.ts:86` 当前生产路径创建一个 FileWorkflowStore。不要按 node/turn 创建 Worker，也不要把 schema 校验和扫描移出被计时窗口来伪造收益。

## 3. 不能合并的提交边界

以下是**当前事实流程**，不是拟删阶段：

```text
admission/预算/身份 durable
          │
          ▼
      执行本地效果
          │
          ▼
结果 artifact durable → root 中效果事实 durable      [边界 A]
                                  │
                                  ▼
                         终态 frame CAS durable      [边界 B]
                                  │
                                  ▼
                            后继节点可执行

B 拒绝：A 仍保留；后继零派发；不得因缺 B 重做效果。
```

`workflow-native-checkpoint.test.ts:39–62` 已证明上述要求。事务实现必须继续通过该业务验收，不能修改为“root fact 一起回滚”。同理：stop receipt 落盘后才允许 signal；重发命令回执不是第二次效果；Provider physical settlement 不是 completed 的替身。

**可以研究的合并**只有不跨这些边界的内部写入：同一次 canonical frame CAS 所需的元数据更新；或者已证明没有中间可观察授权/执行的纯终态草稿。后者已有 sequence 模式，但本轮 loop 草稿仍未解门禁且已撤回，不作为生产输入。暂不加入跨 root 的 group commit、定时攒批或多个并发用户命令的合并。

## 4. 候选存储：SQL 只承载元数据

这是**待实验方案**，不是现存代码或已确定生产格式。

```text
main / 独立 controller
       │ 既有异步 WorkflowStore 方法
       ▼
一个有界、可关闭的 storage Worker（不是执行 scheduler）
       ├─ 私有 Workflow 元数据 DB
       │    root JSON / frame JSON / planning JSON
       │    SQL 事务内读取、复用原 validator、CAS、提交
       │
       └─ 原内容寻址 artifact 文件
            value / collection / output / governing
            原名称、JSON bytes、hash、权限与读取校验
```

### 4.1 最小数据模型

仅为原型描述必要记录，不先实现 schema framework：

- **roots**：workflowId 主键；canonical serialized root。复用现有 record projection，保持 output/governing 的引用结构，不将 artifact body 复制成另一份权威列。
- **frames**：(workflowId, frameId) 主键；canonical frame JSON。revision、generation、origin、parent 和引用仍由 `nextWorkflowFrame` 校验，不建立第二套同义状态。
- **planning**：workflowId 主键；现有 planning intent JSON。保留 route、queued/unknown、stop 与 outputRef 等原合同。
- 全库一个明确 storage-format version。JSON 内容不能被 SQL 的默认值改写；0、false、missing、unknown 保持区别。

字段索引只为实际 lookup/CAS 服务。不增加 runs/tasks/effects 第二套账本。不把 snapshot 压成不可检查二进制，不保存真实 key、Provider 环境或额外会话内容。元数据 JSON 行沿用原单文件的 8 MiB UTF-8 边界；DB/WAL/SHM 和 artifact 目录按私有用户数据保护，不借统计 DB 的宽松可用性语义。

### 4.2 写入协议

1. 接收原 Store 的有限类型操作。捕获不可变输入和原 canonical cwd/userData scope。Worker 不暴露给 renderer，也没有任意 SQL、路径或命令入口。
2. 使用真实文件 DB，设置并读回 `journal_mode=WAL`、`synchronous=FULL`。macOS 还要核实 `fullfsync`、`checkpoint_fullfsync` 的实际支持及耗时；不能假定 WAL 或 FULL 名称本身证明了既有耐久性。所有写连接配置一致。
3. `BEGIN IMMEDIATE` 后读取当前 root/frame，调用现有 ownership、epoch、claim、frame validator。frame stale CAS 在创建新 value artifact 之前拒绝。SQL 的 numeric predicate 不能替代语义身份检查。
4. 有新 artifact 时，按原编码与 hash 写入、flush、rename，并完成 **artifact directory barrier**。这里不能直接照搬旧 value/frame 共目录的单屏障：新 DB/WAL 不在同一目录提交域，必须先使文件引用目标 durable，再提交 SQL authority。失败仅留 orphan，不记入成功缓存。
5. 写入本次元数据，提交 SQL transaction。只有 COMMIT 证明成功后才能返回 Store 成功、发布可推进的进度或释放后继。
6. 任一错误原样保留必要上下文，拒绝成功；不能回退写 JSON、切 NORMAL、忽略 sync 失败或把 DB unavailable 当空历史。

原生效果的边界 A、B仍是两次业务提交；DB WAL 可能让各次提交更便宜，但不准合成一次回滚域。若尝试捆绑纯 frame 变更，必须先给出具体调用方和独立验收，再最小扩展原 Store 方法；原型阶段不预建通用 transaction 接口。

### 4.3 并发、可见性与未知响应

- 同一请求由 Worker 顺序处理，队列按请求数与字节双重背压；不会无限收集整个 transcript/history。数值上限由原型测得并记录，不能采用比现有合法 Store 请求更小的限制来刷绿。
- SQLite 跨连接写锁解决落盘互斥；**不授予执行权**。执行 owner 仍是原 main/controller，不改成 storage Worker。claim 仍核对 fingerprint、epoch、owner 与恢复证据；save 保持现有 `workflowEpochMatches` 语义，不擅加会拒绝合法调用者的 progress-revision 合同。
- root/frame 各读方法不宣称提供跨请求的一致快照，除非该业务读取显式在同一 DB read transaction 内完成。不要把仅有同一 DB 的事实包装成所有 Service 操作原子。
- Worker error、exit、commit 后回包丢失时，本次写的结果可能 unknown。拒绝/关闭未决请求，不自动重发写入或 Provider 请求；重新冷读当前 canonical root/frame 和既有 command receipt，按原 resume/owner fence 决定后续，不用“连接断了”推断未提交。
- Worker 退出不是 Provider 已关闭。App shutdown 仍先收敛既有执行所有权，再等待存储队列并关闭；close 未证明成功不能自动释放其他 authority。
- 新 Worker 是真实新增的 owned resource。App runtime/独立 controller 负责生命周期，Service 的 listener `close()` 不冒充数据库关闭；临时 fixture 必须显式 drain/close 后才能删目录。需要接入的关闭路径必须在原型前列清，不建全局常驻池或每 node 一个 Worker。
- SQLite 只有一个 writer；本方案可能把原本不同 root 的写入串行化。原型必须包含并行 root、长 artifact 写入与 stop receipt 的竞争，测排队时延，不能只挑单 root。多实例 CAS 还要由独立连接/进程证明，不能用同一 Worker 的顺序队列伪装并发安全。

## 5. 读取与 canonical tamper 合同

`loadValue/loadCollection/loadOutput` 仍读取原文件；`load` 仍读取 governing artifact、核对 bytes hash、验证 ownership/classifier ledger。DB 不能作为“文件曾经正确”的替代证据。缺文件、合法 JSON 后多一个空白字节、伪造引用、错误 generation 均 fail closed；真没有调用与 unavailable 也不能合并。

迁移后 root/frame 的 canonical 载体如果改为 DB，其格式变化必须明示：**旧 root/frame JSON 不再是当前权威，不能同时 dual-write 后把任意一份当真。** 行内容需要原有 schema/identity/ledger 校验；JSON hash 可以发现非一致性损坏，但同库保存的 hash 不是防同用户篡改的密码学证明。SQLite integrity check 也不替代业务合同。

针对旧 root/frame 文件路径的故障注入将不再直接击中新 publisher。未来迁移测试可以改为真实 SQL/COMMIT 故障，但必须保留同等业务结论及旧格式读取验收；不能单纯删掉原文件断言声称通过。不改 value/governing bytes tamper 的核心要求。

## 6. 崩溃矩阵：原型必须证明

下表均是**待验证验收**，不是已通过结果。进程级 kill 不能单独证明断电耐久性。

| 故障点 | 冷读允许的事实 | 必须禁止 |
| --- | --- | --- |
| 校验或 stale frame CAS 拒绝 | 原 root/frame；无新 referenced value | 创建新效果、推进消费者 |
| artifact 写到一半/rename 失败 | 旧 metadata；未引用 temp/orphan 可留存 | 成功 ACK、把 orphan 当事实 |
| artifact directory barrier 失败 | 提交未成功；保留错误 | COMMIT 指向尚未 durable 的新文件 |
| barrier 后、SQL COMMIT 前退出 | 旧 metadata；durable orphan | 自动用 orphan 生成结果或退款重发 |
| SQL COMMIT 返回错误或 storage worker 丢失 | 冷读裁定已提交或 unknown | 仅凭错误自动重派效果 |
| COMMIT 成功、回包丢失 | 新 metadata 可能已存在 | 二次派发、伪造一次新用户批准 |
| native fact A 成功、terminal frame B CAS 拒绝 | A 保留，B 不推进，后继零派发 | 回滚/丢弃 A，或把 B 缺失当重做许可 |
| 新旧 controller 同时 claim | 按既有 owner/fingerprint 规则至多一个获权 | 以 SQLite 锁空闲代替旧 owner 退出证明 |
| canonical artifact 损坏/丢失 | 明确拒绝；不以 DB 中的历史成功覆盖 | warm-cache 放行、0/空数组假成功 |
| stop receipt 回包丢失 | 原 durable stop 意图可查 | 未落盘就 signal，或重复 signal 假装首次 |

恢复测试必须启动真实新 Node controller，保留效果 ledger、冷 Store、原 generation/origin、预算和未知结果。磁盘满、权限拒绝和 WAL/checkpoint 错误也需失败注入；不在真实 userData 做破坏性实验。

## 7. 旧数据迁移与回滚：上线阻断条件

**隔离原型不做迁移。** 只在复制出的临时数据上加载原 FileStore，并对照 SQL Store 的冷读结果；原目录只读。没有自动扫描日常 userData、双写、后台导入或静默切换。

若未来决定生产迁移，必须先满足以下条件，否则不启动实现推广：

1. 明确单写者与旧版本阻断方案。新建一个 migration lock 并不能阻止不知道该锁的旧 App 写 JSON；只检查一次 owner closed 同样不足。此问题不能以“用户不会同时开旧版”代替证明。
2. 独立迁移命令在所有相关执行 scope 已关闭后冻结旧数据，分页校验 root/frame/全部引用，复制 immutable bytes 并验 hash；不把每个 root 一次性读入内存。损坏、unknown 或 legacy 只读状态原样保留，不自动升级为可执行。
3. 新 authority 激活点和 storage-format marker 具有可验证的原子、耐久顺序。崩溃不能让新旧存储同时可写，也不能让缺 DB 自动生成空库继续执行。
4. 初次激活前可以撤销临时目标；激活后的回滚不是把旧 JSON 改回可写。若新格式产生了更多事实，必须先冻结并执行验证过的反向迁移，或只读保留现场。不能无损回滚时明确阻断，不自动覆盖。
5. 迁移耗时、ABI 与打包、只读历史、导出/取证、空间与保留策略有明确验收。保留策略变更另需批准，不新增未经要求的自动 GC。

本设计没有伪称已解决旧版本写入阻断或反向迁移。这两项是推广前的硬问题，不影响先在全新临时 namespace 证伪/证实原型；**不能据原型通过就开放生产迁移。**

## 8. 有上限的实施与性能验收方案

以下需另行授权。测量代码与存储代码分开提交；不把统计口径变化混进优化提交。

### P0：先测完整成本，最多一个候选

- 冻结同一源码/workload/Node/Electron/native ABI。原 5000ms 用例体、controller/check/Agent 数量、三修订 map、两修订 SystemStep、loop carry 与恢复数量不变。
- 先为旧 FileStore 记录业务提交数、root/frame/value/目录/lock 写入、字节与 wall time。SQL 原型必须计入 DB transaction/WAL/checkpoint、Worker cold start/排队/复制和全部 artifact 工作。不能因 SQLite native I/O 不经过 mocked fsPromises，就宣称 fsync 消失。
- 原 `workflow.native-result` 等固定 collector 仍测真实文件写入；新增 SQL 计数有“增加一个真实 durable mutation”的敏感性负对照。OS 层 fsync 计数测不到就 unavailable，不用 SQL COMMIT 数冒充实际磁盘 flush 数。
- 同一 timing lock 串行匹配测量、保存所有样本与 highLoad。预先固定采样范围；首次失败不被后来样本抹掉。高负载下不下稳定 L2 结论。

### P1：等价合同，再看速度

复用而非另造 Scheduler/Service fixture：

| 验收来源 | SQL 原型必须保留的结论 |
| --- | --- |
| `workflow-frame-store.test.ts`、`workflow-store-checkpoint.test.ts` | 多实例 CAS、身份/终态保护、durable value-before-reference、失败不 ACK |
| `workflow-store-governing.test.ts` | 冷读每次 rehash、拒绝失败后的缓存记忆、根提交失败如实暴露 |
| `workflow-native-checkpoint.test.ts` | 精确 outcome reference；frame CAS 失败仍保留 native fact |
| `workflow-sequence-checkpoint.test.ts` | 最后 child link/result、同步阻塞、失败、冷恢复 |
| `workflow-node-stop-journal.test.ts` | durable stop-before-signal、旧 generation fence、丢响应不重复 signal |
| `workflow-system-recovery-process.test.ts` 及既有 recovery process suites | 真实 controller/check、旧 owner 拒绝、tamper refusal、效果零重复 |
| 本轮 5 项原始超时 | 完整业务断言在原 5000ms 内通过；不是只完成 Promise 或删掉 setup |

必要负对照：去掉结果 hash 重读、提前 ACK、绕过 epoch/semantic CAS、把 A/B 合并后在 B 注入冲突。对应保护故意破坏时必须失败，且能观察到具体错误或重复效果风险。不要为适配 SQL 而削弱原验收。

### P2：是否值得继续

只有等价合同通过、匹配 L2 观测确实下降、原 5 秒门禁和完整 unit 通过、canonical performance ratchet 无未解释 worse，才考虑下一步 App test 实例、UI/packaged smoke 和生产迁移设计。原型组件测试不等于真实 App；L2 不等于 L3。

若完整成本没有改善、仍超时、必须减阶段/放宽耐久性才改善，立即记录不成立并停止。没有先验理由继续造另一个日志引擎、进程池或缓存。本轮设计不触发构建/安装、版本升级、CLI 发布、真实 Provider/Jev 探针或 push。

## 9. 交付与下一决定

本页完成了：现有 authority/失败边界梳理、方案取舍、候选提交协议、崩溃与负对照清单、迁移阻断条件、有限原型及性能验收范围。**这是设计交付，不是超时修复。** 当前生产源仍等于 v4 提交，完整 unit 仍有 5 项超时。

下一步负责人：主会话。需要维护者另行批准“只在临时 namespace 做一个 SQLite/Worker 原型及同 workload 测量”，再执行 P0/P1；生产接入、迁移和发布不在该批准内。若不批准，保持现状与证据，不自动开始更大的存储改造。
