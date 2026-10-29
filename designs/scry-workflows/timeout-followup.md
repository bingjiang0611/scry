# Workflow 5 秒门禁：计数隔离与后续调查

日期：2026-10-28（本地）；证据归档时间为 2026-10-29 UTC。起点：`684bf80a5e187de239ad68ff1e0ff5e11664ba2d`。仓库：`scry-workflow-m0`，分支：`feat/workflow-m0`。

## 当前结论

已修复性能测试的共享计数串扰，本地提交 `2adc9d9647560bfd160e0dd5c0f9149d41be8d76`。**没有修复生产 Workflow 的 5000ms 超时，完整门禁仍红灯。** 不把计数器修复称为运行速度改善。

本轮未改 timeout、既有断言、固定 workload、重复次数、Provider 阶段或持久化保证。没有真实 Provider/Jev 请求，没有启动 App、打包、安装或 push。v4 工作台既有验收见 [交付报告](v4-workspace-delivery.md)，本轮不重做或扩称该验收。

## 已交付：按工作区隔离 native write 计数

文件：`scripts/performance-counters/workflow-native.counters.test.ts`。

旧 mock 使用一个共享的 `directory/active/nativeWrites`。两个 workload 重叠时，后启动者覆盖目录和数字，前者结束又会关闭后者的计数。Vitest 超时不会取消已开始的异步工作，因此超时后的串扰是可能路径；**没有取得历史那次 `expected 2 to be 1` 的逐操作时序，不能证明它必定由这个机制导致。**

修复使用按 canonical workflows 目录索引的 Map。每个 workload 持有自己的计数对象；writeFile 在 await 真实写入前捕获对象，成功后才计数，finally 仅删除本 workload 的登记。文件 flush 断言、真实写入调用和清理保留。

新增回归让普通和额外写入 workload 同时执行，分别要求 1、2 次实际 flushed native-value writes。旧实现失败，修复后通过。没有用概率、延迟或 sleep 控制交错。Map 只存在于测试 mock，不是生产缓存。

## 当前完整门禁

环境：Node 24.18.0、macOS arm64、10 核；根包版本 0.2.210。所有计时命令经过仓库 timing-run 锁。

| 检查 | 结果 | 归档文件 |
| --- | --- | --- |
| 旧计数器负对照，新增 overlap 回归 | 1 failed；收到 1，预期 2 | `counter-isolation-negative.log` |
| 原 native collector 加新增回归 | 9 passed | `counter-isolation-fixed.log` |
| `npm run typecheck` | Node/Web 均通过 | `meter-typecheck.log` |
| `npm run test:unit -- scripts/performance-ratchet.test.ts` | 10 passed；台账未改 | `meter-ratchet.log` |
| 原 `npm test` | 429 files：422 passed / 3 failed / 4 skipped；4523 tests：4514 passed / 5 failed / 4 skipped | `full-unit-after-meter-isolation.log` |
| `npm run test:shell` 单独执行 | PASS setup-scry-workspace；全量命令的 shell 因 unit 失败未执行 | `meter-shell.log` |

完整门禁耗时 561617ms，负载 15.21→17.03，`highLoad:true`。本轮不能给出稳定 L2 毫秒结论。此前 `highLoad:false` 下也出现过超时，不能把所有失败归结为当前负载。

五项失败都是原 5000ms timeout：

1. `workflow-dynamic-loop-revisions.test.ts`：reuses unchanged iterations and reruns the affected carry iteration。
2. `workflow-dynamic-revisions.test.ts`：matches stable map keys, reruns only the changed item and its consumer。
3. `workflow-system-revision.test.ts`：runs fresh replica/check/verification/scoped Agent effects。
4. 同文件：invalidates a consumer when the same native node definition changes。
5. 同文件：retains a legacy first SystemStep revision and appends cumulative boundaries。

计数器套件在这次完整门禁中 9/9 通过；不能据此证明历史异步清理问题已全部消除。未用后续重复运行覆盖本次完整失败。

## 分段观测：证据与限制

临时 pass-through instrumentation 仅包装实际 FileWorkflowStore、WorkflowSystemHost、WorkflowService 方法。返回值、参数、错误和原 5000ms 上限保留。没有修改生产源文件或原测试体。仅选择 mixed SystemStep revision 一项，不是全量验收。

选中用例 3924ms，通过；`highLoad:true`。记录到 `atomicText` 147 次、累计 1517.53ms，`saveFrame` 41 次、`saveFrameWithValue` 9 次、root `save` 35 次、`saveValue` 42 次。`load` 累计约 70.77ms。

这些方法有嵌套，累计耗时不能相加，不能视为精确关键路径。读写数量说明进一步检查 durable publication 有依据，**没有证明它是全部超时的唯一根因**。仪器脚本和输出在 `profile-phases.mjs`、`vitest.phases.config.mjs`、`revision-phase-profile.log`。

## 未交付实验：合并 loop 终态的中间发布

只读 scout 提出并由主会话核对的具体位置：`workflow-loop-execution.ts` 的 `finish()` 在 outcome artifact 持久化后，先保存一次仍为 entered 的 loop frame，紧接着 Interpreter `complete()` 再保存相同帧的终态和结果；中间没有下一个 child。

候选保留 outcome artifact，返回带原 revision 的未发布 frame draft，由既有 `saveFrameWithValue` 一起发布 terminal metadata/result。没有改 store、lock、CAS、file flush 或 final directory sync。每次 loop finalization 可少一次中间 frame publication，但不是所有 revision 用例都含 loop。

新增 4 项回归：

- 冷 store 读取最终 outcome、状态和 result，且没有 outcome-only 中间发布。
- 真实 stale revision 拒绝 terminal CAS；冷 controller resume 后不再派发已提交 loop body。
- 暂停真实 terminal directory sync，确认 root 未完成且 outcome consumer 未派发；释放后才继续。
- 注入该同步失败，确认拒绝且 consumer 零派发。

负对照在原实现正确到达多余 publication 断言并失败：`loop-checkpoint-publisher-negative.log`。此前两次测试编写错误单独保存：空 invariants 违反合同；consumer prompt 合同会附加 committed binding，不能只等于原始文字。修正 fixture 和预期后才做有效负对照，没有据这两次错误宣称产品回归。

候选 4/4 通过（`loop-checkpoint-fixed.log`，`highLoad:false`）。七个相关文件：**42 passed / 1 failed**，原 dynamic loop revision 仍超时（`loop-checkpoint-contracts.log`，`highLoad:true`）。新合同不证明稳定 L2 改善或解决完整门禁。**候选生产改动及新增实验测试已完整撤回**，patch/test 留存为 `loop-checkpoint-candidate-not-shipped.diff`、`loop-checkpoint-candidate.test.ts`。最终 production 源码等于本轮起点，不拿候选测试作为最终源码的验收。

该实验不重复此前被撤回的 artifact-directory batch sync 候选。也不为剩余超时盲目重跑，或继续无限量微优化。

## 证据与下一步

持久目录：`/Users/baobingjiang/.local/state/rotom/verification-evidence/workflow-timeout-followup-20261029.MWnbwa`。

`manifest.json` 包含计数器提交、最终计数器源码 hash、17 份源码/诊断/失败日志 hashes，以及候选已撤回状态。临时源仍在 `/tmp/scry-workflow-workspace.ioYWPy`；不包含业务 HOME、凭据或真实会话归档。

只读 scout run `ceff780f-23e4-49bd-a608-00bcf43c059a` 已结束；process-terminal 和 registered-resource closure observed，active capacity 0。其建议不是测试证据，本报告只采用主会话复核和实跑结果。

未解决项负责人：主会话。下一步建议先形成 transactional root/frame checkpoint 设计与等价验收清单，再决定是否实现。这涉及持久化边界，不应凭“减少 fsync 数”直接修改。必须保留 artifact-before-authority、durable acknowledgement、跨实例 CAS、冷进程恢复、canonical tamper refusal 和 unknown/no-replay。设计不是已验证修复；尚无足以承诺通过全部 5 秒门禁的方案。需维护者确认扩大到该设计范围，或另行授权一轮有上限的窄实验。M1–M6、跨 Provider/计费/生产接管与业务应用仍未完成。
