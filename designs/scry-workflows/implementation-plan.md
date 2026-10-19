# Scry-owned 工作流 v10：保存编辑与完整程序化编排

状态：**技术方案，不是已实现的生产能力**。按用户确认的范围迭代：v5纳入控制流、中间状态、对抗复核与多方案；v6补齐聊天入口；v7加入无运行中业务输入及资源硬限额；v8补齐管理、依赖恢复与停滞重启；v9加入规模软建议。v10补齐个人/项目保存、手动/Agent编辑、差异预览及模板与运行版本隔离。HTML仍为v3固定模板演示，本轮不修改生产运行器或调用真实Provider。

规范补充：[执行语义与质量模式](execution-semantics.md) · [聊天入口与运行模式](chat-entry-semantics.md) · [运行约束](runtime-limits.md) · [运行管理与恢复](run-management.md) · [保存与编辑](template-lifecycle.md)。六者共同构成方案；v7覆盖历史无上限约定，v10覆盖模板仅App-owned的旧限制。全部合同都须通过，不能用旧原型冒充已实现。

参考：[Claude 官方 Workflows](https://code.claude.com/docs/en/workflows)；逐项事实与取舍见 [原文核对](reference-notes.md)。核心方案读取基线为 `2779a07`，v6 入口补充基线为 `5dfc1f4`。v7 起点 `43685ee`，v8 读取时 HEAD 已为 `8c2d835`。工作区含并行 WIP，实施前重验接缝，不把旧行号当合同；已实读 RunStopLifecycle，现有重复 request 只重播状态，并不重发停止信号。

## 1. 已确定的产品边界

- **Scry 自有运行器**，不依赖 Claude 原生 Workflow。模型生成有控制流与变量语义的 WorkflowProgram，由解释器执行；不用任意 JS/eval/import，也不以此删掉循环、分支或状态能力。
- **自动编排与模板共用一条执行链**。不同任务可以有不同阶段、依赖与检查标准；小任务允许单节点，不为展示多 Agent 强行拆分。
- 用户选择编排、执行、复核、汇总角色的 Provider / 可用 profile / 模型，并可覆盖某阶段。Jev 是独立可选 classifier，不混入 coding Agent 列表。
- 默认共享并发最多 16，CPU 较少时降低，用户可设整数 1–256；单次 parallel/map 最多 4096 项，每次根执行最多 1000 个 Scry Agent 尝试。超限明确排队或拒绝，绝不静默截断；多个 workflow 可并存但共享槽位。真实 Provider 准入、认证互斥、session fencing 与资源错误仍生效。
- 运行中无用户业务输入；权限审批、用量等待和暂停/停止控制保留。阶段间人工确认须结束前一工作流，再明确启动下一工作流，不在原运行中等待业务答案。
- 每个 workflow 创建时即有 ID 和面板。后台执行与当前聊天焦点、renderer 生命周期分离。
- 扫描只是候选；独立复核才产生 confirmed / refuted / unverified。没有证据不能显示 0、成功或“无风险”。
- 完整范围包括审计、评审、研究、多方案权衡、检查修复循环和批量迁移。按里程碑实现，但这些不是延期排除项；尚未实现的节点必须显式 unavailable，不能以固定模板替代后宣称功能完成。真实写入/应用仍需要具体运行时授权，方案批准不是执行授权。

### 聊天入口与模式

- 三种执行入口：自然语言明确请求、会话自动判断、内置/保存模板命令；复用同一StartIntent，不另造执行链。模板编辑/保存不创建执行根。
- off/manual/auto 作用于当前会话；本次 direct/workflow 覆盖只消费一次，不修改 Provider effort。初始 off 不增加路由费用，启用自然语言识别前明确授权编排模型和数据范围。
- 自动判断只授权路由与规划，不自动批准生成的计划。Scry 命令使用 `/scry-workflow` 命名空间，不劫持原生 `ultracode`、`/effort`、`/deep-research`。
- 路由合并规划以免重复调用；失败/unknown 不自动转普通模型重发。来源、命令冲突、恢复、组合任务及验收见 [完整入口合同](chat-entry-semantics.md)。

### 规模指引：建议与硬限制分开

新增 `workflowSizeGuideline`：unrestricted不提供数量建议，small少于5、medium少于10、large少于50，Scry默认medium。本次明确任务要求可覆盖建议；不能因此绕过并发、4096项或1000次预算，也不强制裁剪草案/固定模板。

设置文件覆盖UI/命令偏好，展示生效来源；变更从下一次新任务生效，旧草案/运行/恢复沿用快照。完整配置路径、无效值处理、计数口径、UI和验收见 [规模指引](chat-entry-semantics.md#规模指引v9)。

### 左侧应显示什么

上方显示**用户选择的编排模型**；下方显示**本次冻结计划的可读投影**，不是每次都相同的 `scan/edit/verify` 脚本。

- 展示目标、模板来源或自动生成、program revision、节点与当前执行位置。
- 生成中的计划标草案；验证通过且用户确认后才标执行计划。
- 左侧大纲和中间图来自同一个 plan snapshot；不维护两份可漂移的“脚本”和图。
- 保存为模板时保留定义与参数，不保存“上次检查了这九个文件”当成通用执行逻辑。

## 2. 总流程图

下图全部是**拟实现流程**；当前原型只演示其中的配置与运行投影。

[运行器总览图（SVG）](workflow-overview.svg) · [对抗复核与多方案权衡图（SVG）](workflow-quality-patterns.svg)。以下 Mermaid 展开调度、Jev 和恢复；[执行语义](execution-semantics.md) 另有检查修复循环与多方案权衡图。SVG 同步展示程序化控制流，而非固定阶段。

```mermaid
flowchart TD
  A[聊天请求 / 自动模式 / 模板命令 / 页面<br/>选择角色模型与可选 Jev] --> B{经入口合同确定的工作流任务}
  B -->|已完成入口规划| C[复用入口产出的 WorkflowProgram<br/>已有控制流与角色绑定，不重复规划]
  B -->|选择模板| D[绑定模板版本和参数<br/>缺少范围时再规划]
  C --> E[main 编译并校验程序<br/>作用域、控制流、终止策略、能力与输出合同]
  D --> E
  E -->|无效或能力缺失| X[显示具体原因<br/>修改草案或配置，不静默降级]
  E -->|通过| F[用户确认本次计划<br/>冻结角色绑定、参数与计划版本]
  F --> G[先持久化任务身份和派发意图]
  G --> H[Scry 执行控制帧与调度就绪任务<br/>不由主模型逐轮指挥，按共享槽位与总预算准入]
  H --> I{执行类型}
  I -->|Agent| J[完整 App 启动链<br/>workspace、trust、session、权限、adapter]
  I -->|Jev| K[main 分类调用<br/>凭据、输入授权、模型和结果校验]
  J --> L[等待执行终态与所需证据落盘]
  K --> L
  L --> M{还有所选分支、下一轮或下游?}
  M -->|有| G
  M -->|没有| N[汇总结论及覆盖范围<br/>保留失败、未验证与过期项]
  G -.-> P[持久编排事实与证据引用]
  L -.-> P
  P -.-> Q[自动关联面板<br/>计划、节点、分类、工具证据、用量、历史]
```

**两个授权时点**：明确单次提交/点击“生成计划”，或先授权 manual/auto 的后续路由与规划调用；这些步骤可能消耗模型费用，不是免费识别。生成计划后仍须用户确认该版本才执行。自动判断不替代执行确认。参数足够的模板直接实例化，不额外调用规划模型。

Provider 工具审批仍走原生/映射后的权限模式。批准计划不替代仓库配置指纹校验，不改变既有 MCP/Hook/plugin 自动授权策略，也不自动升级 full_access。

确认/启动使用 commandId 幂等收据并绑定用户看过的 programRevision；旧版本确认不能启动已变化的计划。派发前仍重验当前 workspace、trust 与 capability，不能只依赖预览时的检查。

## 3. 模板不是另一套调度器

### 完整范围中的 Scry 模板

| 模板 | 典型计划 | 必需能力与结果 |
| --- | --- | --- |
| 代码审计 | 确定范围 → 按文件/模块扫描 → 可选 Jev 分类 → 独立复核 → 报告 | 工作区读取与结构化候选；报告保留未知项 |
| 变更评审 | 固定 diff 基线 → 按风险/文件评审 → 去重但保留来源 → 复核 → 排序报告 | 可验证的 diff/工作树输入；基线变化标 stale |
| 资料调研 | 问题分解 → 多角度检索/读取 → 可选 Jev 标签 → 对照来源 → 带引用报告 | 在线调研需要实际搜索/读取能力；不可用不假装检索过 |
| 多方案权衡 | 冻结 rubric → 独立起草 → 非作者交叉审查 → 硬约束筛选/权衡 → 改进或综合 → 复验 | 候选与异议保留；全不合格必须返回 no_acceptable_plan |
| 检查修复 | 固定基线/检查 → 修复 → 独立检查 → 进展判断 → loop → 差异审阅/获准应用 | 真实通过才退出成功；无进展、振荡、unknown 不假成功 |
| 批量迁移 | 发现目标 → 独立副本 map 转换 → 单项验证 → 集成候选 → 整体验证 → 审阅/获准应用 | 冲突与工作树基线检查；单项通过不等于整体验证 |

这些是 Scry 拟内置模板。官方当前明确内置的只有 `/deep-research`；其余例子是生成工作流的提示词，不称为已移植的官方模板。

### 自动入口如何使用模板

1. 编排 Agent 输出目标、建议模板或新组合、节点职责、依赖、输入/输出合同与验证标准。
2. 模板是可复用的计划骨架，不是强制路线；允许省略无用阶段、增加受支持的独立检查分支。
3. main 编译程序，校验类型/作用域、结构化循环、条件的 unknown 路径、终止策略与副作用范围。能力缺失、未授权写入或非法程序必须明确拒绝；不能靠退回主模型逐轮决策掩盖解释器不支持。
4. 用户看到计划差异与模型绑定后批准。规划模型不能偷偷选择更贵模型或改变权限。
5. 有效草案或运行定义可“保存为模板”：明确哪些输入变成参数、哪些依赖固定；个人跨项目复用，项目定义经用户Git操作共享。保存不代表运行成功，下次执行重新校验能力、范围和trust。

### 保存、编辑与单次修改

完整流程见 [v10保存与编辑合同](template-lifecycle.md)。个人定义存App-owned目录，项目定义存授权根下的 `.scry-workflows/`，都保存结构化程序而非JS。模板源码可手动编辑，Agent只生成待审候选；共用编译器、差异预览及冲突检查，明确区分保存新版、另存为与仅本次使用。

模板更新不影响已冻结实例。修订后恢复创建新执行实例但保留原root预算与逻辑身份；全新运行必须另行明确选择。读取项目模板不自动执行，不引入插件、通用拖拽编辑器或模板市场。

## 4. 程序与数据合同：不是任意 JS，也不只是静态 DAG

复用现有类型/校验模式；只新增工作流所需的数据合同与有限 typed 表达式求值。不引入任意 JS VM、第三方通用表达式引擎、插件注册表或第二套 Provider SDK。

| 记录 | 核心字段 / 语义 |
| --- | --- |
| TemplateDefinition / TemplateRef | schemaVersion、稳定templateId、内容revisionHash、参数/角色/完整程序；来源builtin/personal/project及canonical项目身份；不含运行授权 |
| TemplateDraft | 来源与baseRevisionHash、draftRevision、编辑目标、候选及校验/diff；Agent返回绑定基线，保存操作绑定commandId与指纹 |
| WorkflowProgram | workflowId、programRevision、userGoal、workspace identity、templateRef（可空）、配置快照、程序体、输入/输出与证据合同；取代 v4 仅静态节点的 WorkflowPlan |
| ProgramBlock | blockId、phase 分组、sequence/parallel/map/branch/loop/call/return、typed 输入/绑定/表达式；call 绑定 Agent 或 classifier |
| ControlFrame | scopePath、程序位置、frameRevision、已提交变量/引用、分支决策、loopState、iteration、最佳候选、终止原因 |
| SystemStep | 编译器按已批准写入策略派生的准备/组合/应用/清理步骤；effectId、受控目标引用与结果；不接受任意命令/路径，也不计为 Agent |
| ExpandedTask | taskId、nodeId、scopePath、stableItemKey、iteration、inputFingerprint、来源；不是数组位置或完成顺序 |
| Attempt | attemptId、执行身份、派发意图/回执、状态、输出及证据引用、已知副作用、用量来源 |

`phase` 只分组展示；控制流由程序块定义，数据依赖由 typed refs 定义。map 的子程序可以包含分支/循环，parallel 的 join 保留所有 outcome。loop 是逻辑轮次，不是失败调用自动重试。单轮展开图可无环，但程序整体不再被静态 DAG 限制。汇总是消费允许引用的 Agent 节点，根 return 才交回最终结果。

完整语义见 [执行语义 §2–3](execution-semantics.md#2-最小且足够的控制语义)：unknown 分支、并行写入/汇合规则、carry、进展比较和退出条件都有明确合同。

### 校验规则

- 校验版本、唯一 ID、作用域/引用、输入输出类型、合法 workspace 与角色绑定；拒绝任意回边，但允许已校验 loop 块。分支必须处理 unknown，循环必须声明终止/进展策略。启动受理不等于实际开始，更不等于完成；编译失败不派发。
- 输出合同使用版本化结构（文件清单、发现、复核、来源/报告、方案候选、rubric 评价、诊断集合、patch 引用与 loopState），不由模型提交任意代码执行验证。能复用 adapter 原生结构输出则复用，但不能假设所有 Provider 都支持；后验校验始终需要。
- 生成 prompt 标 `source: generated_task`，保留原始用户目标，不伪装成用户直接指令。无效输出记 output_invalid；本期不静默付费重试或把错误解析为空数组。
- 为需要可靠结论的节点声明独立复核，不允许扫描者把自己的自述当 verified。独立会话不等于保证模型无共同偏差；记录 reviewer 与证据来源，不用“多数票”替代来源核对。复核冲突保留各方依据，结论标 unverified/存在争议；额外复核必须来自已批准的节点或新计划确认，不能偷偷追加费用。
- 源码引用包含授权路径、revision 与相关工作树内容摘要；网页引用包含 URL、获取时间和已保存内容引用。报告引用“当时读到的版本”，不假装可变 URL 或旧行号就是当前事实。
- 验证单条 payload 与逻辑集合基数：parallel/map 超过 4096 项整次拒绝，不能借分页或自动分批绕过。合法集合才分页登记；执行还受根预算 1000 次约束，不截断成假成功。

### 运行中才知道任务数量，怎么办？

用户确认的计划可以写“对发现集合中的每项执行扫描/复核”，不必在启动前猜数量。只有上游输出已验证并落盘，才能展开。

- 动态集合先封口并校验基数≤4096，再按稳定 key 登记 expansion checkpoint；槽位/预算准入后才派发。崩溃后核对准入记录和 checkpoint，不重新从数组下标猜身份。
- 展开不得新增未经确认的 Provider/权限/数据发送范围。越界则 blocked，原有在途任务按合同收敛；不得在同一运行补输入后续跑，后续由新计划/新运行承接。
- 集合还在产生时显示“已发现 N / 总数未定”，不显示假的完成百分比。真实成功返回空集合才能省略空分支；上游失败不是空集合。
- map 和 loop 是不同能力：map 按集合展开；loop 按已提交状态执行下一轮。两者可组合，不把旧计划的“只做 map”当完整实现。终止策略在确认时显示；没有可靠进展依据时须提供可见的结束边界，不能裸 while true。逻辑终止策略与资源限额并存：每轮派发都受并发与根执行 1000 次预算约束，达到预算不能借新轮次重置。

## 5. Jev：分类建议与事实验证分开

Jev 使用独立 classifier 调用路径；不是有终端、工具或写权限的 Agent，也不占用 Agent session。沿用已确认的启用/模型/阈值配置，冻结到 program revision。

```mermaid
flowchart TD
  A[扫描或来源读取的候选<br/>含稳定 ID 与证据引用] --> B{启用 Jev?}
  B -->|否| V[独立 Agent 复核]
  B -->|是| C[Jev typed classification<br/>题目、criteria、概率与来源]
  C --> D{结果可用?}
  D -->|错误、中止或缺失| U[标 unavailable<br/>不补零、不当作否定]
  U --> V
  D -->|可用| E{置信度达到用户阈值?}
  E -->|否| L[标记优先 Agent 复核<br/>保留低置信度原因]
  E -->|是| H[保留分类建议与原始概率<br/>用于分组和复核顺序]
  L --> V
  H --> V
  V --> R[confirmed / refuted / unverified<br/>逐项保存依据]
  R --> S[报告同时展示结论与覆盖范围]
```

第一批 Jev **只做分类、分组与复核优先级**，不自动删掉高置信度的否定项，因此不会宣称已减少复核调用或费用。若之后需要省略低价值项，必须另行定义用户明确选择的筛除策略和 triaged_out 状态；它不等于 refuted，安全审计不能默认省略。

- bool 使用 `confidence=max(p,1-p)`；p=0.09 的置信度是 0.91。模板若选择 choice/score，则同时冻结标签/评分 criteria 与相应返回合同并验证 capability，使用真实 confidence，不套 bool 公式；服务/adapter 未支持时明确 unavailable，不假装已经评分。独立 Agent 的方案评价不依赖 Jev 才能执行。
- 分类失败只使分类证据 unavailable；若已批准的计划包含独立复核且原始输入仍可用，可以继续复核。否则显式 blocked，不临时发起未经批准的额外 Agent。
- 凭据与调用在 main。选定账号/费用和发送数据范围后才允许请求；不继承当前 Pi harness 的凭据，不把 key 放 renderer、模板、localStorage 或日志。
- 保存问题/criteria、输入引用、请求与实际模型、概率/置信度、路由原因、stopReason 和用量 provenance。Classifier 用量单列，不能与 Agent/主会话重复累加。
- 当前代码没有 TypeSafe/Jev transport。Pi 的 `models.classify` 只是参考合同，生产实现前必须核对 TypeSafe 官方 API 与仓库可复用依赖。现有原型概率仍是假数据。

## 6. 实际执行：复用完整 App 启动链

本轮阅读确认以下接缝；均为代码证据，不是新能力已通过真实 Provider 验收。

| 已有代码 / 符号 | 复用点与必须补的内容 |
| --- | --- |
| `src/main/index.ts`：AppRunStartOptions / startAppRun | 当前 origin 仅 local/remote，本地还耦合 currentCwd 等状态。补显式 workflow owner、独立 session/context；不能冒充 remote 或驱动 renderer 发消息 |
| 同文件：LiveTraceIngestion / runs.isViewed(runId) | publish 仍按可见 run 过滤。增加全 run observer，让 workflow 投影接归一化事件，不抢焦点、不只监听 onTrace |
| 同文件：archive、settleManagedConversation、runStopLifecycle.settle | 分开发出终态、归档和最终收敛；向 workflow 暴露明确 completion/recording outcome，不能只听 turnDone |
| `src/main/providers/registry.ts`：run / runControls | 复用实际 adapter 与 capability envelope；SCRY_RUN_CONTROLS=0 当前会清除 model，指定模型的 workflow 必须前置拒绝 |
| `src/main/run-registry.ts`、`provider-operation-gate.ts` | 多 run/focus:false 与认证互斥可复用；仍要独立 session fencing，不能把认证互斥当人工串行调度器 |
| `src/main/providers/types.ts`：ProviderRunHandle | 复用 interrupt、promise 与 forceKillScope；仅停止登记且身份匹配的执行，不能杀掉共享 transport 的其他任务 |
| `transcript-archive.ts`、`trace-turn-progress.ts`、`managed-turn-commit.ts` | 复用 canonical 证据与恢复事实；新增的只有编排关系与引用，不复制 transcript 或 token ledger，不把 workflow 塞进 recorder core |
| `provider-event-log.ts` | 可选、fail-open 诊断日志不能充当持久调度 journal |
| `Pickers.tsx`、`BackgroundWorkPanel.tsx`、`AgentsSurface.tsx` | 复用模型/配置档选择、停止文案与证据展示。Provider 内部子 Agent 只是观测对象，不自动重复算 Scry 调度任务 |

实现先抽取最小启动/收口接缝，不顺手重写整个 main。请求模型和观测模型分列；不支持/未登录/不可选择就拒绝或明确 unavailable，不自动替换。实际模型未被上游报告则标 unknown，不把请求值冒充观测值。若 Provider 自行替换模型，保留事实并标记合同未满足，不能悄悄沿用原名称。

工具审批和 Agent 追问沿现有 requestUserInput/权限回调，绑定 workflow/task/attempt，显示在对应运行面板而非污染当前聊天。回答只作用于仍有效的目标请求；停止后的旧问题不可恢复旧 attempt。不同 adapter 不支持交互时显式拒绝相关计划，不自动代用户回答。

### 权限事实

现有 `AgentPermissionMode` 没有跨 Provider 强制只读保证。分析类节点称“请求只读”，写入类节点明确范围与应用策略；两者都不是安全沙箱。工具、获准仓库配置与 recorder 可能写入。副本、冲突、组合验证、基线重验、应用及清理采用 [执行语义 §8](execution-semantics.md#8-写入与迁移也是目标能力不再只写未来设计) 的完整合同，不再留成“未来另行设计”。

## 7. 持久化、下游准入与恢复

身份链：`workflowId → programRevision → scopePath/nodeId → stableItemKey/iteration → taskId → attemptId → providerRunId/classifierRequestId`。原生 session/turn ID 未提供就留未知，不拿生成 ID 冒充。

```mermaid
flowchart TD
  A[任务依赖已满足] --> B[先落盘身份和派发意图]
  B -->|落盘失败| X[拒绝发送]
  B -->|成功| C[复验当前权限与能力后发送]
  C --> D[记录可用的输入回执与事件]
  D --> E[执行终态]
  E --> F[输出合同校验与必要证据持久化]
  F -->|完成| G[任务可供下游消费]
  F -->|未完成或失败| H[settling / recording_failed<br/>所需证据不可用时阻止依赖节点]
  C -.->|发出后崩溃、回执不明| U[interrupted / unknown<br/>不自动重发]
  U --> R[核对现存 owner、进程与证据<br/>用户显式决定新 attempt]
```

- **先持久身份不等于 exactly-once**：外部调用与本地落盘不能原子提交。无回执时宁可 unknown，也不能假定没执行而重发。
- 下游准入依据：执行 terminal、输出有效、节点要求的产物/归档落盘；managed recorder 开启且属于必需证据时也须收口。禁用/不支持的可选证据以明确 coverage 表达，不要求不存在的 API；必需证据失败则依赖 blocked。
- 三组状态分离：execution（pending/preparing/running/terminal）、recording（pending/committed/failed/disabled）、evidence（available/partial/unavailable/stale）。completed 不自动等于 verified。
- 失败集合保留每项 outcome。报告节点可以按显式 collect-outcomes 合同读取成功与失败的摘要，不能把失败输入当普通成功产物喂给执行节点。
- 运行事实始终存 `userData/workflows/` 的App-owned文件：所用模板修订快照、计划/展开页、任务与attempt记录。个人模板也在该数据域；项目当前定义在授权根 `.scry-workflows/`，不能把运行授权/产物写进共享模板。模板当前文件与历史快照的发布/冲突/恢复规则见v10合同。主 manifest 只放运行头和引用，不塞全部任务。根执行准入记录原子保存预算与 attempt 派发意图；任务记录保存生命周期和结果，不能成为第二个派发许可。列表索引可重建，不把索引当执行事实。
- 现有 `scry.db` 是可降级的分析/用量账本，不选它作为必须可用的调度事实源。沿 `transcript-archive.ts` 的 owned-path / 临时文件原子替换模式实现异步写入，不直接调用其中同步写 helper 阻塞 main。此处不承诺外部调用与文件事务的 exactly-once。
- 编排历史保存阶段/任务生命周期和证据引用，不复制每个流式 token 或工具正文；工具级回放读取原有归档，并诚实标出证据缺口。renderer 只持有当前窗口；不建立第二套 transcript/费用事实源。

### 不复制 Claude 的“按启动顺序重放”

保存稳定任务身份、输入引用/摘要、工作区基线、角色/模型/权限/合同指纹。缓存复用或重试时对照这些输入和所需证据；不能只看同一个 HEAD，未提交修改和来源内容变化也要计入。

- 输入/模型/计划或依赖产物变化：相关任务与下游标 stale；无关已完成分支不会因为排队在 B 后面就自动重跑。
- 无法证明输入未变：不复用，显示原因。没有历史事实报 nothing_to_resume；不能自动从头执行，只有用户另行选择才新建运行。
- 不做通用 transport/API 自动重试；v8 对已授权、可确认停滞/响应丢失且安全收敛的调用支持自动重启。手动/自动共用最多五次重启名额，新 attempt 还须经过 v7 总预算与槽位准入。用户重试或符合 v8 条件的自动重启产生新 attempt，保留旧用量/副作用；旧进程未收敛或状态未知不得重叠发送。已批准 loop 的下一逻辑轮是新 iteration，携带新反馈/状态，不属于同一调用重试；不得借 loop 掩盖 unknown 的重复执行。
- 重启先恢复观测与核对 owner，不根据 running 字段自动拉起 Agent；更改计划先新 revision 并确认，不原地篡改运行快照。

### 暂停、停止、限流

暂停调度只阻止新任务，允许在途工作收口，不承诺跨 Provider 挂起进程。停止先登记 stop_requested，再调用已登记 handle；确认收敛后才 cancelled，未知写操作不盲目重发。

真实 rate-limit/资源拒绝按 adapter 能力显示 failed/blocked/waiting。不能从沉默猜限流；不能复制仅适用于特定 Claude 交互订阅的自动等重置策略。不能单凭无输出重启；仅在 v8 的阶段检测、收敛、可重放性和授权条件满足时重启，保留原副作用与用量。

### v8 管理与恢复补充

管理视图与输入框任务面板同源；停止中/未知作用域不从列表消失，明确再次停止可重验后重发信号。用户已选择依赖恢复，不采用启动顺序重放；记录缺失报 nothing_to_resume，不能自动从头执行。

停滞仅按可信模型等待阶段计时；工具/权限/配额等待不计。原 prompt 新 attempt、不接旧 transcript，文件变化与旧用量保留；最多初次1+重启5，所有重试同时受根预算限制。窗口后台运行由 main 驻留承担，真正退出 App 停止任务；不假装已有云执行服务。细节及拒绝条件见 [运行管理](run-management.md)。

## 8. 面板、性能和成本

- 全流程事件驱动：计划产生、确认、展开、dispatch、工具/分类、settling、终态都更新同一个持久投影。临时断线用 snapshot + revision 修复，不靠 renderer 轮询调度。
- 图上明确预计节点与已展开任务；大图按阶段折叠，长列表分页/虚拟化。可见 IPC 批次有上限，不把全 transcript 或整张任务图反复搬给 renderer。分页展开不能等待上一页任务全部结束才派发下一页，否则会变成隐藏的并发窗口；只等待登记/准入所需事实，不等待无依赖任务的终态。
- 左侧计划、图、日志、详情引用同一身份链。点击 Agent 看 prompt/模型/工具/证据；点击 Jev 看问题/概率/阈值/分流理由。计数分别是 Agent 与分类请求。
- 用户切聊天或关闭面板不停止后台运行；停止绘制不等于停止执行。请求态、实际执行态与证据覆盖分别显示。
- 中间结果由运行器的状态/引用存储承载；主模型只接根 return 的最终报告/必要引用，进度不进入父会话消息历史。验证要捕获真实父请求，不能只看 UI。细节见 [上下文边界](execution-semantics.md#6-主会话上下文边界)。
- 共享稳定提示前缀是文本组织优化，不承诺跨 Provider 缓存命中。本期不加首请求 5 秒等待，也不增加固定扇出槽位来“优化缓存”。
- 用量尊重 canonical 来源，包含规划/失败尝试与分类调用；未知就是未知。预估/提醒不得当硬预算；没有准确计量时不保证“花费不会超过 X”。
- 新 IPC 走 typed preload、handleTrusted、sender/schema/path 校验，并映射 performance-paths。main 用户路径不用同步 I/O；按现有性能合同测量，不为文档改动编造提速结论。

## 9. 实施顺序与可证伪验收

| 阶段 | 交付 | 必须能证明的行为 |
| --- | --- | --- |
| M1 启动与收口接缝 | workflow owner、独立 session、全 run observer、completion/recording outcome、停止/再次停止与可信等待阶段 | 两个后台 run 不串聊天；真实 trusted wrapper 拒绝非法调用且不执行 listener；关闭 run controls 不静默换模型；所需证据未收口不提前放行 |
| M2 入口、程序与编译器 | 聊天/命令/模式与规模建议解析/来源快照；路由规划和模板共用 WorkflowProgram；模板作用域/修订/草稿与Agent编写请求；全部控制指令、作用域/类型/终止校验、预览冻结 | 规模仅软建议、文件覆盖/下一次生效；单次不污染会话；来源/费用授权、命令冲突、direct/workflow/template_edit互斥；顺序/并行/map/branch/loop 语义；unknown 不当 false；非法依赖/裸无限循环拒绝；模板编写只产候选、参数化不携带私有运行状态 |
| M3 持久解释器 | 控制帧、绑定、join、iteration/attempt、checkpoint、限额、依赖恢复与停滞重启；模板发布收据与实例快照 | 共享并发默认≤16、配置1–256；4097项整批拒绝、第1001次不发送；跨重启预算/槽位恢复；运行中业务输入拒绝；carry/最佳候选恢复，nothing_to_resume不重开；unknown不重发；旧scope收敛后最多五次重启；模板保存冲突不覆盖，修订恢复不重置root预算 |
| M4 完整质量与写入模式 | 六种模板；对抗复核、多角度起草/交叉评审/裁决/改进、检查修复和批量迁移；Jev 及副本/应用合同 | 反例能推翻候选；全不合格无假赢家；反馈实际改变下一版；综合方案再验证；组合 patch 回归/冲突阻止应用；中间数据不泄漏父上下文 |
| M5 生产面板与控制 | 聊天入口/授权、规模偏好/有效来源、管理与停止/恢复、后台/退出；模板保存/编辑/diff/来源/冲突；同源代码视图、连线实例图、轮次/分支/候选/证据、retry用量及历史 | 三种入口真实交互与每运行自动关联；重挂不双发、模式退出不误停；原会话无安全回注能力时不伪造 turn；窗口隐藏不停止执行；新版/另存/仅本次操作不串源，运行中模板变更不替换旧快照 |
| M6 授权真实验收 | 单 Provider → 跨 Provider → Jev → 循环/对抗复核/多方案/写入组合 → 模板Agent修改与跨会话/项目复用 | 临时 workspace/userData；账号/费用/数据及写入明确授权；实际模型/终态/证据可核对；程序级全部验收通过才称完整 |

UI 可在 M2 后并行按同一合同开发，但不得先用计时器动画冒充真实执行。改 main 前需协调当前 remote/iOS WIP 所有者；本轮未改这些文件。

验证复用 `run-registry.test.ts`、`provider-operation-gate.test.ts`、`command-receipts.test.ts`、`run-stop-lifecycle.test.ts`、`live-trace-ingestion.test.ts`、`trace-turn-progress.test.ts`、`managed-turn-commit.test.ts`，再补紧贴新合同的 focused tests。关键拒绝/恢复用临时工作区与负对照证明不是只检查 UI 文案；DOM/坐标/焦点走现有隔离 Electron fixture。

[执行语义 §9](execution-semantics.md#9-全部能力必须有对应验收不能支持循环只测改计数) 给出每项能力的可证伪检查。迁移/修复的副本、组合验证和应用合同已明确并纳入 M4；工作副本仍不称安全沙箱。实现可以分批；循环、多方案、上下文边界、写入、聊天入口/模式、v7限额、v8运行管理/恢复、v9规模建议和v10保存/编辑合同必须全部通过，才能宣布整个方案完成。

## 10. 当前完成度与下一步

- 已完成：v5 补齐控制流与质量模式，v6 补齐聊天入口，v7 加入运行输入/资源约束；v8 补齐管理与依赖恢复，v9补齐规模软建议，v10补齐个人/项目保存、手动/Agent编辑与版本隔离；不将建议当运行门禁，默认medium且不按未经验证的订阅猜测。初始识别关闭、额外路由费用、计划仍须确认及原生命令不劫持都是显式合同，不声称与 Claude 原生行为完全相同。以上为方案完成，不是生产能力已通过。
- 未实现：生产规划器/调度器/Jev API/React 面板；HTML v3 仍是固定样例。此次没有驱动真实 Agent、读取凭据或调用分类 API。
- 下一授权动作：以此完整方案从 M1 开始实施，先协调 `src/main/index.ts` 的 WIP 所有权；实际 Provider/账号、费用、TypeSafe 数据范围与写入/应用策略在真实执行前确认。循环和多方案的设计范围不再等用户重复批准。
- 强制禁止副本外写入仍不是现有 Provider 权限合同能保证的能力。默认差异审阅，若选择验证后应用必须具体授权；任何生成程序都不能授予自己更多权限。
