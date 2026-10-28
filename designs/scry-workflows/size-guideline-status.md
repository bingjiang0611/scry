# M2：规模偏好与冻结规划快照子集

这是 M2 的有界功能 checkpoint，不是 M2 或 M1–M6 完成交付。合同见 [入口语义](chat-entry-semantics.md)。未实现统一 TaskSubmission、off/manual/auto 路由、size CLI 命令或 tools-disabled authoring。

## 实现

- `src/shared/workflow-size.ts` 定义 unrestricted / small / medium / large。small 建议少于 5、medium 少于 10、large 少于 50 个逻辑 Agent 调用；medium 为缺省。建议包括执行、审查和汇总，不包括规划、路由、Jev 和宿主控制。它不是数量硬门禁；明确的当前用户要求可覆盖，不能裁剪用户要求的 20 个 reviewer。原有 1000 attempts、4096 batch 等硬限制保持。
- `workflow-size-guideline.ts` 与 FileWorkflowStore 使用同一 App-owned `workflows/preferences.json`；固定 `settings.json` 优先。区分缺省 medium 与显式 medium。文件覆盖时只读，拒绝设置和重置；移除覆盖后恢复原偏好。未知共享偏好键保留。不允许 renderer 提供路径。
- 缺失目录、文件或键表示未配置；非法枚举、null、错误 JSON、读取失败和非 owned 符号链接不能回退为缺省。实际读取上限为 64 KiB。更新先序列化并验证同一上限，再使用既有 atomicText 发布；超限不替换原文件。
- `WorkflowServicePlanning` 在排队前冻结有效值、来源、配置原始字节 fingerprint 和原始 goal。一个规划只调用一次现有 planner。App runtime 将冻结值交给真实的 `workflowPlanningPrompt` 构造路径；unrestricted 不追加数量建议。固定模板没有新增规划调用。
- Planning intent、preview、progress 与历史保留冻结元数据和可选 model override reason。恢复与修订继承原事实；legacy 记录保持 unrecorded，不用今天的全局设置补写。不得重写已记录的快照。
- 两个 typed preload/main API 通过现有 trusted wrapper 读取、设置全局 App 偏好。实际 sender/frame/navigation 拒绝测试沿用生产 wrapper；没有新增任意文件或命令 IPC。channel 已分类到既有 catalogue。
- `WorkflowSizePreference.tsx` 显示当前来源、刷新时间、可编辑选择或文件只读状态；错误时清除旧快照并阻止生成。preview/progress 显示实际记录值。文案集中在现有 copy 模块。没有为设置另开 Provider 调用、调度器或全局 singleton。

## 验证与边界

日志根：`/tmp/scry-workflow-template-editor.ZnkC6L/`。所有 App 场景使用独立 userData 和临时合成 workspace，无真实账号调用。

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| 最后源码的类型与 focused | Node/web 通过；5 文件 64 测试通过，包括 19 个规模测试、实际 App builder、存储和 trusted IPC | `m2-size-write-bound-reviewed.log` |
| 排队冻结负控 | 临时改成排队后重读设置，原断言捕获 small 被换成 large；已恢复，正常测试通过 | `m2-size-late-read-negative.log`、上行正控 |
| 文件边界负控 | 原实现超限更新已抛错，却先替换了可读共享文件；新断言证明旧实现失败。修复后拒绝写入且字节不变 | `m2-size-bound-write-original.log`、上行正控 |
| 真实配置与冷读 | 实际 FileStore、main/preload/renderer 原生选择 small，文件覆盖 large 只读且 setter/reset 拒绝；null 文件错误不回退，移除覆盖恢复相同 fingerprint | `m2-size-write-bound-reviewed.log`、场景 verification.json |
| 不影响既有执行 | 设置前后 offline actor 输入均 4；68 个原 workflow/frames/value 等 JSON 文件字节不变；冷读偏好一致 | 同上 |
| 模型请求组合 | 四档各一次调用实际 App runtime builder，捕获 startAppRun 请求的原始 goal、软建议与 20 个未裁剪调用；底层 Provider 执行被禁止 | `m2-size-production-bridge-workspace.log`、最后 focused |
| 原生 UI | 当前设置、重挂载恢复、文件只读、焦点与冻结预览通过隔离 Electron fixture；宽屏及 430px 桌面窄窗截图已检查，detector 无条目 | `m2-size-current-app-counter.log`、`m2-size-ui-detector.json` |
| 原 workload 计数 | collector 8 测试通过；5 样本 parent publications 均 3，ratchet 通过 | `m2-size-final-counter.log`、`m2-size-final-counters/measure.json` |

最后 production App 场景：`/var/folders/14/517c2bss5sx11zd24qqq5lgc0000gp/T/scry-workflow-node-stop-app-FMhd3s`。main SHA-256 `0bbbfb25b10d0cf872ed4e53cfe0e0d6e2552e715dbf04bcdec536393985b9a5`；preload `84f4e880cdc754535dc69474763d829c873cbd8fc4aadea8fab0d9876be8c27f`。原单节点停止、native SIGKILL、两文件 TAP、frame inspector、自动策略与冷启动不重派场景仍通过。三次登记资源 closure 各 tracked=4；不据此保证 escaped descendants 或远程 effect 已收敛。

App 偏好场景没有生成或发送规划。builder 单测将模型 terminal 替换为本地 fixture；它证明生产参数组合，不证明真实 SDK、工具禁用或付费端到端规划。窄窗是桌面布局检查，不是手机验收；没有完整可访问性或量化对比度结论。计数不是毫秒或日常提速声明。

## 保留的失败，不刷绿

- 较早 `m2-size-first-focused.log` 在 Node 类型检查阶段达到 180 秒外层期限；未取得类型结果，原因未知。后续确认 owner 已退出，沿用 timing runner 的 dead-owner 处理，没有手动删除活跃锁。
- 新测试曾遗漏 Pi profile、混用 renderer cwd 与 Service workspace、使用同步拒绝断言、留下未使用参数及引用错误的 fixture helper。修正测试合同或复用原 harness；保留首次日志，不修改业务断言与原 deadline。
- 元数据回归曾暴露全新 userData 目录读取失败和内部 revision 预览缺少历史元数据。已修复 lazy 目录读取及 canonical 继承；`m2-size-cold-root-regressions.log` 5 文件 49 测试通过。
- 原生 UI fixture 的连续 Unicode typeahead 及角色选择曾失败。最终使用独立挂载场景和实际状态等待，保留原断言，不增加 sleep 或 timeout；未证明早期平台输入问题的具体根因。
- 首次 App fixture 误点 footer 最后一个禁用的 Generate，关闭等待超时；修正为实际 Cancel 后通过，未新增规划或真实 Provider 调用。保留 `m2-size-first-production-app.log`。
- 扩大 focused 候选共选择 73 文件。首命令在 240 秒外层期限中止，已报告的 12 文件有 150 通过、2 失败。仅补跑未报告的 61 文件，31/30 两组分别 217/267 通过。合计 634 通过、2 失败，不是全绿，也不是默认完整单测。失败为 `workflow-system-recovery-process.test.ts` 的两个原有 5000ms 场景；本次没有重跑它们或扩大期限，尚不能判定与 M2 是否相关。保存 `m2-size-current-focused-fixed.log`、`m2-size-remaining-A.log`、`m2-size-remaining-B.log` 及两个 recovery diagnostic；登记 controller 已退出并 close，result 文件为空。
- 上述扩大范围发生于最后文件写入上限修复之前；之后只重验受影响的 64 测试和 App，不冒充最新完整范围通过。更早默认 full 的 4068 通过、1 个 SystemStep 5000ms 失败、4 跳过也仍开放。

## 后续责任

父会话继续 M2 main-owned TaskSubmission、typed commands、入口路由及真实 authoring capability，并完成 `index.ts` 的职责拆分。当前 index 仍超过 20000-byte authored blob 上限，不能把本 checkpoint 当 staging-ready。两个恢复超时、旧默认 full 失败、其余 M1–M6 与完整发布门禁需要独立关闭；不得用负载猜测、focused 通过或安装代替证据。

没有 commit、push、安装、版本更新或日常 App 重启。没有新增性能实验、profiler、workload 或 ratchet 修改。冻结证据位置另存于本次 checkpoint manifest；旧 archives 不修改。
