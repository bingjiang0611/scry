# Workflow File / SQLite 双后端合同收口

日期：2026-10-29 UTC。范围：维护者授权改造测试结构、建立双后端合同；**不接入生产、不迁移真实数据**。前轮记录：[SQLite 原型评估](20261029-workflow-sqlite-checkpoint.md)。

## 结论

原 SQL 扩大合同的 13 项失败与 1 个未处理拒绝已不再出现。相同的 58 项共享合同在 SQL 上通过，连同全部 19 项 revision 与 16 项原型检查，共 **93 passed / 0 skipped**。另用带计数器的配置执行 IO meter，**3 passed**。

File 侧曾 **58 passed**；最终高负载复验为 **56 passed / 2 个原 5000ms 超时**。两项未改动的进程恢复路径仍不能宣称稳定通过。生产 FileStore 没有切换，也没有修复生产超时；**完整 P1、完整项目与推广均未完成**。本轮不提供加速结论。

## 实现与合同边界

- `src/main/workflow-storage-probe.fixture.ts` 是测试专用 File 驱动；实验 resolver 仅在显式 opt-in 时换成 `experiments/workflow-checkpoint/storage-test-probe.ts`。没有运行时后端注册表、默认测试排除或新依赖。
- 业务合同仍调用原 Store/Runner/Service。只把 canonical metadata 的检查、输入篡改与物理发布故障交给对应驱动。原 File 的双文件 flush、两个 rename、一次目录 barrier、root 单次 rename、governing 零重写断言移入 File 驱动，**没有删除**。
- File 发布等待真实目录 `sync`；SQL 等待真实 Worker COMMIT。SQL 的独立连接在 COMMIT 被暂停时必须仍读到旧 authority；artifact 必须先 flush、rename、完成目录 barrier。两种物理操作不冒充同一种计数或同一故障。
- SQL 语义篡改直接写 canonical `metadata` 表，并重算 envelope hash，以触发 stop/epoch 等业务校验。另有独立 metadata-hash 负对照验证字节校验；不再写无效的 shadow JSON。
- `sqlite-setup.ts` 延后加载 Runtime，让合同文件先安装 fs 故障探针；`vitest.contracts.config.ts` 继续不预载 method/IO meter。不能把依赖 meter 的测试放到这个配置里。
- native fact A / frame B 合同增加了**尝试 B 之前**的独立 canonical 读：A 必须已经可见。保留 B CAS 拒绝后 A 仍存在、Agent 不派发、frame 不推进的原断言。这不是把 A/B 真正合并后回滚的负对照。

### 修复的真实原型问题

首轮真实 SQLite COMMIT 拒绝揭示：生成 Store 在外层 SQL COMMIT 前就调用 `rememberOutput`。COMMIT 失败后，缓存仍声称值已知；删除 orphan 后再 `saveValue` 会跳过重写，随后 `loadValue` 报缺失。

`prepare.mjs` 现在只在 `withFrameLock` 对应的**整个事务收到成功回执之后**才记住值。生成 Store 为 **19,720B**，未修改生产 `workflow-store.ts` 或其校验器。修复提交：`ecb4a680`。

Worker 新增两个有界故障入口：`constraint_commit` / `hold_constraint_commit`。连接私有 TEMP 表的 deferred foreign key 在真实 SQLite COMMIT 中报错，不是手写假错误。`DatabaseSync.isTransaction` 仍为 true 时，才认定本次提交未发布，随后执行 ROLLBACK；否则保持 unknown。COMMIT 后真实 Worker 退出、丢回复时仍 fence，拒绝后续操作，不重发写。

这是**真实 SQLite 约束提交拒绝**，不是 ENOSPC、设备故障或断电证明。没有新 callback、自动重试、双写或迁移机制。

## 验证与首次失败

环境：Node **24.18.0 / ABI137**，macOS arm64、10 核、内建 SQLite。所有计时执行均经 `timing-run.mjs` 串行加锁。最后 SQL 批次 load **64.87→35.02**、File 复验 **18.94→29.46**，均 `highLoad:true`；只报告合同结果，不比较延迟或宣称 L2/L3 加速。

证据根：

`/Users/baobingjiang/.local/state/rotom/verification-evidence/workflow-checkpoint-contracts-20261029.wxF37l`

临时根：`/tmp/scry-checkpoint-contracts.MrSMWS`。原日志、失败版源码/生成物、故障派生版本与最终输入快照分别保留，不拿后来的源码冒充首轮。

| 检查 | 结果 | 证据（归档内 `temporary/`） |
| --- | --- | --- |
| 最初 File 原 50 项 | 50 passed | `file-first.log/json` |
| 首轮 SQL 原 50 + 新 16 项 | 63 passed / 3 failed | `sql-first.log/json`、`first-failed/` |
| 修复后同批次 | 66 passed | `sql-fixed.log/json` |
| 加入 recovery 全部 8 项后的 File | 58 passed | `file-final.log/json` |
| 最终 File 复验 | 56 passed / 2 timeout / 0 skipped | `file-delivery.log/json` |
| 最终 SQL：共享 58 + revision 19 + 原型 16 | 93 passed / 0 failed / 0 skipped，无未处理拒绝 | `sql-delivery.log/json` |
| 原配置下 IO meter 敏感性与 overlap | 3 passed | `io-meter-correct-config.log/json` |
| 标准实验配置下原型检查 | 16 passed | `backend-probes.log/json`；与 93 项里的 16 项重复，不累加 |
| Node/Web、实验与生成 Store strict TS | 通过；生成 Store 的虚拟源码副本与 build 字节一致 | `typecheck-final.log`、`typecheck-prototype-final.log`、`typecheck-generated.log`、`tsconfig.generated.json` |
| performance ratchet | 10 passed | `ratchet.log/json`；未更改上限或台账 |

首轮 SQL 三项失败中，两项是新增测试错误地构造了缺少必要证据的 `failed` frame。修正为合法、独立的 entered-frame 更新，以验证已知 rollback 后仍可写；没有修改生产 frame 合同。第三项是上述真实缓存问题。

另一次把 IO meter 三项错误地放进不加载 meter 的 contracts 配置，出现 `undefined` 计数（`sql-final.log/json`：93 passed / 3 failed）。未改计数断言或 skip；在原 `vitest.sqlite.config.ts` 下三项通过。最终功能 93 项与 meter 三项按各自配置分开执行。生成 Store 的额外 TSC 检查最初两次配置错了临时虚拟目录布局，出现相对模块解析失败；修正为与真实 `src/main` 同构的 `typecheck/main` 后通过，并用 `cmp` 证明源码字节未改。两份失败日志保留为 `typecheck-generated.*-harness.log`，没有改项目 TS 配置或放宽校验。

### 两项 File 超时的调查

- `workflow-recovery-process.test.ts`：`continues after a hard controller exit without repeating a completed native child`。
- `workflow-system-recovery-process.test.ts`：`recovers the sealed branch/native/child facts without redispatch; corrupted canonical bytes=false`。

这两份测试、fixture、controller、生产 Store/Runner/Service 相对 `c4996aba` 均无改动。诊断已保存到 `failed-process-fixtures/recovery.json`、`native.json`，`stage: closed`。

第一例 crash 控制器在 spawn 后约 2951ms 退出，resume 获得约 2050ms 后到达整例 deadline；第二例 crash 约 4074ms，resume 到 deadline 时约 751ms。两边 resume 的 trace 仍显示 frame/record 推进，未见 Worker 悬挂等待；测试清理发送 terminate 后，注册控制器均出现 `parent_close` / `parent_cleanup_close`。它们不是恢复完成证明，不能把清理成功当作 no-replay 验收通过。

这些是高负载下的诊断时钟，不是可信性能基线；**没有证明高负载是唯一根因，也没有放宽 timeout、加 sleep/retry 或用重跑抹去失败**。下一步由维护者决定是否另开低负载基线/慢路径定位，本轮不扩大到生产优化。

## 故意破坏的有效负对照

只改 prepared build 下的派生文件；每个 manifest 都标为不可推广。正常输入在上述正向批次通过，破坏后出现对应断言失败，不是导入/构建错误或零测试。

| 移除的保护 | 失败数 | 可读结果 |
| --- | --- | --- |
| metadata bytes hash | 1 | 同值、不同字节被错误接受，rejects 断言失败 |
| immutable result hash | 1 | 改值被错误接受，rejects 断言失败 |
| COMMIT 前不 ACK | 1 | 暂停 COMMIT 时 `acknowledged=true` |
| frame transition/CAS | 2 | 两控制器都 committed；已选分支可覆写 |
| epoch fence | 1 | takeover 后旧控制器 `save(oldRecord)` 被错误接受 |
| value cache 等待事务回执 | 2 | rollback 后缓存跳过重建，读取值缺失 |

日志：`negative-<mode>.log/json`；汇总：`negative-summary.json`。`-t` 产生的 pending 是显式筛选，不是新增 skip。最初保留的旧 build 也让缓存回归两项确定失败（`cache-control.log/json`）。

临时汇总脚本第一次未识别 Vitest JSON 将 rejects 断言序列化为 `Error: promise resolved ... instead of rejecting`，虽然日志清楚标为 AssertionError。只修正了结果读取器，并复用已执行的 metadata 控制日志；没有重发该测试，也没有把基础设施失败算成保护证据。

## 未完成与交付边界

- **真正把 A/B 合并到同一事务，再让 B 失败并观察回滚的负对照仍未执行。** epoch 负对照本轮已补；A 在 B 前可见的正向检查不能替代前者。
- File 两个 deadline 失败未解决；完整生产 unit 没有重跑为绿。本轮没有完整 App、真实 Provider/Jev、账单、跨 Provider 或业务仓库验收。
- 未验证 Electron/better-sqlite3、Node20/22、Linux、设备断电、总 OS fsync/物理写入字节、生产接管、旧 writer 阻断、迁移与反向迁移。
- 不修改 default test config、依赖、5000ms、固定五例负载或 performance ratchet；不构建/安装 App，不推送，不改变真实用户数据。
- 因上述边界仍不批准推广。当前交付只是共享合同与真实回归修复；下一阶段由维护者选择 A/B 合并负对照及 File deadline 基线调查。

复现：[实验 README](../../experiments/workflow-checkpoint/README.md)。
