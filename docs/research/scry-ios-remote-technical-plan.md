# Scry iOS Remote 技术方案 v0.1

日期：2026-09-12。状态：设计草案，未实现、未部署、未做真机验收。

前置研究：[Scry iOS 远程操作调研](./scry-ios-remote-research.md)。源码定位基于 `bfd3d70` 的相关 main/shared 文件；现有 renderer/UI WIP 不在本次改动范围。

## 1. 产品合同与本轮决策

用户已确认：**仅 iOS、面向普通用户、Mac 锁屏运行、退出桌面 App 后不用继续、手机最大权限。**

| 项目 | 本方案选择 | 状态 |
| --- | --- | --- |
| 手机 | SwiftUI 为主，复杂 diff/终端可用专用原生组件；共享协议而非桌面视图 | 推荐，须 G0 验证 |
| 连接 | Mac/iPhone 主动连接托管入口；无需 VPN、SSH、路由器端口 | 首发目标 |
| 身份 | 云账号用于发现；Mac 本地配对授予设备控制权 | 设计决策 |
| 加密 | 优先验证 TLS 1.3 双向认证的内层通道，穿过云端字节转发 | 推荐，跨语言/移动适配未证实 |
| 执行宿主 | 现有 Electron 主进程 + 抽取的应用服务 | 不新建 daemon |
| 最大权限 | owner-device，可操作任务、项目文件、受管理终端、Provider 权限、可远程 trust 审批 | 不等于 root、关闭认证或绕过系统权限 |
| 锁屏 | 已登录、App 运行、系统保持唤醒时，CLI/SDK 工作与远程服务继续 | 首发实机 gate |
| 推送 | APNs 完成/失败/待处理提醒；默认不带项目/代码/命令 | 首发建议，尚未由用户单独确认 |
| 不做 | Android、团队 RBAC、屏幕远控、任意进程接管、退出 App 后常驻、跨主机迁移 | 当前范围外 |

目标体验：电脑登录 Scry → 启用远程并确认权限/电源说明 → 手机登录扫码 → Mac 确认手机 → 手机选择电脑/项目操作。首次配对允许在 Mac 前完成；日常 CLI 操作、普通审批和仓库指纹授权不应要求反复走回电脑。

## 2. 架构与信任边界

```text
                          Cloud control plane
                     账号、发现、路由、撤销同步
                        /               \
                iPhone                   Mac Scry
                   \                      /
                    Outer TLS / WSS relay
                    （按已授权路由转发密文）
                   /                      \
           iOS RemoteClient == inner TLS == RemoteGateway
                 │          E2E mTLS             │
        SwiftUI / Keychain                Application Services
                                               │
                                 Provider / Run / Trust / PTY
                                               │
                                    archive / DB / .scry

        Mac activity publisher → Notification service → APNs → iOS
        （单独的最小状态通道，不是命令/审批授权通道）
```

### 2.1 云端能做什么，不能做什么

- 控制面负责账号、在线路由提示、环境/设备关联、短期路由票据、撤销传播和限流；不持有 Provider 凭证或宿主设备私钥。
- 转发面只连接已登记的 host/device 通道，不能接受用户任填的 URL、IP 或本机 origin，避免变成任意代理/SSRF。
- 转发面终止外层 TLS，但不能解密内层应用流；TLS 字节在端点间保序转发，不能插入、丢弃后仍继续假装同一条可靠流。故障则断开并重新建立内层会话。
- 云账号被盗不能直接控制已配对 Mac；新增设备仍需 Mac 确认和新密钥。账号恢复不自动恢复宿主控制权。
- 云端仍能看到账号、IP、连接时序、流量体积及最小通知元数据。E2EE 不防拒绝服务、流量分析、宿主/手机端点失陷或恶意产品更新。
- 所有 remote client 都是不可信输入源。即使是 owner-device，也不能跳过 schema、resource identity、trust 和 Provider capability 校验。
- Scry 不是安全沙箱；获准 Provider/终端以本机用户权限运行。API 项目边界不等于 shell 或 Provider 的文件隔离。

### 2.2 不改变的边界

桌面仍为 `window.scry → trusted IPC → application service`。不放宽 `contextIsolation`、`sandbox`、CSP 或 sender/frame/origin 校验；不让 renderer 直接联网拿宿主密钥。不把 recorder daemon 变成 Remote Gateway，不给 `src/core/turn-recorder/` 引入 Electron、SQLite 或远程依赖。

## 3. 配对、密钥与撤销

### 3.1 初次配对状态机

```text
remote_disabled
 → host_enabled（本机用户同意远程与电源策略）
 → pairing_created（短时、单次，主机侧发起）
 → device_proved（手机证明持有新私钥和配对秘密）
 → awaiting_host_confirmation（显示设备与密钥指纹）
 → paired_owner（权限/密钥授权落盘后才生效）
```

1. Mac 创建稳定 `hostId`、宿主身份/证书材料并安全保存。重启不换 hostId；重置身份必须重新配对，不静默接受云端提供的新宿主公钥。
2. Mac 用户显式创建配对。建议有效期 2 分钟、256-bit 随机秘密、最多一次成功兑换，主机保存 verifier，不可从设备列表恢复明文秘密。
3. 二维码包含协议版本、受限路由标识、宿主信任锚指纹、pairingId、配对秘密。二维码由 Mac 本地生成；秘密不进 URL query、访问日志、剪贴板历史或推送。若采用 Universal Link，秘密只放 fragment，App 消费后清除临时状态。
4. 手机在 Keychain 创建/保存自己的设备私钥，通过绑定二维码宿主身份的内层安全通道发送配对证明与公钥/CSR。初次未认证客户端只能访问配对合同，不能调用业务 API。
5. Mac 展示设备、公钥指纹和“可执行命令/修改文件/批准仓库代码”的后果，用户确认后再发行或登记设备证书与 owner-device grant。配对秘密泄露也不能跳过本机确认。
6. 原子落盘 grant、消耗配对凭证，失败则不发行有效控制权；重放只返回原事务可核对状态，不再产生新设备。后续连接要求内层双向认证，并逐调用检查 grant。

同一账号只是路由条件，不是配对确认。来自云端或手机的设备名称/头像仅供展示，不是身份依据。签名覆盖规范化协议字段，不对任意 JSON 字符串签名后自行猜测 canonicalization。

### 3.2 TLS 技术选择与尚未证明的部分

- 优先候选：内层 TLS 1.3；Mac 使用 Node TLS，iOS 验证 SwiftNIO SSL 的 TLS handler 与流通道适配。SwiftNIO SSL 基于 BoringSSL，提供 client/server handlers；这证明有标准库接缝，**不证明双层 WSS、证书签发、Keychain 和 iOS 后台已经可用**。[S1]
- 使用每宿主独立信任锚/已配对身份，验证证书链、用途、有效期和握手私钥持有证明；禁止“所有自签名证书都接受”。不能从 cloud response 直接替换 pin。
- 配对通道先认证宿主；完成配对后使用客户端证书认证。证书签发/续期所需库、iOS 私钥使用方式和具体 tunnel adapter 必须在 G0 验证后冻结。
- **关闭 TLS 0-RTT/early data**，避免把可重放的早期数据用于写操作。TLS session resumption 也不能绕过当前设备撤销检查。[S2]
- 内层私钥不传入 SwiftUI 展示层、Electron renderer 或云端。首版不承诺 Secure Enclave；只有验证选定 TLS 库能使用其不可导出密钥时才宣称硬件绑定。
- 若标准 TLS-over-tunnel 在 iOS 的性能/打包不合格，停在 G0 重新评估经维护的成熟加密通道；不能临时退化成“中继可读明文”或自写 AES/Nonce 协议后继续高权限上线。

### 3.3 撤销语义

- 本机撤销：持久化 grant 撤销 → 关闭该设备业务流 → 拒绝新命令及尚未执行的待授权动作。落盘失败不显示成功。
- 云端撤销：立即拒绝其路由/新票据，并将撤销交给主机；UI 区分 `cloud_revoked` 与 `host_enforced`。离线 Mac 不能被报告成已经处理。
- 建议路由/在线权限租约最多 5 分钟，连接中持续检查；不能只在握手时查一次。主机无法确认租约/撤销状态时停止接受新的远程业务操作，已接受的 Provider 工作不因此自动重启或终止。时钟/租约状态异常 fail closed。
- 撤销设备不等于已终止它先前启动的一切。保留独立“停止关联 runs/终端”动作，按真实 stop lifecycle 报告 requested/confirmed/unknown，不能模糊 pkill。
- 新增 owner-device、重置宿主身份或批量撤销须独立安全操作与再确认；不由模型提示、终端输出或普通审批响应间接触发。
- 设备丢失后需用另一已授权 owner 或 Mac 本地撤销。仅云账号找回不足以恢复旧密钥。

## 4. 应用协议 v1 草案

下列为设计合同，不是已存在的 SDK/API。外层 HTTPS 管理账号/路由；业务消息只在已认证的内层通道发送。

### 4.1 身份与版本

- `hostId`：稳定宿主身份；`hostEpoch`：每次宿主进程启动的新随机代次。
- `deviceId`/actor：从已验证设备证书与宿主 grant 得出，**不信任 payload 自报 actor**。
- `projectId`：主机映射到 canonical cwd；`sessionRef`：保留 provider/profile/session 身份的 opaque 引用；`runId`、`terminalId` 均由宿主管理，不作为 PID 使用。
- `protocolMajor/minor`、最低兼容版本、supportedOperations、Provider capability envelopes、payloadLimits 在 hello 中协商。缺失写操作能力即禁用，不从客户端版本猜测。
- 时间戳是展示信息；资源版本/代次用于冲突判断，不依赖手机时钟排序。

建议通用命令字段：`requestId`（本次传输关联）、`commandId`（本次用户意图）、`hostId`、`expectedHostEpoch`、`operation`、`target`、`expectedRevision`（按操作）、`payload`。

服务器回复按 discriminated union 区分 `receipt`、`result`、`error`；不要以 `{ ok: true }` 同时表示接收、启动、结束和记录完成。读请求用 requestId；有副作用的离散命令必须 commandId。PTY 输入另用第 7 节的流协议。

### 4.2 操作面

| 分组 | v1 操作 | 关键约束 |
| --- | --- | --- |
| 连接 | hello、host.status、device.list/revoke | 主机状态与云端 reachable hint 分开 |
| 项目 | project.list、project.authorization.inspect/confirm | 新根目录独立确认；不暴露通用 filesystem RPC |
| 会话 | session.list/read、session.create/fork、run.snapshot | read 无切换桌面上下文副作用；fork 受 capability 限制 |
| 执行 | run.start、run.stop、run.controls | 显式 provider/profile/session 与项目；同会话写入串行 |
| 请求 | question.list/respond、trust.inspect/confirm | 普通问题与执行指纹授权不混用 |
| 文件 | workspace.list/read/write/create/rename/move/trash | projectId + 相对路径；保留现有路径/受保护目录约束 |
| 差异 | diff.read | 分别标明 run/session/workspace diff 的来源与范围 |
| 终端 | terminal.create/list/claim/release/close；输入/输出流 | Scry-owned、显式项目、写控制权与 generation |
| Provider | provider.describe、settings.inspect/update | 不支持则 unavailable；认证与普通 operation 互斥 |
| 结果核对 | command.lookup | 不存在/已过期/结果未知必须区分 |
| 订阅 | subscribe、ack、unsubscribe、resync | 每客户端独立，携带 snapshot revision/cursor |

不远程提供 `shell.openExternal(anyUrl)`、`spawn(anyExecutable)`、`readFile(anyPath)` 或 `kill(anyPid)`。终端明确授权的是受管理 shell，不因此给 renderer 一条通用命令 IPC。Provider 凭证初始化、macOS TCC 等无法安全远程完成的动作返回 `requires_local_action`；最大权限不意味着所有系统 API 都支持远程。

### 4.3 owner-device 与 workspace 授权

owner-device 是功能权限，不假设所有目录已授权。既有项目可依据主机 grant 操作；新项目走结构化“解析目标 → 返回 canonical 根与挑战 → 人类确认 → 主机重验并登记”合同，不通过改 `currentCwd` 绕过限制。相对路径、symlink、`.git`/`.scry` 等受保护目录规则继续保留。

普通文件写入沿用 `expectedRevision`，不覆盖冲突内容；新增 rename/move/trash 需带目标身份/版本前置条件。同一 workspace 的 Scry 管理操作序列化；外部编辑器/Provider/终端仍可能同时写，必须重验而不能把内部锁称为全机文件事务。

### 4.4 执行 trust 挑战

`trust.inspect` 返回主机生成的 challengeId、hostEpoch、canonical cwd、Provider/profile、配置与 executable fingerprint、授权作用域、有效期及可读差异。`trust.confirm` 只能引用该挑战，不能由手机自行提交“已批准的 fingerprint”。用户确认后主机在执行前重算/重验身份，并按现有策略冻结获批执行材料；任一变化使旧挑战失效。桌面与手机竞争回复仍由同一 trust 服务裁决。

`full_access` 只改变该 Provider 明确支持的执行审批语义，不自动批准仓库控制的 MCP/Hook/plugin。**保留现有 recorder commitHook 的 auto_grant 例外**及 `source:auto`；`SCRY_COMMIT_HOOK_TRUST=prompt` 仍可恢复询问。本方案不改变此策略，也不把自动授权标记为手机人类批准。无法安全远程化的系统授权返回 requires_local_action。

### 4.5 边界与流量预算

初始设计预算，须性能测试调整：hello/控制消息 64 KiB；数据 frame 256 KiB；单连接发送缓冲 8 MiB。长文本/文件使用分块或分页，不因一个大附件耗尽订阅缓冲。保留现有 workspace 2 MiB 文本编辑上限、terminal 8 会话/64 KiB 单次输入上限；客户端协商只能缩小宿主预算，不能扩大。

按账号、宿主、设备和操作分别限流；慢客户端隔离，不反压所有本地 runs。容量耗尽返回明确 `overloaded`/`resync_required`。APK/IPA、Provider SDK、私钥和任意本机资源不走远程附件接口。

## 5. 命令去重、崩溃与证据

### 5.1 离散命令 receipt

建议 key：`(hostId, deviceId, commandId)`，记录 operation、宿主代次、规范化 payload hash、目标、预分配 resource ID、状态和最小结果索引。不得只依赖 WS requestId 或手机本地 outbox。

```text
received（仅内存，不返回“已接受”）
 → accepted（授权和幂等意图已持久保存）
 → dispatching（执行前 fence 已落盘）
 → effect_confirmed / effect_failed / outcome_unknown
```

- `run.start` 的 effect_confirmed 仅表示建立了可查询 run，不表示 Provider turn 完成；真正结果查 run 的状态与记录证据。
- 同一 commandId、同一 hash：返回已有 receipt，不再次产生副作用。同 ID 不同 hash：`command_conflict`。
- 每一步异步等待（尤其 trust）后，在实际执行前重验设备授权、资源身份、租约、预期版本和 shuttingDown 状态。
- receipt 持久化失败：拒绝新的远程离散写操作，不能“先执行再补记”。允许继续读取和本机停止现有工作；远程安全停止若无法记录，要明确告知需本机处理，不伪造已停止。
- accepted 后尚未 dispatch 即崩溃：恢复时标记取消/需重新确认，首版不自动恢复执行队列。
- dispatching 后崩溃：先根据预分配 runId、已有 archive/Provider/session/文件证据核对；不能确认就 outcome_unknown，**不自动重跑**。
- 旧 hostEpoch 的写入一律拒绝。旧 commandId 可查历史 receipt，但不能把手机缓存意图静默迁移到新进程。
- 未知结果不是新一次运行的授权。客户端只查状态；确需重新执行时让用户明确创建新意图并提示潜在重复后果。

### 5.2 存储选择

新增 `<userData>/remote/` 下专用、versioned、单进程写入的 command/grant store；不是 `.scry`、Provider transcript 或 SQLite analytics 的替代品。建议以原子写、文件/目录 fsync、checksum、恢复扫描实现最小 durable store；格式/故障注入必须先验证，不能因为 rename 成功就承诺断电持久。

关键理由：Scry 的 SQLite 可降级，不能在 native module 失效时让去重悄悄失效。拒绝用远程功能作为理由，把 recorder canonical state 搬进新数据库。

当前 hostEpoch 内保留去重键，容量不足拒绝新写；不得按短 TTL 删除已接受键后重新接受旧请求。旧 epoch 的结果按可配置保留期归档（建议初值 30 天，发布前定隐私策略）；过期查找返回 `receipt_expired`，不解释成“从未执行”。尽量只持久 hash/资源引用，不默认存原始 prompt、终端按键或凭证；元数据本身也按敏感信息保护。

### 5.3 证据不合并冒充

三种里程碑独立：命令意图接受 → Provider/文件/终端副作用 → archive/DB/.scry 持久证据。保留现有 `exact/estimated/partial/unavailable` 与 provenance；不将本地 receipt 拼成 Provider result，也不因通知送达显示 canonical record 已提交。

远程 actor 信息由认证层生成，可通过可选 versioned metadata 关联 intervention；不得把现有 `source`（请求/自动授权来源）改写成设备身份字段。旧 transcript/turn record 解码和无 actor 的历史展示必须兼容。

## 6. 订阅、快照与桌面并发

- 当前 `focusedRunId` 保留为桌面 UI 偏好；运行服务不再依赖它筛选手机问题/事件。手机选择项目不会修改全局 `currentCwd`。
- 新纯读历史服务按 sessionRef 缓存/分页，不调用有副作用的 `agent:loadSession`。与执行恢复上下文分离；revision 只让对应视图过期。
- 对每条事件流分配 `(hostEpoch, streamId, seq)`；在一致性边界内生成 snapshot 和 seq watermark，随后只交付 watermark 后事件，避免“读快照与订阅间漏一条”。
- 每客户端保存独立 cursor/ACK/预算。断线后同 epoch 且仍在保留窗口则补齐；跨 epoch、cursor 过期或超载则返回 resync_required，重新取权威快照。
- 有界重放缓存只用于传输，不成为 canonical 事实源。丢失的是显示增量就标显示缺口；不能反推 Provider 无工具调用，也不能重放命令弥补事件缺口。
- Provider output、运行终态、recording settle、待审批列表分别投影。`done` 不等同于 `providerSettled` 或 records 完成。
- 同一 provider/profile 继续使用 `ProviderOperationGate` 的 auth/operation 互斥；同一 session 的 start/续聊/恢复由应用服务串行裁决。不同项目并行不代表任意两个写操作无冲突。

## 7. 终端必须采用不同于聊天命令的协议

### 7.1 所有权与输入控制权

- terminal ownership：`desktop_window` 或显式创建的 `remote_host`。保留 desktop-owned terminal 在窗口 crash/navigation 时清理的安全行为；不能为了手机简单删掉所有 `closeAllTerminals`。
- 仅 remote_host 终端可以在关窗口或手机断连后保留，随整个 App quit 清理；普通桌面终端不静默升级为持久远程终端。
- 多端可以查看，但同一终端只有一个 writer lease。输入和 resize 携带 lease generation；owner 主动接管会递增 generation 并让旧输入失效，UI 显示当前控制端。
- 输入面始终绑定 terminalId 与主机登记身份；不按 PID 或目录名接管/停止任意进程。

### 7.2 输入不能盲重放

PTY 输入不是可持久幂等的业务事务。每个 writer generation 使用连续 inputSeq：重复 seq 去重，跳号或 hash 不同拒绝；分配/消耗序号与写 PTY 串行。写入发生后结果丢失/抛错标 unknown，不把这段输入自动补发。

同一宿主存活期间可查询 last accepted seq；主机或终端代次变化时旧输入流废弃。手机重新连接时未确认按键保留为“未确认发送”，不自动写进 shell。PTY ACK 最多证明字节被接收/交给 PTY，不能证明其中 shell 命令成功执行。

输出使用独立 byte cursor/有界缓存；超出缓存显示历史缺口。没有经过验证的终端屏幕快照协议前，不声称断线后完整还原 TUI；必要时先只读并要求用户显式重新取得输入权。终端 escape sequence、OSC clipboard、超链接和文件传输均是不可信输出，禁止自动执行或自动写系统剪贴板。

## 8. Mac 锁屏、电源与退出

状态拆分为：`process`、`connectivity`、`power`、`screenLock`、`providerAvailability`。任何观测不支持/过期均可为 unknown，不用一个 connected 绿点代替所有可用性。

| 事件 | 行为 |
| --- | --- |
| 启用远程 | 本地同意后启动网关/出站连接；按用户电源策略申请 prevent-app-suspension |
| Mac 锁屏/熄屏 | 不取消 runs/远程 PTY，不销毁 gateway；不强制亮屏 |
| 空闲但远程开启 | 依电源策略保持可接任务；不能只在已有 run 时保活 |
| 桌面窗口关闭 | 释放窗口订阅及 desktop-owned PTY；保留 remote-host PTY/runs/网关 |
| renderer crash/navigation | 原有窗口安全清理仍生效，远程服务状态不归 renderer 所有 |
| 系统 suspend | 停止接受新命令，连接视为不可靠；不承诺阻止手动睡眠或合盖 |
| 系统 resume | 重建连接、校验权限/租约、快照恢复；不重放未知命令 |
| 关闭远程功能 | 拒绝新远程操作、断开远程控制；已有任务是否停止使用独立显式选择，报告真实后果 |
| before-quit | 先标 shuttingDown、拒绝新命令；按现有 settleRunsForShutdown/截止时间清理全部 PTY/runs/providers；释放电源 blocker |

推荐“接电时保持远程可用”为易理解默认选项；电池继续运行须用户明确选择并说明耗电，不隐藏变更系统全局电源设置。锁屏下 Keychain、Provider 登录缓存、代理和 TCC 都需真机验证。FileVault 未解锁、退出登录、App 已退出以及依赖前台桌面的 Computer Use 不属于可用保证。

设备本地锁屏与手机本地锁屏不是同一问题。手机进入后台不维持永久 socket；Mac 保持任务，手机回前台重新鉴权/核对快照。

## 9. APNs、隐私与运维

- APNs 密钥只在通知服务，不随 Mac App/IPA 分发。Mac 的 activity publish 权限只能给该账号已登记设备发有限状态，不能指定任意 device token 或通知内容。
- payload 默认类似“有任务需要处理”，携带 opaque event reference；iOS 连接宿主后获取项目/请求详情。通知点击/Face ID 仅解锁本地操作，不直接成为主机审批证明。
- 关联 host/run 状态应做去重、合并、TTL 和限流；被撤销设备不继续接收新通知。APNs best-effort，不保证准点或逐条投递。
- 云日志不记录配对秘密、内层明文、Provider token、原始 prompt 或终端内容。指标只反映连接/延迟/错误/队列及受控 traceId；不把云端观察到流量当作 Provider 成功。
- 云故障：手机显示离线/重连，Mac 已接受任务继续；不重试写入意图。路由不可用与权限被撤销分开显示。
- 出站域名 allowlist 位于 main/connector；不放宽 renderer 网络策略。不同开发/生产环境密钥、路由、APNs sandbox/production 严格分开。
- 云成本至少拆控制面、数据转发带宽/连接时长、通知、数据库/日志；未选服务商前不许诺免费或固定月成本。发布地区/网络质量/隐私保留与账号删除流程属于发布前决策。

## 10. 代码落点与迁移顺序

以下新增目录/文件名为**规划**，目前不存在，不应直接当作可执行测试路径。

| 规划落点 | 职责 / 现有接缝 |
| --- | --- |
| `src/main/application/` | 无窗口的 Run/SessionRead/Workspace/Trust/Terminal services；从 index.ts 提取而非复制第二个 runner |
| `src/main/remote/` | Gateway、device grants、command receipts、subscription registry、power lifecycle、transport adapter |
| `src/shared/remote/` | wire envelopes、operation registry、错误与身份 DTO；映射现有 provider/runtime/trace/workspace 合同 |
| `apps/ios/` | SwiftUI、RemoteClient actor、Keychain、connection store、feature UI；路径在建工程时最终冻结 |
| `services/remote-relay/` | 账号适配、路由及密文字节转发；可分部署单元，不先绑定厂商 |
| `services/notifications/` | APNs publisher、设备 token 生命周期、最小 activity API |
| `docs/research/` | 方案/决策记录；本轮唯一实际改动范围 |

协议模型采用“单一 wire schema → TS/Swift 生成或校验”的构建链；不让 Swift 手抄并猜测 TS union。具体 schema/codegen 工具在 G0 选定；既有 Provider/evidence 域状态仍是唯一业务权威，wire DTO 只是显式投影，不新建第二套同义 run 状态。生成产物/fixture 漂移应能在 CI 检出。

### 必须正面处理的现有耦合

- `src/main/index.ts:1214-1233`：trusted IPC 校验保留，在其后调用同一应用服务。
- `src/main/index.ts:2153-2155`：start 校验全局 currentCwd；改为入口各自生成受验证 execution context，而非删除 cwd 授权。
- `src/main/index.ts:1718-1808`：历史加载 revision/cache 有副作用；拆出纯 read，保留桌面显式 resume 行为。
- `src/main/index.ts:2086-2138`、`src/main/run-registry.ts:11-94`：问题推送/focus 与 trace bridge 改为独立订阅。
- `src/main/index.ts:1139-1152,1414-1453`、`src/main/terminal-manager.ts:154-188`：terminal 依赖窗口/currentCwd，需 owner-aware cleanup 与授权的显式 cwd。
- `src/shared/workspace.ts:48-52`：现有 expectedRevision；保留冲突语义。
- `src/shared/runtime.ts:248-257`：intervention source 不作为 actor 使用。
- `src/main/provider-operation-gate.ts`：所有远程 Provider 配置/认证也必须经过同一互斥边界。

不要求一次迁移全部 preload API。先把新的 remote 入口连接到受测服务，再将对应桌面调用切入；每一步保持旧桌面行为可回归，不能在 Renderer WIP 上顺手重构。

## 11. 开发与验收 Gate

| Gate | 交付 | 必须看到的证据 | 失败时 |
| --- | --- | --- | --- |
| G0 协议/传输 spike | Swift↔Node 最小通道、协议生成、证书配对、模拟不可信转发；无真实 workspace 写入 | iPhone 真机通过蜂窝连接已锁屏 Mac；替换证书/重放配对失败；断线重连；二进制/打包可用 | 冻结高权限开发，调整传输或依赖；不得降级明文 |
| G1 应用服务 | 无焦点副作用的 session read/run context；独立订阅与命令账本 | 桌面看 A、手机读 B 不干扰；重复/并发/坏 schema/持久失败/进程崩溃注入 | 保留桌面路径，修本次接缝，不扩大到全 App 重写 |
| G2 任务与 trust | start/续聊/stop/full_access/远程请求与指纹授权 | Claude 与 Codex 各自真实 new/resume/stop；双端审批一次生效；指纹变化拒绝旧批准；auth 互斥 | 不宣称 Provider parity；未支持能力 unavailable |
| G3 文件/终端 | 路径授权、文件冲突、PTY ownership/控制权/流恢复 | 越界拒绝、外部修改冲突、旧 writer lease 拒绝、输入不重复、窗口 crash 安全清理 | 不自动重发输入，不绕过路径检查 |
| G4 日常可用 | 锁屏/电源/通知/撤销/版本兼容 | Mac 锁屏空闲后启动工作、手机锁屏通知、睡眠恢复、账号失陷但未配对拒绝、设备撤销租约到期 | 分开报告网络/权限/执行/记录未知；不能用 UI 绿点验收 |
| G5 公布发行 | 签名/公证/IPA、隐私/账号删除、云运维、独立安全评审 | 当前冻结版本真实端到端、断网/重放/恶意帧测试与 App Store 审核结果 | 未获得外部结果不宣称发布成功 |

真实验证需在用户明确授权的测试 Mac/设备、临时 workspace/userData 和测试账号执行；不使用真实项目 `.scry`、生产 Provider transcript/DB 做破坏性故障注入。没有手机/证书/开发者权限时只报告模拟层证据。

代码实施时按 [验证与交付](../agent/verification.md) 选择检查；本方案会跨 IPC、trust、持久化、PTY 和打包，正式合入/发布需扩大 gate。新增测试名、package scripts 与实际目录创建后再冻结命令，不在此列出尚不存在的可执行测试路径。

## 12. 待决定事项与下一项授权工作

无需再次确认：仅 iOS、公开发布、Mac 锁屏继续、退出 App 不管、最大功能权限。

进入外部服务选择/真实 G0 前需要：

1. 发布地区与主要网络环境（中国大陆/海外/两者），决定路由、账号可达性和数据部署。
2. Apple Developer/测试设备是否可用，以及最低 iOS 版本。
3. 云预算与账号登录方式、APNs 首发优先级。
4. G0 中选定具体 TLS/证书/codegen/终端库，并核查许可证、iOS 支持、CVE 与打包成本。

下一项建议工作：先澄清以上外部约束，再实施 **G0 最小加密连接与 Mac 锁屏验证**。G0 不包含任意命令、文件写入、真实 Provider 执行或生产部署；通过后才开始 G1/G2。当前“继续”用于收敛方案，不视为购买云服务、创建付费资源、远程开放真实电脑或开始生产高权限运行的授权。

## 来源与本轮验证

- 当前仓库 main/shared 源码，路径见第 10 节；[前置研究](./scry-ios-remote-research.md) 汇总竞品及 Apple/Electron 资料。
- [S1] [SwiftNIO SSL README](https://github.com/apple/swift-nio-ssl)（2026-09-12 获取）：BoringSSL-backed TLS 与 ChannelHandler；并非本方案跨隧道可用性证明。
- [S2] [RFC 8446 / TLS 1.3](https://www.rfc-editor.org/rfc/rfc8446)（尤其 early data/replay 风险）：采用标准协议，不自行发明加密算法。
- 本轮仅文档：核对本地引用、合同边界、diff；不构建、不启动 App、不创建云资源，不宣称 G0 已完成。
