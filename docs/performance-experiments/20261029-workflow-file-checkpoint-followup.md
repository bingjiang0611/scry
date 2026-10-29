# File Workflow 检查点减冗余：已落地，5 秒问题未关闭

日期：2026-10-29。仓库 `scry-workflow-m0`，分支 `feat/workflow-m0`。

## 结论

**File 存储路径的三项减冗余改动已提交，但不能称为超时修复。** mac2 聚焦合同 96/96、实验 SQL 93/93 通过；冻结终稿的完整 unit 为 **4526 passed / 1 failed / 4 既有 opt-in skipped**。唯一失败仍是 stable-map 原 5000ms deadline，Vitest duration 5010.5ms。没有以成功子集覆盖它，也没有重跑完整 unit 刷绿。

本轮不再追加文件微优化。建议维护者决定是否另行授权 SQLite 的隔离生产化接线及旧 writer、迁移/回滚、Electron 验证；**当前 App 仍是 FileWorkflowStore，没有接入生产 SQL、迁移真实数据或批准推广。完整 M1–M6 仍未完成。**

代码提交：`42cd553955af6c09ad1c9c77a4d6f0d8f3a99008`。计量改动单独提交：`351b4487`、`69132933`。未 push、升版本或安装/替换日常 App。

## 1. 改动及不变量

1. `src/main/workflow-store-publication.ts` 承担临时文件准备、rename、目录屏障与失败清理；Store 仍负责 schema、命名、大小限制、逐目标写队列、锁与 CAS。这是文件发布职责拆分，不是另建 Store/Scheduler。
2. rename 成功已消耗临时名，不再对该名字调用 `rm`。写入/rename 失败仍清理未发布临时文件；目录 sync 失败仍拒绝 ACK，不删除已经出现的 canonical 文件。
3. `saveFrameWithValue` 允许 value/frame 的临时文件并行 flush，但 frame rename 必须等待 value 的 flush 和 rename。`Promise.allSettled` 收敛两个 writer 后才释放 CAS 锁；缓存仍等成功回执。
4. `src/core/turn-recorder/io.ts` 的正常锁释放在 token 匹配后直接 unlink `owner.json`、rmdir 空锁目录，不递归遍历。owner fsync、token 重查、heartbeat、dead-owner/ownerless 恢复规则未删除。**若锁目录出现非 owner 文件，现在返回 ENOTEMPTY 并保留它，而非递归抹除；调用不报告成功。** 此共享实现同时影响 Recorder，已验证其真实打包 CLI 路径。
5. 实验生成器适配新的文件发布 helper：SQL metadata staging 同样等待 artifact 准备；deferred artifact 目录屏障仍在 SQL COMMIT 前完成，缓存仍在事务成功回执后更新。

```text
value.tmp: write + flush → rename(value) ──────────┐
frame.tmp: write + flush ─────────────────────────┴→ rename(frame) → directory.sync → ACK

native fact A 的持久化/ACK 与后续 frame B 仍是两个独立边界。
上述并行准备只发生在既有 frame/value 检查点 B 内，不合并 A/B。
```

没有改 5000ms、既有断言、固定业务量、Provider 阶段、默认并发配置、源数据校验、epoch、权限或 no-replay 规则；没有新增依赖。新增 8 项测试分别覆盖临时清理 4 项、真实文件并行准备与 value-before-frame 1 项、直接锁释放/错误/额外文件 3 项。

## 2. 输入冻结与环境

- 主要毫秒与合同验收：mac2，macOS 26.3.2、arm64、8 核，Node v24.18.0 / ABI137，Vitest 3.2.7、TypeScript 5.9.3。SQL 为 `node:sqlite` / SQLite 3.53.1，不是 Electron/better-sqlite3 验收。
- 复用先前创建的私有源码/依赖副本，随后用当前 Git archive 与原始 commit object 冻结为上述代码提交；精确 tree：`dca56bb4d5bdae50b7e7fc4d6e05ce150479e811`。它是独立浅快照，不是完整历史 clone。终稿验证前后源码均干净。
- mac2 仅用自建 `TMPDIR` 与 OS 临时树之外的合成 HOME；P0/P1/billing 真实探针变量未开启。没有新增真实 Provider/Jev 调用、账单或业务仓库效果。
- 所有计时经宿主 `timing-run.mjs` 串行加锁。mac2 下述样本均 `highLoad:false`；这只是 CPU load 判定，不证明其他磁盘活动为零。完整 unit 使用仓库默认 2 workers；聚焦合同显式 1 worker。
- 终稿前的诊断快照与终稿只存在 import 排序/注释差异，原样快照已单独保存；完整 unit、最终 SQL、类型、构建、CLI 包检查均使用冻结代码提交。

## 3. 首次失败与最终结果

| 检查/阶段 | 结果 | 证据与范围 |
| --- | --- | --- |
| 改动前单例，带 CPU/IO 诊断 | 1 passed，5 项由 `-t` 筛除；4862ms | `remote/baseline.log/json`；不是原先失败结果的替代品 |
| 只删除多余临时名清理 | 80 passed / 1 timeout；stable-map 5009ms | `remote/candidate.log/json`；方案单独不足 |
| 再并行准备 value/frame | 82/82；stable-map 4668ms | `remote/parallel.log/json` |
| 同版随后诊断单例 | 仍在 5000ms 超时 | `remote/after-profile.log/json`；未完成的计数不能与完成样本算等负载降幅 |
| 再直接释放锁：File 与锁合同 | 96/96；stable-map 4721ms | `remote/release.log/json`；原共享 58 + revision 19 + 新 5 + Core 锁 14 |
| 同版完整诊断单例 | 1 passed，5 项由 `-t` 筛除；4540ms | `remote/release-profile.log/json` |
| SQL 全合同 | 93/93；冻结终稿后另一次仍 93/93 | `remote/sql.log/json`、`remote/sql-final.log/json`；后一次为源输入冻结后的验证，不覆盖早期失败 |
| 冻结终稿完整 unit | **4526 passed / 1 timeout / 4 skipped** | `remote/full-unit.log/json`，4531 项；500.55s，总 CPU load 3.44→5.16，8 核 |
| Node/Web、实验及生成 Store 类型 | 全部通过 | `remote/typecheck.log`、`experiment-types.log`、`generated-types.log`；生成 Store 的 typecheck 副本 `cmp` 一致 |
| App 编译 | `npm run build` 通过 | `remote/build-app.log`；只是 electron-vite 编译，不是打包、安装或真实 App 验收 |
| 独立 Recorder 分发面 | `build:cli`、`smoke:cli-package` 通过 | 真实 npm tarball 临时安装，CLI 0.2.52 的 init 幂等、doctor、合成 Claude/Qoder Hook 录制及 verify；不是调用真实 Provider |

完整 unit 的唯一失败：

```text
src/main/workflow-dynamic-revisions.test.ts
matches stable map keys, reruns only the changed item and its consumer,
and collects current ordered facts
Error: Test timed out in 5000ms.
```

它位于本次目标路径，不列为无关失败。此前完整生产 unit 的 4514/5/4 来自另一轮/另一机器；不能把两个总数差直接归因本次优化。

## 4. 证据敏感性

- 新清理测试对旧生产实现出现 2 项预期断言失败；原失败日志 `local/cleanup-before.log`。
- 故意去掉 `beforePublish` 等待后，真实文件测试以 `frame published before its value` 失败；`local/negative-before-publish.log`。首个 alias 写错导致未收集测试，另存 `negative-invalid-alias.log`，**不算有效负对照**。
- 新锁释放测试对旧实现 3 项确定失败；`local/lock-before.log`。修复后连同既有锁/检查点测试 20 项通过。
- 冻结终稿的七类 SQL 负对照共 **9 项预期失败**：metadata hash、result hash、提前 ACK、frame CAS（2）、epoch、过早 value cache（2）、真实合并 A/B 回滚。`remote/negative-summary.json`。
- A/B 控制由独立判读器证明：A 实际 put、B 真实 CAS 拒绝、同事务 ROLLBACK、新只读连接读不到 A，并触发原 `committedBeforeFrame` 断言。`remote/negative-ab-verification.log`。不是导入错误、只通过正向测试或伪造 rollback。
- 初次准备使用了不符合 `scry-checkpoint-` 前缀的输出目录，guard 拒绝，尚未生成产物；原日志保留在 `local/initial-path-refusal/`。未削弱 guard。

## 5. 能证明的性能结论

一个完成的原始诊断与一个完成的最终诊断，业务调用/数据规模一致：planning 4、artifact 114、root 40、frame 112；文件字节计数 1,085,520、flush 成功 270、显式 sync 成功 388、rename 270 均相同。**没有通过减少文件 flush 或目录/owner sync 取得收益。**

前者记录 426 次匹配 `rm`；后者无匹配 `rm` 计数项，转为 156 次 unlink 与 156 次 rmdir。新回归另外直接禁止成功 rename 后的临时名清理。这只说明已观测的 JS API 与代码路径变化，不是总内核操作数或设备写入量。

CPU profile 覆盖 worker 启动到退出，约 5627ms 中 idle 4393ms；不能把它当作单独 test body 的精确分解。FS 方法时间为 inclusive、可重叠。完成样本 4862→4540ms 是**单对受控 L2 观察**，不是统计稳定性、L3 日常收益或完整门禁改善证明；完整 unit 的失败优先于这个局部结果。

另运行：

在仓库根目录经宿主锁执行：

```sh
trial=$(mktemp -d /tmp/scry-checkpoint-file-counter.XXXXXX)
node .agents/skills/scry-performance-climb/scripts/timing-run.mjs file-map-counter-ratchet -- \
  npm run performance:measure -- --scenario workflow.native-result-checkpoint \
  --compare 69132933 --out "$trial/performance"
```

固定 native-value writes 在 baseline/candidate 各 5 次均为 1，无计数回归。**该指标是 unregistered，ratchet 不拒绝不等于已注册门禁通过。** 本机该次 `highLoad:true`，不用其耗时作 L2 结论。自动创建的 baseline worktree 已从注册列表移除，未触碰其他 worktree。

SQLite native 总 fsync、物理设备写入字节仍 unavailable；不以 COMMIT 数、WAL 大小或未完成 File 样本补造结果。

## 6. 归档、资源与交付范围

本机持久证据目录：

```text
/Users/baobingjiang/.local/state/rotom/verification-evidence/workflow-file-checkpoint-20261029.1GsINU
```

入口 `manifest.json`、`final-state.json`；含代码 tar/raw commit、全部首次失败与原日志、CPU profiles、生成 Store/Worker/负对照、合成失败 fixture、App 编译输出与 CLI dist、执行脚本和文档 hashes。输入 tar SHA-256：`d8f68ed93613c5a15eb47d76a61efcf752f72f87f8ead1465234cef030140262`；远端证据 tar：`672fde54fda8c1700474c35c184e0faaa66cf60fe343acfdd457d800caa6fc26`。

原始证据含一个授权测试用的 `escape.sh -> /bin/sh` 符号链接；本机只保留 tar 与链接元数据，**未物化、跟随或执行**。合成 HOME 的 4 文件/121,628,343B 另有原样归档，绝大部分为 Electron 42.10.1 依赖缓存 ZIP，不是日常 App 安装。

mac2 保留私有源码 `/tmp/scry-checkpoint-mac2.pCyZT4/source`、本轮现场 `/tmp/scry-checkpoint-file-map-fix.2hxJ26`、合成 HOME `/Users/test/scry-checkpoint-file-map-home.1RuA42` 供复盘；不清理用户原有项目或进程。195 份正/负 SQL namespace 报告均 `openNamespaces:0`；收尾的上述路径进程查询没有匹配项。两项都是登记/查询范围的证据，不是整机审计。

**仍未验证**：完整门禁稳定绿色、当前代码的真实 App 交互、Electron/better-sqlite3 与 Node20/22/Linux 矩阵、硬件断电、生产 SQL 接管/旧 writer 阻断/迁移回滚、跨 Provider/完整 billing-Jev 及完整 M1–M6。编译、包 smoke、资源关闭不替代这些结果。

## 下一决定

负责人：维护者确认范围，我继续实现/验证。建议不再追加 File 微优化；是否授权下一阶段**仅在隔离 test 实例进行 SQLite 生产化接线与兼容/迁移回滚验收，暂不迁移真实数据或安装日常 App**？本轮授权不自动扩展为该决定。
