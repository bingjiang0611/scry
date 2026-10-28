# v4 工作台：独立验收与交付报告

日期：2026-10-28。分支：`feat/workflow-m0`。本轮起点：`bf1a829e3b25f07390f67cedecd0a2f267bf0545`。

## 结论

v4 已从静态设计接入生产 Renderer/Main：Run、Plan、Manage、Templates 共用一个工作台，代码、结构图与 canonical 证据联动。不是新写的演示页面，也没有另建 scheduler。

**完整 renderer 门禁、类型检查、开发打包与 packaged Electron smoke 通过；完整 unit 门禁未通过。因此本报告不宣布 M1–M6 全项目、安装或发布完成。** 原始失败、后续通过、诊断与未验证项分别保留。

本轮独立验收由外部受控脚本驱动隔离 App，不以 Scry Workflow 驱动验收，不新建或重跑历史工作流。较早的真实 Qoder/Jev 结果作为只读输入；本轮没有新增 Qoder/Jev 业务请求。现有门禁仍运行其原有合成 CLI/Workflow fixtures，它们不是新的真实账号验收。

## 1. 交付内容

| 范围 | 本轮落地 | 边界 |
|---|---|---|
| M2 模板 | Templates 嵌入工作台；源码编辑、保留草稿、完整差异审查、精确修订保存、历史与恢复沿用原 API | busy/dirty 导航保护；项目变化后草稿仍绑定打开时项目，不自动执行 |
| M3 程序与执行证据 | 同源代码、containment 连线图、节点选择、revision 隔离、按需 frame 读取 | 结构关系不是执行顺序；不根据缺失记录画“完成” |
| M4 分类器证据 | 展示真实 bool/choice/score、置信度、概率及来源；false、0、缺失分开 | 低置信度保持 blocked，不用默认值伪造质量结论 |
| M5 工作台 | Run/Plan/Manage/Templates、键盘 tab、32 节点分页、历史分页、冻结计划、现有 root stop 与报告入口 | 暂停、停滞重启明确 unavailable；没有伪装能力齐全 |
| M6 独立验收 | 隔离生产 App 冷读、原生输入、截图、原记录 hash 核对及外部测试日志 | 不代替跨 Provider、业务仓库应用、完整计费或长期性能验收 |

主要模块：`WorkflowWorkspace*`、`WorkflowRunSurface`、`WorkflowGraphCanvas`、`useWorkflowGraph`、`workflow-graph`、`workflow-flow-layout`。用户文案集中在已有 copy 模块及 `workflow-workspace-copy.ts`。

同时修复了三个真实问题：

- `WorkflowSystemPlan` 不再对共享 `children` 原地 `.reverse()`。旧实现负对照失败，修复后通过。
- `desktop-task-entry.ts` 在返回内存缓存的发送回执前重新检查删除/存档权限。删除中的对话不能再得到误导性的旧成功回执，也不重新派发。新增 pending/complete 两项回归：旧实现 2 failed，修复后通过。
- Remote Host 不再保留 lifecycle 私有影子引用；创建、IPC 读取、失败清理和关闭统一使用共享状态。原 packaged host smoke 曾失败，修复后原命令通过；没有放宽配对或工作区权限。

测试维护没有删除验收行为：

- fixture 对齐真实 `list(cwd, cursor?)` 合同，增加 fixture TypeScript preflight。
- 原 UI 测试点击了第一个工具栏菜单，而非存档按钮所属菜单。改为精确定位所属 `details`；保留原生 pointer、`isTrusted`、命中与几何稳定断言。
- 原 32,318B 的 unified conversation smoke 按 driver/handoff 拆分；原场景与断言保留，修改后的每份 authored 文件均不超过 20,000B。
- 模板从独立弹窗变为嵌入面板后，焦点断言改为真实工作台 dialog + 选中 Templates tab + embedded 面板；关闭走“返回聊天”，没有删除焦点要求。
- `setup-scry-workspace.sh` 仅补回执行位，原 shell 测试不变。

## 2. 真实 App 冷读与截图

环境：macOS arm64；App `0.2.210`；Electron `42.10.1`；Recorder CLI `0.2.52`。使用独立 HOME/userData、合成临时工作区。五个 Provider 全禁用，Jev key 为空，`activeRuns=0`。

### 已验证

- completed 历史：生产 Main/preload/renderer 展示三个分类器与一个 agent attempt；代码与图双向选择、控制帧、Run/Plan/Manage/Templates 四个视图。第一轮原生交互记录 8 次 trusted click。
- 后续明确版本的 `0.2.210`、1000×880 App：真实低置信度 `0.55` 保持 `blocked`；agent 派发 0；blocked 节点 1；假 completed 节点 0；4 次 trusted click；无横向溢出。
- native 依赖准备后，以当时当前源码再次完成低置信度验收；并由生产 API 重新冷读 completed 根：3 classifiers、1 attempt、0 active runs。早期四视图截图与后续版本化低置信度验收分开保留，不把它们合成一次端到端运行。
- 37 份工作流 JSON 与 before hash 及原始档案一致；3 条原工作区 records 与 before hash 一致。6 份模板依赖逐字节等于原始档案。
- 模板依赖没有覆盖首次 UI 操作之前的独立元数据 hash manifest；这里只声明最终副本与原件一致，不倒推不存在的 before/after 证明。
- 三轮显式启动的隔离 App 均按 PID、命令、启动时间与 userData identity 校验关闭。没有要求重启或停止日常 App。

本次是历史冷读，**不证明当前版本的真实 Provider live stop、Qoder 工作流 authoring 或恢复接管**。此前 Qoder `dfmodel` 普通编码及独立测试 2/2、真实 Jev 类型与低置信度/no-replay 证据见[真实验收报告](qoder-jev-real-acceptance.md)，不重新调用模型覆盖历史 unknown。

### 可直接查看的截图

持久证据根：

`/Users/baobingjiang/.local/state/rotom/verification-evidence/workflow-v4-workspace-20261028.KG1wfM`

- [真实 bool 与 Run](file:///Users/baobingjiang/.local/state/rotom/verification-evidence/workflow-v4-workspace-20261028.KG1wfM/screenshots/01-run-real-bool.png)
- [图选择 → 源码](file:///Users/baobingjiang/.local/state/rotom/verification-evidence/workflow-v4-workspace-20261028.KG1wfM/screenshots/03-real-choice-graph-to-code.png)
- [源码选择 → 图](file:///Users/baobingjiang/.local/state/rotom/verification-evidence/workflow-v4-workspace-20261028.KG1wfM/screenshots/04-real-score-code-to-graph.png)
- [版本化低置信度证据](file:///Users/baobingjiang/.local/state/rotom/verification-evidence/workflow-v4-workspace-20261028.KG1wfM/screenshots/10-versioned-app-low-confidence-evidence.png)

## 3. 验证结果

日志均在上述持久目录的 `checks/`；性能 JSON 位于 `performance-deletion-fixed/`。Node 为 `24.18.0`。计时串行经过仓库 timing lock，不通过调整 timeout、skip 或 workload 放行。

| 检查 | 结果 | 证据 |
|---|---|---|
| renderer/结构/模板 focused | 6 suites / 17 tests passed | `focused-final.log` |
| 删除缓存及相邻合同 | 4 suites / 42 tests passed；旧代码两项负对照失败 | `task-deletion-fixed.log`、`task-deletion-negative.log` |
| Remote service focused | 7 passed | `remote-service-focused.log` |
| Node/Web 类型检查 | 通过 | `typecheck-deletion-fixed.log` |
| `npm run test:renderer:ui` | 完整原命令 exit 0，含 Credits、workflow、composer history、conversation IPC、Pi history | `renderer-targets-fixed.log` |
| `npm run test:shell` | 原测试通过 | `shell-final.log` |
| `npm run performance:measure -- --out …` | ratchet passed；5 repeats；49 项观测可测，无 worse | `performance-deletion-fixed-attempt2.log`、`measure.json` |
| `npm run pack:artifact` | 完整原命令 exit 0；含 native rebuild、产物检查、全部 packaged smoke | `artifact-final.log` |
| 最终源码/产物绑定 | 40 份实现/测试输入 hash 无差异，asar hash 一致 | `source-manifest.json`、`checks/final-source-verification.json` |
| diff 与大小 | `git diff --check` 通过；每份 authored 文件 ≤20,000B | 最终提交前检查 |

性能计数通过不表示 L2/L3 更快。三项 CPU instruction 指标仍 missing、非 gating，不能写成 0。首次误用 `--output` 的参数解析失败也保留；它没有产生一次性能测量。

### 完整 unit 门禁仍失败

- 较早一轮 full：4516 passed / 4 skipped，随后 shell 执行位失败；不能拿这个旧结果覆盖后续失败。
- 当前实现的原 `npm test`：**4514 passed / 4 failed / 4 skipped**。四项均触及原 5000ms 上限，位于 dynamic revisions、system revisions 与真实 system recovery controllers。
- 不改 workload 的 `--maxWorkers=1` 诊断：**4512 passed / 6 failed / 4 skipped**。其中五个超时，另一个 native counter 断言 `expected 2 to be 1`。串行没有解决问题；计数断言与前一超时的关系尚未证明，不把它忽略或改预期。
- 对应日志：`full-test-deletion-fixed.log`、`full-serial-diagnostic.log`。两次 timing receipt 都是 `highLoad:false`，所以不能继续把全部失败概括成“都是高 CPU 负载”。

首次 Credits native ABI 不匹配、composer 输入失败、错误菜单命中、旧模板弹窗假设及测试 listener/hover 问题均保留原日志。完整 renderer 最终通过，不擦除这些首次失败，也不把修改测试选择器说成产品功能修复。

## 4. 超时调查的新增结论

保留原[恢复/verification 调查](recovery-timeout-and-ui-gap.md)的控制进程与 native spawn 明细。

此次临时只读 FS 观测选中一个 legacy→System revision 用例，**没有扩大原 5 秒上限**：3384ms 通过；其余九项因 `-t` 未选中，不是一次全 suite 通过。该用例包含最终 native check，不能说是完全没有 native 工作。

- `writeFile`：191 次，累计约 1254ms。
- workflows 目录 sync：170 次，累计约 1052ms。
- lock 相关 sync：106 次，累计约 557ms。

这些是一次观测的累计操作时间，可能重叠；不能相加冒充精确关键路径，也不能推广成全量超时的唯一根因。日志：`profile-legacy-fixed.log`；最初 profiling import 配置失败亦保留。

只读 scout 另发现 system fixture 有一个未使用的额外规划/批准；但它不能解释其他 revision 路径。未通过删场景、缩 workload 或 warm-cache 刷绿。

曾试验同批 artifact 的目录同步合并：**保留 artifact 在 root 发布前的屏障，以及 root 自己的屏障**，而非把两者合成一次。新增顺序/失败注入检查可通过；相关关键 suites 仍有两个 5 秒失败。由于没有证明它解决门禁，本轮已完整撤回该生产改动及配套实验测试，`workflow-store.ts` 与 governing tests 回到原始源码。候选补丁与红/绿日志单独留在证据中，**没有随本次交付混入持久化优化或宣称超时根治**。

## 5. 交付状态与未完成项

- 本地提交本轮实现、回归与本报告；不 push、不升版本、不替换日常 App。
- `dist/mac-arm64/Scry.app` 是经检查的开发签名产物，不是 notarized 发布；本轮不安装。
- 证据目录仅保存 allowlist 的日志、截图、受控脚本、manifest 和检查结果，没有复制真实 HOME、凭据文件或整个 userData。原始工作区与记录保留供复盘。
- 仍未验证：Qoder authoring、生产 `restartEvidence` 接线、完整 billing/Jev 质量基准、跨 Provider 矩阵与业务仓库应用。`legacy_unset`、partial credits、历史 unknown 和此前 Recorder 失败不改写成成功。

下一步负责人：我。后续首先收敛原 5000ms 门禁的重复工作与运行/清理边界，保留真实 controller/check 数量、durability、counter 断言及首轮失败。未取得完整门禁证据前，不把本轮工作台交付扩称为全项目或安装完成。
