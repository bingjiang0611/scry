# Scry #2：Git → PR → Review → Merge 技术方案

状态：**方案与交互稿待确认；未实现产品功能。** 研究基线：Scry `aa2d3fc` / `0.2.186` 的当前工作区；T3 固定 commit 与源码证据见[调研报告](t3-source-control-implementation.md)。

- [打开交互稿](../../designs/scry-source-control/index.html)（需 HTTP 服务加载 ES modules）
- [设计约束、结构比较与验证记录](../../designs/scry-source-control/brief.md)
- 本方案是用户指定顺序 **2 → 4 → 6 → 7** 的第一项。不提前实现跨 Provider 接续、任务编排、会话/文件回退。

## 1. 目标与建议范围

让用户在不离开当前任务的情况下，明确选择提交内容，推送到正确远端，创建或查看 PR，完成审查和合并。每一步都知道操作对象、权限、证据版本和真实结果。

### 建议首个完整交付面

**本机桌面 App + Git + github.com**。不是只有 diff 的演示版本：包含文件级 stage/unstage、本地提交、非强制推送、创建普通/草稿 PR、查看当前分支 PR、描述/文件/检查/评论、行评论草稿与正式 review、手动合并。

| 纳入 | 明确不纳入本轮，及升级触发条件 |
| --- | --- |
| 当前已授权项目；识别 existing linked worktree | 创建/清理 worktree 属于原表 #1，未在本次顺序中；当前功能不依赖它 |
| 当前 branch 的 PR；多个匹配时明确选择 | 跨项目 PR Inbox/搜索待用户确认独立仓库中心后再做 |
| 手工 commit/PR 文案 | AI 起草是可选后续切片；只有明确选择 Provider 和授权发送 diff 后运行，不阻塞核心流程 |
| 现有本地 GitHub CLI 登录 | 不新建 token 存储/OAuth 客户端；`gh` 缺失或未登录时 GitHub 面板 unavailable，本地 Git 仍可用 |
| GitHub REST/GraphQL + Node 原生 fetch | 不做多 forge registry；用户明确要求第二个 forge 时再抽取已有的两个真实实现共同合同 |
| 常规远端、明确的 fork head/base、显式映射 | SSH alias 和多 remote 不猜测；支持经验证的手选映射，无法映射时保留 Git、本轮 PR unavailable |
| 服务端允许的 merge/squash/rebase 方法 | 不绕过 branch protection，不自动删除分支，不启用 auto-merge、merge queue、PR stacks |
| 只读刷新与显式 fetch | 不自动 pull/rebase/merge，不 force push；分叉要求用户在终端处理后刷新 |
| 可放大的桌面工作台 | 不声称手机/远程主机已有同等能力。iOS/远程需后续复用合同、远程权限与真机验收，先完整交付本机路径 |

这是**推荐范围，不是已获批准的功能削减**。若第一版必须覆盖 GitLab/GitHub Enterprise、跨仓库 Inbox 或手机，需要先扩展技术与验收范围。

## 2. 关键产品决策

1. **推荐 A：现有右侧工作台添加“源代码管理”。** 标签为工作区、拉取请求；宽 diff 使用现有放大，不叠加第二个侧栏。备选 B 为独立仓库中心，见交互稿“比较布局”。
2. **默认显式分步：暂存 → 提交 → 推送 → 创建 PR。** 不根据 Agent `full_access` 自动提交，不自动 `git add -A`。用户以后要求组合动作时，也须逐阶段保留结果，不能作为一个原子成功状态。
3. **操作真实 index，不替用户重写 index。** 保留原有 staged/unstaged 分界；提交包含整个已确认 index。若用户只想提交其中几项，先显式取消其他暂存，再提交。
4. **Agent diff、工作区 diff、index diff、PR diff 是不同证据。** 不把整个工作区的文件归属于某一轮 Agent。PR 永远显示远端 head/base SHA。
5. **先正确，再便捷。** 新增只读状态不得把异常变成空数组；失败、过期、缺权限、partial、unknown 均有明确表现。

## 3. 架构：借鉴边界，不移植 T3 平台

```text
现有 RightSurfacePanel
  └─ SourceControlPanel（工作区 / PR）
       → window.scry.sourceControl.<typed method>
       → main IPC wrapper：sender / schema / workspace / operation
       → SourceControlService（单一编排入口）
            ├─ Git：有界 argv 子进程 + 精确 repo identity
            ├─ GitHub：原生 fetch；凭证只在 main 内存
            └─ operation store：意图 / 副作用证据 / 恢复核查

现有 turn/session diff → 继续走 recorder evidence 链，不改语义
```

### 预期代码落点（新路径是计划，不是已经存在的模块）

| 模块 | 职责及复用 |
| --- | --- |
| `src/shared/source-control.ts`（新） | 请求/结果 discriminated union；repository/PR identity；read evidence 与 operation outcome |
| `src/main/source-control/git.ts`（新） | Git argv、porcelain v2 -z、index/HEAD/scope revision、diff、stage/commit/fetch/push |
| `src/main/source-control/github.ts`（新） | 单一 github.com REST/GraphQL 实现；映射、账户、PR、review、checks、merge。没有抽象 provider factory |
| `src/main/source-control/service.ts`（新） | main-owned identity、写互斥、preflight、阶段结果、后置核验、授权接缝 |
| `src/main/source-control/operation-store.ts`（新） | 小型原子 JSON 意图日志和恢复核查；因为外部写入可能超时/崩溃，这是实际需要，不是预留框架 |
| `src/main/index.ts` / `src/preload/index.ts` | 注册窄 IPC；复用 `ipc-trust`、workspace authorization；不继续往 index 填业务细节 |
| `src/renderer/components/SourceControlPanel.tsx` + hook（新） | 展示、草稿与选择；复用 right-surface 标签/放大、按钮/token 和 `parseUnifiedDiff` |
| `src/renderer/right-surface.ts` / App 接缝 | 添加 surface；保持 terminal 挂载与 session promotion 原行为 |

当前 `app-store` 的原子写 helper 是私有实现；落地时先检索可公开复用的既有 atomic writer，只有没有合适实现时再最小抽取。**不新加 SQLite 表，不动 recorder core 的依赖边界。**

### Repository identity 与状态归属

- renderer 传已授权项目/工作区引用，不传命令、任意 API URL、凭证、裸 git-dir。
- main canonicalize cwd 并确认属于授权项目；通过 Git 取得 worktree root、git-dir、git-common-dir。token 绑定该身份；切换/替换 `.git` 后重验。
- write queue 以 canonical git-common-dir 为键，避免同仓库多个 linked worktree 同时修改共享 refs/config；文件/index 状态仍以具体 worktree 为键。
- session 只记“打开哪个面板”的呈现状态。仓库数据不按 session ID 存，避免草稿晋升/切会话造成错绑。
- 当前已登记的同仓库 Agent run 未终态时，允许读取，阻止会修改仓库的操作；terminal/外部 CLI 不受此登记约束，必须明示。

## 4. 合同与状态

以下是接口形状，不是要求照抄的新抽象层；落地先复用仓库已有 envelope 与错误表达。

```ts
type ScRead<T> =
  | { status: 'available'; data: T; observedAt: number; revision: string }
  | { status: 'partial'; data: T; observedAt: number; reason: string }
  | { status: 'unavailable' | 'failed'; reason: string }

type OperationOutcome =
  | { status: 'running'; operationId: string; phase: string }
  | { status: 'succeeded'; operationId: string; evidence: OperationEvidence }
  | { status: 'failed'; operationId: string; reason: string; completedSteps: OperationEvidence[] }
  | { status: 'unknown'; operationId: string; reason: string; completedSteps: OperationEvidence[] }
```

`stale` 是快照和当前仓库/账户/PR revision 的关系，不伪装成失败或“没有变化”。`OperationEvidence` 按操作区分，如 commit SHA、已核验 remote ref SHA、PR number/URL、review ID、merge SHA；不使用任意 JSON blob 掩盖语义。

### 最小 IPC 面

- 读：`status`、`diff`、`githubIdentity`、`pullRequest`、`pullRequestFiles`、`pullRequestActivity`、`operation`。
- 写：`stage`、`unstage`、`commit`、`fetch`、`push`、`createPullRequest`、`submitReview`、`mergePullRequest`。
- 恢复：`reconcileOperation` **只读核查**，不是 retry 别名。
- 共享写字段：main 签发的 repo reference、确认时的 expected revision、operation ID；PR 写另带 account identity、head/base identity。
- 所有 payload 都在生产 wrapper 内做 schema、scope、operation 校验；发送者可信不能替代路径授权。

### 读取策略

- `git status --porcelain=v2 -z --branch` 保留 staged/unstaged、rename、untracked、unmerged；解析不使用按行拆文件名。
- unborn、detached、非 Git、index lock、timeout、权限错误各有状态。detached/unborn 不伪装成 clean；初始提交允许性需专门验证。
- 不主动读取 ignored 文件内容，不跟随文件 symlink 越界读取目标。含空格、换行、前导 `-`、pathspec 魔法字符按 literal pathspec 处理；无法无损表示的文件名明确不支持，禁止静默丢弃。
- staged diff 对比 HEAD↔index；unstaged diff 对比 index↔worktree；PR diff 对比远端 PR 所定义的 base/head。
- `--no-ext-diff --no-textconv`，关闭读路径 fsmonitor 等可执行扩展；保留现有 snapshot 安全策略，但不把 snapshot runner 当作写实现。
- 打开面板/应用回前台/显式刷新/完成 mutation 时刷新；可见且有 PR 时低频刷新检查，隐藏即停，读取 single-flight。无需先造常驻 fs watcher。
- 读缓存以 repo+account+PR+head/base 为键。上限与分页建议：单文件 patch 256 KiB、PR 文件页 100 条、最多 1,000 文件；达到上限显示 partial，禁用未覆盖区域行评论并提供 GitHub 外链。真实大仓库需求出现后再做增量/流式设计，不截断后称完整。

## 5. 每条写入路径

### 5.1 暂存与提交

1. UI 明确展示真实 index，默认不选择任何额外文件；已有暂存保持原样。
2. stage 操作只接受上次快照中明确文件引用；预检 worktree 内容 revision。部分暂存文件的“暂存整个文件”会覆盖该文件原有部分暂存选择，必须明确提示。
3. unstage 是显式 action，只改用户指定路径的 index；不还原工作目录。初始提交用相应 index 操作，不能假定 HEAD 存在。
4. Commit 确认显示 branch、完整 staged 文件集合、message、是否有原生 Git 执行扩展。token 绑定 HEAD、index checksum/tree、execution fingerprint。
5. main 获得锁、重验状态及授权后执行普通 commit，**不运行隐含 stage all/reset**，不自动 amend、stash、清除冲突或忽略 hook。
6. 成功后读取新 HEAD、parent、commit tree，验证与预检关联；hook 若改变 index/产物，报告实际变化，不能把它归为用户已审查的原始内容。执行已发生但不能归因时返回 unknown/需检查，不回滚用户文件。
7. hook 失败保留输出和实际 index；不得“自动恢复 index”覆盖 hook/用户产生的并发修改。

main 队列 + 前置比对 + 后置核验**不是跨进程事务**。同用户终端可在检查后修改仓库；Scry 不承诺绝对隔离。现有活跃 Agent gate 降低真实并发风险，文件/HEAD 变化则要求重审，无法证明的结果诚实显示 unknown。

### 5.2 Fetch 与推送

- fetch 需要明确网络动作；读取 status 不偷偷 fetch。拒绝 repo 配置中的 prune 行为被隐含继承；固定 argv 限定远端/refs。
- 推送目标不能只按 remote 名或 fetch URL 确认。解析有效 `remote.pushurl`、所有 push URL 与 `url.*.insteadOf/pushInsteadOf`，确认框显示脱敏后的**实际写入端点 + ref**；将远端与改写配置 fingerprint 一起绑定确认。第一版只支持单一端点，多个 push URL 明确拒绝，不把一对多写入伪装成一次推送。
- 执行前重验同一配置、目标、branch/ref；使用受控 Git 配置与目标参数，避免显式 URL 再次被不一致的 rewrite 改写。执行后对**同一有效 push 端点**读回，而不是默认查询 origin 的 fetch URL。仅支持经授权的常规 SSH/HTTPS 传输，不接受 `ext::` 等任意 remote helper；URL 内嵌凭证不进入日志/确认文本。
- 多 remote 无唯一答案时必须选。默认分支另行警示，不默认创建/切换分支。
- preflight 读取远端 ref、比较 ancestry；behind/diverged 阻止，不自动 merge/rebase。执行时再次约束 source SHA，不能把用户确认后新产生的本地 HEAD 悄悄推走。
- 仅普通非强制 push，禁用 force/mirror/all/tags 等超范围参数。远端并发变化由 Git 拒绝，返回可解释结果。
- **Git 传输身份与 GitHub API 身份分开显示。** SSH/credential helper 的身份不能从 `GET /user` 推断。
- 退出成功后只读核对 remote ref；断线/超时先标 unknown。远端等于 expected SHA 时可确认已到达；远端已继续前进但归因不清时保持 unknown，不能盲目 retry。

### 5.3 创建 PR

- main 从经验证映射得到 host/base repository/head repository/branch；只支持 github.com endpoint，不允许 renderer 指定任意 URL。
- 用户选择 base，填 title/body/draft；查找既有同一 head/base 的 open PR，多个结果让用户选择，不自动绑定第一个。
- 必须已推送；创建动作不夹带 commit/push。REST 创建后保存返回的 number/node ID/URL/head/base，再查询确认。
- 连接中断后的查找仅能证明匹配 PR 存在，不一定证明本次请求创建。歧义时允许用户明确关联已有 PR，保留原 operation unknown，不自动重发创建。

### 5.4 审查与评论

- PR 页展示描述、文件、CI/check runs 与 commit statuses、讨论和已有 reviews；不把 AI 总结当真人审查。
- inline 草稿键：repo + PR + head SHA + path + side + line；统一 review 包含 verdict、总体意见、草稿。正式提交使用 GitHub review API 的 `commit_id` 固定版本。
- 评论保存到本地草稿不执行外部写入；最终提交显示账户、数量、SHA。author 无权 approve/request changes 自己的 PR 时显示真实限制，不能仅在前端隐藏后仍允后台执行。
- head/base/diff 变化后草稿标需重新定位，不能套用旧行号。binary/truncated/deleted lines 按实际 API 支持给出明确限制。
- 请求超时后查看当前用户 review ID/commit/body 等证据；非唯一匹配时保持 unknown，草稿保留且禁止默认再提交。不能用文本相同冒充幂等 ID。

### 5.5 合并

1. 只接受当前用户已查看版本的 `expectedHeadOid`，以及目标 base identity/merge method。
2. 服务端重读 viewer permission、PR state/draft、head/base、mergeability、branch rules、必需检查与仓库支持的策略。unknown/loading 不显示绿色，不因“checks 数组为空”允许合并。
3. 合并条件由 GitHub 权威结果判断，Scry 的禁用按钮只是提前解释；不调用 admin bypass，不把 auto-merge/merge queue 当成普通 merge 的替代方案。
4. mutation 本身携带 expected SHA（GitHub GraphQL `expectedHeadOid` 或 REST merge 的 `sha`），再读回 merged 与 merge SHA。
5. head/base 在用户确认后变化则拒绝并要求重审。成功不删 branch、不删 worktree、不修改当前会话。
6. API 不提供所有检查与 base-tip 的原子 CAS；分支规则仍由平台执行。方案不声称 Scry 能自行保证跨 GitHub 全局事务。

## 6. 凭证、配置执行与安全边界

### GitHub API

- 首版复用本机已安装并登录的 `gh`，只在 main 解析可信 executable；无 `gh` 时清晰提示安装/登录，不自动安装。
- 从明确 host/account 取凭证；`GET /user` 验证身份。token 仅短时驻留 main 内存，不进 renderer、URL、日志、operation store、`.scry` 或 SQLite。
- 不默默从选中账户切到另一 active account；身份变化清空相关缓存/草稿提交资格，重新确认。
- 使用 Node fetch 访问固定 GitHub API origin；禁止凭证随跨 origin redirect 发送。错误区分 auth、forbidden、not-found、rate-limit、transport；limit reset 时间显示但不自动重试 mutation。
- 不把 Provider profile、MCP 登录、Scry remote pairing 视为 GitHub 权限。

### Git 的执行扩展：需要一个明确决定

Git hooks、clean/smudge filters、SSH command、credential helpers、signing 程序可能执行本机代码。现有 recorder commit callback 自动授权只适用于它自己的合同，**不自动授权这些新路径**。

**推荐：**用户对 Git 动作明确确认；另为仓库控制的 Git 执行配置建立 scope/fingerprint 检查，复用现有 canonical-cwd + 内容/executable inspection 模式，不修改已有四类自动授权政策。识别到未被既有合同覆盖的原生执行扩展时先阻断，说明具体入口；确认授权政策之后再启用。

- 不静默禁用 hooks/filters/GPG 来伪装“安全而成功”的普通 Git commit。
- 不直接复用 `commit-hook-trust.ts` 的 `auto_grant`，两种 hook 不是同一对象。
- 配置入口/脚本 fingerprint 不证明整个依赖树可信，也不抵抗同用户并发替换；保持 Scry 非沙箱定位。
- 具体策略待维护者确认：①新增独立 Git 执行授权（推荐）；②仅第一版无此扩展的仓库可写，其他明确 unavailable。不能把这项留到实现时默认放行。

## 7. 持久化与恢复

- 仓库状态/检查缓存只存内存，重启后重读，不把旧绿灯恢复为当前 truth。
- commit 文案和 PR review 草稿保存到 userData，键包含 repository/account/head identity；大小设明确上限，保存失败展示 unsaved，不装作已持久化。
- `<userData>/source-control/operations/<id>.json` 保存开始前意图、当前阶段、最小目标身份、expected SHAs、已确认副作用及脱敏错误。提交前原子写成功是 mutation 的必要前提；不写真实 `.scry` turn records。
- operation ID 去重只在 Scry main 内生效，不谎称 GitHub mutation 有同等幂等性。
- 崩溃时任何已 dispatch 未确认的操作恢复为 unknown，展示“核查结果”；**不自动执行写操作**。
- 核查只做 Git/平台只读查询；证据充分才转 succeeded。请求未发出或平台明确拒绝才是 failed；未找到对象不总能证明请求未成功。
- 建议已完成日志保留 30 天；unknown 未人工处置前不清理。若实际多窗口/远程共享操作量上升，再评估数据库，而非现在引入。

## 8. 分阶段实现与直接对应需求的验收

| 切片 | 可交付行为 | 必须证明，不以 mock 代替 |
| --- | --- | --- |
| S1 只读底座 | Git 状态、index/worktree diff、repo identity、面板 | 真临时 repo：失败不显示 clean；含换行/空格路径正确；linked worktree 身份正确；不改 index；二进制/截断明确 |
| S2 本地写入 | stage/unstage、确认提交、显式 fetch/push | 真实 Git + 临时 bare remote：保留无关 WIP/部分暂存；stale HEAD/index 拒绝；冲突/锁失败；不强推；跨 worktree 串行；hook 失败与副作用如实 |
| S3 GitHub 闭环 | 身份、映射、PR、评论、review、checks、merge | 本地 HTTP fixture：schema/分页/权限/未知结果/expected SHA；随后授权的测试仓库做真实创建、审查、合并验收 |
| S4 恢复与 UI 收口 | operation 恢复、草稿恢复、完整交互 | 临时 userData 模拟 dispatch 后崩溃；无自动 replay；当前构建真实 App 重放各动作，保持会话/终端状态 |

### 重点失败对照

- 移除 expected SHA 检查后，“远端新增提交仍被合并”测试应失败。
- 改成 `git add -A` 后，“未暂存笔记不进入提交”测试应失败。
- 将 status 异常替换为 `[]` 后，“不可用不等于 clean”测试应失败。
- 移除生产 IPC wrapper 校验后，恶意 sender/cwd 测试应证明 privileged listener 被执行，从而失败；不能只看 iframe 没 preload。
- 模拟服务端写成功但响应丢失：只触发一次 mutation，UI unknown，reconcile 不重复发布 PR/review。
- 同一路径同时 staged/unstaged；rename/delete/symlink；自有 PR 审查权限；无 remote/多 remote/SSH alias/fork；无必需检查与读取检查失败必须分开。
- pushurl 与 fetch URL 不同、多个 pushurl、pushInsteadOf/insteadOf 改写、确认后配置改变：只能写入已确认的单一有效端点，核验不能读错 fetch 端点。
- GitHub API 未登录但 SSH 传输可用：不阻断普通 Git push；身份分开显示。PR 草稿 → 本地提交 → push 新 HEAD 后：旧审批不能换 SHA，旧行评论不能直接提交。

### 检查与环境

本次仅研究与设计；不运行真实 Agent，不改真实 `.scry`/DB，不构建或安装 App。HTML 原型自带 Node 状态检查和浏览器交互检查，它们只证明设计状态，不证明 Git/GitHub 产品功能。

未来生产落地遵循 `docs/agent/verification.md`：focused `npm run test:unit -- <实际新增测试文件>`；typecheck/lint/build 使用落地时核对的 package scripts；安全/持久化/IPC 属于扩大 gate。macOS 门禁含 `test:renderer:ui`。真实 GitHub 验收需要明确测试仓库和账户授权；不能在当前开发仓库随意创建 PR 或合并以“验证”。

## 9. 待确认事项与推荐

1. **交互：推荐 A 工作台方案。** B 只在以跨项目审查为主时更合适。
2. **第一交付面：推荐本机桌面 + github.com，完整手动闭环。** 其他端/forge 不是默认承诺。
3. **原生 Git 执行扩展：推荐独立授权，不继承 recorder auto grant。** 这是安全政策决定；开始真实写路径前必须明确。
4. AI commit/PR 文案、组合按钮、auto-merge 不作为核心流程依赖；确有需求后另行授权设计。

在以上决定确认前，业务代码保持不变。当前交付应先审方案和原型，再开始 S1/S2。
