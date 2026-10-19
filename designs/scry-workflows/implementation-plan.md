# Scry-owned 工作流：实现方案

状态：代码调查与实现提案，**不是已经实现的执行能力**。仅修改 `designs/scry-workflows/`，没有接入真实 Provider。参考源码基线为 `282c918`；当前工作区有独立的 remote/iOS WIP，行号以调查时为准。

v2 用户纠正：以原始视频的编排侧栏、节点连线、执行动效、底部日志为视觉目标，拒绝 v1 的普通任务面板；不要设置并发上限。已删除 v1 的并发字段、隐藏限制与单活动 workflow 限制。v2 为演示完整视觉链路增加 edit 样例节点，不意味着真实修复能力已实现或获准执行。

## 1. 产品合同

- 用户选择每阶段的 Provider、可用配置档、模型；不使用 Claude 原生 Workflow，不固定 Opus/Haiku/Sonnet，不要求 JEV。
- 不设置产品层并发上限，不提供并发数量控件，不在内部隐藏同等限制。就绪任务由依赖与真实 Provider 准入决定。
- 真实执行第一期仍先实现「范围规划 → 并行扫描 → 独立复核 → 汇总」模板；v2 画布预览完整的 scan → edit → verify → review 形态，后续模板可启用修复阶段。规划 Agent 产生结构化计划，分页读取，不执行任意模型生成的 JavaScript。
- 用户确认目标、范围、配置和任务上限后启动。每次启动立即拥有独立 workflow ID 与面板入口；切走聊天不会丢失，历史可重新打开。
- 模型配置在创建运行时冻结。调整配置只作用于下一次运行；请求模型与 Provider 实际观测模型分别记录。Provider 没有上报实际模型就显示 unknown。
- 扫描结果是候选，不直接作为缺陷；复核使用新会话，重新读取源码与调用链。结构校验不等于事实验证。复核失败保留 unverified，不能计为 refuted。
- 第一期不自动修复、不自动合入、不建立任意 DAG 编辑器、不运行无限修复循环、不接手机端、不做跨设备执行。

### 需要明确纠正的“只读”表述

现有 `AgentPermissionMode` 只有 default / auto-review / full_access（`src/shared/runtime.ts:98`）。**没有跨 Provider 强制只读执行合同**。prompt 写“不修改文件”不是权限隔离；获批工具以及经现有指纹校验的仓库 Hook/MCP/plugin 仍可能写文件或执行代码。

因此第一期名称为“请求只读审计”，不承诺“绝不会写入”。保持现有 Provider-specific 授权、trust 策略与文件足迹观测，不自动升级 full_access，不把工作区副本称为沙箱。Recorder 仍可能按原设置写 `.scry`，这与源文件修复不同。若维护者要求“保证不写源文件”，必须另立执行约束设计与 Provider 拒绝矩阵；本方案不能声称已经满足该保障。

## 2. 已有能力与必须补的接缝

下列是代码阅读证据，未通过真实 Provider 验证。

| 领域 | 已有实现 | 本次判断与后续动作 |
| --- | --- | --- |
| Provider 执行 | `src/main/providers/types.ts:63–150`，`registry.ts:77–95`：模型、配置档、emit、interrupt、promise | 复用 adapter，不创建第二套 Provider 实现；不能直接调用 registry.run 跳过上层授权 |
| 模型目录 | `registry.ts:98–116`；各 adapter 的 runControls facet | 复用 capability envelope；目录 unavailable 就阻止该配置启动，不静默改用默认模型。目录探测可能启动 transport，不能当作纯静态读取 |
| 配置档 | `src/main/pi-agent-profiles.ts:19–86` | Pi 有现成 profile store；其余 Provider 先只显示实际已有默认配置，不能伪造统一多账号管理 |
| 并发与焦点 | `src/main/run-registry.ts:15–47,73–94` | 支持多 run 与 focus:false；不是全局单 run，但还受会话 fencing、auth gate 与 transport 限制 |
| 会话准入 | `src/main/index.ts:2784–2994` | 本地启动依赖 currentCwd/sessionByContext/revision；需要显式 workflow owner 和独立 session，不能串行模拟 renderer 发消息 |
| 认证互斥 | `src/main/provider-operation-gate.ts` | 复用同 Provider/profile 认证互斥，不将它误当作工作流串行队列 |
| 事件归一化 | `src/main/index.ts:3305–3347`，`live-trace-ingestion.ts` | 当前 live publish 仅面向被查看 run；workflow 投影必须接全 run ingestion，不能只订阅 renderer onTrace |
| 完成收口 | `src/main/index.ts:4435–4507` | turnDone 早于 archive/recorder/settled；下一阶段必须等执行与所需证据收口，不以文本停止或 promise 分发成功当完成 |
| 停止 | `ProviderRunHandle`、`run-stop-lifecycle`、`BackgroundWorkPanel.tsx` | 复用停止身份与进程作用域；stop_requested 不等于 cancelled，不能为某个任务硬杀共享 Provider transport |
| 持久化 | `trace-turn-progress.ts`、`transcript-archive.ts`、`managed-turn-commit.ts` | 保留各自权威性，只新增编排事实及现有证据引用；不把 workflow 状态塞入 recorder core |
| 诊断日志 | `provider-event-log.ts:4–80` | 默认关闭且 fail-open，不可充当调度 journal |
| UI 选择器 | `Pickers.tsx` 的 CliPicker / ModelEffortPicker | 生产复用，按阶段传 capability 与配置；原型的原生 select 不是未来第二套业务选择器 |
| 子 Agent 证据 | `AgentsSurface.tsx` | Provider 内部子 Agent 是观测内容，不自动变成 Scry 调度任务，避免计数与用量双计 |

特别注意 `SCRY_RUN_CONTROLS=0`：当前 registry 会清除请求 model/effort。工作流若承诺用户指定模型，就必须在准入阶段拒绝，而非默默继续。

## 3. 最小结构

```text
React 工作流入口／运行面板
  │ typed preload + handleTrusted
  ▼
main/workflows（拟新增 focused module）
  ├─ 固定模板、输入 schema、模型配置快照
  ├─ 就绪任务派发、阶段依赖、暂停／停止
  ├─ 持久编排绑定与恢复
  └─ 有界 UI 投影
       │
       ▼
共享 App run 启动链（从 index.ts 提取必要接缝）
  workspace + trust + session fencing + command receipt
       → ProviderRegistry → 现有 adapter
       → 全 run 事件 → archive / recorder 收口
       → workflow 阶段终态
```

仅增加真实职责，不新增通用工厂、插件系统或第二个 Provider registry。不将 workflow 冒充 remote origin 来绕过本地上下文限制；remote WIP 合并前协调 `index.ts` 的编辑归属。

### 任务输入和产物

1. 用户填写目标及已授权范围；规划阶段读取目录并提出分片清单与检查标准。
2. main 校验计划：文件必须落在授权 canonical cwd 范围内；拒绝越界、重复与无效阶段依赖。模型不能授予额外路径或权限。
3. 派发所有依赖就绪且通过真实 Provider 准入的任务，不插入人为的并发槽位上限。扫描分片之间不共享 Provider session；同会话重入和认证互斥仍按现有合同拒绝，不把这两类安全校验伪装成产品并发限制。
4. findings 包含稳定 ID、范围/文件位置、摘要和证据引用。分页传输与按需读取，限制单条／单批载荷大小而非任务或发现总数；超出载荷合同明确报错，不能静默截掉结论。
5. verifier 新会话读取候选与当前源码，记录 confirmed / refuted / unverified 与依据。源码基线变化则结果标 stale，要求重新检查，不拿旧行号冒充当前事实。
6. 汇总阶段只接收这些结构化结果及必要引用；不把全部子 Agent transcript 填回主上下文。保留未知项。

只有样例原型用静态清单。生产不能把该清单、模型目录或发现结果搬进去作为实现。

### 身份与状态

编排身份：`workflowRunId → stageId → taskId → attemptId → providerRunId`，另存原生 session/turn ID（未提供时留空）、冻结配置、来源 revision、证据引用。

任务生命周期建议：

```text
pending → preparing → running → settling → completed
                       ↕
                waiting_for_input

失败路径：failed / cancelled / interrupted / blocked
控制状态另存：pause_requested / paused / stop_requested
证据状态另存：available / partial / unavailable
```

- “暂停调度”只停新任务，允许在途任务完成；不是跨 Provider 的进程暂停承诺。
- “停止”先写控制请求，再调用已登记 handle；只有收敛证据才能变 cancelled。部分 transport 停止语义未知时保留 unknown，不自动发第二次。
- “阶段已收口”不代表每项 finding 已确认。界面必须分别显示确认／排除／未验证计数。
- 进度按明确的任务总数计算；规划阶段总数未知只显示运行中，不给预测百分比。
- Provider 执行结局与归档提交结局分开保存；归档失败可显示 recording_failed，但不能显示完整可回放。

### 持久化与崩溃恢复

复用 App-owned storage 的原子写入／目录策略，新增有界 workflow manifest 和编排事件，不复制全部 transcript，也不新增第二份 canonical token/cost ledger。

关键顺序：先分配 runId、写入任务绑定及派发意图 → 落盘成功后才允许 Provider dispatch → 记录输入回执（有能力时）→ 持续 checkpoint → 等待终态与必要归档收口 → 允许下游。

- 绑定或派发意图落盘失败：fail closed，不发送。
- 发出后崩溃但未获回执：恢复为 interrupted/unknown。不能假定未执行，不自动重发。
- 重启先核对活动 owner，再恢复投影；不凭 manifest 的 running 就重新启动 Agent。
- 用户要重跑时，必须看清前一 attempt 的已知副作用；新建 attempt，不覆盖旧证据。
- 保留、清理及备份流程沿用 App archive 约定；删除 workflow 引用不声称删除了 Provider 原生历史。

### 无人为并发限制；观测与传输仍有界

用户明确不要并发上限。删除“单个活动 workflow”“扫描 1–4”“任务数 64”等人为派发限制，不增加隐藏的 maxWorkers、默认槽位池或替代配置。

未设产品上限不代表 Provider 或主机资源无限。实际 Provider 限流、认证互斥、同会话冲突或资源不足应返回明确状态／错误；不绕过安全校验，不将未知结果自动重试。没有错误证据时，不猜测限流或自动改变用户选定模型。固定模板不引入自动重试；后续修复循环若加入，连续两轮无进展停止属于终止条件，不是并发限制。

有界性应用于观测和传输：UI 每页 50 条任务／事件、虚拟化长列表；详情按引用读取；main 合并有界 IPC 增量，revision 缺口由 snapshot 修复。窗口不可见时停止绘制，不停止真实执行。按页读写计划与结果，不把所有任务或 transcript 常驻 renderer 内存。原型的有限演示任务与 120 条日志窗口只是样例／显示范围，不得转化成生产派发上限。

费用沿用 canonical usage 来源，不把子 Agent 与主 Agent 重复累加；来源缺失显示 partial/unavailable。高并发可能提高瞬时资源与费用消耗，但不以此擅自恢复用户拒绝的上限。费用来源不完整时不能承诺美元硬预算，不制造虚假的预算开关。

## 4. 面板与原型差异

| 区域 | 原型演示 | 生产实现 |
| --- | --- | --- |
| 配置 | 静态、明确标记样例目录；Pi 才有额外样例配置档 | adapter capability/model catalog；身份变更清理旧能力与模型 |
| 运行图 | 自动／单帧回放；左编排轨迹、中间连接图与粒子、下方日志；9 个扫描、4 个修复、3 个验证样例 | 运行器事实投影，自动出现并持久可回放；粒子和阶段高亮随真实事件变化 |
| 节点详情 | 假路径、提示、固定结果，标记演示证据 | 显示真实 task/run/session/turn、逻辑工具调用与证据来源 |
| 用量 | unavailable | canonical usage + coverage，不承诺完整计量 |
| 暂停／停止 | 演示请求与确认的分离 | 真正的队列 admission 与已登记 handle 作用域 |
| 历史 | v2 聚焦执行画布，提供重新回放，不包含历史导航页 | 持久化、分页、重启恢复；不自动续跑 |
| 模板保存 | 浏览器 localStorage | App-owned validated template store；renderer 无任意文件写入能力 |

## 5. 实施顺序与验收门槛

### M1：完整启动链的 workflow owner 接缝

从 `startAppRun` 提取必要模块，使执行 owner 显式区分本地会话、remote 与 workflow，保留现有授权和 session fencing。增加事件 observer 与 settled/recording outcome，而不是让 renderer 轮询或抢焦点。

验收：两个独立 mock Provider run 并发不污染聊天 session；同 session 重入仍拒绝；workspace/trust/身份拒绝测试触发生产 trusted wrapper，证明特权 listener 未执行；关闭 run controls 不可静默换模型。

### M2：固定模板、持久绑定、真实执行闭环

实现四阶段模板、用户模型配置、依赖就绪派发、结构化 findings、独立 verifier、暂停／停止及崩溃恢复。用现有临时 workspace/userData 与本地进程 fixture，不调用付费 Provider。

验收：逐阶段不同 Provider/model/profile 正确到达 adapter；新验证会话可追溯；失败不会生成全绿报告；重复 start 不重复执行；派发前落盘失败不发出；派发后崩溃不重发；等待 settling 不提前派发下游。

### M3：生产运行面板

将本原型确认后的布局迁入 React，复用现有 picker、证据详情、文案模块与样式 tokens。增加 typed preload / `handleTrusted` 工作流操作，所有新 channel 进入 `scripts/performance-paths.json`。生产不依赖原型脚本。

验收：每条 workflow 自动关联面板；关闭重开／切换聊天／renderer 重挂后恢复；后台阶段不丢事件；暂停与停止文案符合真实状态；键盘、长值、空／错／unknown 态通过隔离 Electron 的真实输入检查。

### M4：经授权的真实 Provider 验收

先验证一个 Provider，再验证用户选定的跨 Provider 组合。真实探针需要明确账号与费用授权、临时工作区与 HOME/配置凭据 allowlist；过程结束确认子进程收敛。不同 Provider 分别记录可用、降级与未验证能力，不能用 mock 冒充。

未来修复阶段另行设计独立 worktree、冲突检测、验证命令、差异审阅、合入授权和清理；不在审计一期中偷偷接入。

## 6. 验证清单

复用／扩展以下现有 focused tests，而不是另造大套测试框架：

- `run-registry.test.ts` / `provider-operation-gate.test.ts`：后台 run、认证互斥与上下文隔离。
- `command-receipts.test.ts`：幂等启动，未知结果不能重放。
- `run-stop-lifecycle.test.ts`：请求与确认分离，不能越过 shared transport 边界。
- `live-trace-ingestion.test.ts`：后台投影、乱序／重复／丢批后的 snapshot。
- `trace-turn-progress.test.ts` / `managed-turn-commit.test.ts`：崩溃恢复与归档失败，不提前提交证据。
- workflow 新 focused test：所有依赖就绪任务可派发且无隐藏并发上限、真实 Provider 拒绝不绕过、模型／配置档失效、独立复核、unverified 保留、全路径自动关联。
- 新 IPC 安全测试调用实际注册 wrapper，并用负对照证明绕过保护时会失败。
- 实际 UI 验收使用现有隔离 Electron fixture；HTML 原型点击不替代生产交互证明。
- 热路径改动按项目性能约定加锁运行 `npm run performance:measure -- --scenario <已登记场景>`，不得猜测场景名。计数下降与真实毫秒下降分别报告。

发布交付遵守项目 typecheck／focused test／打包／安装合同。安装不自动重启 Scry，真实 App 复验等用户手动重启后执行。

## 7. 下一步与待确认

1. 用户确认本版面板结构和模型配置体验，然后实施 M1–M3。
2. 权限文案默认采用“请求只读审计”，不承诺安全隔离。若要求强制禁止写入，需要维护者明确这一升级目标，先设计执行约束再排期。
3. 生产修改 `src/main/index.ts` 前，由实现者协调现有 remote/iOS WIP；本次不改该文件。
4. 真实 Provider 组合与费用授权由用户在 M4 前决定；本次不会启动模型或模型目录探针。
