# T3 Code → Scry：工作区与 Diff 源码调研

本文件保留本次源码证据与复用清单。产品取舍、交互和实施计划见 [技术方案](t3-workspace-diff-plan.md)。

## 1. 调研依据与范围

上游：[pingdotgg/t3code](https://github.com/pingdotgg/t3code)，本地只读参考 `/tmp/scry-reference/t3code`。

冻结提交：`d14ace8233ad3cf7856b6b834824f888240d67a1`（2026-10-23，MIT，Copyright © 2026 T3 Tools Inc.）。这是本次拉取的默认分支版本，**不保证与截图版本完全一致**。未安装其依赖、启动其 App 或执行其 Provider；结论来自下列调用链的定向源码阅读，并非全仓库审计。

以下 T3 路径均相对于冻结仓库，可通过 `https://github.com/pingdotgg/t3code/blob/<sha>/<path>` 核对。

| 主题 | 源码证据 | 观察与迁移判断 |
| --- | --- | --- |
| 上下文条 | `apps/web/src/components/BranchToolbar.tsx`、`BranchToolbar.logic.ts` | Current checkout / New worktree / Previous worktree；最近 worktree 从未归档 thread 按更新时间挑选。Scry 借鉴入口，但最近项必须在主进程重验是否仍存在。 |
| 选择分支 | `apps/web/src/components/BranchToolbarBranchSelector.tsx` 的 `selectBranch` | 新 worktree 模式只选择 base；已有 worktree 可复用路径；普通模式会调用 switchRef 真实切分支。Scry 不照搬“选择即写入”。 |
| 首次发送 | `apps/web/src/components/chat/useComposerSend.ts`、`apps/server/src/orchestration-v2/ThreadLaunchService.ts` | workspaceStrategy 区分 worktree / existing_worktree；创建完成后写 branch、worktreePath，再继续启动。可选从远端抓取、命名等不属于本次首版。 |
| 工作区统计 | `apps/server/src/vcs/GitVcsDriverCore.ts` 的 `readStatusDetailsLocal` | status + `diff-index -M --numstat -z HEAD`；无 HEAD 时合并 staged/unstaged numstat；status 有、numstat 没有的路径补 0/0。这不是完整的未跟踪文本行数统计，不原样替换 Scry。 |
| 单轮快照 | `apps/server/src/orchestration-v2/CheckpointService.ts`、`apps/server/src/vcs/GitVcsDriver.ts` | 临时 index、write-tree、commit/ref 保留 checkpoint；前后 checkpoint 算 numstat。现版用 authored paths 排除部分 pull/rebase 导入变化。此类过滤不能被解释为完整作者审计。 |
| 会话净 diff | `apps/server/src/checkpointing/CheckpointDiffQuery.ts` | full-thread 从 root baseline 到目标 checkpoint，不是累加每轮；相邻轮次使用 preceding scope checkpoint；正文有输出预算。 |
| 不能迁移的证据语义 | `apps/server/src/checkpointing/Diffs.ts`、`CheckpointService.ts` | 二进制 `-` 被转成 0；部分统计错误返回 `[]`。Scry 必须区分二进制、失败、未采集与真实零变化。 |

许可：本方案和原型自行编写，不复制 T3 源码或资产。后续若复制实质代码，保留 MIT 版权/许可并更新 `THIRD_PARTY_NOTICES.md`；不引入 Effect、T3 orchestration 或其全套 UI 依赖。

## 2. Scry 当前可复用能力

| 模块 | 已有能力 | 本次建议 |
| --- | --- | --- |
| `src/core/turn-recorder/git.ts` | `readWorkspaceNumstat`、turn snapshot、numstat、patch 预算与安全 Git 配置；工作区统计包含受预算约束的未跟踪文件 | 复用，保持 recorder 无 Electron/SQLite/Provider SDK。工作区和轮次比较不要再建第二套解析器。 |
| `src/main/git.ts` | 授权 canonical cwd，按 cwd 合并正在执行的工作区统计读取，不缓存已完成结果 | 保留权限检查和并发合并；统一入口不应多发一次相同读取。 |
| `src/main/session-diff.ts` | `SessionDiffBaselineRegistry`、运行中预览、终态封口；恢复会话基线可标 resumed | 复用会话净 diff；新 cwd 不能携带旧基线。 |
| `src/renderer/components/PinnedSummary.tsx`、`hooks/useIntegrations.ts` | 工作区摘要、时间、刷新状态和 cwd 防串结果 | 摘要变成右侧 Diff 入口，仍共用一次采集。 |
| `src/renderer/components/TurnDiffReviewPanel.tsx`、`turn-diff.ts` | 单轮/会话展示、partial、预览；归档已保存有界 patch，缺失时才仅统计 | 扩展为统一查看入口，保留既有正文，不拿当前文件补历史。 |
| `src/main/source-control/{git,service,ipc,store}.ts` | root/gitDir/commonDir 身份，revision、同仓库串行写入、operation ID、unknown 持久化；已有 stage/commit/fetch/push | 在现有 service/操作记录上加 switch/create worktree，不建立第二套 Git mutation manager。 |
| `src/shared/source-control.ts` | typed IPC 请求、操作状态、仓库快照 | 增加有界 ref/worktree 查询和创建意图。当前没有切分支/worktree action，不能只加 UI 即宣称完成。 |
| `src/renderer/composer-drafts.ts`、`App.tsx`、`components/chat-view/Composer.tsx` | 草稿身份、输入、附件迁移、会话与 cwd 流程 | 把 workspace intent 放入同一草稿生命周期，不能使用全局“最近分支”覆盖其他草稿。 |
| `src/main/index.ts`、`workspace-authorization.ts`、`workspace-lease.ts`、`conversation-service.ts` / `conversation-store.ts` | cwd 授权、新会话、真实会话生命周期与持久化 | 在 main 完成目标准备与绑定；不得靠 renderer 连续 setCwd/newSession 充当事务。 |

现有限制保留：工作区读取无 HEAD 返回 `unavailable/no_head`；当前上限为 1,000 文件、未跟踪总内容 16 MiB、默认 5 秒。属性、特殊 index flag、子模块等部分组合会明确 unavailable。本次不为了“像 T3”静默扩大支持。
