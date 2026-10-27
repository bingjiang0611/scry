# 20261027 准备工作区少跑 21 个 git 子进程

## 现象与证据

发送第一条消息时「正在准备工作区，尚未确认启动…」要等好几秒。

日常记录（快照 `~/scry-performance-archive/20261027-0220`，运行中 packaged build `bfebcfdf19a125a0dcb85b0239a63939c632f04f9b279e3bf2e6e28b1d0561f7`）：`workspace.prepare` p50 4461 ms / max 9270 ms（n=2），其中 `git_prepared` 3351 ms / 7702 ms。样本只有 2 次，属线索。

根因不是 checkout 体积。本机 `git --version` 单次就要 329 ms（load 24），而 prepare 路径上有几十个 git 子进程：受控夹具（200 个文件、真实临时 Git，经 `SourceControlService.startWorkspace` 走完整首发送）计数为 **98 个 git 子进程**（`git.run` 46 + `git.process.run` 52）：`rev-parse` 11、`config` 9、`ls-files` 8、`status` 4、`worktree list` 4、`rev-parse --git-path hooks` 4。3.1 s 由此而来，与仓库大小关系不大。

## 改动（两处，都是「不重复做同一件事」）

1. `src/main/source-control/workspace-start.ts`：`journal.phase === 'planned'` 分支里 `verifyWorkspacePlan` 执行完、写入日志后，紧接着又对整个工作区重新验证了一遍，两次之间只有一次日志写入（非 Git 写入）。改为复用本次调用刚验证的结果 `preparedThisCall`；`admit` 回调里登记前的最后一次重验保留，所以没有放宽最后一道检查。恢复路径（phase 已是 `prepared`）仍然重新验证。
2. `src/main/source-control/workspace-git.ts`：`assertWorkspaceCheckoutSafe` 原本无条件读取整份 `git config --list --includes`，改为先看 `check-attr` 结果里是否真的出现 filter driver，没有就跳过 config。常见仓库没有 filter，因此省掉一次 git 进程；有 filter 时判定逻辑不变（仍 fail closed）。

## 验证

- 受控夹具计数（200 文件真实临时 Git，`SourceControlService.startWorkspace`，同一夹具前后各跑一次）：

| 指标 | 改前 | 改后 |
|---|---:|---:|
| `git.run` 调用 | 46 | 36 |
| `git.process.run` 调用 | 52 | 41 |
| git 子进程合计 | 98 | 77 |
| `rev-parse` / `config` / `ls-files` / `status` / `worktree list` | 11/9/8/4/4 | 9/6/6/3/3 |

- 功能：`npx vitest run src/main/source-control/workspace-start.test.ts` 9/9 通过（含"Git 写入结果未知时不重试""同一消息重放复用同一 run""登记前 trust 失败不启动"）。
- `npx vitest run src/main/source-control/workspace-choices.test.ts` 中 1050-ref 分页用例在 load 24 下仍会 5 s 超时（与本次改动无关，单跑 3772 ms 曾通过）；其余用例通过。
- `npm run typecheck:node` 通过。

## 减少的工作去了哪里

不做了：重复的整仓验证（一次）与无 filter 仓库上多余的 config 读取。工作量真实下降，而非挪走。

## 级别与后续

- L1：git 子进程 98→77（−21，−21%）。计数用受控夹具、同机同负载连续两跑得到。
- L2：未测。单样本毫秒在 load 24 下噪声大于收益（改前 3157 ms、改后 3709 ms），不能作为结论；需要在 `timing-run.mjs` 锁内做多次重复。
- L3：待部署后日常记录对比。
- 剩余机会（未做，按代价排序）：`git.identity` 在一次 prepare 里仍被调用 9 次、`readStatus` 里每次都重读身份与 `ls-files` 探测、3 次 `status`；这些可以合并成一次身份读取 + 一次状态快照，预计还能再减 30 个子进程。

## 第二轮：同一份证据只解析一次

第一轮把一个 prepare 的 git 子进程从 98 降到 77（夹具计数）。剩下的重复在「同一条信息被
不同调用点各自重算」：

1. **`readStatus` 用自己刚验证的身份继续读**（`src/main/source-control/git.ts`）。
   原来它先 `identity()` 重验一次，之后却拿**旧的** identity 去跑 status、读 config、读 index。
   现在把验证后的身份作为这次读取的身份继续使用，`revisionState` 也只接受这份 observed 结果。
   这一条不减少进程数，改的是「用哪份身份读」——验证过的路径和实际读取的路径不能是两份。
2. **`assertSafeWorktreeRead` 一次列举代替两次**。原来先 `ls-files --stage -z` 判子模块，
   再 `ls-files -z --cached --others` 取名字，两次都要起 git。合并为
   `ls-files --stage -z --others --exclude-standard`：staged 行（`mode hash stage<TAB>path`）
   判 `160000` 子模块，其余取路径；任何 stage 0-3 都算，未合并条目照旧进入名字集。
   每个 status 读少起一个 git 进程。fail closed 行为不变：filter driver 仍拒绝。
3. **登记前不再为一个 root 字符串重解析身份**（`src/main/source-control/workspace-start.ts`）。
   上一行的 `verifyWorkspacePlan` 已经证明 `realpath(plan.cwd) === target.root`，
   紧接着的占用判定直接用 `target.cwd`。最后一道重验（verifyWorkspacePlan + 同步授权校验）
   一行不少，只是不再重复解析身份。没有引入任何跨调用的身份缓存——那不是这里该做的事。

## 验证（第二轮）

- `npx tsc -p tsconfig.node.json --noEmit`：通过。
- `npx vitest run src/main/source-control/`：8 个文件 75/75 通过，含
  “fails closed for executable hooks and filters without running them”（覆盖合并后的
  filter 判定）与 “fails closed for ... submodules” 相关用例。
- 全量 `npm run test:unit`：见本轮提交说明中的结果。

## 未验证（第二轮）

- 子进程计数没有重测：本仓库 `process.ts` 会在清洗后的 PATH 上解析绝对可执行文件，
  外部 PATH 包装脚本无法注入计数，所以只有代码级与用例级证据，不给数字。
- 毫秒未测（机器 load 16-45）。
