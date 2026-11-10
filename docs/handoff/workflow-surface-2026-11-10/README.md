# Workflow 面板交接：真实验证与补齐（2026-11-10）

目标：把 Claude Code 原生 workflow 的观测面板从“合成数据上成立”推进到“真实运行上成立”，并补齐剩余功能。分支 `claude/sweet-ptolemy-qxysuh`，基线 `main@f708285a`。

已交付内容见提交 `3a015367`（历史模块拆分）与 `09304e7b`（面板本体），提交说明里有完整的实现与证据边界。先读这两个提交说明，再读本目录。

旧分支 `feat/workflow-m0` 是另一套“Scry 自有运行器”，**只可参考界面，不要合并、不要 cherry-pick、不要改它**。

## 协作方式（为减少往返而设计）

- **审查方**（Claude 云端会话）：写了本目录，全部工作包结束后集中核验。它运行在 Linux 容器里，**只能看到你 push 的内容**，看不到你的屏幕、本机日志和 `/tmp`。
- **执行方**（你）：在 macOS 本机、同一分支上**连续完成所有工作包**。每完成一个工作包：提交、写 `reports/<包>.md`、更新 [STATUS.md](STATUS.md)、push。**不需要等审查方回复就继续下一个。**
- 能自己查清楚的问题当场查完并在报告里写明依据。只有命中下面「必须停下」才停止对应条目，其余条目照常继续。
- 预算不是约束：真实 Claude 账号调用、多次真实 workflow 运行、长测都已获维护者授权。不要为省钱缩小验证范围。
- 不 push `main`，不开 PR，不合并，不发布。**本轮不安装到 `/Applications`**（这是对 CLAUDE.md 默认安装的显式覆盖：代码还未经审查）。用独立 test 实例验证，不停止、不干扰维护者正在用的日常 App。

## 工作包与顺序

详细做法见 [W.md](W.md)。**B 最重要，先做**：它决定后面是照现有设计走，还是要改归一化。

| 包 | 内容 | 依赖 |
|---|---|---|
| A | macOS 环境与基线：依赖、类型检查、相关测试、面板冒烟 | 无 |
| B | 真实事件核对：抓真实 workflow 的原始事件，对照并修正归一化，沉淀真实夹具 | A |
| C | 真实 App 验收与截图：运行中、完成、失败、停止、重启后恢复、窄屏与最大化 | B |
| D | 归档回放冒烟：不依赖 Provider 的真实 App 自动化检查 | B |
| E | 补齐功能与文案 | B，可与 C/D 交错 |
| F | macOS 全量门禁与总结 | 全部 |

## 必须停下的情况（其余自行决定）

停下指：**该条目**不再改代码，在 STATUS 和报告里写明证据与你建议的方案，然后继续其他条目。

1. 需要改变 Claude 的运行方式：把每轮一次的 `query()` 改成流式输入、声明 `supportsTaskStop`、改 interrupt 语义、让后台任务跨轮存活。
2. 需要改审批、权限模式、仓库 trust gate、renderer 隔离（sandbox、CSP、contextIsolation）或新增任意路径、任意命令类 IPC。
3. 需要改 `.scry/records` 的 schema、recorder 落盘内容，或往 `src/core/turn-recorder/` 引入 Electron、SQLite、Provider SDK、原生依赖。
4. 需要放宽门禁：改 `scripts/performance-ratchet.json`、加大超时、加 sleep 或重试、skip 测试、扩大 20,000 字节文件上限。
5. 真实事件与现有设计根本不符，例如 SDK 流上完全没有 `workflow_progress`，或 workflow 在轮次结束时被杀掉。这时**不要**为了让面板好看去猜数据或读未授权的路径。按 W.md 的 B5 处理。
6. 需要读取或改写 Provider 的原生文件来补数据，例如去解析 `transcriptDir` 下的子代理 transcript。只允许写设计说明。

## 硬约束（来自仓库 CLAUDE.md，本任务最相关的几条）

1. **证据不能说谎。** 拿不到的阶段、agent、用量显示 `unavailable` 并写原因，不显示 0、空或绿色。运行结束但没有 Provider 终态时保持“状态未知”，不推断成功或失败。
2. **身份只看结构化字段**：`task_type`、tool_use id、`workflow_progress` 是否存在。不用描述文本、提示词或正则判断“这是 workflow”。
3. **Provider 差异显式存在。** 面板只对 Claude 成立。其他 Provider 显示空态说明，不伪造能力。
4. **有界。** 事件、行、日志、DOM 节点都要有上限。不把整份快照逐次转发。
5. **提交身份**按 CLAUDE.md「提交身份」一节。每个文件不超过 20,000 字节，超过就按职责拆分。
6. **测试纪律**：真实截图与自动测试分别报告；不用程序化 `.click()` 冒充真实点击；负对照要真的失败过；不写真实 `.scry`、真实 userData。执行测试前读 `docs/agent/verification.md` 的「测试维护纪律」。

## 已核对的事实（不用重查）

- **App 实际用哪个 CLI**：优先 `SCRY_CLAUDE_PATH`、`~/.local/bin/claude`、PATH 上的 `claude`，都没有才用 SDK 0.3.251 自带的 2.1.251。见 `src/main/claude-locate.ts` 的 `resolveClaudeBin`。所以你机器上的版本可能和审查方读过的两个版本都不同，**报告里必须写明实际版本**（`system/init` 的 `claude_code_version`）。
- **现成的抓包工具**：`src/main/provider-event-log.ts`。启动 App 前设 `SCRY_PROVIDER_EVENT_LOG=1`，会在 `<userData>/provider-event-log/<thread>/` 写 NDJSON，native（Provider 原样）与 canonical（Scry 归一化后）两条流共享序号。`task_*` 不在瞬时白名单里，会落盘。记录里含提示词和工具输出，所以只在临时工作区的 test 实例里开。
- **test 实例怎么起**：参考 `scripts/electron-security-smoke.mjs` 的 `launchApp`。要点是 `--user-data-dir=<临时目录>`、`--remote-debugging-port=<端口>`、环境变量 `SCRY_TEST_APP=1`。冒烟脚本把 `HOME` 换成临时目录并禁用了真实 Provider；**真实运行要保留真实 `HOME`**（否则 Claude 未登录），并且不要设 `SCRY_DISABLED_PROVIDERS`。主进程启动时会清掉继承的 `CLAUDECODE`、`CLAUDE_CODE_*`，从 Claude Code 会话里启动没有问题。
- **驱动与截图**：`scripts/app-driving.mjs` 的 `createAppDriver` 提供真实指针点击和 `Page.captureScreenshot`。工作区授权的预置方式看冒烟脚本怎么写 `recent-folders.json` 和 `app-sessions.json`。
- **归档回放模板**：`scripts/electron-security-smoke.mjs` 的 `--dev-file-history-only` 把一份归档轮次写进 userData 再打开，是包 D 的直接模板。
- **审查方容器里的结果**：见提交 `09304e7b` 的 Verification 一节。Linux 下以 root 运行的 5 个单测失败是环境原因，macOS 上不应出现。

## 审查方没有验证、需要你回答的问题

逐条在 `reports/B.md` 里用证据回答。每条都给出事件日志里的序号或摘录。

| # | 问题 | 现有代码的假设 |
|---|---|---|
| Q1 | SDK 流上有没有带 `workflow_progress` 的 `system/task_progress` | 有 |
| Q2 | Scry 每轮是一次性 `query()`。workflow 是在本轮 `result` 之前跑完，还是在轮次结束时被杀或被留在后台 | 本轮内跑完，事件都落在同一轮 |
| Q3 | task 事件的 `tool_use_id` 是不是 Workflow 那次 tool_use 的 id | 是 |
| Q4 | 行的字段名与类型是否与 `readWorkflowWireRow` 一致，有没有读不出的行 | 一致 |
| Q5 | `task_notification` 的 `status` 取值，上面带不带 `workflow_progress` | completed、failed、stopped；可带可不带 |
| Q6 | Workflow 的 tool_result 上有没有结构化的 `tool_use_result`（taskId、runId、scriptPath） | 有 |
| Q7 | 一次运行里 native 的 task_progress 条数与字节数，对应 canonical 的条数与字节数 | canonical 明显更小 |
| Q8 | 在 Scry 里怎样的提示词会触发 workflow。`ultracode` 关键字在未标记 human 来源的 SDK 输入里是否有效 | 未知，空态文案写了 ultracode，可能不准 |
| Q9 | 内置或按名称运行的 workflow 是否不下发脚本、阶段标题是否被替换成 `phase N` | 是 |
| Q10 | workflow 子 agent 自己的消息会不会出现在主流上，有没有污染聊天区或 Agents 面板 | 不会 |
| Q11 | 轮次 `result` 的用量是否已含 workflow 子 agent。面板上的任务级用量有没有被别处重复相加 | 已含；面板单独标注不相加 |

## 报告与证据格式

审查方只看 push 的内容，所以报告要自足。

- `reports/<包>.md`：结论在最前。然后是 revision、macOS 版本与架构、Claude CLI 版本、实际命令、退出码、耗时。失败和未验证项单列，不写成通过。
- `evidence/screens/*.png`：真实 test 实例的截图，文件名带场景和宽度。报告里说明每张图证明什么。
- 事件摘录放 `evidence/wire/*.ndjson`，**每个文件不超过 20,000 字节**（门禁不豁免证据文件）。只保留回答问题所需的记录，并在报告里写明完整日志的记录数、字节数和 sha256。提交前去掉账号、令牌、邮箱，把家目录替换成 `~`。工作区用一次性的临时目录和无意义的样例文件，这样内容本身无需保密。
- 修改了归一化或投影，就把真实摘录做成测试夹具并加回放测试。审查方会在容器里重跑这些测试，这是它能独立核验真实格式的唯一方式。
- 全部结束后写 `reports/SUMMARY.md`，在 STATUS 顶部写「全部待核验」，push。
