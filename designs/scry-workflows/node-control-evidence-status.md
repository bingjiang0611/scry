# 单节点停止与 Node 测试报告：有界证据

本页封存 M3/M4 两个子集的 pre-M5 检查点，不表示 M1–M6 完成。代码基于 `c9386b60` 后的工作区，尚未提交、推送或安装。后续 frame inspection、最近完整 unit 与新 App 版本证据见 [M5 有界证据](frame-inspection-status.md)；完整缺口见 [总台账](m1-m6-delivery.md)。

## 单节点停止

生产调用链仍为 typed preload → trusted IPC → WorkflowService → WorkflowRunner → Interpreter/effect adapter。`stopNode` 只接收 root、commandId 和 `{ kind: 'attempt' | 'system', id }`，不接收 PID、路径或 executable。

- main 从冻结预览重验工作区授权；目标必须属于该 root 已登记的实际 intent，不接受 renderer 猜测的逻辑节点名。
- 复用 `stopRequests`。没有 target 的旧收据仍表示整根停止；同一 commandId 不能改绑目标或控制模式。
- 同步锁住目标的后续派发，再等待持久化。只有持久化成功且 admission generation 仍匹配，才可调用该目标的已登记 stop hook。发布被阻塞或失败时不发信号，也不停止独立 sibling。
- ACK 只证明停止意图已记录。不证明 Provider 接受、业务结果已停止、进程退出或 scope 收口。槽位和副本 lease 仍由实际收口证据释放；unknown 不变成成功。
- 重传已接受的 commandId 不重发信号。冷启动只确认已有收据，不凭磁盘中的 PID 猜测或重发停止。
- 行上的 `stopRequested` 是只读投影。它不写入 canonical Agent outcome，也不充当第二份控制账本。界面在回复不明时保留原 commandId；只有明确的“再次请求停止”操作才生成新命令。

这是**已登记的单次 Agent attempt / SystemStep**控制。尚未实现 queued 逻辑节点、整个 stage、`fail_fast`、stall 策略或通用 restart。当前视图仍使用已有有界快照（Agent 最近 32 行、SystemStep 最近 64 行），不是完整实例图或历史节点检查器。

## Node 原生测试报告

`parser: 'node_test'` 的 argv 仅允许：

```text
[nodeExecutable, '--test', '--test-reporter=tap', ...explicitTestFiles]
```

至少一个显式普通文件；不接受额外 flags、glob、目录、inline JS、重复 canonical 文件或逃出 owned root 的符号链接。保留 argv 总长度 64 的原上限。main 按顺序冻结文件路径和 SHA，绑定实际工作副本，执行前重验。可执行文件名称校验及完整字节 SHA 不等于更强的 binary attestation。

`WorkflowTestEvidence` 进入 canonical immutable native value 和 schema，不只放在 summary：

- 仅解析未截断 stdout 的完整 Node TAP 报告；验证 header、最终 root plan、唯一且有序的 counters，以及安全整数和计数总和。不从 stderr 或任意子串提取成功。
- available 的来源为 `node_test_tap`，计数为 `total / suites / passed / failed / cancelled / skipped / todo`。root plan 的数量不必等于 test 总数。
- 这些是 **runner-reported counts**，不是独立发现分母、实际 body 执行或覆盖率。Node 对空文件或提前 `process.exit(0)` 也可能报告一个通过项。因此 discovery、execution、coverage 分别明确为 unavailable，并保留原因；comparison.progress 仍 unavailable。
- 对已收口、exit 0 且未截断的命令，缺失报告、total 为 0 或存在 skip/todo/cancelled 不伪装为完整通过，标记 `incomplete`。非零退出、超时、取消、unknown、截断和诊断错误保留原有更强状态。
- verification 从 immutable stdout 重新解析，再与 immutable value / main receipt 核对。仅重写 counts、伪造绿色 state 或重新计算 JSON hash 不能替代原始证据。

这不是完整的测试发现、执行覆盖率或六质量程序验收。当前生产表格新增“不完整”状态；完整证据检查器、图及 Recorder/SQLite 联动仍待 M5。

## 已执行的检查及范围

日志根：`/tmp/scry-workflow-template-editor.ZnkC6L/`。

| 检查 | 实际结果 | 范围与证据 |
| --- | --- | --- |
| M3 focused、Node/web types | 10 文件 / 107 测试通过 | `m3-node-stop-rejected-cache-focused.log`；包括调用方目标拷贝和停止收据错误缓存回归 |
| M4 原有完整 focused 工作量、Node/web types | 7 文件 / 76 测试通过 | `m4-node-tests-lower-load.log`；原有期限不变，仅新四文件 fixture 使用先前明确批准的 4 秒命令期限，外层仍为 5 秒 |
| 隔离 Renderer 的真实 Chromium 输入 | 通过 | `m3-node-stop-ui-and-native-app.log`；焦点、重复点击、丢失回复后重挂、同命令重传、明确 stop-again、430px overflow；是显式 UI fixture，不单独证明 main 权限 |
| 完整隔离 App 的三条生产链 | 当前构建通过 | `m3-m4-stop-cache-app.log`；含边界/错误缓存修复和冷启动先错目标后合法收据的生产 IPC 回归，见下文 |
| 默认全量 unit | 4049 通过 / 1 失败 / 4 opt-in 跳过 | `m3-m4-all-unit.log`；原 legacy 三修订用例 5000 ms 超时，整体未通过，不归为无关失败 |
| 四组关键负控 | 旧实现均失败 | outcome 污染、提前 fence、可变调用方目标、错误缓存毒化；见同目录 `m3-node-stop-{outcome,early-fence,target-copy,rejected-cache}-negative.log` |

调用方目标拷贝回归已证明旧代码可能将停止改发给 sibling。修复将目标校验/拷贝移到 Service 首次 await 之前；修复后 focused/types 和新构建重放均通过。其首次检查被其他工作树持有的全局 timing 锁拒绝（exit 75），没有运行检查，也没有绕锁；锁释放后才执行。锁拒绝原文另有带来源标注的工具输出转录，原单行 tee 被后续成功日志覆盖，不将转录伪称为原始日志。

停止收据另有一处错误缓存缺陷：发布已落盘但回复丢失时，warm replay 被缓存的 rejected promise 永久挡住；冷启动先发送错目标，也会毒化随后正确的收据核对。仅对 stop cache 增加窄范围 rejected-entry 清理，错误仍抛出；accepted entry 和其它命令 cache 不变。内核仍核对同目标的 durable receipt；未确认的内存候选不回滚、不重新发布或发信号。增强的失败 publisher 回归证明同命令两次拒绝仍只有一次写入尝试、零信号。

### 完整隔离 App 实际证明了什么

入口为 `npm run test:workflow:app`，由 `test:workflow:ui` 接入现有 macOS renderer gate。它不取代原隔离 UI 工作量，不安装或操作日常 App。

1. **Agent 单目标停止**：现有离线 adapter 的两个独立调用中，仅目标 stopped + settled，sibling completed + settled；预算仍为 2、segment 仍为 1。通过 canonical 记录检查没有 outcome 元数据污染。冷重传不再派发。没有真实账号、SDK 或实际模型质量验收。
2. **真实本机 Node 进程停止**：owned copy 内的合成脚本持有文件 watcher；ready marker 证明进程已启动。可信点击后实际 SIGKILL，canonical check 为 cancelled，scope 收口，目标 PID 的 signal-0 返回 ESRCH，stdout artifact hash 相符。源目录没有执行 marker、源 SHA 不变。Agent attempts 为 0；冷启动不重发或重启。该 PID 证据不扩大为任意逃逸后代或安全沙箱保证。
3. **真实 Node TAP**：两个冻结的显式文件中，一个 body 实际执行一次，一个 skip body 没有执行；runner 报告 `2 / 0 / 1 / 0 / 0 / 1 / 0`，exit 0 仍呈现 incomplete。immutable value、main snapshot 和原始 stdout 相符。冷重传不重跑。该合成 body marker 只证明此 fixture，不把一般 execution/discovery/coverage 改成 available。

最新通过的原始现场为系统临时目录 `scry-workflow-node-stop-app-T0GqXv`。其中保留 synthetic userData/workspace、canonical records、截图、offline-provider 声明、13 个桌面构建 artifact 的 SHA 和两个 session 的登记进程收口证据。main artifact SHA 为 `acac97f8bed3f073267a072e10b88b844db81d5b0a8b43aaa1f3ec7cfda80710`。登记进程闭合不是整台机器或远端副作用审计。

### 保留首次失败，不以重跑擦除

- 最初两次 App 搭建在 workflow start 前失败：缺 root return；以及不具备 independent session。最初遗漏完整 smoke guard，不能声称这两次启动已证明全链路离线；可能发生本地能力探测。它们的登记进程已收口，日志及现场保留。
- 后续 harness 仅传环境白名单、完整 smoke guard、隔离 HOME，且在任何 Workflow effect 前断言唯一 descriptor 的 transport 为 `packaged smoke fixture`。正向场景不继承账号凭据，也不借真实模型调用证明功能。
- 早期 focused 超时、未正确等待业务边界的断言、旧 FileStore 腐败夹具在更早的写入拒绝处失败，以及 native Return 缺少 char event 的输入失败均保留。修正夹具的顺序/真实输入或增强写入拒绝，不删除冷读取拒绝、容量或权限断言。
- 最后一次 App 重建重放先暴露了夹具读取竞态：live SystemStep 已存在，但对应 canonical intent 尚未发布，直接读取得到 undefined。修正为分别等待实际持久化 intent 和进程 marker，没有延长期限或减小工作量。`m3-m4-copied-target-app.log` 保留首败；该现场登记 App 已闭合，未找到该 fixture 的 ready marker 或存活匹配命令后，才运行修改后的新隔离场景。
- M4 的原 5 秒失败记录仍保留。一次较低负载下通过不证明任意负载稳定；最近多次运行 highLoad，毫秒结果不作性能结论。`providers.catalog` 仍缺匹配 counter collector，记 unavailable，不报告 0 或 pass。

## 尚待完成

默认全量 unit 的 legacy 三修订 5000 ms 失败仍未关闭。最后一次已授权画像在原完整用例和原期限下通过，记录了 189 次 atomic publication、180 次 directory sync、两次完整 executable 读取；单用例通过不替代全量通过，也未证实首次超时的唯一根因。见 [分阶段诊断](../../docs/performance-experiments/20261025-workflow-legacy-stage-profile.md)。第三轮实验额度现为 0，不擅自增加性能实验或放宽期限。

父任务按既有“先实现其它功能”的选择继续本地证据封存及 M2 入口/路由、M3 其他控制、M4 全部质量程序与独立写授权、M5 图/输出/Recorder、M6 真实账号/SDK/费用和历史 CLI/release gates；当前不把失败检查后的子集作为完整交付或提交依据。未进行的真实调用必须先满足所缺授权和可靠费用上界；本页不补授权，不把离线 adapter 当作真实 SDK。
