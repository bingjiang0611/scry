# Claude Dynamic Workflows：原文核对与 Scry 取舍

本轮依据：用户确认“任务驱动编排，模板作为捷径”，要求核对官方文章细节。来源为 [官方页面](https://code.claude.com/docs/en/workflows) 与对应 [Markdown](https://code.claude.com/docs/en/workflows.md)。本轮完整读取 Markdown 的 506 行；HTML 同时取回用于核对页面来源。文档会更新，下列数字和行为是本次取回版本，不是所有历史版本的保证。

本文只说明文档事实与设计取舍。没有运行 Claude 原生 Workflow、付费 Agent 或 Jev 请求。

本次源文件：`/tmp/scry-workflows-article.md`，SHA-256 `a324b4814d760d6c6f115a0a534123fe71acc40e4a9fa63f0e2f85200df197dd`。该临时副本用于核对，仓库只保留提炼后的事实与链接，不镜像整篇文章。

## 1. 先纠正“几个内置模板”

官方 **Bundled workflows** 当前只列 `/deep-research <question>`：多角度搜索 → 获取与交叉核对来源 → 对 claim 投票 → 带引用的报告。要求 WebSearch 可用，且只有用户调用时才运行。

**Example workflow prompts** 列出的是让 Claude 临时生成流程的六种任务：多文件审计、检查/修复循环、多文件迁移、PR 评审、多来源研究、反复寻找问题直到不再增长。它们不是该表列出的六个内置命令。文章另提多角度草拟计划，也不是宣称内置了同名模板。

我们可以内置自己的模板，但应标为 **Scry 模板**，不冒用 Claude 命令或宣称已移植原生运行器。

## 2. 原文细节 → Scry 决策

| 原文位置 / 事实 | Scry 采用或明确差异 |
| --- | --- |
| [When to use a workflow](https://code.claude.com/docs/en/workflows#when-to-use-a-workflow)：脚本持有循环、分支、中间结果，主会话只接最终答案 | 采用“计划外置、运行器调度、结果按引用传递”。编排模型准备计划，不在每个子任务之间重复当调度器；不承诺零上下文或零 token |
| [Have Claude write a workflow](https://code.claude.com/docs/en/workflows#have-claude-write-a-workflow)：任务生成 JavaScript；ultracode 可让实质任务自动走 Workflow | Scry 支持自动规划入口及模板入口；本期不用 ultracode，也不执行生成的 JS。编排模型由用户选；简单任务可生成单节点，不强行拆成多 Agent |
| [Approve the plan](https://code.claude.com/docs/en/workflows#approve-the-plan-before-it-runs)：可查看原脚本，审批行为随权限模式变化 | 提供结构化计划预览和配置确认；启动规划与批准执行是不同动作。确认计划不替代 Provider 工具审批、workspace authority 或仓库 trust |
| [Save for reuse](https://code.claude.com/docs/en/workflows#save-the-workflow-for-reuse)：`.claude/workflows/`、用户目录、`meta` 名称/描述、args、`/reload-skills` | 保存为 App-owned 的版本化数据模板、参数和角色绑定；不写 `.claude/workflows`。保存只保存定义，不连带执行或授权。固定任务列表不自动变成可泛化模板 |
| [Saved script](https://code.claude.com/docs/en/workflows#what-the-saved-script-looks-like)：`agent()`、`pipeline()`、`parallel()`、`phase()`、`log()` | 概念映射为 Agent 节点、按项目展开、依赖图并行、阶段分组、带来源事件；阶段是展示分组，不应强制所有节点存在全局 barrier |
| 同节：schema 在启动前校验矛盾；输出失败默认最多五次校验尝试 | Scry 校验版本化输出合同、引用与依赖；不假设每个 adapter 支持原生 schema。先做后验校验，不静默追加五次付费尝试；Provider 内部尝试若可观测则单独记录 |
| 同节：停止/不可恢复错误可返回 null；示例 `.filter(Boolean)` 丢弃空槽 | **不照搬**。任务必须保留 failed/cancelled/unverified 和 coverage；空数组只用于真实成功且没有发现。部分结果可汇总，但不能让失败消失 |
| [Runtime](https://code.claude.com/docs/en/workflows#how-a-workflow-runs)：脚本无直接文件/命令访问，无 import；禁止时钟和随机性来支持重放 | 不引入 JS VM、eval 或模块加载器。计划为数据，文件/工具工作仍走获准的现有执行路径。稳定 ID 和持久事实支持恢复，不靠重新运行脚本重建身份 |
| [Prompt caching](https://code.claude.com/docs/en/workflows#prompt-caching-in-a-fan-out)：同模型/effort/agent type/tools/schema/cwd 才共享前缀；后续 Agent 默认最多等首个响应 5 秒 | 仅参考提示前缀复用，保持稳定的公共规则与每项差异输入。不跨 Provider 承诺缓存；本期不加这种延迟队列，也不以缓存为由改用户模型或隐藏限制并发 |
| [Behavior and limits](https://code.claude.com/docs/en/workflows#behavior-and-limits)：默认最多 16 并发，可能受 CPU 降低；配置 1–256；单次集合 4096、总计 1000 Agent | **不照搬数字或固定上限**。遵守用户不要并发限制；真实准入/资源拒绝如实显示。分页和虚拟化限制单批开销，不限制总任务数 |
| [Resume](https://code.claude.com/docs/en/workflows#which-agents-run-again)：按启动顺序重放；B 失败可令已完成 C/D 一并重跑 | 改为 task/attempt 稳定身份与输入/产物指纹；重试是显式新 attempt。只重新评估受影响的依赖，不把队列位置作为身份；证据不足时不复用、不自动重发 |
| [Stalls](https://code.claude.com/docs/en/workflows#when-an-agent-stalls-and-restarts)：自动重启最多五次；旧文件改动和 token 消耗仍保留 | 不默认自动重试写入或未知请求。停止/进程收敛、已知副作用、重试授权都要先确认。逻辑修复循环与 transport 重试分开 |
| [Usage wait](https://code.claude.com/docs/en/workflows#when-a-run-hits-your-usage-limit)：仅特定交互订阅、设置和重置时间条件下等待；headless/SDK 不同 | 不把这种能力视为 Scry adapter 共有。只有 Provider 明确返回可证实状态才显示 rate_limited/waiting；本期不承诺自动等重置再续跑 |
| [Cost](https://code.claude.com/docs/en/workflows#cost)：大运行提示是提醒，不是限额；原生可能替换组织不允许的模型 | 请求模型与观测模型分列，前置拒绝不可用选择；若上游仍替换，保留差异且不宣称满足指定模型合同。缺价格/用量是 unknown，不假装免费或保证硬预算 |
| [Watch](https://code.claude.com/docs/en/workflows#watch-the-run)：phase → agent → prompt/tools/result，可过滤、停止和保存 | 自动绑定 workflow 面板；真实事件投影驱动图、详情与历史。左侧显示本次计划及版本，模型名称只是角色绑定，不等于 Workflow 本身 |

## 3. 两个容易混淆的点

1. 原文 auto mode 中的 **classifier** 是其权限判断机制，不能据此说官方 Workflow 内置了 TypeSafe Jev。文章没有给出 Jev 集成合同。Scry 的可选 Jev 是我们自己的设计，认证、数据发送、计量需要独立实现。
2. 原文模型生成 prompt 不被当成用户直接请求。Scry 也应保存 user_goal / generated_task 的来源区别；计划批准不能把模型生成的每条工具指令升级成用户授权。

## 4. 本轮落地范围

已修订 [技术方案与流程图](implementation-plan.md)，用户认可的“自动编排 + 模板”不再列为待确认方向。当前 HTML 原型仍只演示固定鉴权模板及可选 Jev，不将方案更新当成生产实现。

本轮不导入原生脚本、不添加执行引擎、不修改现有 remote/iOS WIP。循环修复、自动合入、任意 JS、跨设备工作流不在第一批范围内。
