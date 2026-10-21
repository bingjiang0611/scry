# M1 进展：工作流停止命令收据

本轮是在 M0 之后推进 M1 的一个交付块，不代表 M1–M6 或完整 Workflow 功能已完成。用户明确先不处理此前整仓七项门禁失败；本轮没有重跑整仓门禁、放宽期限或修改那些路径。

## 已接通

- App 的 `workflow.stop(workflowId, commandId)` 先同步阻止新派发，再持久化停止意图，成功后才调用既有 canonical 停止链。IPC 校验两个身份，旧的无 commandId 请求拒绝，不隐式生成新命令掩盖重复投递。
- 同一 commandId 并发重投共用收据；缓存逐出和 App 重开后仍读持久收据，不重复发送可能已执行的信号。用户再次点击生成新的 commandId，沿用原 run 身份校验、优雅停止窗口及安全升级，不退款、不替换 Provider。
- `true` 仅确认停止意图已经持久化，不证明 Provider 接受、信号成功或进程停止。没有安全存活句柄时，新命令返回 false，UI 显示不可控制；已有收据仍可只读重放。
- 保存失败时不发信号，也不继续后续 Agent；未收敛继续占槽位。失败的内存候选不能在命令缓存逐出后变成“已持久化”的假 ACK。即使看到旧内存意图，也要核对磁盘记录，缺失则报未确认错误，不重发。
- 初始化期间停止会立即阻断派发，但等待初始执行记录检查/保存结束后再写停止意图，避免执行把自己刚保存的记录当成旧运行而拒绝。初始化失败不产生 Provider 调用或停止信号。
- 每根最多 **256 个停止请求**，不驱逐旧身份来允许重放；达到上限拒绝新的请求。若真实操作需要更多，先改为分页的独立控制日志并保留全部去重身份，再考虑提高上限，不清空旧收据或未知容量。
- UI 以“已请求停止，等待收敛”和“再次停止”区分请求与终态；历史 unknown 不被提升成 stopped。所有新增用户文案集中在现有 copy 模块。

## 实际验证

证据目录 `/tmp/scry-m1-stop.7jb82s/`。没有真实模型、账号费用探针、安装、push 或用户 App 重启。完整 App 验证仍使用原先获准的固定离线 Pi 脚本和原临时项目，四角色显式绑定同一 profile/model/full_access。

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| 原实现负对照 | 相同停止命令立即发两次信号，新增检查失败 | `before.log` |
| 自审补充负对照 | 保存失败、缓存逐出后，旧候选错误返回 true；检查先红，修正后绿 | `eviction-before.log`、`workflow-reviewed.log` |
| Workflow + canonical stop 生命周期 | **10 文件 / 86 passed**，新增 10 项，覆盖持久化先于信号、重复/明确再次停止、失败不派发、真实 FileWorkflowStore 重开、缓存逐出、初始化竞态、256 上限和损坏日志拒绝 | `workflow-reviewed.log` |
| Node/web typecheck | 通过 | `typecheck-reviewed.log` |
| 隔离 UI 原生输入 fixture | 通过；两次明确点击产生两个不同 commandId，等待收敛/未知显示、焦点和重挂不重跑均保留；隐藏窗口、假 bridge，不冒充完整 App | `ui-final.log`、`current-wide.png`、`current-narrow.png` |
| 最终 App 构建、产物与安全 smoke | 构建/产物校验及前四项 smoke 已完成；进程随后被中断，剩余 desktop-remote smoke 单独补完，不把中断称为整条命令成功 | `pack-reviewed.log`、`desktop-remote-final.log` |
| trace.delivery 计数门禁 | 5 次均 2 messages / 165996 bytes；highLoad=true，无毫秒提速结论。该计数不测停止延迟；停止前新增一次必要日志写入 | `performance/measure.json`、`performance.log` |

首次 UI 扩展在 remount 后仅等旧 DOM 存在，过早读取导致失败；改等具体“未知”状态提交，没有延长上限或削弱原断言。保留 `ui.log`。首次 App 重开观察过早连接 CDP，ECONNREFUSED；根据登记 PID/启动日志确认同一 App 已启动，只重连该实例，不重启或重发 workflow。保留 `reopen.log` 与 `reopen-final.log`。

## 完整 App 的逐包范围

1. 本轮首包 asar **`2bd68592dd745243fe6d4e60fb778b343cf5d9256e483ee652bec2eafc4d1cc8`**，快照 `app.asar`：通过真实生产 App/preload/trusted IPC/Pi adapter 完成一次规划、批准执行、观察输出后停止。新 workflow `workflow-5a10645346ac27bcc128bfb5f569ed2038ae6cc8f5cbc9fd0090dfec795a9225` 为 stopped、1 attempt、settled、slots 0。实际按钮保存一个停止收据；相同 ID 经生产 IPC 再投两次，原生 abort 仍只有 **1**。非法身份被拒绝，新 ID 控制已收敛 scope 返回 false。
2. 首包重开后冷收据再投返回 true、原生 abort 仍 1、总 model prompts 仍 **14**，五个历史 workflow 只观察恢复。原十二条记录哈希和旧真实现场十六个源文件哈希未改，未清除旧 2 unknown / 1 pending。见 `case.json`、`reopen-result.json`、`reopen-final.log`。
3. 随后修正缓存逐出后的假 ACK 边界。**最终包** asar **`09ba1782934f99336c43589c63e1d1abc2e7f4b79c69d0e8d92e20f07182c60e`**，快照 `app-reviewed.asar`：补验生产 IPC 冷收据、无句柄拒绝；14 prompts、原生 abort 1 均不增加，检查期间十四条 canonical records 哈希不变。最终包没有另开新模型任务；缓存逐出异常路径由上表先红后绿回归证明，不借首包正常停止宣称该异常分支已做真实模型验收。见 `final-scope.json`、`final-app-result.json`。
4. 当前生产源码 SHA-256 与对应包的 scope 文件绑定。App 仍为 0.2.210、私有 CLI 0.2.49，没有安装。原 `dist` 是可变构建目录，先前 M0 离线 asar 13017… 已不在该原路径，不能拿现在的文件校验旧包；本轮两份 asar 快照单独保留。

自有完整 App PID 13681、25157、65458 已按 executable、userData 和出生时间重验后关闭，关闭前 scope 已收敛。没有对用户 App 发送停止或启动命令。

## 尚未完成与下一段

- 此处只覆盖用户通过 Workflow API 发出的停止命令。**内部退出/错误清理仍沿用原 best-effort stopAll**；“真正安全退出：停止意图持久化并等待全 scope 收敛”尚未完成，不能从本节推断它已有保证。
- 原生控制的详细 accepted/unavailable/unknown 反馈仍由既有 run-control 链表达；本次 boolean 不是逐 Provider 停止成功证明。
- 下一段由维护 Agent 实现 M1 **可信等待阶段观测**：从原生 tool 生命周期与真实 permission promise 取证、隔离 run/attempt、保留重叠工具状态；不能从沉默、turn start、retry intent 或快照文本推断模型/配额等待。
- 当前五 Provider 都没有已证明完整的“模型等待＋工具/权限/配额排除”合同；自动停滞 watchdog 与自动重启继续 unavailable，不因新增部分阶段观测而开启。其后再推进 M2 程序/模板和 M3 持久解释器，不把本轮叫完整功能交付。
