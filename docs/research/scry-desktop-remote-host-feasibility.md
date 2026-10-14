# Scry 桌面跨机器连接：可行性调研与技术方案

> 2026-10-14；以下保留调研时的历史基线，不代表当前实现状态。后续已选择 App-host + SSH 首版；实现说明与验证边界见 [桌面远程](../desktop-remote.md)。
> Scry 基线：`32046b6db64c53d6c071bd4b21db7e81bee59a59`（0.2.179）。
> T3 Code 对照：`8d7523248964ec7b37cc08f91e15122def171821`。
> 调研阶段授权：本地源码调研、mac2 的只读 SSH 环境检查、形成方案。该阶段没有安装软件、启动远程服务、修改配置、读取 Provider 凭据或运行真实 Agent。后续用户另行授权本地实现，以及本地检查通过后的 mac2 隔离安装、SSH/配对和最小真实模型验收。

## 1. 结论

**可行，但不是给 Electron 加一个监听端口就完成。**

Scry 已有生产远程宿主和 iPhone 客户端：配对、证书身份、TLS 1.3、设备撤销、执行账本、恢复、历史、文件读取、Provider 执行等可以复用。缺少的是：

1. 桌面端作为远程客户端，以及本地/远程上下文的完整隔离。
2. 产品化的 LAN 直连入口；现有生产组装主要拨出到 relay，而不是开放本地监听器。
3. 完整桌面证据与执行路径的复用。**当前远程 run 明确关闭 managed recorder，不能把现有手机路径直接包装成“与本地相同”。**
4. 可独立安装、无 GUI 运行的 Agent host。目前独立 `scry` CLI 是 recorder 工具，不是完整 Provider 服务端。

建议：**先复用现有 Mac App 作为宿主，完成桌面客户端 + mTLS LAN 直连；mac2 可先用 SSH 转发两条 TLS 连接做验证，不依赖公网 relay。** SSH 是可选网络路径，不是绕过配对/权限的入口。无 GUI 常驻宿主放在明确的后续阶段，不作为第一版的隐含能力。

两台机器上的项目、Provider 登录和记录分别保留在各自主机。连接远程不意味着同步仓库、复制登录态或接管 Herdr 中已运行的 Agent。

## 2. mac2 只读检查

通过 `herdr machine list` 找到已保存的 mac2 SSH 目标。直接使用 OpenSSH，启用 `BatchMode=yes`、`StrictHostKeyChecking=yes`、`ConnectTimeout=8`，成功执行只读命令；没有调用 Herdr 的安装、重连准备或远程启动命令。实际用户名/IP 不写入此文档。

| 检查 | 本次结果 | 证据与限制 |
| --- | --- | --- |
| SSH | 可连接 | 已有主机信任与当前身份足以完成只读 SSH；不代表所有后续网络端口可达 |
| 系统 | macOS 26.3.2，Darwin arm64 | `uname -sm`、`sw_vers` |
| 资源 | 16 GiB 内存，8 logical CPU，HOME 所在卷约 366 GiB 可用 | `sysctl`、`df -h`；只说明资源基础，不代表 Agent 性能 |
| Node / npm / Git | Node 24.18.0、npm 11.16.0、Git 2.50.1 | 非交互 `/bin/zsh -lc`，没有安装或升级 |
| rotom | launcher 指向 0.1.21 | `command -v` 与符号链接；未启动 RPC、未读取账号凭据、未验证模型调用 |
| Provider 命令 | PATH 未发现 `claude`、`codex`、`qoder`、`opencode`、独立 `pi` | 不等于机器上绝对未安装；Scry Pi adapter 已有 rotom 分支，可作为后续探针候选 |
| Scry | 标准应用目录未发现 App；检查的 userData/`.scry` 目录未发现；精确名称进程数为 0 | 不是全磁盘扫描，也没有检查每个项目的 `.scry` |
| 网络 | 非 loopback IPv4 在 en0；macOS Application Firewall 关闭 | 没有测试新端口，也不能据此排除网络 ACL、Wi-Fi 隔离或第三方过滤 |
| 电源 | AC sleep=0；电池 sleep=1 | `pmset -g custom`；未判断当前供电、合盖行为或实际休眠恢复 |

特别注意：mac2 地址不在 RFC1918 私网段。虽然 SSH 可达，**不能仅凭“在同一网络”就当作可信私网，也不能照搬只枚举 RFC1918 地址的自动发现规则**。第一版使用用户明确选择的接口/地址；连接始终验证宿主身份并加密。

安装 Scry、为它配置 rotom profile、选择允许的 workspace、真实 Provider 请求与费用，均属于后续实施/验收授权，不在本次操作内。

## 3. T3 Code 值得借鉴什么

[T3 远程架构](https://github.com/pingdotgg/t3code/blob/8d7523248964ec7b37cc08f91e15122def171821/docs/internals/remote.md) 的核心是客户端/环境分离：环境拥有执行、文件和持久状态；LAN、SSH、Tailscale、relay 只是访问路径。

- [DesktopServerExposure](https://github.com/pingdotgg/t3code/blob/8d7523248964ec7b37cc08f91e15122def171821/apps/desktop/src/backend/DesktopServerExposure.ts)：local-only 绑定 loopback，Network access 绑定 `0.0.0.0`，另行提供可分享地址。
- [onboarding](https://github.com/pingdotgg/t3code/blob/8d7523248964ec7b37cc08f91e15122def171821/packages/client-runtime/src/connection/onboarding.ts)：先读取环境身份，再兑换配对凭据并保存连接。
- [DirectEndpoints](https://github.com/pingdotgg/t3code/blob/8d7523248964ec7b37cc08f91e15122def171821/apps/server/src/environment/DirectEndpoints.ts)：已连接的服务端报告地址，客户端把它们学习为额外路由。这不是在局域网广播扫描所有机器。
- [环境认证](https://github.com/pingdotgg/t3code/blob/8d7523248964ec7b37cc08f91e15122def171821/docs/internals/environment-auth.md)：权限独立于网络路径，WS 升级后仍按 RPC 校验权限。

Scry 应借鉴身份/路由分离和远端持有状态，**不照搬 T3 的 HTTP + bearer 配对**。现有 Scry 的设备证书、宿主 CA pinning、人工确认和逐请求授权更适合直接复用；另建 bearer 登录体系会增加迁移与安全成本。

## 4. Scry 当前真实基础与缺口

以下来自指定基线的代码阅读，不是本次端到端测试结果。旧文档中的 iPhone/公网成功记录也不算本次 mac2 验收。

| 能力 | 已有实现 | 本次需要补齐 |
| --- | --- | --- |
| 宿主生命周期 | [remote-host-service.ts](../../src/main/remote/remote-host-service.ts) 组装身份、controller、run/pair transport、relay | 产品化 listener 生命周期、配置与状态；可只启用直连而不自动拨公网 relay |
| 稳定身份 | [host-identity.ts](../../src/main/remote/host-identity.ts)：持久 hostId、每安装一份 CA、server leaf | 客户端保存并固定 hostId + anchor；地址变化不能替换身份 |
| 配对 | [pairing.ts](../../src/main/remote/pairing.ts)、[pairing-transport.ts](../../src/main/remote/pairing-transport.ts)：一次性秘密、CSR、TLS 私钥证明、本机指纹确认、撤销 | Node 桌面设备端；新直连邀请格式；保留 iOS 的现有格式和人工确认 |
| 加密业务通道 | [inner-mtls-host.ts](../../src/main/remote/inner-mtls-host.ts)：TLS 1.3 + client cert，`serve(Duplex)` 和 `listen(port, host)` 均存在 | 由 App 正式管理监听、启动/关闭失败和资源预算 |
| 请求/恢复 | [host-controller.ts](../../src/main/remote/host-controller.ts)、[session-ledger.ts](../../src/main/remote/session-ledger.ts)：intent、状态、输出 cursor、watch、问题/回答、停止 | 桌面 typed client、版本/能力协商、跨主机标识隔离、未知结果处理 |
| 项目/文件/历史 | [remote-workspace.ts](../../src/main/remote/remote-workspace.ts)、[history-reader.ts](../../src/main/remote/history-reader.ts)；服务端逐次验证 workspace | 桌面展示接入；能力未支持时明确 unavailable，不能读本地同路径替代 |
| Provider 执行 | [remote-run-binding.ts](../../src/main/remote/remote-run-binding.ts) 调用真实 registry；支持 resume、输出、问题、interrupt、archive | 与本地完整 run orchestration 对齐，不止 adapter 调用对齐 |
| managed recorder | [index.ts](../../src/main/index.ts) 的远程 checkpoint/archive 显式 `managedRecorderEnabled: false` | 完整支持远程桌面任务前，复用本地 recorder/diff/trust/settlement 路径，不能伪造 records |
| 桌面入口 | [preload](../../src/preload/index.ts) 当前 remote API 是本机宿主配对管理；[remote.ts](../../src/shared/remote.ts) 是对应 DTO | 远端连接管理、远端数据源、所选 host 的作用域，不是暴露所有 IPC 到网络 |
| 独立宿主 | [CLI](../../src/cli/scry.ts) 目前没有完整 remote host 命令；[db.ts](../../src/main/db.ts) 等依赖 Electron | 后续拆 App runtime composition 与存储路径；不能把 recorder CLI 叫作 server |

额外发现：`index.ts` 部分注释仍声称远程交互问题未接入，但实际 binding/controller 已有问答路径。方案以实际调用为准；后续整理共享 run 时同步修正受影响注释，不在本次扩散修改。

## 5. 目标架构与第一版边界

```text
本机 Scry renderer（仍不可信、无 Node/网络特权）
  │ typed window.scry，连接 ID / host-scoped context
本机 Electron main
  ├─ 本地操作 → 既有本地执行/读取服务
  └─ Remote client → 已固定宿主身份的 TLS 1.3 + mTLS
                        │
                  LAN TCP 或 SSH 本地转发
                        │
mac2 Scry App 宿主
  PairingTransport / InnerMtlsHost
    → HostController / workspace / device authorization
    → 共享的完整 run orchestration → Provider adapter → mac2 上的 CLI/SDK
    → mac2 的 archive / DB / workspace .scry
```

### 第一版建议范围（需要实施时确认）

- macOS 桌面连接另一台运行 Scry App 的 Mac；保存多个 host，但一次操作明确指向一个 host。
- 连接、配对、撤销、项目/会话/历史、new/resume、模型与权限选择、问题回答、stop、文件与 diff 只读展示。
- 两种可达方式：直接 TCP/mTLS（满足同网络需求）；SSH 转发同样的 pair/run 端口（便于 mac2 验证）。
- 完整 run 路径完成复用后才开放“与本地一致的远程执行”；先交付只读连接闭环是阶段里程碑，不是全功能完成。
- 不在第一版实现浏览器客户端、mDNS 自动发现、跨主机仓库同步、负载均衡、自动安装 Provider、远程账号登录、通用远程 shell、跨平台 headless 服务或 relay 自动选路。
- 原有 iPhone + relay 不退化；新功能不要求修改公网服务。

这里的“只读阶段”指客户端暂不提供写操作，不代表现有 owner-device grant 已变成只读权限。第一版只面向机主自己的设备；若要分享给第三方且保证只读，必须另增服务端强制权限合同，不能靠隐藏按钮实现。

如果实际要求 mac2 注销 GUI 后仍运行、开机无人值守，那么 App-host 阶段不足以完成目标，应先确认将第 9 节的 headless 阶段纳入范围。

## 6. 关键设计

### 6.1 Listener 与 SSH

复用两个独立 TLS endpoint：pair 接受持钥证明但尚未授权的设备；run 只接受已授权证书。不合并认证等级，不新建自定义加密协议。

- 新直连入口默认关闭；明确启用后选择 interface/address 与两个端口。展示配置状态、实际 bind 地址和监听结果，端口占用不能显示 ready。
- mac2 初期建议只监听 `127.0.0.1`，客户端通过 OpenSSH 建立两条 `-L` 转发。它仍是实际端到端网络验证，但**不能算 LAN 直连端口验收**；之后必须单独验证直接 listener。
- 同网络直连显式绑定所选接口；不默认监听所有接口。bind 地址与邀请中的 advertised 地址分离，不能分享 `0.0.0.0` 或错误的 loopback 地址。
- 端口由配置决定，首版可先手动指定，不引入端口扫描/服务发现。DHCP/IP 改变时让用户更新 endpoint；原 hostId 和 CA pin 不变，连接失败不得静默接纳新身份。
- pair listener 仅覆盖有效邀请、待确认配对与签发后有界的证书领取窗口。设备还会用 `pair.status` 取回 grant，不能一按确认就关闭端口；领取窗口与现有 pairing authority 的有效期合同对齐。取消/过期后收敛。新增 handshake/idle deadline、连接数及帧预算，关闭时销毁活跃 socket。现有 pair transport 的 frame cap 不等于这些边界已齐全。
- 部分端口启动失败时回滚本次新增 listener，清晰报告失败，不破坏原有 relay。停止直连不删除 grants、不停止仍在宿主执行的 run，也不把 relay 已授权设备误称为“全部断开”。
- SSH 使用系统 `/usr/bin/ssh`、argv 数组、不拼 shell 字符串；固定转发目标为 remote loopback；`ExitOnForwardFailure`、严格 host-key 校验、禁止 agent forwarding。不得接受 renderer 提供的任意 SSH options、remote command 或 proxy command。
- 第一版不复制 Herdr 的 session/config/密钥，也不调用它自动部署。用户输入/确认 SSH 目标；复用 OpenSSH 的合法身份与 known_hosts。新增/变化 host key 在用户处理前 fail closed。
- SSH child 由本机 main 持有，记录 PID 与 identity，只关闭自己创建的进程；客户端断开不关闭宿主 App，更不能杀 Herdr/rotom 任务。第一版不自动上传或启动远程宿主。

### 6.2 配对、身份与凭据

1. mac2 的可信本机 UI 创建邀请，携带 hostId、anchor、公用直连坐标、pairingId、短时 secret。
2. 本机桌面 main 生成 P-256 设备密钥、CSR、bootstrap client certificate；优先复用已安装的 `@peculiar/x509` 与 Node crypto，不另引 crypto 库。
3. 客户端固定邀请中的宿主 CA，连 pair TLS，证明持钥并提交 CSR/secret。
4. 用户在 mac2 的 Scry UI 核对设备指纹后确认。**SSH 已登录不等于自动批准一个 Scry 设备。** 若无法操作 mac2 UI，这一阶段受阻，不用自动确认绕过。
5. 本机保存 device cert/私钥，之后 run channel 走 mTLS。逐请求重验 grant、有效期和目标授权，撤销后所有后续请求拒绝。

直连邀请使用独立、带版本的桌面格式（具体 DTO 在实施时确定）；不要悄悄给当前 `scry1:` relay payload 改字段，让旧 iOS 解析器误读。旧手机协议继续保留，新桌面发现不兼容版本应明确要求升级。

宿主现有 server leaf 的 CN 是 `scry-host`，不是 LAN IP。Node 客户端须定义并测试“已固定 CA + 该证书逻辑服务身份”的校验；不能为 IP/SSH loopback 名称不匹配而设置 `rejectUnauthorized:false`。bootstrap 的服务端允许自签 client cert，是 pairing endpoint 的既有特殊合同，不得传播到 run endpoint 或客户端服务端验证。

设备私钥仅在 main 内使用，采用 Electron `safeStorage` 加密后存私有文件；系统安全存储不可用则拒绝保存长期连接，不回退明文。证书过期进入明确的重新配对状态，第一版不新增自动续期协议。邀请不进入日志/URL query/错误报告，renderer 只按用户动作临时展示邀请；客户端私钥与业务通道凭据从不下发 renderer。宿主 CA 目前为 0600 文件，并非 Keychain，同用户进程攻击不在现有保证范围；新方案不作更强承诺。

### 6.3 桌面上下文与协议

- 保持 `contextIsolation:true`、`nodeIntegration:false`、`sandbox:true` 和现有 CSP；远端网络、TLS、SSH、凭据全部在 main。renderer 不直接 `fetch/ws` 到远端。
- 增加最小 typed connection API（拟新增），方法按业务定义；不提供任意 URL、任意 `op` 或 raw JSON 转发的 IPC。
- 项目、session、run、question、草稿、文件引用与订阅需要 host 作用域。语义键至少包括 `hostId + provider/profile + cwd + sessionId`；本地对象保持现有存储格式，在 UI 边界附本地来源，不为此迁移全部历史 DB。
- 切换 host 必须切换 Provider/capability、授权目录和审批上下文，并取消旧视图的读取订阅；正在运行的任务不因切换页面停止。答案/stop 请求携带目标 host 与 run/question ID，main 重验。
- 缓存可标“离线缓存 / 最后观察时间”，不能显示成当前远端在线状态。远端路径点击不得变为本地 `shell.openPath`，远端 `localhost` 也不是本机 localhost。
- 新桌面宿主增加认证后的版本/能力查询（拟新增）。现有 run wire 并非通用、完整版本化 RPC；不能因旧手机能用就假设新版桌面所有字段都支持。能力查询失败或未知 op 不得乐观降级为完整功能。
- 不从手机的文字 `output` chunks 重建完整 TraceEvent。桌面需要的工具树、usage provenance、完整 archive DTO，通过既有共享类型和明确的有界请求补齐；缺证据就显示 partial/unavailable。
- 复用现有 newline JSON、cursor 和 long-poll，不为桌面再换成 WebSocket RPC。每 lane 一次在途请求；watch 与交互命令用独立、数量有界的连接，避免长轮询阻塞 stop/answer。

### 6.4 执行完整性：本任务最大工作项

当前手机 binding 直接调用 `providerRegistry.run`，并不等价于 `agent:start` 的全部生命周期。桌面远程执行不得绕过本地已有的 recorder、trust、diff 和归档顺序。

实施时按真实依赖提取共享的 run orchestration（拟新增 focused module，路径实施时确定），让本地 IPC 与远程 controller 调用同一层：

- 授权 canonical cwd、Provider/profile、能力与权限选项；auth/run 互斥仍由宿主统一 gate 管理，重构时避免两层重复获取 lease。
- 所有仓库 MCP/Hook/plugin/executable 首次及变化时重验 fingerprint；按当前自动授权策略记 `source:auto`，不能远端跳过校验，也不能另加本机批准弹窗改变既定策略。
- 保留 Provider-specific default/full_access 语义；UI 显示实际 effective mode。现有宿主环境变量覆盖客户端选项的行为必须显式报告，不能展示客户端选择而执行另一种权限。
- managed recorder、hook 收敛、turn diff、RunRegistry、问题/取消、archive、DB projection 和 settlement 使用同一执行链；`.scry` 仍只写宿主 workspace。
- 两阶段提交仍等待真实证据；客户端不因断线把 run 标为 completed，不根据输出文字推断用量/文件变化，也不把收到 final text 当作 recorder 已提交。
- 若某 Provider/操作尚未实现远程完整链路，能力明确 unavailable，并禁止入口；可以展示阶段性只读结果，但不能靠 `managedRecorderEnabled:false` 宣称已完成完整功能。

无需把 recorder core 加上网络或 Electron，更不能把现有 recorder npm 包塞入 Provider SDK/native/Electron 依赖。

### 6.5 重连、幂等和数据边界

- 用户提交前在本机持久化稳定 intentId；不落重复的完整 transcript。提交结果未知时按同一 ID 查宿主 ledger，禁止生成新 ID 重发 prompt。
- 必须核对现有 ledger 的作用域与 payload 冲突语义，并加测试证明重复 intent 只执行一次；若有缺口只在 ledger 边界修复。
- 客户端掉线时宿主 run 继续；重连后查状态、问题与 cursor，恢复真实输出。只自动重试读取/建连，不盲目重放 start/answer/stop；这些写操作先通过对应业务状态或幂等 ID 确认。
- 复用 ledger recovery：recorded 未 dispatch 可按既有合同恢复；已 dispatch 但宿主丢失 owner 的运行结果为 unknown/interrupted，不重跑伪装成功。
- Provider 凭据、transcript、archive、DB、`.scry` 保持在 mac2。本机可持有明确标为缓存的展示数据，不写入本地 canonical records，不复制本机登录态去 mac2。
- 不自动扫描或接管 Herdr 的 `rotom-team` 会话。Scry 只对自己持有或已有合法导入合同的会话负责。

## 7. 实施顺序与交付门槛

| 阶段 | 交付 | 通过条件 |
| --- | --- | --- |
| M0：隔离协议探针 | 临时 host/device 身份，真实 Node TLS 客户端连生产 pair/run transport；不接 Provider | 成功配对/读取；错误 CA、未授权/撤销/过期设备被拒；保留一个故意破坏保护会失败的负例 |
| M1：桌面只读闭环 | mac2 App-host；连接管理、LAN listener、桌面配对、SSH 可选路径、项目/历史/文件只读 | UI 能证明当前 host；相同路径/会话 ID 不串主机；断线显示诚实；iOS 原链路不退化 |
| M2：完整远程执行 | 共享 run orchestration，new/resume、权限/问题、stop、真实 trace/record evidence | 本地与远端同一授权/证据合同；远端 archive 与 canonical record 逐项核对；不得提前称 parity |
| M3：真机稳定性/分发 | 两台实际 Mac 的安装包、两种网络路径、重启/休眠/撤销/异常回放 | 下节验收完成，记录版本、环境、所有未知项；不开公网、不自动安装其他软件 |

复杂度判断：网络 listener 较小；桌面多 host 状态和共享 run 执行层是主要工作量。未完成依赖抽取和 M0 前，不给“改几行/一天完成”的承诺。实施不应一口气重构所有 IPC，也不为尚无需求的第三种 transport 建插件注册表。

## 8. 验收计划（尚未执行）

### 本地隔离自动检查

优先扩展已有测试，不建平行 harness：

- [inner-mtls-host.test.ts](../../src/main/remote/inner-mtls-host.test.ts)、[pairing-transport.test.ts](../../src/main/remote/pairing-transport.test.ts)：错误身份、bootstrap 不得进入业务、撤销/过期、半包/超长包、连接超时和 close 收敛。
- [session-ledger.test.ts](../../src/main/remote/session-ledger.test.ts)、[remote-dispatcher.test.ts](../../src/main/remote/remote-dispatcher.test.ts)：并发重复 submit、提交回包丢失、重连、崩溃恢复不得重复执行。
- [remote-run-binding.test.ts](../../src/main/remote/remote-run-binding.test.ts)、[managed-turn-commit.test.ts](../../src/main/managed-turn-commit.test.ts)：共享 run 后证据收敛、错误/取消/未知、Provider 差异、hook trust 拒绝时无 Provider side effect。
- [remote-workspace.test.ts](../../src/main/remote/remote-workspace.test.ts)、生产 IPC wrapper fixture：路径穿越、符号链接越界、旧 host 上下文、iframe/非可信 sender、伪造连接 ID。
- 真实 SSH 本地 fixture：带空格路径、转发失败、host key 不匹配、退出后无子进程残留。stub 验 argv 不替代实际转发测试。
- Electron 隔离 UI fixture：实际点击切换 host、相同 session ID、陈旧事件/审批、文件链接、断线/重连、完整 trace。不能用 SSR 或 `.click()` 单独证明焦点/命中。

当前存在的验证入口：`npm run test:unit -- <受影响测试文件>`、`npm run typecheck`、`npm run build`、`npm run test:renderer:ui`。本项目没有单独 lint script，不虚构命令。跨认证、持久化和分发的实现按[验证与交付](../agent/verification.md)扩大 gate，包含相关 packaged-app/security 检查。这些都是未来实施检查，**本次未运行**。

### mac2 真机验收

另行获得安装、临时 workspace、Provider/费用授权后：

1. 安装冻结版本的 Scry 到 mac2；单独配置 host、rotom profile 和临时 workspace，不改 Herdr 配置/原项目。
2. 先 SSH 转发验证，再单独测试直接 LAN listener。保留连接到 mac2 的身份与网络路径证据，不能只看客户端显示 connected。
3. 用无成本 fixture 验证远端文件/历史读取、stop/answer 的目标 host；再执行获授权的真实 Provider 请求。
4. 在 mac2 临时 workspace 产生唯一标记文件，证明执行落在远端；本机 workspace 不应产生相应写入。
5. 核对远端 run/session ID、terminal 状态、Provider 原始结果、archive、`.scry` 和 CLI overview；各持久面的失败单列，不拿其中一项成功替代其余。
6. 请求已发送但回包丢失、网络断开、客户端退出/重启、宿主重启、grant 撤销、证书错误分别验证。检查是否多运行一次、越权读取或将 unknown 显示成成功。
7. 接电/电池/休眠分别验证；不自行修改电源策略或添加保活服务。失败时说明如何影响“远端保持运行”的前提。
8. 退出与清理仅针对登记的测试资源；确认 SSH 子进程、listener、Provider 进程收敛后清理临时文件，不碰现有 Herdr 会话。

## 9. 何时升级到无 GUI 宿主

**触发条件：**用户要求 mac2 不登录桌面也能工作、开机启动，或要支持 Linux 服务器。这时再提取独立 Scry host 分发面。

- 复用 M2 共享运行层，将 `app.getPath`、窗口事件、dialog、safeStorage 和进程退出从业务服务中注入/隔离；SQLite/native/Provider SDK 保留在 host 包，不能进入 recorder core/npm 包。
- 需要独立的安装包/更新/资源 allowlist、日志、单实例/lease、Provider 可执行路径和 launcher 身份校验，不能把实验 `lan-live-*` 脚本直接发布。
- 无 GUI 首次配对需要受信任本地 CLI/Unix socket 管理面。用户通过已有 SSH 进入主机后，显式创建邀请并确认指纹；device-facing 接口仍不能 confirm 自己。
- 若使用 launchd，显式配置受支持的非交互 PATH/Provider profile。不能假设 Herdr shell 下可用就等于 LaunchAgent/Daemon 可用，更不能从 Herdr 复制私密环境。
- 自动安装、远程启动、更新/卸载与共享数据目录并发策略必须另行验收。首版 App-host 不提前预留工厂或不必要的配置层。

## 10. 本次交付与待决事项

本次只完成源码/环境调研及本文。SSH 成功只证明当前已知目标可登录；Scry mac2 连接、运行、LAN 端口、安装包、Provider 登录/额度均未验证。

建议下一步批准 M0 → M1 的实施，再在共享执行链审查后推进 M2。开始安装/真实 Agent 验收前需要明确：

- 是否接受第一版要求 mac2 的 Scry App 保持运行；若不接受，将 headless 阶段提前，而不是暗中降低无人值守需求。
- 是否允许安装隔离版本、创建临时 workspace，以及配置现有 rotom profile；真实模型/费用授权单独确认。
- 首次配对由用户在 mac2 Scry UI 确认；若不能操作，应先实现可信 CLI 确认面，而不是自动放行。

本次无程序代码修改、无构建/安装/部署、无 Provider 请求。文档交付只执行 diff 和引用/命令核对；提交不推送，遵循仓库约定。
