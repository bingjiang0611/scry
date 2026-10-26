# 2026-10-26：恢复完整远程 UI 验收

## 结果与范围

用户明确选择独立维护超时夹具，而不是扩大持久化同步协议。实现提交`b9ff9cc2`：**完整`npm run test:renderer:ui`一次执行退出0**，不再将分段补跑当成完整通过。本轮是测试组织修复，不是App性能优化。

验证组合`976331dc79570df0aa3559d6c4ddf887dc943458`包含既有CLI修复`5bb630e1`。344个unit文件共4008通过、4项既有opt-in跳过；该全量采用文件串行，未增加任何用例超时。裸性能分支没有吸收CLI修复，不能把组合结果写成裸分支全绿。

原始计数、命令、源码hash、失败与负对照见[证据JSON](20261026-ui-acceptance-evidence.json)。源码、Git提交及试验资源仍在独立工作树中；未合入原开发工作区、未push、未安装、未重启用户App。

## 根因与实现

原`scripts/desktop-remote-ui-smoke.mjs`为145,903 bytes，既超过完整文件20KB提交门禁，也把活动、工作区、运行、主机设置串在同一55秒生命周期里。此前基线诊断到53.57秒才开始最后一组断线/重连检查，后续断言尚未执行就遇到总截止。正文读取并发等产品逻辑不是这个问题的修复点。

现在默认入口顺序执行四个职责，每个使用全新Electron进程、临时HOME/userData和fixture状态：

| 场景 | 保留的主要行为 |
|---|---|
| `activity` | 远端开始/结束、轮询失败、历史保留、断线/重连、完成未读、项目排序与折叠 |
| `workbench` | 正常分栏、文件/目录分页、readonly/旧宿主边界、resize/最大化、会话独立面板、轮次导航 |
| `runtime` | 目录显式授权、位置/Provider/profile/model、提交与回执、停止/回答、失败证据、原生session采用与重连 |
| `hosts` | 本机返回、新会话、入站授权与出站连接分开、SSH编辑取消/失败/双Enter、显式重连、renderer重载 |

- 每个独立场景仍是**55秒**；visibility baseline原来的75秒不变；条件等待仍是7秒。完整套件可以合计运行更久，这是已授权的组织变化，不是偷偷扩大单场景截止。
- 默认入口不漏场景，任一失败会停止整个命令并返回非零。新增`--scenario=activity|workbench|runtime|hosts`供focused定位；原有focused/测量/负对照参数保留。
- 原生输入驱动、各业务场景成为正常`.mjs`函数，使用已有esbuild生成临时Node CJS入口；没有`AsyncFunction`、eval拼接或文字碎片注册表。
- renderer fixture按imports、状态、完整transport对象、App桥接/界面生成分开。生成的TSX在11组原有参数配置下与旧实现逐字节相同。
- sandbox/contextIsolation/nodeIntegration、CSP、只允许file请求、原生命中检查、截图以及`stopOwnedApp`清理路径保持。
- 未改`src/`、package、lockfile或性能台账；没有新增依赖。全部28个实现/测试文件小于20KB，正常提交hook通过。

## 不靠删断言获得通过

冻结旧脚本及AST清单后，逐条比较调用表达式：

- 原191个`check`与255个`wait`全部保留。
- 唯一原断言表达式调整：主机地址编辑不能启动Provider，改为比较**本场景开始前的提交数**，而不是依赖运行场景已提交3次。主机管理场景现在从0开始，仍不允许新增提交或本机执行。
- 新增一个等待，确认独立场景的已归档轮次确实经真实renderer/fixture transport加载，不只等待远程壳出现。
- 原来活动场景会留下`hostRunArchived`；现在工作区/运行/主机设置显式准备这个已归档历史前置条件。活动场景自身仍完整验证开始、结束、再读历史的状态转换。
- 原来运行场景会授权第三个项目；主机设置场景通过fixture桥接准备同一项目。目录浏览不授权、取消、失败、重复确认及不隐式发送仍由运行场景原生操作验证。**不提前设置catalogRevision**，最后的重连仍须将旧目录更新为v2。

新增18个unit用例覆盖默认四场景、11个原focused参数、错误场景名拒绝，以及拆分后不能引用旧函数隐藏变量。该绑定检查在内存故意移除`check`绑定时确实失败。

## 负对照

12个生产bundle内变异均被业务/原生命中检查拒绝，另有visibility正对照通过。生产源码始终未被修改。

| 变异 | 最终拒绝证据 |
|---|---|
| 暴露远程后台任务停止 | `Remote background task exposed a task-stop control` |
| 新会话改走本机路由 | 提前命中`New remote draft queried history before a session existed` |
| 编辑SSH后自动连接 | `Address edit automatically reconnected` |
| hover菜单改成自动高度 | 原生命中落在错误按钮，`Native pointer missed [data-machine-id="local"]` |
| 禁止及时刷新活动 | 等不到后台远程spinner |
| 远程文件改用本机API | 等不到远程文件预览 |
| Meta Prompt改成本机目标 | 无法返回原远程会话 |
| 设置入口改成外观页 | 无法直接打开远程设置 |
| 命令标题去掉宿主 | `Remote command heading did not identify its host` |
| 历史命令也打开补全 | `History recall opened slash completion instead of history navigation` |
| 忽略Provider元数据revision | 同上下文元数据变化未重读controls |
| 隐藏/显示不撤销旧确认 | `Resume must withdraw stale online/activity confirmation` |

两项slash变异的旧目标仍指向`ChatView.tsx`，实际逻辑已移到`chat-view/Composer.tsx`。第一轮只是“target not found”，不能算业务敏感性通过；本次修正目标后，分别得到上表的实际业务失败。machine/hover则比预期的较后断言更早触发对应保护，初始文本匹配失败也保留在JSON中，没有删改产品断言来迎合日志。

## 验证与首轮失败

环境：mac2，macOS arm64、M1 8核、Node24.18.0、Electron42.10.1。所有GUI使用隔离数据及受控Provider，不调用真实付费Provider或真实手机。

| 检查 | 结果与范围 |
|---|---|
| 完整UI | 原package中27条命令一次退出0，含默认四场景、Credits、当前production App临时Git、真实IPC与Pi历史；559,692ms，highLoad=true，不作性能结论 |
| 当前完整unit | 文件串行，344文件、4008通过、4原有跳过、0失败；790,969ms，highLoad=true，不作性能结论 |
| 本机focused | 新夹具18 + 原文件大小/真实hook集成10，共28通过 |
| 类型 | `npm run typecheck`通过 |
| 构建/真实App | 完整UI命令内执行当前App构建、临时Git交互及生产conversation ownership/unified IPC；退出0 |
| 断言/生成内容 | 全部原调用表达式保留，仅上述场景提交数调整；额外1个前置等待；11种TSX生成输出与原文相同 |
| 当前版本一致性 | mac2测试前的28个源码hash与本地提交相同；清理自有dirty副本并切换已提交组合后再次全部匹配 |

失败没有被最终通过覆盖：

1. 子任务第一次只分割文字碎片，未接受。第二次生成正常模块时因连接错误退出；确认writer及登记资源关闭后由parent接管。修复了3处语法问题及遗漏的参数绑定；正式验证前全部修正。
2. 新工作区独立场景最初缺少原活动阶段留下的归档轮次，原生pointer无法命中轮次按钮。补显式前置数据及其到达等待后通过，没有改geometry检查。
3. 主机独立场景缺少第三个已授权项目，原“3项目”断言失败。一次误判成catalog版本，仍然失败；随后读取真实条件并补正确前置项目，撤回无依据的catalog预置，原断言通过。
4. 第一次完整UI在未修改的session-capability夹具处失败：子进程退出0但没有结果，外层正确拒绝。负载14.65→23.12/8核。未改该文件/CSP/30秒watchdog；后续完整命令退出0。不能把exit0单独当作业务完成，也不以CSP警告猜测根因。
5. 第一次默认并行完整unit：4007通过、1失败、4跳过。未改动的真实Git hook集成用例6.484s，JSON只有`STACK_TRACE_ERROR`，对应Vitest `withTimeout`保存栈，默认测试上限5秒；负载12.53→39.46。没有扩大期限。该文件和新测试在本机focused28通过；改用文件串行执行同一全量后4008通过。默认并行模式的高负载波动仍应保留，不宣称正常CI从此无偶发风险。

## 命令与身份

```sh
npm run test:unit -- scripts/check-staged-file-size.test.ts scripts/desktop-remote-ui-smoke.test.ts
npm run typecheck
node .agents/skills/scry-performance-climb/scripts/timing-run.mjs mac2-ui-maintenance-full-final -- npm run test:renderer:ui
node .agents/skills/scry-performance-climb/scripts/timing-run.mjs mac2-ui-unit-two-workers -- npm run test:unit -- --maxWorkers=2 --no-file-parallelism --reporter=json --outputFile=../logs/ui-maintenance/unit-two-workers.json
node scripts/desktop-remote-ui-smoke.mjs --scenario=workbench
node scripts/desktop-remote-ui-smoke.mjs --session-parity-only --negative-slash-control
```

`--maxWorkers=2`是上限；`--no-file-parallelism`使文件串行，不能将该次运行说成两个文件并行。没有修改仓库CI默认配置。

组合构建仍为App0.2.221，build `d42af910ace0c33cfdcc96a6f9392c23780416e4f5e587e393554eee0285a6a2`。与上一轮相同，因为本次没有产品源码改动；产物没有安装。更早的日常App观测不作为本次验收版本。

本地结果：`/private/tmp/scry-performance-climb-20261025.yjlnNW/results/mac2-ui-maintenance-20261026/`；mac2：独立实验根的`logs/ui-maintenance/`。保留失败日志、变异日志、源码/AST清单、bundle、测试报告和失败fixture。已将测试dirty副本转换为hash一致的提交；独立node_modules符号链接仍保留，不提交。Electron ABI146已恢复。

## 下一步与边界

本次已关闭完整UI综合夹具阻塞。合入原开发分支、推送、安装与L3仍未授权/执行；只做了独立验证分支的组合提交。若选择交付集成，由agent先核对当前开发分支及并行WIP，再重新验证集成结果。若选择继续持久化大收益，仍需用户单独允许批量目录同步协议实验；不能因UI通过而默认减sync。

本轮未单独重跑60秒visibility计数baseline，也没有做真实Provider/跨平台或日常L3；保留测量模式的代码/生成输出不等于已验证这些运行结果。
