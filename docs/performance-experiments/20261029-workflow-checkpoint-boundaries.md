# Workflow：真实 A/B 回滚负对照与 File 恢复阶段调查

后续：[mac2 低负载复验](20261029-workflow-checkpoint-mac2.md)已通过 File 共享 58 项与 SQL 全部 93 项；File 扩大批次仍 76/77，stable-map 单例低负载也超时。下文保留本轮历史结果；低负载机器不再是复验阻碍，但生产超时仍未修复。

日期：2026-10-29 UTC。范围：维护者继续授权的两个事项；仅合成数据和临时 namespace，不接生产、不迁移、不放宽 5000ms。前轮：[双后端合同](20261029-workflow-checkpoint-contracts.md)。

## 结论

**A/B 真合并回滚负对照已闭环；File 恢复超时尚未修复。** 本轮新增的是测试/证据工具，不是生产持久化改造。生产 Store、Runner、默认测试配置、依赖、固定业务负载与 timeout 均未改变。

最新 SQL 批次为 **92 passed / 1 timeout / 0 skipped**，不是前轮的 93/93。File 的完整 10 项进程合同首次为 8 passed / 2 timeout，两次不同粒度的诊断各为 9 passed / 1 timeout。所有测量均 `highLoad:true`；不能提供新的加速结论，也不能把机器负载定为唯一根因。完整稳定性、完整项目及推广仍未完成。

## A / B：确实在同一 SQLite 事务内丢失事实

正常路径要求：

```text
A：native fact COMMIT → 独立连接可见 A → B：frame CAS 拒绝 → A 仍存在
```

`negative-native-merge.mjs` 只生成明确标记“不具备采用资格”的错误派生版本：A 的真实 SQL put 不 COMMIT，却向上返回；后续 B 进入同一未结束事务。原 Store 的 CAS 校验仍执行，不伪造 SQL 异常。

最终负对照记录的是同一 **transaction 15**：

```text
BEGIN IMMEDIATE（isTransaction=true）
  put workflow-….json                  ← A
  get workflow-….<hash>.frame.json      ← B 的真实 CAS 读
ROLLBACK（之前=true，之后=false）
  新建只读连接：nativeFactCommitted=false
```

该事务没有 COMMIT。真实 B CAS 拒绝后，Worker 在回复 ROLLBACK 之前用另一条只读连接检查 canonical root，证明 A 已丢失。既有业务测试在 `expect(committedBeforeFrame).toBe(true)` 处确定失败；不是导入错误、零用例或仅手工篡改最终 JSON。失败处理可能从内存重新写入事实，所以只看最终 root 不足以证明 A 曾独立提交。

正常原型的两项 native 边界检查通过；最终 93 项批次内这两项也通过。新负对照只筛选其中一项：**1 项预期断言失败、1 项被筛选**，不是新增 skip。

实验 resolver 仅在派生 manifest 显式提供 `runtimePath` 时换成错误 Runtime；默认仍使用原 Runtime。派生 Worker 和 Runtime 源码、编译物及 hash 一起保留。两处负对照日志各限 128 条并发出截断标记；判读器拒绝截断证据。没有改变正常 Worker/Runtime 或生产入口。

`verify-evidence.mjs` 同时核对业务断言、同事务 put/get、真实 rollback、独立冷读和 namespace 关闭。删除冷读 receipt 或进程 profile receipt 后，它分别确定拒绝输入。旧 metadata-hash 模式也重新生成并触发原预期失败，证明新增解析路径没有把该保护静默旁路。

## File：已定位阶段，未定位唯一系统根因

新增显式 `SCRY_WORKFLOW_RECOVERY_PROFILE=1`：

- 子控制器只汇总 `save`、`saveFrame`、`saveFrameWithValue` 的调用、完成、拒绝和 inclusive 时间；保留原返回值与错误。
- 记录 engine 等待、父进程 spawn/close、Node time origin、bootstrap 和 controller entry；不增加 preload、sleep 或重试。
- 只增加固定大小退出 receipt，复用原有有界 lifecycle trace。没有增加原 trace 上限。
- parent 在确认登记控制器 close 后输出诊断。profile 判读器再用原 lifecycle 的 persistence-end 数独立核对新计数。

10 项业务合同及断言未删减。历史的 hard-controller-exit 用例在本轮默认运行及两次诊断中通过，诊断显示最终重复 resume 没有新增写入或本地子进程；这不能覆盖其他恢复路径。

native `corrupted canonical bytes=false` 在三次 File 运行中仍超时。Node-clock 样本在截止前已经进入第二个控制器，仍有 root/frame 持久化推进，随后由测试清理停止；不是观测到固定阶段一直不动。首控制器完成的被测 Store API 为 record 12、frame 21、frameValue 4 次。它们不是总写入数，更不是 37 次 fsync。

高负载诊断样本的首/次控制器 apparent pre-Node gap 约 492/594ms，Node bootstrap 约 18/27ms；Store 方法也有明显累计耗时。该 gap 用同机 epoch anchor 相减，只能定位到 Node time origin 之前，不能精确归属调度、sandbox/exec、签名检查或其他系统成本。方法 inclusive 时间可能重叠，且不覆盖 create、独立 value 写入及全部业务 IO，不能相加冒充独占关键路径或设备 IO。

最新 SQL 也在 retry-controller 场景触及 5000ms：首控制器正常关闭；第二个控制器在截止时仍有真实本地 child，清理等待它关闭后以 75 退出。其 stderr 显示先有 frame/record 推进，后收到 IPC termination，再收到 native child close。**这是当前未通过项，不标成已证明无关的旧失败，也不从高负载推断唯一原因。**

## 实际验证

环境：macOS arm64、10 核、Node v24.18.0 / ABI 137、SQLite 3.53.1、Vitest 3.2.7。所有毫秒运行经既有 timing-run 锁；没有并行测速。

| 检查 | 结果 | 证据日志 |
|---|---|---|
| 原型正常 native 边界 | 2 passed；也包含在最新 SQL 93 项中 | `ab-positive.log`、`sql-final.log` |
| 最终真合并负对照 | 1 项预期失败；判读通过 | `ab-negative-bounded.log/json`、`ab-verification-bounded.log` |
| File 原完整进程合同 | 8 passed / 2 timeout / 0 skipped | `file-recovery-default.log/json` |
| File inclusive profile | 9 passed / 1 timeout / 0 skipped | `file-recovery-profile.log/json` |
| File 加 Node 时钟 profile | 9 passed / 1 timeout / 0 skipped | `file-recovery-clocks.log/json` |
| SQL 共享 58 + revision 19 + 原型 16 | 92 passed / 1 timeout / 0 skipped | `sql-final.log/json` |
| IO meter / ratchet | 3 passed / 10 passed | `io-final.log/json`、`ratchet-final.log` |
| Node/Web、实验、生成 Store/错误 Runtime/Worker 类型 | 全部通过 | `project-types.log`、`experiment-types.log`、`generated-negative-types.log`、`generated-bounded-types.log` |
| 旧 hash 负对照 | 1 项预期 hash 断言失败 | `metadata-negative.log/json` |
| 判读器敏感性 | 缺冷读、缺 profile receipt 均被拒绝 | `receipt-sensitivity.log` |

File 默认失败为 retry-controller 与 native=false；不是前轮的 hard-exit + native=false。两次 profile 仅 native=false 失败。SQL 仅 retry-controller 失败。保留首次结果，不用后续部分通过覆盖失败。

前三次 File load 分别为 24.87→20.21、18.33→20.50、14.93→14.27；SQL 为 28.64→21.96。均超过 10 核阈值。调查期间只读负载快照还观察到 52.58；没有擅自停止其他任务换取低负载结果。

两份 File profile 各核对了 **21 个登记控制器 close**，不是 21 个独立业务用例。SQL 最新批次的 **93 份** after-hook namespace 报告全部为 0；最终负对照及 meter 也均为 0。仅证明这些已登记资源收敛，不是全系统进程审计。

辅助判读器初版错误假设 Vitest JSON 有 Jest 的 runtime-error 字段；第二次又把仅在文本日志中的源码片段当成 JSON 字段内容。均为判读方法错误，已按实际 JSON/文本合同修正；原业务负对照始终是对应断言失败。首版源码及工具回显摘记保留，不伪造成原始 shell 日志。

## 交付、边界与下一动作

计量提交：`a55105a3`。A/B 与判读工具提交：`34b6a668`。本轮只本地提交；无 push、App 构建/安装、真实 Provider/Jev 调用或数据迁移。复现入口：[实验 README](../../experiments/workflow-checkpoint/README.md)。

持久证据目录：

`/Users/baobingjiang/.local/state/rotom/verification-evidence/workflow-checkpoint-boundaries-20261029.64MvY8`

包括原始日志/JSON、生成源码/Worker、首次失败、诊断、patch、选取的源码输入、manifest 与最终状态；以 manifest hash 校验归档，不以临时目录寿命作为保存保证。

下一动作由维护代理执行：在 **1 分钟 load≤10** 的空闲窗口，以相同 10 项 File 合同和相同 93 项 SQL 合同串行复验，保留 5000ms；若仍失败，沿已记录的启动/持久化阶段继续定位。需要的是机器空闲窗口，不是生产接入授权；本次不启动后台轮询或停止用户进程。

尚未执行完整项目 unit、Electron/better-sqlite3、App 验收、硬件 flush/断电、迁移/回滚与生产推广。既有原五项生产 timeout 未被本轮修复。A/B 证据闭环不等于项目完成。
