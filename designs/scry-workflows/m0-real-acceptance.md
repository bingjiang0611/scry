# M0 真实 Provider 验收记录 · 2026-10-20

## 授权与范围

用户明确选择 Pi·Rotom + Codex、当前默认模型、当前账号、预算无上限；另行明确允许 Pi `full_access`。发生故障后，用户明确选择保留原现场，另开独立临时 workspace/userData 验 Codex 停止，不清空原未知容量，也不重发原任务。

- Pi：现有 profile `pi:564f7a994e4e34da`，Rotom `0.1.26-verified.263e5f7b`，模型引用 `{providerId: qoder, id: ultimate}`。Scry Provider 是 Pi，不冒充独立 Qoder CLI。
- Codex：目录实际默认 `gpt-6.1-sol`，原生 `default` 审批。未替换模型或 Provider。
- macOS arm64、Node 24.18.0、Electron 42.10.1；App 版本仍为 0.2.210，版本号不证明构建身份。
- 使用打包 App 的真实 `window.scry` preload / trusted main IPC / canonical `startAppRun`，未使用 smoke Provider。App 全程为独立隐藏测试实例，不是前台完整 UI 操作验收。
- 任务只有合成标记和数学文本；仅临时 HOME/workspace/userData。凭据仅复制选定 Pi qoder 登录态和 Codex auth；不复制个人扩展、指令、hooks、skills 或历史。Pi 的内置产品扩展仍会运行，临时目录不是 OS 沙箱。
- 未安装、停止或重启 `/Applications/Scry.app`，未修改原开发工作区的 WIP。

现场：

- `A=/tmp/scry-workflow-m0-real.n9qssN`
- `B=/tmp/scry-workflow-m0-codex-stop.w0Hpde`（用户批准的独立 Codex 停止现场）

A 的测试并发设为 2；B 使用该机器的原生默认 10。两者为独立 App userData / 内核，不声称共享一个 OS 全局池，也没有放宽 A 的上限或清除其预留。

## 冻结构建与实际结果

冻结源基点为 `81e4b63`，最终生产代码补丁 SHA-256 为 `496e5d9c6cb588f68d121dc7b619649b47b532c7d45d9b9b1c019223464f0993`（对四个生产 TS 文件的 `git diff`，不含测试和本文）。冻结 App 位于 `A/artifacts/<阶段>/Scry.app`。

| 阶段 | `app.asar` SHA-256 | 真实结果 |
| --- | --- | --- |
| `81e4b63` | `ee2699e178f44ae4e895a9eb9f83c520341c84b0141232ae368c13d163ed50b8` | 首次 Pi 规划用了 `children`，被严格校验拒绝，无执行批准 |
| `prompt-fix` | `9e563404abe3aa58226240aa3ad5ccc5a9a5ca5b8a09fd2d3f1cc5156dcc0c35` | 返回合法程序，但 Codex 冷启动健康快照过早，预览 unavailable，无子任务执行 |
| `readiness-fix` | `298c84415ff23b7eb01ffe5acc419daa2857e393c2b1f962b594724e8d5f6ba9` | 混合完成链通过；后续第一次停止试验因控制器断连中断，未发出 stop，不计为停止成功 |
| `projection-fix` | `f5df6ff9a92da971f32536dbd8d6e98636aae9fd80902a6c5efea69e7754c61f` | 恢复只观察、未知容量显示、Pi 实际生成后停止、B 中 Codex 实际生成后停止通过 |

### 混合完成链（readiness-fix）

```text
Pi 规划 → 精确 revision 批准 → parallel(Pi worker, Codex reviewer)
                                  ↓ 两个已提交 inputRefs
                             Codex summarizer → 显式 return
```

- Root：`workflow-6c1ec39b397fa15bdb34ba6cbcc0c48da3a418efac423916e10e7095d3bd6f7e`。
- revision：`f82631d767663e28f73a3ca247063922cac376a2e379362e0402b12e287eded1`。
- 计划与实际均为 3 次子尝试；共享槽位峰值 2；完成后该实例占用 0。
- 3 个独立 Native session 均有归档和已收敛 outcome；实际报告模型分别为 `ultimate`、`gpt-6.1-sol`、`gpt-6.1-sol`，不是请求值兜底。
- 两个合成标记确实存在于各自 canonical model output，再出现在 summarizer 的 canonical output 和最终显式 return 报告中。
- 所收集的 workflow progress 不含中间 `output` 字段。父焦点 API 的开始/结束读数均为 null；没有把这两个采样扩展成“真实流程全程 OS 焦点已验证”。
- 证据：`A/happy-result.json`、`A/happy-events.json`、`A/happy-preview.json`。

### 两个 Provider 的停止（projection-fix）

| 项目 | 结果 | 证据 |
| --- | --- | --- |
| Pi / qoder ultimate | 先观察到真实生成，再发一次 stop；最终 `stopped + settled`，该新尝试槽位释放，旧未知槽位仍保留 | `A/cancel-pi-result.json` |
| Codex / gpt-6.1-sol | B 中先观察到真实生成，再发一次 stop；最终 `stopped + settled`，共享占用归零，新增 active run 为零 | `B/cancel-codex-result.json` |

两项均核对了 Provider result 来源的 exact `interrupted` canonical record，不以 stop acknowledgment 代替终态。没有把两次分别停止宣称为一次双 Provider 同时停止验收。

## 发现并修复的产品问题

1. **规划合同不完整**：原提示只定义 call / return，未定义 sequence / parallel 的 `blocks`。将完整提示放回语法所属模块 `workflow-program.ts`，补全四种节点；typed JSON 示例由同一生产 validator 测试，不执行该示例。仍拒绝 `children`，没有兼容非法程序。
2. **冷目录前冻结健康状态**：原服务先取 descriptor，再用目录 RPC 建立 Codex 健康，导致把已经 ready 的真实目录配上旧 unknown。现在同一去重、Provider operation gate 内先读目录后取 descriptor，服务直接使用该一致快照；真实 unknown 仍拒绝。
3. **持久化槽位不是当前占用**：恢复时内核实际保留 1 个未知作用域，API 却返回旧更新时的 2。公共 snapshot/list/start/event 投影改读当前共享内核计数，持久化尝试和结果不改写。故意把历史槽位设成 99 的回归先在旧实现失败，修复后通过。未借此释放未知容量。

相关文件：`src/main/index.ts`、`src/main/workflow-program.ts`、`src/main/workflow-capability.ts`、`src/main/workflow-service.ts` 及相邻测试。

## 必须保留的失败与未知

- 首次真实规划失败、冷目录 unavailable 预览均未批准或执行子任务。首次规划时临时 workspace 尚未 `scry init`，recorder 为 disabled，只有原生归档，不把它计为 canonical record 通过；后续由冻结 App 的私有 CLI 初始化 recorder。原记录位于 `A/cases/01-invalid-plan`、`A/cases/02-unavailable-preview`；失败不是靠重发同一 commandId 掩盖。
- 第一次停止控制器错误地 await 了代表整轮执行的 `start()` Promise，尚未开始观察/停止就发生 CDP 断连；控制器随后超时被终止。原因不能进一步武断归为模型、Renderer crash 或某个网络超时。没有 `stop-intent` / acknowledgment，不能称为成功取消。后续控制器与生产 UI 一样异步启动并独立观察，不改生产 start 合同。
- 该 Root `workflow-7bc70efe19239e1cd4117b9c1a193270dc5ce69700edc7d586e83c888f675957` 中 Pi outcome 已提交，Codex 没有已收敛 outcome。恢复不自动执行，派发次数仍为 2，先保留 1 个未知容量，canonical record 数不增加（`A/recovery-current.log`）。
- A 中另一 Codex 停止尝试在生成前被 `Scry 精确记录仍有 1 轮待恢复` 拒绝。当前异常边界保守记为 unknown，另保留 1 个槽位；**2 个 reservation 不代表已证明还有 2 个实际 Agent 在运行**。没有用错误消息字符串给它退款或补造 settled。
- A 的 doctor exit 5：`pendingCount=1`、canonical store 10 records / 0 errors；旧 Codex `open.json` 为 `managedByScry=true`，有原生 turn 边界而无 canonical result journal。不能删 open、用 rollout 近似补齐，或增加容量来绕过。
- 经用户单独批准，B 是全新的独立 workspace/userData，未把 A 标记恢复、未重发其旧任务。A 的两个 unknown outcome、预算和 pending 均保留。B doctor exit 0、pending 0。

## 独立证据核对

`A/audit-evidence.mjs` 对全部 12 个 canonical JSON 和 13 个 archive 文件进行解析，并对混合链 3 个执行 outcome、Pi 停止、Codex 停止逐项做跨来源连接：workflow run ID → archive Native session → 唯一 `.scry` record。它核对了实际模型、`completed/interrupted`、exact `provider_result` termination、5 项均 `available + []` 的工具证据，以及真实 model output 中的合成标记。这是结构化解析/字段核对，不是全部原始 transcript 的人工通读。

- `A/evidence-audit.json`：5 个关键执行均匹配；A 有 10 records / 11 archive 文件，B 有 2 records / 2 archive 文件。
- 两处 `scry turns verify` 均 exit 0。**这不表示所有身份字段完整**：CLI 仍提示 model identity / turn role / task link 为 `legacy_unset`。本次角色、模型与父子关系以 workflow store + archive/session 连接核对，不把这些可选 canonical 字段说成已补齐。
- 所有 record 都没有 `costUsd`；没有从外部账单独立核对费用，不给出总美元数，更不显示成 0。

## 本次最终代码验证

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| `npm test`（默认 2 workers，含 shell） | 3478 passed / 4 默认 skipped；shell 通过 | `A/final-test.log` |
| workflow program / service / capability / behavior | 32 tests 通过；含 unknown 不提升和 stale slots 负向控制 | `A/projection-focused.log`、`A/stale-slots-negative-control.log` |
| Node / web typecheck | 通过 | `A/projection-typecheck.log` |
| `npm run pack:artifact` | 当前构建、产物校验与隔离安全/恢复/远程宿主 smoke 通过 | `A/projection-pack.log` |
| 工作流原生输入 UI fixture | 通过，仍隐藏、不抢焦点、不重挂重发 | `A/final-workflow-ui.log` |
| `performance:measure -- --scenario trace.delivery` | ratchet 通过；5 次均 2 IPC messages / 165996 bytes | `A/performance/measure.json` |

4 项默认 skip 仍为性能相关性、billing-admin-real、P0、P1。当前 unit 与计数测量时机器高负载（unit 结束 load 72.51 / 10 核）；没有作 L2 毫秒或 L3 用户体感结论，没有改 timeout、门限或 workload。Renderer 源码本次未改；完整 renderer gate 是前一 `81e4b63` 阶段结果，本次补跑相关 fixture 和 packaged production IPC smoke，不把旧完整 UI 结果当当前前台验收。

## 清理与剩余动作

- 已关闭本轮隔离 App / 观察宿主；逐 PID 校验后停止 Rotom 内置 computer-use 扩展留在临时 HOME 的 helper。这个 helper 在目录读取时即会启动，不能把 Scry 注册的 run scope 说成覆盖所有扩展后代。
- 两处 HOME/userData 无本轮残留打开文件进程；4 份临时登录态副本已删除，保留 source hash、脚本、冻结产物、archive、records、unknown 和 pending（`A/cleanup.json`）。原始凭据和原用户 App 数据未改写。
- 混合完成的直接真实证据属于 `readiness-fix`；最终 `projection-fix` 只改了槽位投影，已有直接真实证据是恢复观察和两项停止。没有在最终产物再重复完整 3-call 混合完成链；若要升级为该产物完整端到端验收，应由下一轮独立授权重放一个新合成计划，不能重发 A 中未知任务。
- A 的未知/待记录结果仍需原 Provider 权威结果才能恢复，当前 M0 没有手工清空并重跑通道。后续 owner 应先取权威证据并按 exact-managed 合同收口；若要优化前门拒绝的保守 unknown，应先补结构化“未派发”证据合同，不能靠字符串匹配释放容量。
- 本轮证明了指定模型组合的真实能力，不证明五 Provider / 所有模型 parity，也不代表完整 v10 / M5 或前台真实 UI 产品验收已交付。未 push、未安装、未重启用户 App。
