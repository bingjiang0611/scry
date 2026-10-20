# M0 实现与验收边界

状态：独立分支 `feat/workflow-m0` 中的实验实现。已有指定账号/模型的真实完成与停止证据，但仍有故障现场 unknown / pending，不代表完整 M0、v10 或 M5 产品验收已交付。最新范围与逐构建证据见 [真实 Provider 验收记录](m0-real-acceptance.md)。

## 已接入的路径

- 本地经典聊天和统一对话：`/scry-workflow run <目标>`；工作流按钮可独立创建目标。远程聊天未开放此入口。
- 四个角色分别选择已配置的 Agent、profile、模型和原生权限模式。当前 App 的独立 profile 仅 Pi 提供；不会忽略其他 Provider 的虚构 profile 后使用默认配置。
- 原生模型目录与明确的 adapter fresh-run 合同参与准入。注册 adapter、显示 descriptor 或存在同名模型，均不单独证明运行能力。合同声明不是实际账号或付费模型探针结果。
- 编排 Agent 生成 JSON。宿主只解释 schema v1 的 sequence、parallel、call、return；不执行脚本、eval、import 或宿主 Shell 步骤。
- 生成计划和执行计划是两次授权。执行绑定规范化程序版本、工作区与角色快照；每次派发前及原生启动边界重验目录/入口指纹与能力。该指纹不是凭据快照或原生会话接续身份。
- 通过现有 App 启动、授权、仓库 trust/fingerprint、审批、recorder、归档和停止链启动独立原生会话；不冒充 remote，也不修改父会话选择或注入中间结果。
- 下游只消费 `inputRefs` 明确引用的、已经提交的前置调用输出。并行兄弟和未来节点不能互相引用；最终报告仅来自实际到达的根 return。
- 原生权限请求仍走原生审批。业务提问、自由文本回答和运行中追加业务输入被拒绝，不会被包装成权限同意。

## 上限与持久化

- 全部工作流的规划/执行共用槽位，默认 `min(16, availableParallelism())`。
- 并发配置：App userData 下 `workflows/settings.json` 的 `workflowConcurrency`，整数 1–256，启动时读取；M0 尚无设置界面。
- 逻辑并行集合最多 4096 项。M0 没有分支或循环，超过 1000 个 Agent 调用的静态计划不能确认；内核另有单根 1000 次派发预算。完成、失败、停止均不退款；排队未派发不占预算。
- 派发意图先提交，必要结果再提交，最后释放槽位并允许消费者前进。规划原文和节点输出使用持久化记录/内容寻址产物；原生运行引用用于查阅对应证据。
- 未知效果、未收敛作用域或必要结果写入失败保留容量，不自动重发。修复存储错误后可能需要重启并核对原生证据；M0 不提供手动清空未知容量的捷径，后续由 M3 的有证据对账处理。
- 重启只恢复观察。排队但未派发的规划取消；已收敛的规划不会被误算为活动作用域；执行预算和未知作用域跨重启保留。尚未执行的草案可只读打开，再由用户明确确认。已有执行记录不能用旧批准重新派发。
- 程序/规划文本上限 4 MiB，单个持久化记录上限 8 MiB。进入控制链的单次输出上限为 16,384 个 UTF-16 码元；超限不截短后冒充成功，完整内容以原生归档为准。需要更大数据时应先设计摘要/产物读取能力，不放宽现有限制掩盖缺口。
- UI 分页读取历史，仅投递最近 32 条节点元数据，不向父模型或 IPC 历史页投递全部中间输出。

## 必须保留的限制

- Scry 不是安全沙箱。规划本身已经是一次有费用的原生 Agent 调用，并按所选权限运行工具；要求“只生成计划”的提示不提供操作系统只读隔离。执行中的 Agent 工具也可能修改工作区。M0 没有隔离副本、独立宿主 check 或自动应用能力。
- 报告是 Agent 输出，不是独立业务验收结果。请求模型与实际报告模型分别展示；缺少实际模型或费用证据不能显示为请求模型或 0。
- Provider 内部的工具、嵌套 Agent、共享服务和逃逸进程不因此获得 Scry 的全量审计/绝对数量保证；预算限定 Scry 管理的 Agent 派发。
- map、branch、loop、模板编辑/发布、Jev、恢复执行、写入/应用流程及完整管理页面仍按 M1–M6 推进，M0 不替代这些里程碑。
- 若原生命令目录明确声明同名 `/scry-workflow`，文字入口拒绝猜测来源；独立按钮明确选择 Scry。完整的命令来源选择属于后续入口工作，不静默抢占原生命令。

## 已执行检查与待验收

受控范围包含：解释器/服务/真实临时文件、预算 1001 次负向控制、排队取消、持久化失败后的未知容量、连续重启、不重复规划/执行、权限与业务输入区分、生产可信 IPC wrapper、五个 Provider 的既有受控回归，以及隐藏 sandboxed Electron 中的原生输入。

UI fixture 验证独立编排 Pi profile / Codex 执行角色、不同模型 vendor ID、原生权限交互不受规划框阻挡、完成规划不抢父输入焦点、批准前不执行、连按不重复开始、未知停止不伪装成功、重挂载只观察。它使用明确的假主进程 API，不等于完整 App 或真实 Provider 验收。

同步 `be907ef`（0.2.210）后：focused 13 文件 / 100 tests、typecheck、build、独立工作流 UI 和新版后台卡片 UI 通过。同步前本地结果：focused 12 文件 / 88 tests、五 Provider 的受控回归 339 tests、typecheck、build、独立工作流 Electron UI、shell 和 trace.delivery 计数检查通过。计数测试时机器高负载，不据此作毫秒或用户体感结论。

### 81e4b63 的本地结果（真实调用前）

验证对象为同步 `be907ef` 后的 M0 与本次测试修复，环境为 macOS arm64、Node 24.18.0、Electron 42.10.1。没有修改生产 Git 实现、测试超时、预算或像素断言。

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| `npm test`（默认 2 workers，含 shell） | 3476 passed / 4 skipped；shell 通过 | `/tmp/scry-workflow-m0-final-default-test.log` |
| `npm run test:unit -- --maxWorkers=1` | 3476 passed / 4 skipped | `/tmp/scry-workflow-m0-final-unit-serial.log` |
| 工作流、preload、Overview 等 focused 检查 | 14 文件 / 113 tests 通过 | `/tmp/scry-workflow-m0-final-focused-shell.log` |
| `npm run test:renderer:ui` | 最终单次完整命令通过，包含 compaction、模型、终端、Credits、工作流、可信 IPC 与 Pi 历史 | `/tmp/scry-workflow-m0-final-renderer-ui-settled.log` |
| `npm run check:cli-release` | typecheck、587 tests、CLI 构建与独立包 smoke 通过 | `/tmp/scry-workflow-m0-cli-release.log` |
| `npm run pack:artifact` | build、打包、产物校验、隔离 Electron 安全/恢复/远程宿主 smoke 通过 | `/tmp/scry-workflow-m0-pack-artifact.log` |

默认全量测试经 timing lock 串行于其他测速任务执行；10 核机器 load 为 8.63 → 8.34，`highLoad: false`。这不是性能提升证据。4 个默认关闭的检查为性能相关性、billing-admin-real、P0 和 P1；没有启用真实账号探针。产物为本工作区 `dist/mac-arm64/Scry.app`，开发签名、未公证，不是已安装版本或正式发布包。

本次修复位于测试层：空会话应隐藏汇总，有已观测 turn 且无压缩事件才显示计数 0，新增单测同时证明这两个状态；终端完整 App fixture 补充 typed 空 workflow bridge；模型选择的原生输入在 hover 后重读几何与命中状态，保持 5 秒上限，业务点击只派发一次。新增 `--capability-only` 用于隔离诊断，不改变默认完整 UI 范围。

动画测量改为读取 Electron 新呈现帧，而不是把 rAF 后的 `capturePage` 当作新帧证明；使用设备比例裁剪，呈现事件有 5 秒失败期限并清理订阅，不强制重绘、不按像素结果重采样。减少动态效果检查先等待项目既有 CSS 合同允许的 ≤0.01ms 微过渡结束；不等待更长或无限动画，最终无动画/非透明断言不变。增加样式与失败截图诊断，没有放宽可见像素阈值。两个故意破坏的控制均按预期失败：移除可见渐变被像素检查拒绝，注入 1000ms 无限动画被减少动态效果检查拒绝；控制结束后校验源文件 SHA-256 恢复。证据：`/tmp/scry-workflow-m0-sidebar-frozen-control.log`、`/tmp/scry-workflow-m0-sidebar-motion-control.log`。

### 先前失败记录（保留，不被最终通过抹去）

- 同步前默认全量 unit：3462 passed / 11 failed / 4 skipped，四个原有文件；相同四文件在本分支与无 M0 的 `c405df0` 基线均串行通过 39 tests。这不是等价的默认全量基线对照。
- 同步后第一次全量串行 unit：3474 passed / 1 failed / 4 skipped；5000 文件终端 diff 的生产 `beginGitTurnDiff` 返回 timeout。collector 与 `src/core/turn-recorder/git.ts` 相对 `be907ef` 未修改。当时 10 核机器 load 为 23.00 / 37.60 / 40.68，不能据此独立证明失败根因。随后该用例单独通过、整个 counter 文件 6 tests 通过，最终默认及串行全量也通过；未增加超时。完整 counter 证据：`/tmp/scry-workflow-m0-subprocess-file.log`。
- 完整 UI 曾先因缺少 workflow fixture API 失败，再因空会话过时计数断言失败；后者已用上述状态区分修正。模型场景还发现旧坐标在布局改变后失效；第一版预等待遗漏 hover，诊断失败保留于 `/tmp/scry-workflow-m0-models-stable-input.log`，最终修复保留 hover 与新坐标命中检查。
- 无 M0 的基线曾在 reduced-motion / scrollbar-color 失败；本分支也出现 sweep 截图 0 个可见变化像素。最终审查重放再次失败，这次诊断证明两个动画位置不同的采样 PNG 哈希完全相同（`/tmp/scry-workflow-m0-final-sidebar.log`），改用新呈现帧后像素检查通过；继而读到 scrollbar-color 的 0.01ms 过渡仍在结算（`/tmp/scry-workflow-m0-sidebar-presented-frame.log`），对应 `styles.css` 的既有减少动态效果合同。两者分别修正测量/状态读取边界，不修改生产动画，不用重跑通过替代修复。保留最初 `/tmp/scry-workflow-m0-baseline-capability-ui.log`、`/tmp/scry-workflow-m0-renderer-ui-continue-4.log` 与后续负向控制。
- 一次完整 UI 在 steer 检查后被取消，没有计为整套通过；分段检查完成后，最终另行执行了上述单次完整 UI 命令。
- Credits 首次因独立 worktree 缺少 SQLite 原生 binding 失败；仅重建已锁定的 `better-sqlite3` / `node-pty` 并执行现有 helper 准备，未更改依赖或全局放行安装脚本。证据：`/tmp/scry-workflow-m0-native-rebuild.log`。

### 真实 Provider 验收进展

用户随后明确授权当前 Pi·Rotom / Codex 账号和默认模型、预算无上限、Pi 本机完全访问，并在故障后批准另开独立 Codex 停止现场。真实目录为 Pi 上游 `qoder/ultimate` 与 Codex `gpt-6.1-sol`，没有静默替换。实际调用使用临时 workspace/HOME/userData，不触碰生产会话。完整记录见 [m0-real-acceptance.md](m0-real-acceptance.md)。

真实调用发现并修复三个问题：规划提示遗漏容器 `blocks`、冷目录初始化前抓取旧健康状态、公共进度返回历史槽位计数。`d4c5f94` 运行代码的默认 `npm test` 为 3478 passed / 4 skipped（shell 通过），typecheck、打包安全 gate、相关原生输入 UI 和 trace.delivery 计数 ratchet 通过。机器高负载，不作毫秒提升结论。

此前已核对混合完成链和最终产物上 Pi、Codex 各自生成后的 `stopped + settled`，5 个关键 outcome 与 12 个 canonical JSON / 13 个 archive 有独立核对。用户再次授权后，已在最终 `projection-fix` 冻结构建（`d4c5f94` 运行代码）新建独立现场补齐完整混合链：3 个子调用全部收敛、共享占用峰值 2 后归零；4 个不同 Native session 的规划/执行均与本轮 4 个 canonical record、4 个 archive 精确匹配，最终报告逐字等于两行真实标记。完成后重新启动仅观察，派发次数仍为 3、records 仍为 4、active run 0，无自动重发；CLI verify / doctor 通过，pending 为 0。

旧停止控制器断连后的现场仍保留 2 个 unknown reservation 和 1 个 pending managed turn，不清空、不降级证据、不重发；本轮前后两条 unknown workflow 与 managed open 文件的 3 个哈希均不变。三个临时现场的进程和共 6 份登录态副本已清理，记录和冻结产物保留。本次指定账号/模型、隐藏 App + 生产 IPC 范围的最终构建混合补验完成；前台 OS 焦点、完整 UI 操作和五 Provider 能力矩阵不在此范围。canonical 新身份/role/task-link 字段仍有 legacy_unset advisory，费用没有 costUsd，均不冒充完整或零费用。

### 未派发拒绝的后续修复（受控检查，不替代上述真实构建验收）

- canonical `startAppRun` 在进入 `providerRegistry.run` 前触发内部派发标记，规划和子调用各自拥有独立、单向的标记。在标记前拒绝会锁住延迟派发入口，并产生 `providerDispatch: not_attempted` 的结构化证明；不是按错误消息或 `frontdoor` 文案猜测。
- 证明随规划收据/子调用 outcome 持久化后，未派发失败或停止才释放槽位。子调用的尝试次数仍保留，不退款、不自动重试。不明异常、已尝试派发后的异常、必要持久化失败仍保留容量。
- 不迁移或清空旧记录。旧现场的 2 个 unknown reservation / 1 个真实 pending 继续保留；旧 Native history 的 `inProgress` 只是最后持久化状态，没有可用于 exact-managed 提交的整轮终态。没有重发任务，也没有从进程退出推断完成或中断。
- 新增 9 项回归，覆盖未派发/已尝试/未证明拒绝、延迟派发封口、停止不退款、写入失败保留容量、重启不重跑和真实文件 round-trip。全部 workflow 测试 **64 passed**；关闭新分类的负对照会因 `unknown != failed` 失败。typecheck、build、shell、生产 conversation ownership / unified conversation IPC 通过；后者是隔离 smoke Provider，不是真实付费调用。
- 保留首次验证失败：首批 32 个 focused 中 3 项因新证明未进入既有 outcome 投影失败（含一个等待超时），已补齐投影，未改断言或超时。默认全量首轮在未改动的 recorder FIFO 同步用例 15 秒超时，随后工具 300 秒截止，没有完整汇总；单项复核通过。串行全量为 **3486 passed / 1 failed / 4 skipped**，失败是 Pi custom-command fixture 的 3 秒终态等待；它在当前代码单项复核中既有失败也有通过，`fcc55ad` 生产源码对照单项通过。尚未确定该时序失败的原因，不能称全量绿色；没有修改 Pi 测试来通过。
- trace.delivery 计数为 2 IPC / 165996 bytes，5 次一致，ratchet 通过；该场景不代表新拒绝分支的端到端耗时。测速锁报告 highLoad，不作毫秒提升结论。
- 本次证据：`/tmp/scry-workflow-no-dispatch.LEItDb/`；旧现场只读调查：`/tmp/scry-workflow-pending-audit.uvf8wW/report.md`。没有新真实 Provider 验收、App 安装/重启或 push；旧冻结产物不包含这次新代码。

### Pi 间歇超时独立复核（未定位根因）

- 在用户授权的独立排查中，Pi 文件 113 项全部通过；原并发全套检查两次均为 **3487 passed / 4 skipped**，最终 `npm test` 同时通过 shell 检查。保留上节的历史失败，不把本轮通过当作间歇问题已修复。
- 原失败没有保留 RPC 阶段日志，fixture 退出时会删除临时现场。本轮未再次捕获原超时，不能判定它卡在进程启动、请求响应、命令处理还是结果清理；不猜测修改 Provider 逻辑。
- 仅在该测试失败时、停止子进程和删除 fixture 之前，输出 `PI_COMMAND_DIAGNOSTIC`：terminal 状态、最后 32 条事件的 kind/stage/ts、命令日志末尾 4096 字符及启动 PID。输出仅来自隔离的假 Provider，不读取真实账号数据；原异常继续抛出。3 秒等待、15 秒测试上限及全部原断言均未改变。
- 人为破坏终态断言的负对照按预期失败且输出诊断，恢复后全套通过。该负对照只证明诊断路径有效，不是原超时复现。
- 日志：`/tmp/scry-pi-command-convergence.ekAvy5/`。若该分支再次失败，保留 `PI_COMMAND_DIAGNOSTIC` 行后由维护 Agent 继续定位；当前仍不宣称根因修复。没有新增真实 Provider 调用，也没有修改旧 pending/unknown 或安装/重启现有 App。

实现检查点 `32a70bd` 基于 `c405df0`（0.2.204）；本分支经授权同步 `be907ef`（0.2.210），未包含或修改原工作区的 WIP。本地代码门禁通过不等于上述剩余范围已交付。未安装、未重启用户 App，也未 push；相同版本号不等于已部署。
