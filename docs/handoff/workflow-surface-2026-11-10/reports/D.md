# D：归档回放冒烟

结论：新增 `npm run test:workflow-archive`，在真实 App 里回放一份归档轮次并断言阶段、agent、终态、脚本行和布局；正向通过，负对照（去掉 workflow 去重键）失败。回放同时暴露并修好了一个投影缺陷：活动行先于 `tool_use` 到达时会出现第二个“状态未知”运行。

## 命令

```bash
npm run test:workflow-archive                     # 默认用共享合成夹具
node scripts/workflow-archive-smoke.mjs --fixture <messages.json> [--keep]   # 用真实摘录夹具
SCRY_WORKFLOW_ARCHIVE_SCREENSHOT=evidence/screens node scripts/workflow-archive-smoke.mjs
```

- 包装脚本 `scripts/workflow-archive-smoke.mjs`：把夹具消息交给生产 `normalizeSdkMessage` 得到事件，写一份真实布局的归档轮次（`trace-archive-turns-v1/...`）、一份 Provider 原生 transcript（`$HOME/.claude/projects/<encoded cwd>/<session>.jsonl`）和会话行，然后调用 `electron-security-smoke.mjs --dev-workflow-only`。
- 冒烟模块 `scripts/electron-security-workflow.mjs`：真实指针点击打开会话 → 展开工具组 → 点“在 Workflow 面板查看” → 用生产 `deriveWorkflowRuns` 算出期望值，逐阶段、逐 agent、终态、脚本行、横向溢出对照 DOM；随后 `Page.reload`（渲染进程重启）重开同一会话再对照一次。
- 包装脚本会启动**两次**真实 App 进程，共用同一个临时 userData/HOME：第二次什么也不写（不重写归档、不重写 transcript，只重写会话目录行），因此“还能打开并显示同样结果”证明数据是从磁盘读回来的。第二次的输出带 `"relaunch": true`。
- `scripts/electron-security-smoke.mjs` 只增加 `--dev-workflow-only` 分支与种子调用，新逻辑都在独立模块里；文件 19.6 KB，仍低于 20,000 字节。

## 正对照

`npm run test:workflow-archive` 退出码 0，输出：

```json
{"archivedWorkflow":{"runId":"run-archive-workflow","events":8,"archivedPhases":3,"archivedAgents":6,
"status":"已完成","statusTitle":"来自 Claude Code 的 task_notification 终态",
"phases":[["scan","done","3/3 已结束"],["edit","failed","2/2 已结束"],["verify","done","1/1 已结束"]],
"agents":6,"logEntries":24,"scriptLines":21,"notices":[],
"reloaded":{"status":"已完成","phases":3,"logEntries":24},"noProviderRuns":true,"isolatedUserData":true}}
```

两次运行（首次 + 完全重启）输出一致，第二次带 `"relaunch": true`：

```
fresh   已完成 ['scan','edit','verify'] 6
relaunch 已完成 ['scan','edit','verify'] 6
```

`noProviderRuns: true` 来自 `window.scry.activeRuns()` 为空：回放不启动任何 Provider。断言里还有一条
“transcript 轮次与归档轮次必须合并成一“条”（`#main-pane .turn` 数量为 1）”，用来证明种子确实走了
生产的历史合并路径，而不是归档单源捷径。

截图（真实 App，真实指针点击）：

| 文件 | 证明了什么 |
|---|---|
| `evidence/screens/workflow-archive-chat.png` | 归档轮次在聊天区渲染出 Workflow 工具卡片与“在 Workflow 面板查看”入口 |
| `evidence/screens/workflow-archive-surface.png` | 点聊天卡片后打开右侧 Workflow，三个阶段、6 个 agent、终态与归档一致 |
| `evidence/screens/workflow-archive-reloaded.png` | 渲染进程 reload 后重新打开，阶段数/agent 数/终态与 reload 前一致 |
| `evidence/screens/workflow-archive-relaunch.png` | 完全退出 App、用同一 userData 重新启动、不写任何测试数据，仍打开同一阶段/agent/终态 |
| `evidence/screens/workflow-archive-layout-{pane-min,narrow,wide}.png` | 面板拖到最小、窗口 900px、窗口 1600px：三档都重跑同一套 `verify()`，横向溢出 0 |
| `evidence/screens/workflow-archive-plain-session.png` | 同一归档但删掉 Workflow 活动行的会话：`状态未知`、0 阶段、0 agent，切回原会话后重新验证 |

## 负对照

把 `src/main/session-history-trace-merge.ts` 里 workflow 的去重键从 `workflow:<runId>:<taskId>:<seq>` 临时改成 `workflow:<runId>:<taskId>`（并 `npm run build`）后：

```
[scry] smoke failure: Error: Error: Workflow archive UI timed out: document.querySelectorAll('#right-surface-pane .workflow-phase').length > 0
```

原因：去重键失去 `seq` 后，8 条增量行只剩第一条，面板没有阶段可渲染。恢复键并重新构建后再次运行，退出码 0，结果同上。

## 顺带修掉的缺陷（回放发现）

`deriveWorkflowRuns` 按 `(runId, toolUseId)` 和 `(runId, taskId)` 两个索引折叠。历史合并按时间排序，活动行可能先于 `tool_use` 到达；此时任务行先建了一个运行，随后 `tool_use` 又建第二个运行，面板选中最新那个就显示“状态未知、无阶段”。

- 先失败后通过的测试：`src/renderer/workflow-runs.test.ts` →「活动行先于 tool_use 到达时仍是一次运行，不出现“状态未知”的第二个运行」（修复前 `expected … length 1 but got 2`，修复后通过）。
- 修复：任务行建出的运行同时登记到 tool 索引，后到的 `tool_use` 认领同一个运行并补上脚本/日志，而不是新开一个。

## 是否接入 CI

没有接入 `test:renderer:ui`。理由：它需要先 `npm run build`、启动一次 Electron、约 25–40 秒，而 `test:renderer:ui:3` 已经在做构建后置检查；接进去会拉长那条链，且按 `docs/agent/pr-workflow.md` 的维护清单还要同步 `scripts/ci-workflow.test.ts`。现在以独立脚本 `npm run test:workflow-archive` 提供，维护者可以一次性决定是否并入。

## 未验证

- 夹具目前是共享合成夹具（`src/shared/claude-workflow.fixture.ts`）。W.md 要求用 B4 的真实摘录夹具生成；B 因公司网关 429 尚未拿到真实运行，拿到后会用 `--fixture` 换成真实摘录并重跑本条，届时更新本报告。
