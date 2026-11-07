# P3 · 宿主 daemon 设计（只设计，不含实现）

状态：设计稿。P3 尚未实现；本文描述迁移边界、需要维护者决定的事项和验收办法。

## 1. 要解决的问题

当前宿主能力全部住在 Electron main 里：`src/main/bootstrap/remote-host.ts` 在 App 启动时组装 `RemoteHostService`，App 退出即全部消失。后果：

1. 关闭 App 即断开所有已配对设备，运行中的 run 被中断。
2. 升级 UI 必须重启 Provider 与远程连接。
3. 远程设备的可用性等于「用户是否开着窗口」。

P3 把这些能力搬到一个常驻 Node 进程，Electron main 退化为本机客户端。

## 2. 进程边界：哪些模块迁出 Electron main

判断依据是运行时依赖：`src/main/remote/*.ts` 与 `src/main/providers/*.ts` 目前**没有任何文件 import `electron`**（已 grep 确认），Electron 耦合集中在 `src/main/bootstrap/*.ts` 的组装层。因此迁移是「抽出组装层 + 新增通道」，不是重写宿主逻辑。

### 2.1 迁到 daemon（宿主拥有的事实源）

| 责任 | 文件 |
|---|---|
| 设备通道与鉴权 | `remote/enrollment.ts`、`remote/pairing.ts`、`remote/pairing-file.ts`、`remote/pairing-transport.ts`、`remote/inner-mtls-host.ts`、`remote/desktop-host-listeners.ts`、`remote/host-identity.ts` |
| 请求路由与设备面 | `remote/inner-mtls-dispatch.ts`、`remote/inner-mtls-history-dispatch.ts`、`remote/remote-protocol.ts`、`remote/execution-targets.ts` |
| 控制器与运行生命周期 | `remote/host-controller*.ts`（surface / submit / watch / run-controls / desktop-reads / tool-panel / session / attachments / execution / routing / types） |
| 台账 | `remote/session-ledger.ts`、`remote/session-ledger-file.ts`、`remote/run-output-log.ts`、`remote/run-output-file.ts`、`remote/run-output-file-worker.ts`、`remote/run-output-worker.ts`、`remote/trace-output.ts` |
| 设备面读取 | `remote/remote-gateway*.ts`、`remote/history-reader.ts`、`remote/history-context.ts`、`remote/remote-workspace.ts`、`remote/remote-file-download.ts`、`remote/remote-directory-browser.ts`、`remote/desktop-host-reader.ts`、`remote/desktop-workbench*.ts`、`remote/desktop-directory-picker.ts`、`remote/desktop-trace-delta.ts`、`remote/desktop-attachments.ts` |
| 运行与 Provider | `remote/remote-dispatcher.ts`、`remote/remote-run-binding.ts`、`remote/remote-run-policy.ts`、`remote/remote-interaction-broker.ts`、`remote/remote-terminal-ownership.ts`、`remote/recover-dead-lease.ts`、`remote/remote-provider-prewarm.ts`、`remote/remote-provider-snapshot.ts`、`remote/remote-gateway-catalog.ts`、`providers/**`（含 `providers/provider-warm-pool.ts`） |
| relay 接入 | `remote/relay-client.ts`、`remote/relay-connect*.ts`、`remote/relay-credential.ts` |
| 观测 | `remote/remote-request-timing.ts`、`providers` 侧 trace 产出点 |

### 2.2 留在 Electron main

- `remote/desktop-client*.ts`：这是**设备侧**客户端（Desktop 远程用它连别的宿主）。P3 之后 Electron main 同时是「本机 daemon 的客户端」和「远程宿主的客户端」，两套客户端共享 `desktop-lane.ts`、`remote-protocol.ts` 的线上约定。
- `remote/desktop-transport.ts`（SSH 转发）、`remote/remote-attention.ts`、`remote/remote-defaults.ts`：纯 UI 侧。
- `bootstrap/**`：所有 IPC handler、窗口、菜单、Dock、通知。
- `src/renderer/**`：保持 `contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`，只经 typed `window.scry` 调用 main。

### 2.3 新增（daemon 与 main 的共同入口）

- `src/daemon/main.ts`：唯一入口，读环境、建 socket、登记进程身份、装配 `RemoteHostService`。
- `src/daemon/local-server.ts`：本机通道服务端（见 §3）。
- `src/daemon/lifecycle.ts`：launchd/systemd 交互、单实例锁、崩溃恢复。
- `src/main/daemon-client.ts`：main 侧本机通道客户端，接口与 `DesktopRemoteClient` 对齐，使 renderer 的 IPC 层无需分支。
- `src/main/daemon-supervisor.ts`：App 拉起 daemon、探活、必要时重启并重放**只读**请求。

## 3. 本机通道认证

目标：本机 UI 拥有与远程设备同等的鉴权强度，不新开网络端口。

1. **socket 位置**：`<userData>/daemon/local.sock`（macOS/Linux 同路径），父目录 `0700`，socket 文件 `0600`。Linux 上同时校验 `SO_PEERCRED`（uid 相同）作为纵深；macOS 使用 `LOCAL_PEERCRED`。两者都不是授权依据，只是额外过滤。
2. **设备身份**：daemon 首次启动生成一对本机设备密钥（沿用 `remote/enrollment.ts` 的 CSR/证书链路），main 侧持有私钥（现有 `desktop-client*` 的 device identity 存储可复用）。每次连接仍走 mTLS over unix socket，或走「本机通道 challenge + 证书指纹」两次校验；**选择哪种需要维护者决定**（§8）。
3. **授权**：daemon 侧沿用 `RemoteAuthority`——按已验证的证书指纹判断，与远程设备同一套 grant 表；本机设备是一条特殊 grant（`scope: local`），撤销后失败为 `device_not_authorized`。
4. **协议**：与远程完全相同（`REMOTE_PROTOCOL_VERSION`、lane 语义、`catalogSnapshot`、`watch output:false`），只是传输从 TLS-over-TCP 换成 unix socket。这样「本机 UI 与远程设备能力不一致」不可能发生。
5. **不做的事**：不监听 TCP；不允许 renderer 直连 daemon；不因「就在本机」跳过版本校验或指纹校验。

## 4. 生命周期

决策已定（PLAN.md）：App 拉起 daemon；App 关闭后 daemon 继续运行；可选登录自启。

1. **启动**：main 启动时先探活 `local.sock`（connect + `desktop info` 等价调用，带协议版本）。无响应则拉起 daemon 并等待就绪（上限 10 s，超时即为 `daemon_unavailable`，UI 显示可操作错误，不静默降级为本机 `full_access` 之外的假数据）。
2. **单实例**：`<userData>/daemon/daemon.lock` 存 pid + 启动时间 + identity 指纹；已有存活实例则接入，不启第二个。
3. **退出**：main 退出只关闭自己的 socket 连接，**不**发停止命令。用户显式「退出全部」时由 main 调 `daemon.shutdown`（只读握手 + 二次确认），daemon 先停远程设备通道、再等运行中 run 到安全点或标记 unknown，然后退出。
4. **自启**：macOS 用 `LaunchAgents` plist（`RunAtLoad`），Linux 用 `systemd --user` unit（`Restart=on-failure`）。两者都由安装脚本写入，安装前显示将写入的路径与内容；用户可在设置里关闭自启（关闭即卸载 unit，不从后台偷偷保留）。
5. **升级**：安装新版本时若 daemon 运行中，标记「运行中的 run 属于旧版本」。安装脚本先写入新二进制（独立路径），再让 daemon 在下一个空闲点自替换；正在运行的 run 不迁移（见 §7 崩溃恢复的处置方式）。这与现有「App 产物改动才构建安装」的约定不冲突：daemon 升级必须在 App 升级时一并进行，版本不一致时本机通道也走 `protocol_mismatch`。

## 5. 打包与私有 CLI 绝对路径

- daemon 与 App 同一次打包（同一个 `electron-builder` 产物里作为额外资源），但**独立可执行**：`Contents/Resources/daemon/scry-daemon`（macOS）、`/opt/scry/scry-daemon` 或 AppImage 解包路径（Linux）。
- 私有 CLI（`scry-turn-recorder`）继续通过 `process.resourcesPath` 解析出的绝对路径调用，daemon 中不得用 `PATH` 查找；与现有 hook 调用的绝对路径规则一致。
- 启动环境清洗（现有 `env` allowlist 逻辑）在 daemon 入口再次执行：daemon 是长期进程，环境漂移（用户重登、`launchctl setenv`）必须被清理而不是继承。
- `package resource allowlist`（现有 sanitiser）扩展到 daemon 资源；新增任何 daemon 侧可执行文件都要进 allowlist，否则打包校验失败。
- sandbox preload 的 CJS/native unpack 规则不变；daemon 不加载 renderer 资源。

## 6. 进程身份登记与停止规则

现有约定：只停止登记过且重验 identity 的进程，不使用模糊 `pkill`。daemon 继承并加强：

1. 登记：daemon 启动即写 `<userData>/daemon/processes.json`（pid、启动时间、可执行路径、identity 指纹、角色 `daemon`）；每个 Provider 子进程由 Provider adapter 写入同表（现有 provider 进程登记逻辑迁移）。
2. 停止：只停「pid 存在 + 启动时间一致 + 可执行路径一致 + identity 重验通过」的进程；任一不符即放弃并报告 `process_identity_changed`，不重试。
3. auth 与同 provider/profile 运行保持互斥：互斥锁由 daemon 独占持有（不是 main），避免两个进程各持一半。
4. App 退出不得停止 daemon 拥有的 Provider 进程；App 也不得 spawn Provider 进程（这条在 P3 收紧：main 里出现 Provider spawn 即为缺陷）。

## 7. 崩溃恢复

| 场景 | 期望行为 |
|---|---|
| daemon 崩溃 | main 探活失败 → 重启 daemon → daemon 读台账恢复。已写出但未确认的写操作（submit/stop/answer）按 intent/answer id 核对，状态不明时**标记 unknown 并要求用户核对**，不重放。 |
| Provider 子进程崩溃 | 现有 `recover-dead-lease.ts` 逻辑在 daemon 内执行：租约失效 → run 标 failed（带原因），不自动重跑 prompt。 |
| main 崩溃 | daemon 不受影响，远程设备与运行中的 run 继续；main 重启后重新订阅。 |
| 机器重启 | 台账恢复 lastKnown：离开 `dispatched` 的 run 一律标 `failed`（detail `host_restarted`，现有 `HOST_RESTARTED_DETAIL`），不重放。 |
| 本机通道断开 | daemon 只关闭该连接；正在等待的长轮询在该连接结束时结束，不累积。 |

## 8. macOS / Linux 差异

| 项 | macOS | Linux |
|---|---|---|
| 进程托管 | `LaunchAgent` plist（`~/Library/LaunchAgents/dev.scry.daemon.plist`） | `systemd --user` unit（`~/.config/systemd/user/scry-daemon.service`） |
| socket 对端校验 | `LOCAL_PEERCRED` | `SO_PEERCRED` |
| 凭据存储 | Keychain | libsecret；无 libsecret 时**显式报不可用**，不写明文 |
| 路径 | `Contents/Resources/daemon/`、`/Applications` | AppImage 解包路径、`/opt/scry`、pacman 安装路径 |
| 自启 | 由 plist 的 `RunAtLoad` | `systemctl --user enable` |

Linux 目标机是 Arch/Omarchy x86_64 + Hyprland/Wayland；容器与 headless 通过不算目标机验收。

## 9. 迁移步骤（每步可独立合入、可回滚）

1. **抽出组装层**：把 `bootstrap/remote-host.ts` 的依赖组装移到一个不依赖 Electron 的 `createHostRuntime(deps)`，main 仍在本进程内调用它。这一步不改行为，只消除 Electron 耦合。
2. **新增本机通道（影子）**：daemon 不存在时 main 用进程内 runtime；daemon 存在时用本机通道。两者读同一 userData 台账（注意单写者：影子期只允许 daemon **或** 进程内二选一持有台账锁）。
3. **默认走 daemon**：daemon 成为唯一写者，进程内 runtime 删除。
4. **托管与自启**：安装脚本写 unit/plist，设置页显示状态与开关。
5. **发布校验**：`npm run install:mac:dev` 后验证「关闭 App 不中断 run」「远程设备重连不灭」「升级 UI 不中断」三条。

## 10. 测试计划

| 层 | 内容 |
|---|---|
| 单元 | `createHostRuntime` 无 Electron 依赖（import graph 断言）；本机通道授权（本机 grant 撤销后拒绝）；版本不一致拒绝；单实例锁冲突；进程身份重验失败不停止。 |
| 集成（真实 socket + 真实 mTLS） | unix socket 上跑现有 `desktop-lane-real-host.test.ts` 的同等场景；daemon 崩溃后重启恢复台账；main 崩溃后 daemon 继续服务远程设备。 |
| 生命周期 | 关闭 App 后 run 继续（真实 stub Provider）；daemon 被 SIGKILL 后重启，离开 `dispatched` 的 run 变 `failed(host_restarted)`。 |
| 门禁 | 现有 `npm run test:desktop-remote` 全部 scenario 仍通过；新增 daemon smoke（同一套 fixture，但通道换成本机 socket）；Linux 需要在目标机跑一遍（无法执行则标 `not-run`）。 |
| 安全边界 | renderer 仍无 `window.scry` 之外的能力；daemon 不接受 TCP；socket 权限 `0600`/目录 `0700`；Provider spawn 只出现在 daemon 侧（静态检查）。 |

## 11. 与 CLAUDE.md 五条不妥协项的关系

1. **证据不能说谎**：daemon 只搬运现有事实源（台账、transcript、`.scry/records`）；本机通道与远程通道返回同一 envelope，`unavailable`/`unknown` 语义不变。daemon 不可用时 UI 明确报 `daemon_unavailable`，不用空数据冒充。
2. **Provider 差异显式存在**：adapter 全部在 daemon 内，capability 探测与降级逻辑（Pi 无 MCP API 等）一字不改地跟着迁移；本机 UI 不因「本机」获得额外能力断言。
3. **权限与 trust 不是一回事**：`full_access` 语义不变；仓库控制的 MCP/Hook/plugin 仍在 daemon 内每次重验 canonical cwd + 指纹，fail closed；本机 grant 不等于绕过 trust gate。维护者 2026-09-21/2026-10-15 的决定继续生效，本设计不改其任何一条。
4. **renderer 不可信且无特权**：sandbox/CSP/typed preload 全部不变；新增的本机通道是 main↔daemon，renderer 无法触及；main 仍校验 sender/frame/origin 与 payload。
5. **Recorder Core 独立**：daemon 不把 SQLite 或编排逻辑塞进 `src/core/turn-recorder/`；私有 CLI 仍用绝对路径、独立于 daemon 版本运行。

补充：本文不放宽任何现有安全边界，也不引入新端口或新的持久化格式（除 §7 的进程登记表与 §4 的锁文件，两者都是运行状态，不是事实源）。

## 12. 需要维护者决定

1. **本机通道认证方式**：① 直接 mTLS over unix socket（复用现有证书链路，实现最一致）；② socket + challenge/证书指纹两次校验（实现更小，但与远程路径分叉）。推荐 ①，因为它让「本机与远程同一协议、同一鉴权」成立。
2. **daemon 退出语义**：App 退出后 daemon 常驻是已定决策，但「用户如何显式停掉全部」需要 UI 位置与二次确认文案；是否允许在没有运行中 run 时随 App 空闲超时退出（默认建议：不允许，否则远程可用性又回到窗口依赖）。
3. **升级期版本不一致**：daemon 与 App 版本不一致时，是硬失败（要求一起升级）还是允许「旧 daemon + 新 UI 只读」？推荐硬失败，与「不做协议兼容层」一致。
4. **Linux 首批托管方式**：只做 `systemd --user`，还是同时支持无 systemd 的启动项？目标机 Omarchy 有 systemd，建议只做 systemd 并显式降级（无 systemd 时提示手动启动）。
5. **打包方式**：daemon 作为 electron-builder extraResources（同一产物、独立可执行）还是独立包（pacman/.pkg）？涉及发布流水线与 `install:mac:dev` 的改动范围。

## 13. Batch 4 设计补全

正文移到 [P3-batch4-design.md](P3-batch4-design.md)，仍沿用 §13.1–13.6 的编号：

| 小节 | 内容 |
|---|---|
| §13.1 | IPC channel 矩阵（119 个：main 24 / split 3 / forward 39 / new-op 53）与生成、守卫方式 |
| §13.2 | 本机设备入网与 `scope: local`：secret 生命周期、重新入网、单实例 |
| §13.3 | 生命周期：探活、拉起、App 退出、`daemon.shutdown`、升级 |
| §13.4 | trace 推送方式与延迟预算 |
| §13.5 | dock badge、通知、未读会话的有界事件缓冲 |
| §13.6 | 按 grant scope 选策略（`agent:start`、`agent:deleteSession` 的语义差异） |

生成文件 [P3-ipc-matrix.md](P3-ipc-matrix.md) 与 [P3-ipc-ops.md](P3-ipc-ops.md) 由 `scripts/daemon-ipc-matrix.mjs` 产生，`scripts/daemon-ipc-matrix.test.ts` 守住。
