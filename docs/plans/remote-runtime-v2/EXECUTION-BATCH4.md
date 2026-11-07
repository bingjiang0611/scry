# 执行任务书 · Batch 4（Batch 3 遗留 + App 经本机通道使用 daemon + 删除进程内宿主）

本文给执行 agent。开工前先读：

- [REVIEW-BATCH3-P1-CLOSE.md](REVIEW-BATCH3-P1-CLOSE.md)
- [STATUS-BATCH3.md](STATUS-BATCH3.md) 中的「后续事项」
- [P3-daemon-design.md](P3-daemon-design.md) §2–§7、§9
- [P3b-local-runtime-design.md](P3b-local-runtime-design.md) §2–§8

工作约定、停止条件、提交与 STATUS 规则同 [EXECUTION.md](EXECUTION.md) 第 0、1 节。进度写入新文件 `STATUS-BATCH4.md`（总览表加 `status/b4-*.md`）。分支继续使用 `claude/remote-runtime-v2`。

**本批目标：** 纯本机使用也走 daemon。App 不再组装运行管线、不再持有台账或 SQLite 写者、不再自己 spawn Provider，只做 UI、IPC 与「连接别的宿主」的客户端。关闭 App 窗口后，run、终端和远程设备连接都继续工作。本批结束时删除进程内宿主和 App 直连 SQLite，不保留兼容版本。

**不在本批：**

- 「登录时启动」开关，以及 launchd/systemd 服务的安装与卸载（P3 §9 第 4 步，Batch 5）
- 事件日志 / replica（P4）
- 路线竞速、push 订阅协议（除非 B4-L3 的测量要求，见该节）

## 已采用的决策（维护者可推翻；推翻前按此执行）

| 决策 | 出处 |
|---|---|
| 纯本机也走 daemon，本机与远程只维护一套数据流 | PLAN「已定」2026-11-03 |
| 本机通道 = mTLS over unix socket，协议、鉴权与远程相同 | REVIEW-BATCH1 |
| daemon 独占 SQLite；登录/重认证经本机通道排队；`ProviderOperationGate` 只由 daemon 持有 | REVIEW-BATCH2 答复 |
| 本机设备用 `scope: local` grant，Batch 4 实现 | REVIEW-BATCH2 答复 |
| App 退出不停 daemon；菜单提供「退出 Scry 与后台服务」，有运行中的 run 时二次确认；不随 App 空闲退出 | REVIEW-BATCH1 |
| daemon 与 App 版本不一致即硬失败，不做协议兼容层 | REVIEW-BATCH1 |
| 默认不随登录自启：打开 App 时拉起 daemon | PLAN「已定」 |
| 迁移期只允许开发开关 `SCRY_HOST_DAEMON`，默认关闭；合入前删除旧路径 | REVIEW-BATCH2 更正 3 |
| 已有本机会话不迁移格式；daemon 读同一 userData 下的现有数据 | PLAN「已定」 |

## 硬约束（全批适用）

1. **任何时刻只有一条运行管线。** 开关打开时，App 进程不得构造 `createRunPipeline`、`createHostRuntime`、台账 store、`ProviderOperationGate` 或 SQLite 写连接；开关关闭时，daemon 不得被拉起。远程 run 与本机 run 分在两个进程跑，会让同 provider/profile 的互斥失效（CLAUDE.md「auth 与同 provider/profile operation 保持互斥」），所以不允许按「远程先迁、本机后迁」拆开两个写者。
2. **开关打开、但某个能力还没迁完时，该能力显示 `unavailable` 并说明原因。** 不能回退到进程内实现，不能返回空数组或 0。
3. 每个迁走的 IPC channel 仍由 main 用 `handleTrusted` 注册，并保留 sender/frame/origin 校验与 payload schema。main 只负责转发，daemon 在自己这侧再做一次 cwd、path 与 operation 授权。renderer 不能接触本机通道。
4. 全部测试使用独立 userData 与临时工作区，不打开用户真实的 DB、`.scry` records 或 transcript；不在当前开发仓库驱动真实 Agent。

## 任务

### B4-F · Batch 3 遗留（先做，各自单独提交）

- **F1 修复 `test:renderer:ui` 的既有失败**（`Performance control obscured: #performance-empty`）。本批会大量改 UI，必须先让这个门禁可用。先在 `577995b` 上用现有隔离 Electron fixture 定位原因：是组件真的被遮挡，还是 fixture 的坐标或时机有问题。修的是真实原因，不能放宽命中检测，也不能跳过；修复前后各留一次失败和通过的日志。如果查明是产品 bug，按 UI 修复流程补 focused 回归。
- **F2 supervisor 余项。**
  - 已知的确定性启动失败（如 `remote_lease_owner_alive` / `remote_lease_identity_unverifiable`、`daemon_recorder_cli_unavailable`）映射为不重试的退出码；
  - reason 提取同时接受 `remote_` 前缀，正文仍不落盘；
  - 每种情况各写一条先失败的测试。
- **F3 收窄 macOS 上的 Scry command 兜底。** 身份格式可识别、且来自 UTC `lstart` 的记录，在 macOS 上视为精确身份；兜底只对旧格式记录生效。同步修正注释里「macOS drift」的说法。测试：
  - 正例：macOS 上另一个 pid、command 是 Scry、身份不同 → 接管；
  - 反例：旧格式记录 → 拒绝。

### B4-D · 设计补全（只写文档）——完成后停下等核验

在 `P3-daemon-design.md` 新增 §13，在 `P3b-local-runtime-design.md` §8 更新进度表，内容如下。

1. **IPC channel 矩阵。** 当前 main 有 119 个 `handleTrusted` channel（agent 59、conversation 17、workspace 13、terminal 11、remote 8、runTraces 6、app 5）。逐个标为以下三类之一：
   - (a) 留在 main：窗口、菜单、隐私、连接别的宿主的 `DesktopRemoteClient`；
   - (b) 转发到 daemon，并写明使用哪个现有协议 op；
   - (c) 需要新增协议 op，写清 op 名称、请求与响应的 schema、授权函数，以及对应的 `performance-paths.json` 用户路径。

   矩阵用脚本从源码生成，并有测试守住：新增 channel 没有分类时测试失败，做法与 `performance-feedback.test.ts` 相同。
2. **本机设备入网与 `scope: local`。** 推荐方案如下，**需要维护者确认，因为它涉及授权语义**：
   - daemon 首次启动时，在 `<userData>/daemon/` 写入一次性的本机入网 secret（`0600`）；
   - App 以同一 uid 读取 secret，经 unix socket 完成 CSR 与 proof，得到带 `scope: local` 的 grant；
   - `scope: local` 的 grant 只在 unix socket 传输上有效，经 SSH 或 Relay 使用时返回 `device_not_authorized`；
   - 设备列表中显示为「本机」，可以撤销，撤销后 App 显示可操作的错误，不自动重新入网；
   - secret 使用一次后即作废。
3. **生命周期。**
   - App 启动时探活 `local.sock`：先连接，再做带协议版本的 info 握手；
   - 拉起 daemon 时沿用 `daemonLaunchEnvironment`，就绪等待上限 10 s，超时显示 `daemon_unavailable`；
   - App 退出时只关闭自己的连接；
   - 「退出 Scry 与后台服务」的 `daemon.shutdown` 语义：先停远程设备通道，运行中的 run 等到安全点，否则标为 unknown；
   - **升级流程**：`install:mac:dev` 之后，新 App 遇到旧 daemon 会因版本不一致硬失败，此时 UI 提供「重启后台服务」，走 shutdown 语义；被打断的 run 按 `host_restarted` 处理，不重放。
4. **trace 推送。** 先沿用现有的 `watch` 长轮询加 `traceDelta`，在 unix socket 上实现本机流式输出。App 侧保留 16 ms 合批与背压。验收以 L2 计时比较「进程内」与「经 daemon」两种方式下首 token 与流式输出的延迟，写明预算；超出预算时，再提出 push 订阅 op 作为单独决定，不在本批默默加上。
5. **dock badge、通知、未读会话。** 由 daemon 产生事件，App 渲染。App 未运行时这些事件不累积，以上限加 cursor 处理。

### B4-L1 · 本机入网与 `scope: local`（核验通过 B4-D 后开始）

按 B4-D 第 2 条实现。必须有的测试：

- 首次入网成功；secret 被重复使用时拒绝；
- local grant 经非 unix 传输使用时拒绝；
- 撤销后 `device_not_authorized`，且不自动重新入网；
- 远程设备的 grant 行为不变（现有 `test:desktop-remote` 全绿）。

### B4-L2 · main 侧 daemon 客户端与 supervisor

新增 `src/main/daemon-client.ts` 与 `src/main/daemon-supervisor.ts`（P3 §2.3）。客户端复用 `desktop-lane` 的线上约定，读、写分两条 lane；写操作在结果未知时按 intent id 核对，不重放。

测试覆盖：

- 探活 → 拉起 → 就绪；
- 已有 daemon 在运行时直接接入，不再拉起第二个；
- 版本不一致时硬失败，并在 UI 显示「重启后台服务」；
- daemon 被 SIGKILL 后，App 探活失败、重新拉起、重新订阅；
- App 退出后 daemon 仍在运行。

### B4-L3 · run 经 daemon（`SCRY_HOST_DAEMON=1` 下）

迁移 start / stop / answer / fork、live state、trace 流式输出、user question、run controls、Provider 登录与重认证排队。完成后，开关打开时 App 进程内不存在运行管线，用一条导入图或构造断言守住。

同批完成 N3 UI：把 `workbenchOps` 接入 catalog，受限的操作要隐藏或禁用，并显示原因。

验收：

- 现有 run 相关的 renderer 与 main 测试，在开关打开时全部通过；
- `test:desktop-remote` 全绿；
- 按 B4-D 第 4 条做 L2 计时，结果写入 STATUS 并注明机器负载。

### B4-L4 · 其余能力经 daemon

按矩阵完成其余 channel：conversation/history（SQLite 读改为走 daemon projection）、source-control、终端 PTY（「关闭 App 后终端继续」）、tool panels、side chat 等。每完成一组，就把这一组从 `unavailable` 改为可用，并附带对应测试。

### B4-S · 切换与删除

- 开关默认打开，随后删除 `SCRY_HOST_DAEMON`、进程内宿主组装（`bootstrap/remote-host.ts` 中的宿主部分、`index.ts` 里的 `createRunPipeline`）、App 直连 SQLite，以及在 main 里 spawn Provider 的路径。
- 新增静态检查：`src/main` 的值导入图中不得出现 Provider spawn、台账 store 或 SQLite 写连接，并带自检。
- 远程设备改由 daemon 服务。App 的「远程宿主」设置页改为显示 daemon 的状态。

### B4-V · 验收

| 场景 | 断言 |
|---|---|
| 关闭 App 窗口和进程 | 运行中的 run 继续到 settled；终端继续；远程设备仍可连接并看到 trace |
| 重新打开 App | 接入同一个 daemon，不拉起第二个；按 cursor 续读，缺口如实显示 |
| daemon 被 SIGKILL（被杀前已有一个 dispatched run） | App 重新拉起 daemon；该 run 变为 `failed(host_restarted)`，不二次 dispatch；未确认的写显示 unknown（这一条覆盖 STATUS-BATCH3 后续事项第 4 项） |
| 升级 | 构建新产物后：旧 daemon 加新 App 时硬失败 → 用户选「重启后台服务」→ 恢复可用 |
| 「退出 Scry 与后台服务」 | 有运行中的 run 时二次确认；退出后没有残留进程、lock 或 lease |
| 同 provider/profile 互斥 | 本机与远程同时在同一 profile 上启动，第二个排队或被拒绝，与进程内语义一致 |
| trust gate | 仓库 MCP/Hook/plugin 在 daemon 内重验 canonical cwd 与指纹，指纹变化拒绝执行 |
| renderer 隔离 | sandbox、CSP 与 typed preload 不变；renderer 无法访问 `local.sock` |
| 性能 | `performance:measure -- --compare <B4 起点>` 与 B4-D 第 4 条的 L2 计时；每个 `worse` 都要说明，回归先修 |
| Linux | 构建产物验收在 Ubuntu runner 上跑一遍；Arch/Hyprland 目标机不可用时标为 not-run |

## 交付前全局验证

与 Batch 3 同一张表全部重跑：

- `npm test`、typecheck、build、`build:cli`
- `performance:inventory`、`performance:measure`
- `test:desktop-remote`、`--dev` security smoke
- `pack:artifact`、`npm run test:renderer:ui`（本批要求通过）
- `git diff --check`

另外，在 macOS 宿主上执行 `npm run install:mac:dev`，并按上表的升级场景实测一次。无法执行的项写 not-run 并说明原因。不升版本号，不开 PR。

## 停止条件（在 EXECUTION.md 之外追加）

- B4-D 完成后停下，等维护者确认第 2 条（本机入网与授权语义）和第 4 条（trace 推送方式与延迟预算）。
- B4-L3 完成后停下核验，之后再做 B4-L4 与删除。
- 测量显示某个用户路径必须提高 ratchet 门限或基线时，停下走 `raise` 记录和 `performance-raise-approved`，不要自行放宽。
- 迁移中发现某项语义无法保持（recorder 提交时机、审批语义、trust 判定位置、证据权威性），或者需要改授权语义（grant 字段之外的变化、trust 策略、权限模式）时，停下写入 STATUS「需要决定」。
- 不得为了让 App 能连上 daemon，而跳过版本校验、指纹校验或 mTLS。
