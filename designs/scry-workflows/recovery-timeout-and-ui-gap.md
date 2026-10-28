# Recovery / verification 超时定位与 v4 UI 差距

日期：2026-10-28。产品源码：`0e6b667101c15325737450312bfe4be62f046bee`。

> 后续进展：[v4 工作台独立验收与交付](v4-workspace-delivery.md)。生产工作台、代码联动和连线图已落地，完整 renderer/packaged smoke 通过；原 5 秒 unit 门禁尚未收敛。下文保留当时版本的调查和 UI 缺口，不代表后续源码仍没有工作台。

## 结论

1. 已定位的 recovery 失败是**多次真实 Node/controller 启动及执行累加，耗尽单用例 5 秒预算**，不是 controller 完成后 IPC 一直不关闭。不能因此把真实崩溃恢复测试换成 mock、删掉阶段或扩大 timeout。
2. verification 的失败用例使用 `MemoryWorkflowStore`，不能把其超时归咎于 FileWorkflowStore 的 fsync。它需要四次真实 native check；一次实际采样中四个 Node 子进程耗时合计 1655ms，占该次 2722ms 用例的约 61%。
3. 当前机器持续高负载。各次测量的 timing lock 均报告 `highLoad:true`。已确认关键路径及波动事实，**没有证明操作系统启动抖动的最终原因，也没有得到可信的低负载 L2 基线**。本轮没有实施性能修复或宣称变快。
4. 用户对 UI 的质疑成立：现有生产界面不是已确认的 v4 工作台。已有证据查询控件，但主要是聊天页折叠面板和弹窗中的列表；**不能把后端/helper 测试通过当成设计稿已落地**。

## 1. Recovery：直接分析原始失败现场

未先重跑刷绿。先读取上一轮保存的三份 `recovery-diagnostic.json`，覆盖原串行失败的 retry、第二个 controller 重入及 loop 三种情形。原始诊断已复制到本次证据目录。

### admitted retry 的失败链

| 阶段 | 原始证据 | 判断 |
|---|---|---|
| `retry-refusal` controller | parent close 2203ms；一个本地 child 从 spawn request 到 close 973ms；记录/帧持久化区间合计 259ms | 正常退出 code 0，非退出等待卡死 |
| `retry-crash` controller | parent close 2016ms；一个本地 child 873ms；已闭合的记录/帧持久化区间合计 256ms | 按测试合同退出 code 73，非异常挂起 |
| `resume` controller | 启动约 304ms 后触及全用例截止；收到 cleanup 的 terminate；最后 close 950ms / code 75 | 截止发生时第三个 controller 甚至尚未开始实际恢复派发 |

前两个 controller 已消耗约 **4.219 秒**。加上 setup/bundle 与第三次启动，5 秒预算已用尽。`parent_exit`、stdio end 与 `parent_close` 在前两个 controller 中接近同时发生，没有“业务已结束但一直等待 close”的证据。

其他两份失败现场同样记录到实际子进程启动/执行和预算截止；loop 的 resume 在截止后仍等待其已启动 child 收敛，这部分属于 cleanup，不能拿 cleanup 总时长冒充正常业务完成时长。

注意：parent 和 fixture 的 `ms` 使用不同起点。`parentClose - fixtureLastPhase` 只能标为“入口前启动/模块加载与尾部退出的合并差额”，不能直接全部标成 fsync、Node 启动或 IPC 尾耗时。这里没有这样归因。

### 代码调用链

- `workflow-recovery-process.test.ts`：一个用例中顺序执行多个 controller，验证真实崩溃、恢复及不重派发。
- `workflow-recovery-process.fixture.ts`：esbuild 后通过 macOS sandbox 启动真实 Node controller；持久化及 IPC/close 分段已有诊断。
- `scripts/fixtures/workflow-recovery-process.ts`：每个真实执行再启动一个本地 Node CLI，等待真实 close，再提交结果。
- `workflow-store.ts`：保持文件 flush、原子 rename 与目录 sync。原始失败中的已记录持久化占比不足以支持“先删 durable writes 来解决”的方案。

## 2. Verification：四次 native check，而非 FileStore

选中旧失败用例 `reuses persisted verification after a cut`，使用临时只读观测 hook，记录生产代码实际调用的 spawn/execFile 时刻；没有改测试断言、程序、命令、sandbox、超时或 native 结果。

临时 hook 在 `setupFiles` 中加载，包装后仍返回原 ChildProcess / Promise；只记录 executable、固定 flag、spawn/close 时刻和退出码，不记录命令载荷或凭据。

一次有效观测：

| 子进程 | spawn 到 close |
|---|---:|
| native Node check 1 | 389ms |
| native Node check 2 | 422ms |
| native Node check 3 | 391ms |
| native Node check 4 | 453ms |
| 四次固定 `ps` 身份观测 | 合计 102ms |

该次用例 2722ms，1 passed / 9 因 `-t` 未选中。相同产品代码在另一轮临时观测中耗时 4838ms。两者都处于高负载，不能拿较快一轮抹掉先前失败，更不能声称优化成功。

前三个观测步骤的局限亦保留：仅通过 `NODE_OPTIONS` 加载 hook 时没有覆盖 Vitest worker；随后 worker 的 exit hook 未落盘；改为每个 ChildProcess close 时保存才取得上述明细。前两次没有子进程观测证据，不算有效分段数据。

### 启动与退出的分离对照

另外执行四个只加载 `node:fs` 的空白 Node 控制进程；这是用来隔离启动/尾部的诊断，不是替换原验收 workload。

- 无 sandbox 两次：启动 372 / 35ms，尾部 3 / 2ms。
- 相同 deny-network sandbox 两次：启动 65 / 46ms，尾部 2 / 3ms。

这证明该次波动主要发生在进入 JS 之前，而不是退出尾部，也**不支持把 sandbox 本身断言为根因**。样本很少且高负载，不能推广为稳定启动基线。

### 尚未决定的根因层级

已决定：失败用例的关键路径包含多次真实进程启动，预算耗尽；没有捕获到应用死锁或 controller close 常驻。

未决定：启动变慢具体是 CPU 调度、文件/模块页缓存、OS 扫描还是其他宿主争用。缺少同机低负载下的等负载对照；本轮没有停止用户其他工作来制造低负载。不能简单写成“都是机器忙，与改动无关”。

下一步负责人：我。先在不扩大原 5 秒上限、不减少真实 controller/check 数量的条件下，补齐 controller 入口前阶段的时钟证据，取得低负载同场景对照，再决定是否存在可删除的重复工作。若只剩宿主启动抖动，应明确环境门槛，不伪造产品修复。

## 3. 为什么看不到 v4 的 UI

### 设计稿与实际入口不是同一实现

- 已确认设计：`designs/scry-workflows/v4/index.html`、`app.mjs`、`style.css`。页面自己明确标为固定样例回放、未连接 Provider。
- 实际 App：`App.tsx:2673` 仅在 chat/conversation 中挂载 `WorkflowProgressPanel`。
- “程序与记录”打开 `WorkflowExecutionInspector` 弹窗，默认显示“程序结构”，再切“同源实例图”。
- 实际 `WorkflowExecutionGraph.tsx:114–119` 渲染 `ol/li` 列表；父关系以文本 ID 展示，不是设计稿的横向连线图。
- 新增 Main helper `projectWorkflowGraph()` 的仓库调用检索只有自身定义和 `workflow-graph.test.ts`，没有生产调用方。Renderer 仍用自己的 `workflowGraphItems()`。不能称该 helper 已接成主工作台。

### 差距清单

| v4 设计 | 当前实际 | 结论 |
|---|---|---|
| 一体化工作台，运行 / 计划确认 / 管理 / 模板编辑 | 聊天底部按钮、折叠条目、若干独立弹窗 | 未落地 |
| 左侧 orchestrator/代码与选中节点联动 | 弹窗内只读程序结构与 JSON | 有基础能力，不是设计布局 |
| 连线式 map / branch / loop / return 主图 | 按代码块分组的竖向列表、长实例 ID、父 ID 文本 | 主图未实现 |
| runtime slots / attempt budget 与排队态主状态条 | 表格/文字分散展示 | 未按设计聚合 |
| 从图节点检查真实候选、轮次与证据 | 实例按钮可打开控制帧/输出检查 | 部分证据交互已实现 |
| 清楚、可发现的工作流入口 | 已完成工作流需展开条目，再打开弹窗，再切图 tab | 入口隐蔽 |

因此不是用户没找到某个开关，也不是只有安装版本旧。当前源码的可见界面本身就未达到已确认设计。上一轮只给 Agent 输出截图，没有重放完整 UI 路径，也没有据设计稿验收，是交付缺口。

### 本次实际重放

从现有合成验收数据复制独立 userData，使用当前 build 启动新 test App。**所有 Provider 禁用、Jev key 为空、activeRuns 为 0**，没有新付费调用。真实原生交互路径：

`选择已有会话 → 展开执行完成的工作流 → 程序与记录 → 同源实例图`

保存两张当前 App 截图：

1. `screenshots/01-current-inline-workflow.png`
2. `screenshots/02-current-inspection-graph.png`

另外通过只读 localhost 服务在 Chrome 渲染 v4，与实际 App 对照。设计稿截图由 Relay 加密 artifact 保管：`pi1_browser_artifact_541dd016-c437-440d-8db3-d55ce9c7e5f2`；它不是本地 PNG，不伪造一个路径。

我建议的下一项实施任务：**按现有 v4 补主工作台、代码联动与连线图，复用现有 typed Main API、Runner、账本和 stop/recovery 合同**。先核对每个可见控制的真实能力；未实现的暂停/重启等操作必须明确 unavailable，不能照搬样例假按钮。不要再出一份静态设计稿来替代接线。

## 4. 证据与最终状态

本地证据目录：

`/Users/baobingjiang/.local/state/rotom/verification-evidence/workflow-recovery-ui-audit-20261028.WOVJ0g`

包含旧失败诊断、三次 targeted 观测日志、有效 subprocess 明细、启动对照、两张实际 App 截图及 SHA-256 清单。所有 timing run 经现有主机锁串行执行，`highLoad:true`，不宣称稳定毫秒结论。

本次只定位、审查和记录。没有改产品源码、测试、timeout、gate 或设计稿；没有 push、构建安装、真实 Provider 请求。仅提交本报告。已确认独立 test App 与 localhost 设计稿服务退出；没有停止用户日常 App。
