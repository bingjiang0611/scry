# T3 Code 源代码管理实现调研

- 调研日期：2026-10-14。
- 任务：用户功能表 **#2 Git → PR → Review → Merge**。后续顺序为 #4、#6、#7；本次不研究它们的落地。
- 上游固定版本：[`pingdotgg/t3code@7ac952c630ef8a60d14ca8f6a0c7adce33db4bae`](https://github.com/pingdotgg/t3code/tree/7ac952c630ef8a60d14ca8f6a0c7adce33db4bae)。这是 main 快照，**不是稳定版 0.0.45 的能力声明**。
- Scry 基线：本轮实际读取 `aa2d3fc`、package `0.2.186` 及当时工作区；main/index、App、ChatView 等有用户并行 WIP。上次调研的 `3b66ea2` 已不是当前 HEAD。
- 方法：定点读取上游官方文档、真实 UI/transport/server/Git/GitHub 调用链、相关社区问题；没有安装或运行 T3，没有真实仓库/账号写入。下面的风险是**代码阅读发现**，不是复现结论。
- 交付：[Scry 技术方案](source-control-technical-plan.md) · [交互设计说明](../../designs/scry-source-control/brief.md) · [HTML 原型](../../designs/scry-source-control/index.html)。

## 1. 真实调用链

```text
GitActionsControl / useGitStackedAction
  → vcsActionManager.runStackedAction
  → 客户端队列（environment + cwd）
  → typed streaming RPC: git.runStackedAction
  → server/ws handler
  → GitWorkflowService → GitManager.runStackedAction
       ├─ runCommitStep → GitVcsDriverCore.commit → 本机 git
       ├─ pushCurrentBranch → 本机 git push
       └─ runPrStep → GitHubSourceControlProvider → GitHub REST
  → 关联 thread / 刷新状态 / UI 展示阶段结果
```

它不是“让聊天 Agent 写一段 shell 命令”。Git 写操作与托管平台 API 有独立服务，AI 主要用于可选内容生成。GitHub 主流程使用直接 REST/GraphQL；`gh` 在这条路径主要是凭证来源，不是 `gh pr create/review/merge` 的总封装。

### 可复查的源码入口（均为上述固定 commit）

| 位置 | 读取范围 | 证明什么 |
| --- | --- | --- |
| [GitActionsControl.logic.ts](https://github.com/pingdotgg/t3code/blob/7ac952c630ef8a60d14ca8f6a0c7adce33db4bae/apps/web/src/components/GitActionsControl.logic.ts#L156-L434) | 156–434 | 操作可用性、快捷操作组合、默认分支确认 |
| [GitActionsControl.tsx](https://github.com/pingdotgg/t3code/blob/7ac952c630ef8a60d14ca8f6a0c7adce33db4bae/apps/web/src/components/GitActionsControl.tsx#L1152) | 1152、1257–1312、1456–1466、1942–2092 | 文件选择、提交文案、确认弹窗 |
| [sourceControlActions.ts](https://github.com/pingdotgg/t3code/blob/7ac952c630ef8a60d14ca8f6a0c7adce33db4bae/apps/web/src/state/sourceControlActions.ts#L224-L232) | 224–232 | React action 入口 |
| [vcsAction.ts](https://github.com/pingdotgg/t3code/blob/7ac952c630ef8a60d14ca8f6a0c7adce33db4bae/packages/client-runtime/src/state/vcsAction.ts#L445-L529) | 445–529 | operation ID、payload、串行调度与进度消费 |
| [vcsCommandScheduler.ts](https://github.com/pingdotgg/t3code/blob/7ac952c630ef8a60d14ca8f6a0c7adce33db4bae/packages/client-runtime/src/state/vcsCommandScheduler.ts#L1-L12) | 1–12 | 队列是客户端的，不是仓库全局锁 |
| [ws.ts](https://github.com/pingdotgg/t3code/blob/7ac952c630ef8a60d14ca8f6a0c7adce33db4bae/apps/server/src/ws.ts#L2819-L2880) | 2819–2880 | 生产 transport 注册、执行后关联与刷新 |
| [GitManager.ts](https://github.com/pingdotgg/t3code/blob/7ac952c630ef8a60d14ca8f6a0c7adce33db4bae/apps/server/src/git/GitManager.ts#L2988-L3184) | 2100–2338、2988–3184 | commit/push/PR 的顺序执行，不是事务 |
| [GitVcsDriverCore.ts](https://github.com/pingdotgg/t3code/blob/7ac952c630ef8a60d14ca8f6a0c7adce33db4bae/apps/server/src/vcs/GitVcsDriverCore.ts#L2180-L2434) | 950–1044、1871–1949、2180–2434 | argv、状态、临时 index、真实 index 和 push |
| [GitHubSourceControlProvider.ts](https://github.com/pingdotgg/t3code/blob/7ac952c630ef8a60d14ca8f6a0c7adce33db4bae/packages/source-control-github/src/server/GitHubSourceControlProvider.ts#L995-L1024) | 995–1024 | 通过 REST 创建 PR |
| [GitHubCredentials.ts](https://github.com/pingdotgg/t3code/blob/7ac952c630ef8a60d14ca8f6a0c7adce33db4bae/packages/source-control-github/src/server/GitHubCredentials.ts#L184-L270) | 106–178、184–270 | 凭证顺序、账户选择、缓存 |
| [GitHubApi.ts](https://github.com/pingdotgg/t3code/blob/7ac952c630ef8a60d14ca8f6a0c7adce33db4bae/packages/source-control-github/src/server/GitHubApi.ts#L339-L519) | 339–519 | 有界 HTTP、超时、错误与 token 隔离 |
| [PullRequestService.ts](https://github.com/pingdotgg/t3code/blob/7ac952c630ef8a60d14ca8f6a0c7adce33db4bae/apps/server/src/pullRequest/PullRequestService.ts#L1950-L2199) | 1950–2199；3493–3604 仅符号定位 | capability / viewer permission、mutation、刷新 |
| [GitHubPullRequestApi.ts](https://github.com/pingdotgg/t3code/blob/7ac952c630ef8a60d14ca8f6a0c7adce33db4bae/packages/source-control-github/src/server/GitHubPullRequestApi.ts#L2600-L2829) | 2600–2829 | merge、评论、整批 review submission |
| [PullRequestReadCache.ts](https://github.com/pingdotgg/t3code/blob/7ac952c630ef8a60d14ca8f6a0c7adce33db4bae/apps/server/src/pullRequest/PullRequestReadCache.ts#L45-L164) | 45–164 | 读缓存持久化、过期、版本失效；非 mutation journal |
| [PullRequestDetailLayout.tsx](https://github.com/pingdotgg/t3code/blob/7ac952c630ef8a60d14ca8f6a0c7adce33db4bae/apps/web/src/components/pullRequest/PullRequestDetailLayout.tsx) | 全文件 | 标题/作者/分支/文件统计、内容标签与检查状态分层 |

## 2. 从 UI 到执行：值得借鉴什么

### 2.1 动作是状态机，不是固定一排按钮

`resolveQuickAction` 根据 dirty、upstream、ahead/behind、是否默认分支、是否已有 PR 决定主动作：

- dirty：可能是 commit、commit+push 或 commit+push+PR；
- behind：pull；分叉：要求先处理，不直接推进；
- ahead：push 或 push+PR；
- 已同步且已有 PR：无操作；
- 默认分支推送弹确认，并可改为创建 feature branch。

提交弹窗可选择文件，消息可手写或由 AI 生成；阶段进度让用户知道卡在 hook、commit、push 还是创建 PR。Scry 应采用**有依据的按钮可用性和阶段反馈**，不直接采用多阶段默认连点。

### 2.2 PR 是独立工作面，不只是一个 URL

标题、作者、时间、base ← head、统计构成稳定头部；内容分标签。评论/审查/合并在 server 再检查 capability 和当前用户权限。整批 review（verdict、总体意见、行评论）一个请求提交，草稿不先暴露给其他人。

### 2.3 读状态与写状态分开

Git 使用 porcelain v2；PR/检查有各自查询、缓存和失效。读缓存约 60 秒过期，不缓存错误。token fingerprint 参与缓存/限流隔离。它们改善性能，但**缓存存在不代表数据新鲜，读取成功不代表写操作成功**。

## 3. 不能原样移植的行为

### A. 临时 index 只保护预览，不保护最终提交

`prepareCommitContext` 复制/构建临时 index，使用 `GIT_INDEX_FILE` 生成候选 patch；选择文件时使用 `read-tree`，避免 `reset` 清掉 merge 状态。

但真正 `commit` 时，选中文件路径会先在**真实 index** 执行 `git reset`，再 `git --literal-pathspecs add -A -- <paths>`；全部文件则 `git add -A`。该处 reset 错误被吞掉。因此不能把它描述为“保留用户暂存区的选择性提交”。

**Scry 决策：**显式 stage/unstage；提交完整的已确认 index，不偷偷 reset、stage all 或替换既有 staged selection。部分暂存文件默认保留，用户主动“暂存整个文件”前说明影响。

### B. 默认 merge 不总是绑定用户看到的 SHA

`GitHubPullRequestApi` 先读取最新 action state；只有去除 agent credit 导致合并消息变更时，才设置 `expectedHeadOid`。默认直接合并路径没有始终携带这个字段。

**Scry 决策：**确认框绑定用户审查的 `expectedHeadOid`；服务端重读并比较，mutation 本身也带 expected SHA。不能拿“刚读取过”替代“用户审查过”。

### C. 客户端队列不是跨调用者的仓库锁

已确认队列按 environment + cwd 串行。已检查的 server workflow 没有把完整操作包进仓库级互斥，也没有 preview HEAD/index 的 compare-and-swap。

**边界：**没有遍历所有上游调用方，不能据此断言 T3 全项目没有任何其他锁。

**Scry 决策：**main 进程按 canonical git-common-dir 串行写入；确认 token 绑定 worktree、HEAD、index、选中文件版本和执行配置。仍不承诺排除外部终端或同用户进程的所有竞争。

### D. 多阶段操作不可回滚，失败不等于没有副作用

commit → push → PR → thread association → refresh 顺序进行；后续失败不会撤销前面动作。已检查路径不构成 durable partial-operation ledger。

GitHub 超时或断线可出现在服务端写入成功之后。上游不自动重试这些 mutation，这是正确方向，但 HTTP error 本身不能证明远端没有发生写入。

**Scry 决策：**拆分明确动作；记录每个 operation 的阶段和证据。断线/崩溃后先核查，不自动 replay。PR、评论无法确定是否已写入时保持 unknown，不通过“再发一次试试”解决。

### E. argv 安全不等于仓库执行 trust

Git runner 使用 argv 和 `GIT_OPTIONAL_LOCKS=0`。但普通 Git 仍可能执行 hooks、filters、credential helpers、SSH/signing 程序。已读路径保留正常 hook 生命周期；未建立 Scry 所需的 canonical cwd + fingerprint gate。

**Scry 决策：**不能直接搬 runner；也不能把 recorder 的 commit callback 自动授权误用于 Git 原生 hook。执行政策见技术方案的待确认项。

### F. 不搬整个架构

不移植 WebSocket/environment 框架、Effect 服务栈、多 forge registry、跨机器凭证路由、stack PR、自动合并队列。Scry 当前需要一条本地 Electron typed IPC 链路和一个明确的 GitHub 实现，不需要为将来的第二个托管平台提前造注册表。

## 4. 社区反馈怎样影响本方案

| 原始问题 | 已见反馈及局限 | 设计/验收动作 |
| --- | --- | --- |
| [#14113 首次打开 PR 面板加载失败](https://github.com/pingdotgg/t3code/issues/14113) | 查询时 open；并非本机复现 | 区分 loading/error/真实空列表；切换会话后强制验证目标仓库；错误时保留可识别的旧快照及刷新入口 |
| [#6198 SSH alias 被当成 GitHub API host](https://github.com/pingdotgg/t3code/issues/6198) | 查询时 closed；标题/问题样本用于边界分析，不推断仍有此 bug | 原始 Git remote 与 GitHub API 身份分开；SSH alias / fork / 多 remote 不猜测，显式选择并验证映射 |
| [#15924 PR watch 工作中侧栏却看起来空闲](https://github.com/pingdotgg/t3code/issues/15924) | 查询时 closed；watch 不在本轮实现范围 | UI 不把本地 Git 操作、PR 检查、Agent run 混为单一 running 状态；未来 watch 另建明确合同 |

原站 [t3.codes](https://t3.codes) 的 Git 区块在 Chrome 实际查看：分支、变更计数和下一步动作放在同一局部区域。它是**官网示意图，不是运行中 App 截图**。采用它的局部信息层级；不复制营销中的“一键全做”承诺或页面装饰。真实控件行为以固定源码为准。

## 5. 对 Scry 当前实现的核查

- `src/main/git.ts` 只 re-export recorder core，不能向其中加入 GitHub/SQLite/Electron 依赖。
- `src/core/turn-recorder/git.ts:939–970` 的 `gitNumstat` 会把部分失败变成 `[]`；`useIntegrations.ts` 也有同样兜底。**新状态不能复用这个返回值判断 clean。**
- `src/main/index.ts` 当前 `agent:gitDiff` handler 不是新写权限模板；必须再做 canonical workspace/operation 校验。
- `RightSurfacePanel` 和 `right-surface.ts` 已有右侧标签、隐藏/放大、终端保持挂载；适合添加“源代码管理”。
- `TurnDiffReviewPanel` 是 Agent 单轮/会话证据。复用 diff parser/展示，不复用它的 scope 身份来表示 Git index 或 PR。
- `useSessionRightSurfaces` 是会话布局持久化；仓库状态必须以 worktree/repository 身份持有，不能随 session ID promotion 错绑。
- `workspace-authorization`、`ipc-trust`、Git 临时目录/恶意 filter 测试可参考；现有 Provider operation gate 不是 Git 仓库锁。

结论：借鉴 T3 的工作流与反馈分层；Scry 在实际暂存区、并发、执行 trust、未知结果和审查 SHA 上需要自己的更明确合同。
