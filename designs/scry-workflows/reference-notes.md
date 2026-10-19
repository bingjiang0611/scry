# Claude Dynamic Workflows：原文核对与 Scry 取舍

本轮依据：用户确认“任务驱动编排，模板作为捷径”，要求核对官方文章细节。来源为 [官方页面](https://code.claude.com/docs/en/workflows) 与对应 [Markdown](https://code.claude.com/docs/en/workflows.md)。本轮完整读取 Markdown 的 506 行；HTML 同时取回用于核对页面来源。文档会更新，下列数字和行为是本次取回版本，不是所有历史版本的保证。

本文只说明文档事实与设计取舍。没有运行 Claude 原生 Workflow、付费 Agent 或 Jev 请求。v5 已补齐循环、分支、中间状态与质量模式的规范，见 [执行语义与补充研究](execution-semantics.md)。下表的“不执行任意 JS”不再意味着只能做静态 DAG。v6 的 [聊天入口与模式](chat-entry-semantics.md) 补齐单次请求、自动判断和模板命令；v7 按用户最新要求采用 [运行输入与资源限额](runtime-limits.md)，明确覆盖旧的无上限取舍。v8 的 [运行管理](run-management.md) 补齐暂停/停止、依赖恢复和停滞重启；用户确认只做本地后台，不新增 daemon 或云执行。未实现状态不变。

本次源文件：`/tmp/scry-workflows-article.md`，SHA-256 `a324b4814d760d6c6f115a0a534123fe71acc40e4a9fa63f0e2f85200df197dd`。该临时副本用于核对，仓库只保留提炼后的事实与链接，不镜像整篇文章。

## 1. 先纠正“几个内置模板”

官方 **Bundled workflows** 当前只列 `/deep-research <question>`：多角度搜索 → 获取与交叉核对来源 → 对 claim 投票 → 带引用的报告。要求 WebSearch 可用，且只有用户调用时才运行。

**Example workflow prompts** 列出的是让 Claude 临时生成流程的六种任务：多文件审计、检查/修复循环、多文件迁移、PR 评审、多来源研究、反复寻找问题直到不再增长。它们不是该表列出的六个内置命令。文章另提多角度草拟计划，也不是宣称内置了同名模板。

我们可以内置自己的模板，但应标为 **Scry 模板**，不冒用 Claude 命令或宣称已移植原生运行器。

## 2. 原文细节 → Scry 决策

| 原文位置 / 事实 | Scry 采用或明确差异 |
| --- | --- |
| [When to use a workflow](https://code.claude.com/docs/en/workflows#when-to-use-a-workflow)：脚本持有循环、分支、中间结果，主会话只接最终答案 | 采用“计划外置、运行器调度、结果按引用传递”。编排模型准备计划，不在每个子任务之间重复当调度器；不承诺零上下文或零 token |
| [Have Claude write a workflow](https://code.claude.com/docs/en/workflows#have-claude-write-a-workflow)：任务生成 JavaScript；ultracode 可让实质任务自动走 Workflow | v6 定义自然语言单次请求、会话 auto 和模板命令，使用 Scry 命名空间，不调用原生 ultracode 或生成 JS。编排模型由用户选；简单任务可 direct 或单节点；执行仍确认计划，识别费用和默认 off 显式披露 |
| [Approve the plan](https://code.claude.com/docs/en/workflows#approve-the-plan-before-it-runs)：可查看原脚本，审批行为随权限模式变化 | 提供结构化计划预览和配置确认；启动规划与批准执行是不同动作。确认计划不替代 Provider 工具审批、workspace authority 或仓库 trust |
| [Save for reuse](https://code.claude.com/docs/en/workflows#save-the-workflow-for-reuse)：`.claude/workflows/`、用户目录、`meta` 名称/描述、args、`/reload-skills` | 保存为 App-owned 的版本化数据模板、参数和角色绑定；不写 `.claude/workflows`。保存只保存定义，不连带执行或授权。固定任务列表不自动变成可泛化模板 |
| [Saved script](https://code.claude.com/docs/en/workflows#what-the-saved-script-looks-like)：`agent()`、`pipeline()`、`parallel()`、`phase()`、`log()` | 概念映射为 Agent 节点、按项目展开、依赖图并行、阶段分组、带来源事件；阶段是展示分组，不应强制所有节点存在全局 barrier |
| 同节：schema 在启动前校验矛盾；输出失败默认最多五次校验尝试 | Scry 校验版本化输出合同、引用与依赖；不假设每个 adapter 支持原生 schema。先做后验校验，不静默追加五次付费尝试；Provider 内部尝试若可观测则单独记录 |
| 同节：停止/不可恢复错误可返回 null；示例 `.filter(Boolean)` 丢弃空槽 | **不照搬**。任务必须保留 failed/cancelled/unverified 和 coverage；空数组只用于真实成功且没有发现。部分结果可汇总，但不能让失败消失 |
| [Runtime](https://code.claude.com/docs/en/workflows#how-a-workflow-runs)：脚本无直接文件/命令访问，无 import；禁止时钟和随机性来支持重放 | 不引入 JS VM、eval 或模块加载器。计划为数据，文件/工具工作仍走获准的现有执行路径。稳定 ID 和持久事实支持恢复，不靠重新运行脚本重建身份 |
| [Prompt caching](https://code.claude.com/docs/en/workflows#prompt-caching-in-a-fan-out)：同模型/effort/agent type/tools/schema/cwd 才共享前缀；后续 Agent 默认最多等首个响应 5 秒 | 仅参考提示前缀复用，保持稳定的公共规则与每项差异输入。不跨 Provider 承诺缓存；本期不加这种延迟队列，也不以缓存为由改用户模型或隐藏限制并发 |
| [Behavior and limits](https://code.claude.com/docs/en/workflows#behavior-and-limits)：运行中不接受用户输入；默认最多16并发、CPU可降低，配置1–256；单次集合4096、总计1000 Agent | **v7 按用户最新指示采用这些约束**；阶段人工确认拆成独立工作流。Scry 使用自己的配置，不接原生环境变量；共享槽位、根预算与恢复口径见运行约束，超限不静默截断 |
| [Resume](https://code.claude.com/docs/en/workflows#which-agents-run-again)：按启动顺序重放；B 失败可令已完成 C/D 一并重跑 | 改为 task/attempt 稳定身份与输入/产物指纹；用户在 v8 明确选择按依赖恢复；重试产生新 attempt。只重新评估受影响的依赖，不把队列位置作为身份；证据不足时不复用、不自动重发 |
| [Stalls](https://code.claude.com/docs/en/workflows#when-an-agent-stalls-and-restarts)：自动重启最多五次；旧文件改动和 token 消耗仍保留 | v8 加入受条件约束的自动停滞恢复；手动/自动最多重启5次。必须先停止并确认作用域收敛、核对可重放性与授权；unknown 不重发。原文件变化和旧用量保留；逻辑循环与 attempt 分开 |
| [Usage wait](https://code.claude.com/docs/en/workflows#when-a-run-hits-your-usage-limit)：仅特定交互订阅、设置和重置时间条件下等待；headless/SDK 不同 | 不把这种能力视为 Scry adapter 共有。只有 Provider 明确返回可证实状态才显示 rate_limited/waiting；本期不承诺自动等重置再续跑 |
| [Set a size guideline](https://code.claude.com/docs/en/workflows#set-a-size-guideline)：unrestricted无建议，small<5、medium<10、large<50；任务可覆盖建议，设置文件优先，下次提示生效，硬上限不变 | v9采用相同软建议语义、文件覆盖和来源快照；用Scry自己的设置/命令，统一默认medium，不推断Claude版本/Pro权益，不取消运行限额；详见[规模指引](chat-entry-semantics.md#规模指引v9) |
| [Cost](https://code.claude.com/docs/en/workflows#cost)：大运行提示是提醒，不是限额；原生可能替换组织不允许的模型 | 请求模型与观测模型分列，前置拒绝不可用选择；若上游仍替换，保留差异且不宣称满足指定模型合同。缺价格/用量是 unknown，不假装免费或保证硬预算 |
| [Watch](https://code.claude.com/docs/en/workflows#watch-the-run)：phase → agent → prompt/tools/result，可过滤、停止和保存 | 自动绑定 workflow 面板；真实事件投影驱动图、详情与历史。左侧显示本次计划及版本，模型名称只是角色绑定，不等于 Workflow 本身 |

v8 另核对 Manage runs 与 Resume after you leave the session：采用管理视图/任务面板、停止后保留未收敛任务、明确再次停止、记录丢失报 nothing_to_resume。Scry 现有 RunStopLifecycle 重复 request 只重播状态，重发需要实现新路径。后台由 main 驻留承担；用户已选择真正退出时停止并保存，不扩展为 Claude 云服务或独立后台 daemon。

v9 定向复核同一快照的 Set a size guideline 小节。原文默认medium、特定新版Claude Pro默认small及旧版unrestricted是Claude特有行为；Scry保留用户可选四档，默认medium，不伪造订阅识别。文件覆盖时隐藏可编辑设置，但仍展示只读有效值/来源，避免用户不知道实际用了哪一档。

## 3. 两个容易混淆的点

1. 原文 auto mode 中的 **classifier** 是其权限判断机制，不能据此说官方 Workflow 内置了 TypeSafe Jev。文章没有给出 Jev 集成合同。Scry 的可选 Jev 是我们自己的设计，认证、数据发送、计量需要独立实现。
2. 原文模型生成 prompt 不被当成用户直接请求。Scry 也应保存 user_goal / generated_task 的来源区别；计划批准不能把模型生成的每条工具指令升级成用户授权。

## 4. 本轮落地范围

已修订 [技术方案与流程图](implementation-plan.md)，用户认可的“自动编排 + 模板”不再列为待确认方向。当前 HTML 原型仍只演示固定鉴权模板及可选 Jev，不将方案更新当成生产实现。

v5 修订：循环修复、多方案权衡、批量迁移、明确授权后的应用均已纳入完整方案，不能继续以“第一期不做”代替用户要求。任意 JS/import、插件市场和跨设备运行不属于截图中的目标能力；不因此引入。

本轮只修订文档和图，不执行真实修复或自动合入、不添加生产执行引擎、不修改现有 remote/iOS WIP。

## 5. v5 补充核对

- 本轮重新下载官方 Workflows Markdown，SHA-256 与上述 506 行副本一致；原文含循环、对抗复核及多角度规划，v4 范围确实不完整。
- 另定向读取官方 Agent SDK 的 WorkflowInput/WorkflowOutput：status=async_launched 仍可能携带编译 error，最终结果是后续 task completion。因此受理、实际开始与完成必须分开。
- 读取 LangGraph 的并行、Routing、Orchestrator-worker、Evaluator-optimizer，以及 Checkpointers 的任务写入、Replay、Durability 小节。借鉴状态隔离、评价反馈、checkpoint 与 side-effect 边界，不采用框架依赖或照搬其重放策略。
- `durable-execution.md` 获取到的内容标题实际为 Persistence，本轮以具体 Checkpointers 页面核对恢复行为，不把 URL 名当内容证据。最初 platform 域的 SDK `.md` 返回 HTML，不将它当已阅读的 Markdown；使用 code.claude.com 对应 Markdown 的指定小节。
- 补充来源的链接、实际阅读范围及哪些属于 Scry 设计决定，均列在 [执行语义 §1](execution-semantics.md#1-研究结论与实现选择)。

## 6. v6：入口能力不等于执行能力

本轮复核同一官方快照的 Have Claude write a workflow、Ask for a workflow、Let Claude decide with ultracode 与 Bundled workflows 小节：自然语言或关键词可只作用于当前任务；`/effort ultracode` 对会话实质任务自动使用工作流；内置命令是独立入口。这些不能用“已有自动规划按钮”代替。

v7 再次核对同一快照的 Behavior and limits 表。用户明确修改了先前的无限并发要求；旧的反对固定上限记录只保留作历史，不再约束当前方案。截图没有给出 Scry 的跨 Provider 调度实现，本文不将设计决定冒充原生运行时保证。

Scry 的设计对应三种入口，但不承诺原生命令兼容或自动放行：默认关闭额外路由，启用识别前取得费用/数据授权，执行计划仍须确认。没有读取原生运行时实现，也没有真实调用验证；它们是已核对文档事实与明确的 Scry 产品选择。
