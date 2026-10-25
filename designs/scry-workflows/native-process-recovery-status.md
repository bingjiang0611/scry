# Native 同根修订：独立 OS 控制器验收

本增量基于 `69b5a55a2c324783f20673d843a685c9096289d0`，只增加测试、fixture 与本记录，不修改 App 运行代码。它不闭合完整 M3 或 M1–M6。

## 实际路径与断言

- 使用真实临时 FileStore、临时源码目录和独立 Node 控制器进程。父进程通过 IPC 登记并等待 controller `close`；不按模糊进程名停止，不操作日常 App。
- 本地固定 CLI 代替账号/SDK transport，其余走 compiler → Service → Runner → Interpreter → main SystemHost。CLI 协议明确报告 `local-cli-fixture` 模型，不把缺失模型证据当作可复用。
- 初始修订先完成独立调用。第二个同根修订复用它，真实物化 owned copy、运行 Node check，再在冻结 branch 的 terminal sequence 内执行 scoped Agent。CLI 真正使用 Service 提供的 workspace；普通调用在临时源码目录，scoped 调用在 main 验证的副本目录。
- check 只在副本写计数，源码目录不写；Native 系统帧引用 main canonical 结果。scoped 子帧结果已持久，但终端父帧仍为 entered、cursor 0、无 child-link/resultRef 时，控制器在联合 checkpoint 前直接 exit(73)。这不是 graceful shutdown。
- 新 OS 控制器经 Service.resume 恢复同一 Root：保留 start/revision/continue 三个 segment、两个 governing revision、两个 Agent attempt、两个 Native intent/outcome，原账与原帧不改写。branch 选择/decision hash、子结果和父完成帧一致，CLI 和 check 均不重复执行。
- 另一完整相同工作量场景，在两控制器之间给 canonical 物化结果追加一个空格。JSON 语义不变但内容 hash 不符，冷控制器必须报告 digest 错误；不新增 Agent/Native 调用，不继续产出成功报告。

## macOS 测试隔离

原有 `(allow default)(deny network*)` profile 不能执行系统 setuid `/bin/ps`。最小对照证明 detached Node 可启动，但 `/bin/ps` 在该 profile 中为 `spawn EPERM`、在 profile 外可以只读查询自己的启动时间。实际 check 已运行时，main 仍诚实保留 group closure unknown，不能把 controller 退出当作系统作用域闭合。

维护者本次明确允许仅对固定 `/bin/ps` 使用测试 profile 的 `process-exec (with no-sandbox)` 例外。例外仅用于新增 Native 场景；原七项进程用例保持原 profile。没有修改 App 权限、生产 process identity/group 校验或结果语义。

新增场景在 macOS 实际检查：controller、普通/scoped CLI 与 Node check 的 loopback listen 均被 `EPERM` 拒绝。子进程仍继承网络限制，不能把放行 ps 扩张为放行 Agent/检查进程。Linux 未使用 macOS profile，不能据此声称 Linux 网络隔离。

## 超时清理

移动原有 harness 到 `workflow-recovery-process.fixture.ts`，原七项测试 body 与父提交逐字节相同，工作量与原 5000ms deadline 不变。新增用例沿用同一 deadline。

`afterEach` 先退役已登记 root，再等待已登记 controller。异步测试 body 超时后，不能在清理快照之后又启动 controller；launch 在最后一次异步准备后、实际 spawn 前重验 root admission。新增回归通过；临时删除该 guard 后，回归因 promise 反而成功派发而失败，不是 timeout。候选源码已逐字节恢复。Native teardown 仅在 Service.prepareForShutdown 返回 ready 后退出；unconfirmed/error 只记录并保留，不冒充 scope closure。

## 实际验证与首败

日志在 `/tmp/scry-workflow-template-editor.ZnkC6L/`。

| 检查 | 当前结果 | 证据 |
| --- | --- | --- |
| Node 类型检查，包含实际可执行 child entry | 通过 | `m3-system-process-final-node.log` |
| Web 类型检查 | 通过 | `m3-system-process-final-web.log` |
| 原七项与新增三项完整组合 | 2 文件 / 10 项通过 | `m3-system-process-final.log` |
| 关闭 root admission guard 的负控 | 预期断言失败；已恢复 | `m3-system-process-admission-negative.log` |
| admission focused | 1 通过、2 未选中；不替代完整组合 | `m3-system-process-admission.log` |

保留首败：`first-node` 的搬迁导入错误、`first` 的 preview.roles 字段错误、`native` 的 ps EPERM 与模型未知导致不复用、`ps` 的 Service workspace/cwd 适配错误、`cwd` 的 branch 报告预期错误。最后一项依据真实 IR 的 `{ arm, value }` envelope 修正，保留 arm 和 value 的完整断言。

`ps`、`cwd`、`envelope` 还出现原 5000ms deadline 超时，涉及原有三进程用例和新增负控，日志未覆盖或删除。最终完整组合在相同 deadline/工作量下通过，但 timing wrapper 仍为 highLoad=true（10 核，load 14.36→11.31）；这不是稳定性、性能改善或超时根因已解决的证明。不以本轮绿灯抹掉首败，不提高时限，不缩减工作量，不 sleep/retry 刷绿。

## 仍未证明

本次是本地固定 CLI、真实 Node check 和独立 Node OS 控制器，不是 Claude/Codex 等真实账号/SDK、完整 Electron App 或发布验收。没有执行新 revision/restart IPC/UI、generic failed/stopped restart、阶段 stall、完整六种质量程序、apply/write authorization 或 M6 外部账单/SDK 验收。

下一步由本任务继续接通 typed revision/restart 管理入口，并完成尚未实现的控制/质量路径；高负载超时与真实 Provider 验收仍独立开放。本次没有调用真实 Provider/Jev、没有新增费用、安装、push、版本升级或业务工作区写入。
