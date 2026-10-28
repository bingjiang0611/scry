# Qoder dfmodel / Jev 真实验收报告

日期：2026-10-28。分支：`feat/workflow-m0`。

## 结论与范围

独立 test App 的普通编码任务、真实 Jev bool/choice/score、Qoder 独立复核、低置信度阻断及已完成工作流的冷读回均取得证据。不是只测 HTTP，也没有把离线 fixture 冒充真实 Provider。

**这不等于 M2–M6 全部产品能力或发布门禁完成。** 默认安装流程的全量 unit gate 未通过，未进入打包安装。日常 `/Applications/Scry.app` 未被本轮安装替换。

本轮使用隔离 HOME、userData 和临时 Git 工作区，只处理合成 incident 与加法示例。没有在业务仓库调用真实 Agent，没有 push 或发布。

## 本次修复

- `typesafe-workflow-classifier.ts`：Main-only TypeSafe adapter，调用官方 `/v1/systemone`；保留返回的模型、值、概率和 confidence，明确映射 bool/choice/score。15 秒请求上限，支持取消，不重试。失败或未知不伪造结果。
- `main-workflow-ipc.ts`、`provider-env.ts`：Main 注入 adapter；`TYPESAFE_API_KEY` 不得进入 Provider 子进程，显式环境 allowlist 也不能重新注入。
- `workflow-capability-resolution.ts`、`workflow-program.ts` 与 Service 调用方：区分 authoring 和 frozen execution。Qoder 可执行已冻结程序，但没有声明的规划能力仍然拒绝；缺失能力保持 unknown。
- `workflow-recovery.ts`：active FileWorkflowStore load 允许已写入但尚未完成的 classifier intent；cold recovery 仍要求闭合证据，未完成项转 unknown，不重放。补真实 FileStore、resultRef 和篡改回归。
- Service/template 大测试文件按领域拆分，保留原测试和负对照；更新显式验收入口。新增本次碰到的 App bridge 能力声明、preload 固定方法合同与 `workflow:restartStalled` 性能目录映射。
- acceptance manifest 移除未使用的历史 git/hash 快照；验收报告在执行时采集实际 HEAD、dirty 内容和 source hashes，避免历史元数据冒充当前版本。

## 真实操作与结果

| 项目 | 结果 | 证据 |
|---|---|---|
| CLI preflight | 请求 `dfmodel`，Qoder 显示 DeepSeek-Flash，返回指定标记 | `qoder-dfmodel-preflight.jsonl` |
| 普通 App 编码 | Read README、Write 两个文件、Bash 执行测试；父会话独立重跑 2 passed / 0 failed | screenshot 01、`workspace/sum.mjs`、`workspace/sum.test.mjs` |
| Jev bool | `true`，confidence `0.98`，概率 `{true:0.98,false:0.020000000000000018}` | `real-verification.json`、canonical resultRef |
| Jev choice | `technical`，confidence `1`，概率 `{billing:0,technical:1,sales:0}` | 同上 |
| Jev score | `2`，confidence `1`，概率 `{"0":0,"1":0,"2":1}` | 同上 |
| Qoder reviewer | 真实 `dfmodel` 独立读取以上结果，成功终态，下游调用一次；持久化输出与 recorder assistant 文本一致 | screenshot 05、`real-verification.json` |
| 不确定性控制 | 未观察到结果的公平硬币 confidence `0.55`，低于冻结阈值 `0.9`；blocked，**下游派发 0 次** | `low-confidence-result.json`、ledger summary |
| 冷启动无 key | 重复原 start 返回已完成结果；新 start 拒绝重派发；原 canonical root 字节不变，输出仍可读，activeRuns 为空 | `cold-verification.json` |
| Recorder | CLI `turns verify`：`ok:true`、3 records、无错误、无 open turns；reviewer 对应 record 与归档吻合 | `recorder-verify.json`、`real-verification.json` |

三个成功分类的实际来源都是 **`typesafe:jev-1.14.0`**。这些 confidence 来自 Jev，不是测试脚本预设，也不是对真实业务质量的普遍保证。

成功 workflow：

- `workflow-fca208d22821f1a62b3c3e04ba1c89308aa3ee945fa52b15570ea733f0417474`
- revision：`d2c0857ec39d18450dbcd3c60e256094eaf0c147726d57beb44b18f37bd3a211`
- start command：`real-jev-qoder-start-03`
- Qoder session：`b7571dcd-aae1-4ee9-a0c1-265ea6770417`
- reviewer record：`c8e5cef17334babef994275dca589232`

score adapter 目前只接受 `min:0` 且 criteria 为长度 `max+1` 的 JSON 字符串数组；不能表达的 rubric 在 HTTP 之前返回 unavailable。需要其他量表时，应扩展明确的映射和合同测试，而不是近似转换。

## 离线验证与失败记录

| 检查 | 结果 | 范围 / 证据 |
|---|---|---|
| Source-bound 独立验收 | 最终结果见 `offline-final.json` | 24 个 focused suites / 194 tests，9 个命令及 4 个负对照；包含 Node/Web typecheck、生产 build、隔离 Electron security smoke |
| 旧 FileStore validator 负对照 | 目标测试失败，raw exit 1，错误是恢复 ledger 拒绝 pending intent | `negative-file-ledger.log`；仅恢复旧 validator 路径，保留新测试及 adapter signal seam；其余 2 tests 因 `-t` 未选中 |
| 拆分与大小检查 | Service 38 个测试声明 / 173 个 expect 保留；Template 17→18 个声明 / 108→116 个 expect；40 个本次文件均 ≤20,000B | `test-preservation.json`；新声明是 Qoder frozen/authoring 分离回归 |
| 性能工作量 | admission input-observation calls `0 → 0`，ratchet passed；映射更新后再次通过 | `performance-final/measure.json`、`performance-after-mapping/measure.json`；仅 L1 计数，不宣称 L2/L3 变快 |
| 安装流程首轮 | 外层工具在 300 秒截止；当时仍在 unit 阶段，未进入安装 | `install-first-tool-timeout.log`；确认相关进程退出后才继续 |
| 安装流程完整一轮 | **52 failed / 4456 passed / 4 skipped**，14 failed suites，769.34 秒 | `install-final.log`；退出 1，未进入 shell tests、打包或安装 |
| 其中合同问题修复 | 3 suites / 35 tests passed | `full-gate-contract-fixes.log`；包括新的无 host-tool proof 拒绝用例、固定 commands/submit 参数验证及 channel mapping |
| 其余失败套件串行检查 | **8 failed / 88 passed**，4 failed suites / 11 suites，205.52 秒 | `full-gate-failed-suites-serial.log`；主要 5 秒超时，另有超时后的 ENOTEMPTY 清理错误 |
| 历史基线比较 | 同一旧提交先前 3 failed / 10 passed；另一组 4 suites / 40 tests passed | `baseline-system-tests.log`、`baseline-final-timeouts.log`；不能据此把全部当前失败宣称为“既有且无关” |

未扩大测试 timeout，未 skip、删除断言或弱化 gate 来获得安装成功。后续串行通过不能抹掉完整 gate 的失败。机器同时运行其他工作；记录到 load averages `16.84 / 24.40 / 29.61`，没有停止用户的其他实例。机器负载只是环境证据，不足以证明所有超时的根因。

真实 App 验收之后没有再修改产品运行源码；与 `offline-current.json` 比较的 23 个运行源文件 hash 全部一致，见 `runtime-source-continuity.json`。最后的测试/目录修正不能被误称为重新执行了真实付费调用。

### 保留的首次失败

1. 最初 canonical classifier start 在 FileStore 再次 load 时拒绝 unmatched intent。旧 root 保持 unknown，**没有用相同 intent 补跑或改写成成功**。新验证使用独立 command/root。失败图为 screenshot 02。
2. 普通 App 第二轮最初遇到 recorder open identity 不可用。隔离 recorder bootstrap 的 Node PATH / hooks 配置修复后，新路径及 reviewer 的提交获得证据；不把后来的健康记录当成该历史失败轮次恢复完成的证明。
3. 历史 unknown root 的 resume 因无法证明原 controller 闭合而拒绝，见 screenshot 04。收尾发现原 test App 在 graceful termination 后仍存活；确认 `activeRuns:[]` 并核对独立 launcher 身份后，仅强制结束该 owned test 实例。最后核对两个登记的进程组均无存活进程，见 `process-closure.json`。

## 证据目录与截图

完整本地证据：

`/Users/baobingjiang/.local/state/rotom/verification-evidence/scry-qoder-jev-real-20261028.7HxICp`

- `screenshots/01-qoder-dfmodel-completed.png`：普通 App 编码与测试结果。
- `screenshots/02-real-classifier-ledger-failure.png`：首次真实 classifier ledger 失败。
- `screenshots/04-preserved-unknown-after-restart.png`：历史 unknown / refusal，**不是成功 workflow 图**。
- `screenshots/05-qoder-real-jev-review.png`：真实 Qoder reviewer 与已提交记录。
- `userData/workflows/`、`workspace/.scry/`、trace archive 与校验输出用于交叉核对，而不是仅依赖截图。
- `checksums.json` 记录保留文件的 SHA-256；不包含临时 key 或 Qoder auth 副本。

费用不完整：Qoder 三条记录的已观测 credits 合计约 `0.2435824642`，CLI preflight 另报告 `0.0066487134`；不是全程账单或美元。Recorder identity coverage 仍为 `legacy_unset`，credits 标为 partial。Jev 费用归因未实现；最初未闭合请求也不能当作免费。不得把缺失 usage/cost 写成零。

临时 Jev key 文件与隔离 HOME 中的 Qoder auth 副本已删除；精确 key 扫描未在非 secret 证据或任务源码中发现匹配。没有将凭据写入仓库或本报告。

## 未验证项与明确下一步

| 项目 | 当前边界 | 负责人 / 下一步 |
|---|---|---|
| 全量门禁与日常安装 | focused 与真实场景通过，不代表 release gate 通过；本轮安装未执行 | 我：单独 profile recovery-process 与 verification 的 I/O、子进程收敛及 5 秒预算，先定位差异，再重跑原完整 gate；不先加 timeout |
| 停滞重启 | offline contract / IPC 有测试，生产 `restartEvidence` 未接线，不假装可重启 | 我：接入可证明 attempt 身份与闭合的生产证据后，另做真实停滞验收；此前保持 unavailable |
| Qoder 工作流规划 | 未声明 authoring；本轮只证明普通运行和 frozen execution | 我：只有 Provider 提供可证明的结构化、禁用宿主工具的规划边界后才接入，不用普通聊天冒充 |
| 质量模板与源码应用 | 验收了离线合同；没有真实业务仓库应用或质量基准 | 用户指定业务仓库和代表性任务后，我再执行源码应用与质量验收；不替用户选择业务数据 |
| 完整费用归因 | 部分 credits 与模型来源可核对，完整 token/cost 和 Jev billing 尚未接通 | 我：按 Provider 的权威 usage/billing 合同扩展，不从 confidence 或零 token 推算费用 |

本次仅本地提交，未 push、未发布，未将“构建成功”写成“已安装”。
