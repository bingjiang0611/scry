# 工作包

每个包的“完成条件”是审查方核验时逐条对照的清单。做不到的条目写明原因，不要省略。

## A：macOS 环境与基线

1. `git fetch origin claude/sweet-ptolemy-qxysuh` 并切到该分支，确认 HEAD 含 `09304e7b`。安装依赖。
2. 运行并记录：`npm run typecheck`、`npm run build`、`npm run build:cli`、`npm run check:harness-bindings`、`npm run test:workflow-ui`，以及这组相关测试：

   ```bash
   npx vitest run src/main/normalize-workflow.test.ts src/main/session-history-trace-merge.test.ts src/main/session-history.test.ts src/renderer/workflow-runs.test.ts src/renderer/components/WorkflowSurface.test.tsx src/renderer/right-surface.test.ts src/renderer/right-surface-tabs.test.ts
   ```

3. `npm run test:workflow-ui` 设 `SCRY_WORKFLOW_UI_SCREENSHOT=<目录>` 会输出各状态截图。把宽、窄各一张完成态放进 `evidence/screens/`，标明“合成夹具”。

完成条件：以上命令的退出码与耗时都在 `reports/A.md`。有失败先判断是不是本分支引入，用未改动的 `main` 对照。

## B：真实事件核对（最重要）

目的：回答 README 里的 Q1 到 Q11，并让代码以真实格式为准。

### B1 准备

- 建一个一次性临时工作区，放 4 到 6 个无意义的小文件，`git init` 并提交一次。
- 起 test 实例：临时 userData、真实 `HOME`、`SCRY_TEST_APP=1`、`SCRY_PROVIDER_EVENT_LOG=1`、调试端口。选 Claude，把临时工作区授权进去。
- 记录 `system/init` 里的 `claude_code_version` 和工具列表里有没有 `Workflow`。没有 `Workflow` 时先查账号是否开启了 Dynamic workflows，查清原因写进报告。

### B2 场景（都要跑，预算不是约束）

| 场景 | 做法 | 主要回答 |
|---|---|---|
| S1 小型内联 workflow | 用自己的话要求“用 workflow”：两到三个阶段，每个文件一个只读 agent，再加一个汇总 agent | Q1 到 Q7、Q10、Q11 |
| S2 触发方式 | 分别用 `ultracode: ...` 和自然语言请求各发一次，看哪种会调用 Workflow 工具 | Q8 |
| S3 运行中停止 | S1 同类任务，跑到一半按 App 的停止按钮 | Q2、Q5，停止后的终态 |
| S4 失败的 agent | 让其中一个 agent 必然失败，例如读一个不存在的文件并要求严格 schema | 行的 error 状态 |
| S5 较大扇出 | 20 个以上 agent | Q7，分片与上限 |
| S6 按名称运行 | 先把 S1 的脚本存成 `.claude/workflows/` 下的命令再按名称运行；另跑一次内置的 `/deep-research` | Q9 |
| S7 同一会话两次运行 | 同一会话里先后跑两个 workflow | 运行选择器 |

审批：默认权限模式下 Workflow 工具调用会走 Scry 的审批。记录审批界面出现了什么，再批准。也可以另用 full access 模式跑一遍对比，但两种模式分别记录。

### B3 对照

对每个场景，从事件日志里取出 native 的 Workflow `tool_use`、对应 `tool_result`、全部 `system/task_*`，以及它们派生的 canonical `harness/workflow_activity`。逐条回答 Q1 到 Q11。

特别检查：
- 有没有 native 的 workflow 事件**没有**派生出 canonical 事件，或派生时丢了字段。
- `rowsUnrecognized` 是否出现。出现就说明有行读不出，要补 `readWorkflowWireRow`。
- canonical 的 `seq` 是否连续。
- 面板显示的阶段数、agent 数、每个 agent 的终态，是否与 native 最后一份快照逐行一致。写一个小脚本做这件事，不要肉眼比。

### B4 修正与沉淀

- 发现不一致就改 `src/shared/claude-workflow.ts`、`src/main/normalize-workflow.ts`、`src/renderer/workflow-runs.ts`，每处修改配一个先失败后通过的测试。
- 把脱敏后的真实摘录做成夹具，放 `src/main/workflow-wire-fixtures/`，每个文件不超过 20,000 字节，加回放测试：真实 native 消息经 `normalizeSdkMessage` 再经 `deriveWorkflowRuns`，断言阶段、agent、终态。合成夹具 `src/shared/claude-workflow.fixture.ts` 保留，但在文件头注明哪些形状已被真实数据证实。
- 更新 `src/shared/claude-workflow.ts` 文件头的证据说明：实测的 CLI 版本、哪些字段是实测的。

### B5 如果真实行为与设计根本不符

- **流上没有 `workflow_progress`**：保留任务级状态与用量，面板显示 unavailable。把“从哪里还能拿到明细”写成设计说明，不实现。
- **workflow 在轮次结束时被杀或被留到后台**（Q2）：这是 Scry 一次性 `query()` 的运行方式决定的，属于「必须停下」第 1 条。如实记录现象、终态事件和面板显示，确认面板没有把被杀的运行显示成完成。写出两到三个可选方案及各自影响，不实现。
- **事件跨轮到达**：检查 `deriveWorkflowRuns` 是否仍能把它们归到同一次运行，以及“所属轮次已结束”的判断是否把仍在运行的 workflow 误标成未知。这个可以修，配测试。

完成条件：`reports/B.md` 逐条回答 Q1 到 Q11；`evidence/wire/` 有各场景摘录；有真实夹具和回放测试；改动都有测试。

## C：真实 App 验收与截图

在 B 修正之后的代码上做。每个场景给出截图和一句“这张图证明了什么”。

1. **运行中**：阶段卡片逐步出现，运行中的阶段对应的脚本行高亮，日志跟随到底部。至少两张不同时刻的截图。
2. **完成**：终态、用量、每个 agent 的结果预览。点开一个 agent 的详情。
3. **失败与停止**：S3、S4 的最终画面。停止后的 agent 不显示成完成。
4. **重启后恢复**：完全退出 test 实例，用同一个 userData 重新启动，打开同一会话的 Workflow 标签。重启前后阶段数、agent 数、终态必须一致。这一条验证历史合并的修复，**必须真实重启**，不能只刷新页面。
5. **布局**：默认右栏宽度、最大化、最窄可用宽度各一张。不应出现横向溢出或被裁掉的内容。
6. **相邻路径**：切到另一个会话再切回；同时打开 Agents 标签，确认 workflow 的任务没有混进子 Agent 列表；聊天区里 Workflow 工具卡片显示正常。
7. **其他 Provider**：机器上若装了其他 Provider，打开它的会话看空态。没装就写未验证。
8. **证据语义**：对照事件日志确认界面上每个“已完成”“失败”“状态未知”都有对应的 Provider 事件来源。

完成条件：`reports/C.md` 加 `evidence/screens/`。自动测试结果与真实交互结果分别写。

## D：归档回放冒烟

目的：给真实 App 一个不依赖 Provider、可在 CI 里跑的 workflow 检查，同时把“重启后恢复”变成自动回归。

- 以 `scripts/electron-security-smoke.mjs --dev-file-history-only` 为模板，新增 `--dev-workflow-only`：把含 `workflow_activity` 事件的归档轮次写进临时 userData，启动真实 App，打开该会话的 Workflow 标签，断言阶段、agent、终态，并截图。归档内容用 B4 的真实夹具经生产归一化代码生成，不手写事件。
- 加负对照：把 `src/main/session-history-trace-merge.ts` 里 workflow 的去重键临时去掉，这个冒烟必须失败。恢复后再通过。两次结果都写进报告。
- `scripts/electron-security-smoke.mjs` 已接近 20,000 字节，新逻辑放独立模块。
- 加 `package.json` 脚本。是否接入 `test:renderer:ui` 的 CI 链由你判断：接入需要遵循 `docs/agent/pr-workflow.md` 的维护清单并同步 `scripts/ci-workflow.test.ts`。不接入就在报告里写明理由。

完成条件：命令、正反两次结果、截图在 `reports/D.md`。

## E：补齐功能与文案

按价值排序，逐条做，每条配测试并在真实 test 实例里看一眼。

1. **从聊天区打开面板**：聊天里的 Workflow 工具卡片加一个“在 Workflow 面板查看”入口，点击后打开右侧 Workflow 标签并选中这次运行。参考 `app-shell.tsx` 里 `onOpenAgents` 的做法。不需要新 IPC。
2. **文案以实测为准**：根据 Q8 修正 `src/renderer/constants/workflow-copy.ts` 的空态说明。所有“来自某事件”的提示语与 B 的实测一致。
3. **脚本不可得时的说明**：根据 Q9 确认按名称运行、内置 workflow 两种情况的显示。阶段标题被替换成 `phase N` 时要说明这是 Provider 隐去的，不是真实标题。
4. **大规模运行**：用 200 到 1000 个 agent 的合成快照验证上限。主进程每个事件的行数、renderer 每阶段渲染的节点数、日志条数都要有断言。再测一次 `deriveWorkflowRuns` 在这种规模下每次流式更新的耗时，耗时明显时改成增量折叠。按 CLAUDE.md 的性能纪律报告，测不到的写 unavailable。
5. **用量诚实**：根据 Q11 确认面板上的任务级用量没有被总览、分析或账单重复相加。发现重复就修，并说明减掉的数字原本去了哪里。
6. **停止控制**：**不做**独立的 workflow 停止或暂停按钮（必须停下第 1 条）。只需在 C3 里验证现有的停止按钮对运行中 workflow 的真实效果。
7. 你在 B、C 里发现的其他问题，属于本面板范围的直接修，不属于的写进报告的“另列待办”。

完成条件：`reports/E.md` 逐条写做了什么、测试名、截图。

## F：macOS 全量门禁与总结

1. 定稿后运行 `npm run pack`（类型检查、全量单测、打包、打包产物校验、Electron 冒烟）。**不运行 `install:mac:dev`**。
2. 运行 `npm run test:renderer:ui`。
3. 改动触及 `scripts/performance-paths.json` 里 `sources` 列出的文件时，运行 `npm run performance:measure -- --compare origin/main`，对每个 `worse` 说明原因。
4. 按 `docs/agent/pr-workflow.md` 的「本地提交前自查」核对累计改动。
5. 写 `reports/SUMMARY.md`：每个包的结论、Q1 到 Q11 的一句话答案、仍未验证的项、你建议维护者决定的事。在 STATUS 顶部写「全部待核验」。

完成条件：SUMMARY 里列出的每个“通过”都能在对应报告里找到命令和退出码。
