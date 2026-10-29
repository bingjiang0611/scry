# Workflow SQLite/Worker 隔离原型：有收益样本，尚不能推广

日期：2026-10-29 UTC（macOS 本地 10-28）。仓库 `scry-workflow-m0`，分支 `feat/workflow-m0`。

## 结论与交付状态

**授权的隔离评估已执行，生产超时未修复。** 一个 SQLite/Worker 候选在同一组原 5000ms 测试中 5/5 通过；文件版同轮 2 通过、3 超时。65 项聚焦检查通过，但扩大合同检查仍为 **37 passed / 13 failed，另有 1 个未处理拒绝**。不能把这些结果合成“完整门禁通过”。

原型保留在 `experiments/workflow-checkpoint/`，没有接入生产构造入口。`src/` 自 v4 `684bf80a5e187de239ad68ff1e0ff5e11664ba2d` 完全未变。没有更改已有测试体、timeout、固定 workload、断言或默认生产测试配置；没有新 Provider/Jev 调用、迁移、App 构建/安装、版本升级、发布或 push。

| 交付 | 提交/状态 |
| --- | --- |
| 初始方法测量，先于原型 | `48f5295d` |
| 同口径 JS IO collector、敏感性/overlap 回归 | `a8ddfe93`、`9c0368e4`；后者补计真实 sibling initialization lock |
| 不含业务计数增量的隔离 backend | `31b73b96`；独立 scoped typecheck 与 48 项既有合同通过 |
| SQL 工作量计数与故障检查，和 backend 分开提交 | `dcb54f39` |
| 结果 hash、提前 ACK、frame CAS 负对照 | `3fffbf2d` |
| 合入主线/部署/生产生效/L3 | 均未发生；原型不是 App build |

当前完整生产 unit 的最后结果仍是 [超时后续报告](../../designs/scry-workflows/timeout-followup.md) 中的 4514 passed / 5 timeout / 4 skipped；本轮没有反复跑全量 unit 刷绿。源码未切换 backend，不能把原型的 5/5 当作生产问题已消失。P1 不合格，未进入设计的 P2 完整 unit、App 与迁移推广阶段。

## 1. 环境、候选与冻结范围

- 两侧均为 Node **24.18.0**，模块 ABI **137**，macOS arm64，10 核；SQLite **3.53.1**。
- 设计原先优先考虑已安装 `better-sqlite3`，但安装物 ABI **146** 与本次 Node 所需 **137** 不符；以只读依赖、仅尝试 `:memory:` 的当前 preflight 复核，原始错误保存在 `better-sqlite3-abi-current.log`。未重建或替换共享依赖；原型改用 Node 24 原生 `node:sqlite`。**这不是 Electron 或 better-sqlite3 验收，也不声明 Node 20/22、Linux 支持。**
- 原型只接受 `/tmp` 或 macOS 原生临时树中的 `scry*` namespace。`TMPDIR` 不能把用户目录变成获准存储；拒绝该路径且未创建 DB 的回归通过。
- 独立 Worker 内使用 WAL、`synchronous=FULL`、`fullfsync=ON`、`checkpoint_fullfsync=ON`，启动时读取确认；初始化/版本/缺 DB/损坏均拒绝，不读空历史、不双写、不自动迁移。
- root/frame/planning 元数据放入独立 SQLite；value、collection、governing、output 等 artifact 仍走原文件实现。复用原 FileWorkflowStore 验证、Runner、Service、slots 和 frames，不另造 scheduler。
- 生成器仅替换存储原语和目录枚举，并跟踪延迟 artifact barrier；生成 Store 为 **19692B**。原公共 API、8MiB 上限、身份验证、终态与 semantic CAS 保留。生成文件、Worker 与原始 Store 的 hash 均留在 manifest。
- 一个 namespace 一个 Worker，最多 64 个业务请求排队；关闭保留一个控制位置，队列满时仍能释放 Worker。独立 root 共用 namespace 时不串事实；独立进程 CAS 只允许一方提交。

提交顺序没有把事实 A 与控制推进 B 混成可回滚域：

```text
新 artifact：文件 flush → rename → 真实目录 barrier → SQL 元数据 COMMIT → ACK
原生事实 A 的 durable root commit   ≠   后续终态 frame B 的 commit
```

B 的 CAS 失败时 A 必须保留，原 `workflow-native-checkpoint.test.ts` 在 SQL 路径通过。Worker 在 COMMIT 后、回包前真实 `process.exit(74)`；调用方收到 unknown、拒绝后续写入，关闭后冷读裁定已提交，未自动重发。

## 2. 同 workload 的最终对照

文件为 `workflow-dynamic-loop-revisions.test.ts`、`workflow-dynamic-revisions.test.ts`、`workflow-system-revision.test.ts`。同一个 `-t` 选中原五例，其余 14 例是该对照的显式筛选，**不是新增 skip**；随后的聚焦批次执行了这三个文件全部 19 例。

| 原用例 | FileStore | SQL/Worker |
| --- | ---: | ---: |
| loop carry 修订 | 4505ms，通过 | 2385ms，通过 |
| stable map keys 修订 | 5003ms，超时 | 3301ms，通过 |
| mixed SystemStep/Agent 修订 | 5156ms，超时 | 3818ms，通过 |
| 相同 scalar、native definition 改变 | 5185ms，超时 | 3246ms，通过 |
| legacy first SystemStep 修订 | 3907ms，通过 | 2893ms，通过 |

- `comparison-stock.log`：exit 1，CLI wall **16599ms**，load **5.34→5.45**。
- `comparison-sqlite.log`：exit 0，CLI wall **12259ms**，load **5.45→5.06**。
- 两侧均经 `timing-run.mjs` 串行加锁，`highLoad:false`。这是 **L2 受控、已构建 fixture 的观察样本**，不是日常 App、冷 App 启动或稳定分位数。历史高负载样本和先前 2 项超时的对照也全部保留，不选最好的一轮抹掉失败。
- Worker 创建、DB 打开、排队、消息复制、artifact 与 COMMIT 都在原流程内。CLI wall 包含测试 hook 的关闭工作；显式生成源码/编译 Worker 是事先构建步骤，不在上述 wall 或单例 5000ms 内。没有把 fixture 的 controller/check/Agent 阶段或 Store 初始化搬出原测试体。
- 失败 FileStore 的计数只是未完成前缀，可能含失败收尾，不能拿它和 SQL 完整执行算业务工作量缩减率。通过样本也不能证明所有五项原超时的唯一根因。

### 减少的工作去了哪里？

下面只比较两侧均完成的 loop 用例。业务提交次数未减少：planning **4**、root **22**、frame **83**、artifact **82**，两侧一致。

| 观察维度 | FileStore | SQL/Worker | 含义 |
| --- | ---: | ---: | --- |
| 已发布 value 文件 | 72 | 72 | 没有删 value 事实 |
| JS `writeFile(flush:true)` 成功 | 191 | 83 | 元数据移入 SQLite，不能当作总 fsync 下降 |
| 显式 FileHandle.sync 成功 | 283 | 85 | 包含测得的目录/锁 IO；SQLite native IO 不在此数内 |
| 目录锁创建 | 109 | 1 | SQL 侧仍计入真实初始化锁；其余互斥转为 SQL transaction/有界队列 |
| JS writeFile 累计文本字节 | 481871 | 53202 | 不含 FileHandle.writeFile 与 SQLite，更不是设备写入量 |
| FileHandle.writeFile 累计字节 | 9483 | 87 | 锁 owner 文件等；和上一行分开 |
| SQL COMMIT / 成功 put | 不适用 | 109 / 109 | 对应原 109 次 metadata 提交，没有跨业务边界合并 |
| SQL mutation 文本字节 | 不适用 | 428733 | 原元数据成本移入 DB，不是消失 |
| DB / WAL 关闭前大小 | 不适用 | 4096 / 1874632B | 是大小快照，不是累计写入量；db.close 的最终 checkpoint 不在该快照里 |

SQL 新增了每次定位 namespace 的 canonical realpath 工作（该例 449 次请求）；这是原型的额外成本，未伪装成优化。尚未做跨请求缓存。关闭/最终 checkpoint 的时间在完整 CLI wall 内，但没有独立可信毫秒分解。

**L1 只确认文件发布转为 SQL 元数据提交，未证明总 OS fsync、总物理字节或总磁盘工作下降。** 这些值为 unavailable：SQLite native VFS 不经过 fsPromises，JS collector 只覆盖其列出的 API（不含 readFile 等未插桩 API）和返回的 FileHandle。SQL COMMIT 不等于一次硬件 flush，WAL 大小也不等于累计写入量。

## 3. 验证与负对照

| 检查 | 实际结果 | 证据 |
| --- | --- | --- |
| 最终聚焦批次，11 文件 | **65 passed，0 skipped**；含全部 19 revision 例、14 原型故障/边界例、3 个 IO meter 回归与既有恢复/stop/CAS 合同 | `final-contracts.log/json`，load 5.94→5.29，highLoad:false |
| 后续增强 held-COMMIT 断言 | 14/14；冷连接读完旧 frame 后仍不得提前 ACK | `prototype-strengthened-final.log/json` |
| 同组原文件专用合同，生产 FileStore | **50 passed** | `contracts-stock.log/json`；highLoad:true，不作速度结论 |
| 同组扩大合同，SQL 路径最终版 | **37 passed / 13 failed；1 unhandled rejection** | `contracts-expanded-final.log/json`；load 5.14→4.53，highLoad:false |
| 元数据 hash 保护删除 | 预期 1 failed：相同 JSON、改变 bytes 被错误接受 | `hash-negative-final.log/json` |
| canonical value hash 保护删除 | 预期 1 failed：被追加空白的 artifact 被错误接受 | `negative-valid-result-hash.log/json` |
| COMMIT 前故意 ACK | 预期 1 failed：acknowledged 已 true | `negative-valid-early-ack.log/json` |
| frame transition/CAS 校验绕过 | 预期 2 failed：两个 writer 均成功、已选 arm 可被改写 | `negative-valid-frame-cas.log/json` |
| Node/Web typecheck、独立原型 strict TS | 通过；无 any/ts-nocheck | `typecheck-final.log`、`typecheck-probes-final.log` |
| performance ratchet 单测 | 10 passed；门限、基线和 workload 未变 | `ratchet-final.log` |

故障检查包括：真实 artifact rename 错误、真实目录打开屏障失败、COMMIT 前失败、真实 Worker 回包丢失、不可重发、冷读零/false、canonical bytes、缺 DB 不补空库、旧 JSON 不迁移、满队列仍能关闭、并发 root 与双进程 CAS。不是只 mock 一个返回值表示成功。

epoch 故意破坏、把 A/B 真正合并后回滚的负对照还没有执行；现有活 owner 拒绝、跨 controller 冷恢复与 A 保留的正向合同通过不替代这些负对照。**P1 未完成，不能据已有负对照宣称全部信任/恢复保证已被证明。**

## 4. 为什么扩大合同仍失败

没有删除、skip 或修改这些原断言。最终 13 个失败位于四文件：

- `workflow-store.test.ts`：6 个。直接读/改 root/planning JSON、检查 stripped epoch、篡改 stop identity/receipt、检查 planning receipt 的物理文件。原型改为 SQL 后，这些旧路径不再是 canonical；包括 ENOENT，以及写了 shadow JSON 但 SQL 仍返回未改事实。
- `workflow-store-governing.test.ts`：3 个。两个直接读旧 root manifest；一个对旧 root 文件目录 sync 注入失败，未作用于 SQL COMMIT。
- `workflow-store-checkpoint.test.ts`：2 个。期待 value/frame 两次 rename 和共享文件目录屏障；SQL frame 没有第二次 rename，故原故障入口与等待点失效。
- `workflow-sequence-checkpoint.test.ts`：2 个。等待旧 terminal-parent 文件目录屏障，SQL 路径没有这个等待点，原 5000ms 超时。

另一个未处理拒绝为 `frame rename failed`。源码中 `mockImplementationOnce(actual.rename).mockImplementationOnce(throw)` 的第二次 frame rename 在 SQL 路径未发生，断言失败后遗留的 once mock 被后续 value rename 消耗；后续测试在真实 barrier 前已拒绝，却仍等待原 gate。日志 stack 与源码吻合。没有用吞错、延长 timeout 或跳过这些测试隐藏它。

这些结果不能直接当作“13 个已证明产品 bug”，也不能豁免。说明现有文件实现专用的物理故障入口，尚不能作为 SQL 的完整等价合同。新增 SQL 探针只补了部分证据，没有替代整套 governing/cache、planning/stop 数据损坏、terminal sequence 和 root COMMIT 失败测试。**必须先建立不削弱语义的 File/SQL 双后端合同，才能判断 P1 合格。**

## 5. 首次失败与限制

- 初次原型因尚不存在的 userData 父目录 realpath 失败；修为从既有 canonical ancestor 定位，并重验初始化路径。首次 `candidate.log/json` 保留。
- 初次真实 recovery controller 已写结果但 Worker 没关闭，两个原 5 秒测试失败；控制器 PID **40282、40379** 的 spawn receipt、精确 command/lstart 重验及 SIGTERM 后退出证据在 `first-recovery-cleanup.json`。只清理自有测试进程，没有操作其他 PID。
- 修复是测试 controller 的 owned storage close/生命周期绑定，不是把 Worker unref 或提高 deadline。后续普通退出、硬 controller exit、旧 owner 与 cold no-replay 检查通过，最终报告 openNamespaces=0。
- 初写探针时，setup 已预载 Store，测试本地 fs mock 未作用到该实例，导致 3 个探针失败。没有改原合同；新探针改为真实路径冲突/目录移动造成 IO 错误。初次与修正日志均保留。
- IO collector 最初漏计 sibling 初始化锁；`9c0368e4` 补齐，新增真实 lock 与无关文件排除回归，最终比较使用修正口径。早期数字不作最终结论。
- 早期未提交 Runtime 的完整源码快照未独立冻结；初次日志、生成 Store/Worker 保留，最终代码另行快照，不把后者当作初版。
- 部分早期负对照准备失败（anchor 不匹配、临时路径 /tmp 与 /private/tmp 不一致导致导入失败、0 test collected），**不算保护失效证明**。只有上述 assertion 确定失败的 valid 日志算有效负对照。临时 scoped typecheck 的 typeRoots 路径错误也已修正，未改项目类型合同。
- 不验证断电、磁盘控制器 flush、Electron/原生 ABI/打包、迁移/旧 writer 阻断、真实 App/Provider 或生产 takeover。没有安装包，也不要求用户重启日常 App。

## 6. 复现、证据与下一决定

命令入口与固定选择范围见 [experiments/workflow-checkpoint/README.md](../../experiments/workflow-checkpoint/README.md)。源码生成不是新的存储 API；同一个 Worktree 内保持单写者。不得对真实 userData 调用原型或把测试 alias 接到 App。

持久证据目录：

`/Users/baobingjiang/.local/state/rotom/verification-evidence/workflow-sqlite-checkpoint-20261029.RMj5Ct`

临时生成物/日志原件：`/tmp/scry-checkpoint-sqlite.kUwzaD`。持久归档包含日志、JSON、生成 manifest/代码、故意破坏的负对照版本、初次 recovery 诊断、最终源码快照及 hashes；`manifest.json` 核对输入与完整文件 hash。归档原件是验证依据，报告摘要不升级 unknown。

下一步负责人：主会话。**建议先征求维护者是否继续授权修改现有存储测试结构，建立共享 File/SQL 合同与对应故障入口；仍不接入生产。** 补齐后重新评估 P1、完整 unit 和 Electron ABI。当前停止推广；不申请放宽 5000ms、持久化或批准“先用起来”。生产迁移仍需独立解决旧版本 writer 阻断、authority 激活与反向迁移。
