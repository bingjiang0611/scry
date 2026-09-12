# Scry iOS 远程操作调研

调研日期：2026-09-12。状态：产品范围已由用户补充确认；技术选型仍为建议，未实现。

## 0. 已确认的产品约束

用户确认：**仅 iOS、面向普通用户发布、Mac 锁屏要能运行、退出桌面 App 后不要求继续、最大权限。**

据此调整：

- 不规划 Android；SwiftUI 成为优先评估方案，不把框架选型当作用户已批准事项。
- 普通用户无需安装 VPN、配置 SSH 或路由器。托管连接与扫码配对进入首发范围，Tailscale 只作研发备选。
- Mac 保持登录、Scry 进程运行时，锁屏/熄屏不应中断受支持的后台任务；不承诺系统睡眠、合盖、重启未解锁或退出 Scry 后在线。
- “最大权限”按手机具有宿主管理端能力设计，包括任务、文件、终端、Provider 权限与可远程化的执行授权；**不是 root 权限、绕过 macOS TCC，也不是取消配对或仓库 trust gate**。
- 产品支持 full access，但每位实际用户须在配对时明确批准管理设备和真实权限后果。本次要求不是替所有未来用户授权。
- 手机后台推送尚未由用户单独确认；面向普通用户的首发建议包含完成/失败/待处理提醒，Live Activities 暂缓。

## 1. 结论

**值得做，但应定位为「Scry 的移动控制端」，不是把 Electron 搬到 iOS，也不是手机本地运行 Provider CLI。**

建议形态：iPhone 发起/继续任务、查看进展、处理审批、审阅改动；Provider、凭证、项目、执行与 canonical evidence 继续由 Mac 持有。

优先路径：

1. 抽取不依赖窗口的应用服务，为 Mac Scry 增加默认关闭、显式授予手机管理权的远程网关。
2. 优先评估 SwiftUI 原生 iOS 客户端，以版本化协议及生成模型对接 TS 后端；React Native 保留作研发效率对照。
3. 首发提供账号/设备发现、主机端扫码配对、出站托管连接；不要求用户开放入站端口或安装 Tailscale。
4. 推荐端到端加密的数据面与独立 APNs 服务；先验证设备密钥、撤销和命令一致性，再扩展高权限操作。
5. 网关跟随 Electron 主进程；补锁屏/熄屏保持运行与电源管理，不拆退出 App 后继续运行的 daemon。

**不是“加一个 WebSocket 就够了”。** 主要工程量在服务边界、多端一致性、安全授权、断线恢复和宿主生命周期，而非手机页面。

## 2. 研究范围与证据限制

- 按公开发布、每位用户用 iPhone 控制本人 Mac 上的 Scry 调研；包含经授权创建和操作的远程终端，不默认接管任意既有终端进程。团队共享、云端执行和桌面屏幕控制不在当前范围。
- Scry 基线：`0.2.148`，Git HEAD `2974cda`；工作树已有 UI WIP，本次不修改它们。
- T3 Code：检查官方仓库 README、远程/认证/架构文档、移动端 package.json、relay 文档和 LICENSE。目录树查询返回 SHA `e816064945144957b6eb9b268912a98b0555644b`，内容通过当时的 main 获取；不能当作冻结版本的运行验收。
- Codex：检查 OpenAI 当前官方 Remote、Remote connections、app-server 文档。
- iOS：检查 Apple 后台执行、APNs 和 App Review 官方资料。
- 本次是公开资料与源码静态调研；没有安装或操作竞品、配对手机、运行真实远程任务、验证推送或进行完整安全审计。

## 3. 竞品：已经具备什么

### T3 Code：最直接的架构参考

| 方面 | 已查证事实 | 对 Scry 的启示 |
| --- | --- | --- |
| 客户端 | 官方提供 iOS、Android、Web、Electron；移动端用 React Native / Expo | 多端共享协议和状态，不等于共享所有 UI |
| 执行归属 | Provider、Git、终端、文件、持久状态在 environment server | 手机是控制端；不传输 Provider 登录凭证来重建执行环境 |
| 直连 | 支持 LAN/private network 一次性配对；支持 Tailscale HTTPS | 网络可达与应用授权应独立 |
| 无路由器配置连接 | T3 Connect 管理账号、环境链接和托管 tunnel endpoint | 产品化连接比增加 socket 多一套控制面 |
| 认证 | environment 自签发 scoped session；DPoP、短期 WS ticket、逐 RPC scope 校验；可撤销设备 | 连接成功不能意味着所有操作都获批 |
| 多端状态 | 共享 client-runtime；持久事件、投影、命令 receipt 在事务内提交 | 区分“命令被接受”和“实际执行成功”，处理重复提交 |
| 推送 | T3 Connect 支持完成、失败、审批、输入提醒及 iOS Live Activity | direct/Tailscale 本身不提供后台推送 |
| 许可 | 根 LICENSE 为 MIT | 可以借鉴或有选择复用；复制时保留声明，另查依赖/native vendor 许可 |

值得特别澄清：

- T3 的 relay Worker 是**控制面**，正常 HTTP/WS 会话不由该 Worker 代理；应用流量走 environment 的 tunnel hostname。不能据此说「不经过任何云网络」。
- 文档明确 relay 是可信 broker，签名密钥失陷仍有风险。DPoP 不等于整条数据链端到端加密，也不是“服务端零信任”。
- T3 的 `orchestration:read` 允许读取宿主账号可读的项目外绝对路径。这是它的设计选择，**不应照搬到 Scry 的远程文件授权**。
- 它的服务端已有独立事件日志架构。Scry 不必为借鉴移动端而迁移到它整套 Effect/数据库/状态系统。

依据：[T1]–[T8]。

### Codex：优先借鉴体验，不能假设能复用官方远程基础设施

当前官方 Remote 文档已说明：

- ChatGPT iOS/Android 客户端可连接运行桌面 App 的 Mac/Windows 主机。
- 从主机端启动设置，扫码，使用相同账号/workspace，按需要完成 MFA/SSO/passkey；功能受 rollout 和组织设置影响。
- 手机能新建任务、续聊、指导执行、批准操作、看 diff/测试结果/终端输出，并接收提醒。
- 执行使用宿主的项目、凭证、工具和安全设置；宿主必须保持在线、唤醒且 App 运行。
- 官方说明有 secure relay；这些页面不足以证明其底层为某种特定 E2EE 协议。

必须区分三条链路：

1. **手机 Remote → 官方桌面宿主**：面向用户的产品；手机配对不能从 CLI/IDE 发起。
2. **桌面 App → SSH host**：通过 SSH 启动/管理远程 Codex app-server。
3. **自建客户端 → Codex app-server**：开源集成接口，双向 JSON-RPC，支持流式事件和审批。

app-server 当前文档仍把 WebSocket transport 标为 experimental/unsupported，并警告非 loopback listener 在 rollout 期间默认可能未启用认证，必须主动配置认证和 TLS。因此：

- 不能把裸 `codex app-server` 暴露到公网。
- app-server 可以作为 **Scry Codex adapter 的内部能力**，不能代替多 Provider 的 Scry Remote 协议。
- 未发现可让第三方 Scry iOS 直接接入官方 Remote 配对/relay 的公共集成合同；不要把这当作可复用 SDK。
- 官方产品支持更复杂的 SSH、跨主机 handoff；Scry 首版不应因此同时承诺跨主机迁移。

依据：[C1]–[C3]。

## 4. Scry 现状：哪些能复用，哪些必须拆开

以下是远程扩展缺口，不是认定当前桌面版存在漏洞。行号为调研时源码位置。

| 领域 | 现有能力 | 远程改造要点 / 代码证据 |
| --- | --- | --- |
| 操作合同 | start/stop、session、activeRuns、问题回复、workspace、terminal | preload 是能力清单，不是网络 allowlist；`src/preload/index.ts:109-240` |
| Provider | emit/requestUserInput/interrupt 等注入式合同 | 可复用 adapter，保留各 Provider capability；`src/main/providers/types.ts:40-99` |
| 并发 run | 按 runId 保存状态/控制器，支持快照 | 焦点目前只有一份；`src/main/run-registry.ts:11-94` |
| 审批 | broker 去重、规范化、拒绝过期回复，留下 intervention | 尚无远程答复者身份；原生 trust dialog 另走路径；`src/main/user-question.ts:79-132`、`src/main/index.ts:540-577,2086-2116` |
| 实时事件 | 批量传输、背压、超载时明确 degraded/resyncRequired | 单窗口 bridge，bytes ACK 不等于可重连日志；`src/main/trace-output.ts:36-121`、`src/main/index.ts:2123-2138` |
| 历史 | archive/Provider 合并，历史分页 | loadSession 有会话切换副作用，单份 cache/revision；`src/main/index.ts:1770-1808`、`src/main/session-history.ts:26-53` |
| workspace | canonical cwd、已知项目、文件路径约束 | 增加设备→项目→操作授权，不能只认“本机已知目录”；`src/main/workspace-authorization.ts:4-25`、`src/main/workspace-files.ts:18-70` |
| IPC | 校验唯一窗口、mainFrame、renderer URL | 不放宽此边界；另建网络认证入口；`src/main/index.ts:1214-1233` |
| 生命周期 | 退出时收敛 runs，取消问题，释放 Providers | 真正退出即失联；Mac 无窗口留进程不等于 headless 服务；`src/main/index.ts:1139-1152,3559-3585` |

最容易踩的坑：

- `agent:start` 会把请求 cwd 与全局 `currentCwd` 比较（`src/main/index.ts:2153-2155`）。桌面看项目 A、手机启动 B，不能靠取消校验解决，必须把 UI 选择与执行授权拆开。
- 当前 `loadSession` 不是纯读接口。手机浏览历史不应切换桌面的恢复上下文或让另一个客户端分页失效。
- pending questions 虽然保存在 run 中，但实时问题推送依赖当前 focused run。远程订阅不能继承桌面焦点过滤。
- 已有 recorder daemon 是独立录制用途的本地 socket HTTP 接口；OAuth loopback、OpenCode server、Codex app-server 都不是现成的 Scry Remote 服务。不得把 recorder 扩成远程执行入口。

## 5. 推荐架构

```text
Scry iOS（优先评估 SwiftUI）
  │ 账号与设备发现 → 云控制面（不等同于宿主授权）
  │ 主机扫码确认 → 绑定设备密钥与管理权限
  │ 加密命令/事件 → 托管转发数据面 ← Mac 主动建立出站连接
  │ 通知 ← APNs ← 独立最小通知服务
  ▼
Mac Remote Gateway（默认关闭，建议数据面端到端加密）
  设备身份、撤销、scope、项目授权、schema、限流
  协议版本、幂等命令 receipt、订阅与补齐
  ▼
Scry Application Services（与窗口无关的应用服务）
  ├── 现有 Electron IPC → 同一服务；保留 renderer 安全边界
  └── 现有 ProviderRegistry / RunRegistry / question broker
         ▼
      本机 CLI / SDK / server
         ▼
      原有 archive / DB / .scry canonical records
```

分步演进，而不是一次性重构：

- **第一步**：仅提取移动端必需服务；网关仍跟随 Electron 主进程。明确要求 Scry App 运行，不承诺退出后继续。
- **当前明确不做**：独立 daemon、退出桌面 App 后继续运行、开机未登录即运行。关闭窗口与真正退出必须区分：若进程仍在，远程任务/终端不得因为窗口销毁而被清理；现有终端窗口关闭行为需调整。
- `src/core/turn-recorder/` 保持 Electron/SQLite/Provider SDK-free；新的远程协议不进入 recorder core。
- SQLite 是 Scry 可降级组件，不能直接假定 T3 的“DB 单事务事件源”可移植。命令账本的持久方案另定；无可靠 receipt 存储时拒绝远程写入或明确禁止自动重试，不悄悄退化为可能重复执行。

### 手机技术栈选择

| 选项 | 判断 |
| --- | --- |
| SwiftUI | 新约束下优先评估。仅 iOS，不再为 Android 预付复杂度；适合原生导航、安全存储和系统集成。协议模型需生成/契约测试；Markdown、diff、终端与长列表仍要实机验证，不能宣称纯 SwiftUI 即可解决所有复杂组件 |
| React Native / Expo | 效率备选。现有 TS/React 经验和 T3 代码更容易借鉴；只做 iOS 也完全可行。若 spike 表明 SwiftUI 客户端逻辑/组件成本过高，再选择此路线 |
| PWA / Capacitor | 可以快速验证窄闭环；不等于将桌面 renderer 托管即可运行，也不能假定包装后的后台/推送行为一致；不推荐直接把三栏桌面界面缩小当正式首版 |

**仅 iOS 已确认，SwiftUI 尚未最终选定。** 用协议对接、流式长列表、diff 和终端输入的技术 spike 比较实现成本，不单凭“原生”标签决定。

### 连接方式选择

| 方式 | 适合阶段 | 代价 / 边界 |
| --- | --- | --- |
| 托管连接 + 账号 + 设备密钥配对 | 面向普通用户的首发方案；Mac 主动出站连接 | DNS/TLS、设备身份、撤销、服务成本、可用性、滥用控制和隐私责任；建议转发密文，不把账号登录等同于获准控制宿主 |
| Tailscale + HTTPS + Scry 配对 | 仅研发/诊断备选，不是用户安装前提 | 两端加入 tailnet；仍需应用级鉴权 |
| 局域网 HTTPS 直连 | 后续可选优化，不阻塞公网远程闭环 | 手机和 Mac 必须可达；证书、iOS 本地网络权限、切网需处理；不默认退回明文 |
| 自研 P2P/WebRTC | 暂缓 | NAT/TURN、网络切换与移动后台增加复杂度；P2P 标签不能证明安全或无需服务器 |

推荐将账号/发现、数据转发、通知分成三个责任面。主机本地确认建立设备信任，账号找回不能自动获得新的宿主控制权；设备私钥不交给云端，中继断线不取消已接受的任务。选择成熟、经评审的加密协议，不自创密码学。即便转发密文，云端仍能观测连接/IP/流量时序等元数据，不能宣称“零数据”。具体中继服务商、部署地区和协议尚未选定。

Tailscale Serve 可将本地服务通过 tailnet 内 HTTPS 暴露；不是公网 Funnel。本次未实际配置或修改任何网络路由。[N1]

## 6. 首版安全与一致性合同

**Scry 仍不是安全沙箱。** 项目/scope 限制的是远程 API 权限，不证明 Provider 只能访问项目内文件；获准任务及工具最终以本机用户权限执行。`full_access` 的 Provider-specific 含义和独立仓库 trust gate 必须继续保留，不能把“手机已配对”解释为更强隔离或一揽子执行授权。

1. **显式授予最大管理权**：主机端明确展示手机可执行命令、修改文件及批准仓库代码的后果，用户确认后才授予可撤销的 owner-device 身份。短时单次配对凭证绑定设备密钥；二维码不得包含长期通用 token。Keychain/安全存储保存设备私钥或凭证，日志不得记录它们。
2. **最大权限仍需逐操作校验**：owner-device 可以获授任务、文件写入、终端、Provider 配置与 trust 审批能力，但所有 API 仍为显式 allowlist，并校验设备、目标宿主、资源和操作。支持当前 Provider 的 full_access，不映射成 sudo/root，也不越过 macOS TCC。远程新增管理设备或变更安全策略须独立二次确认，不能靠一条聊天提示或普通 token 续期扩大权力。
3. **将可远程的 trust 审批带到手机，而不是删掉**：首次或指纹变化的 MCP/Hook/plugin 仍需独立确认；主机产生带 canonical cwd、配置/executable fingerprint、请求代次及有效期的挑战，手机展示后签署/提交，主机重新校验才能执行。变更后旧批准失效；保留批准来源/设备证据。不能远程完成的系统授权明确显示“需在 Mac 解锁处理”，不能自动允许。
4. **已有自动授权例外不能藏起来**：仓库当前 recorder commitHook 默认 auto_grant，远程启动也可能触发本机脚本。沿用并如实显示 source:auto，不改成“手机用户已批准”，不在本次研究中变更策略。
5. **同一意图不能因重连重复执行**：start/reply/stop 使用 clientCommandId、payload hash 和可查询 receipt；相同 ID 不同内容拒绝。客户端超时显示 unknown/待确认，查服务端结果，不盲重发。receipt 不证明 Provider 已完成，不能对外宣称跨系统 exactly-once。
6. **审批竞态由宿主裁决**：两端答同一请求，仅仍有效的一次响应生效；后来的返回 already_resolved/stale，包含可审计的 device/operator 信息。断网不自动批准。
7. **多端读状态相互独立**：focused session 属于客户端；执行目标使用显式项目/session/run 身份。同会话写入需串行或显式拒绝 busy，不做隐式抢占。
8. **重连是协议，不是 socket 自动重开**：需要宿主 epoch、event sequence、cursor、快照版本、缺口补齐；进程重启/窗口丢事件时可以要求 resync，旧实例审批和命令不得误用于新实例。
9. **证据与传输状态分开**：保留 exact/estimated/partial/unavailable、provenance；离线缓存是缓存，不代表当前 run 状态。手机只显示 Scry 所有的会话 catalog，不顺手收编任意终端会话。
10. **高权限操作走专门合同**：文件编辑和交互终端纳入产品范围，但不新增 renderer 任意路径/命令 IPC。文件仍经授权根目录、canonical path、symlink 与敏感路径校验；新项目/目录必须显式授权。terminalWrite 只能作用于获授权且由 Scry 登记的终端，不能接管任意 PID；断连、重连和关闭窗口的终端生命周期单独定义。按订阅分发，历史按字节/条数分页，附件按需读取。
11. **兼容、撤销与加密必须可测**：协商 protocol/capability；拒绝未知写入能力；主机收到撤销后终止订阅并阻止后续操作。离线主机重新接受命令前先同步撤销状态或要求仍有效的短期授权，不能声称云端点击后离线主机已立即处理。最大控制权使中继成为高价值目标，推荐首发采用经评审的端到端加密与设备密钥生命周期；WSS/TLS 不能替代这一证明。

## 7. iOS 后台、宿主睡眠和 App Store

### 后台不是永久在线连接

Apple 说明普通 App 进入后台后会被挂起，额外后台执行时间是有限的，不能靠滥用音频/VoIP 保活来维持 Agent WebSocket。[A1][A3]

因此分为：

- 前台：WSS 实时更新，掉线后查快照/补齐。
- 后台：任务在 Mac 继续；若要主动提醒，需要 APNs。
- 回前台/点通知：通知只作唤起线索，重新鉴权并查询真实状态；不得把通知到达当作任务成功或审批授权。

APNs 需要持有推送资质的 provider server。技术上可自建，甚至个人 Mac 可作为发送方；但商业客户端不能把共享 APNs 私钥分发给所有 Mac。产品化通常需要小型推送服务。[A2]

推送和远程数据通道分开设计：本方案为**托管加密数据连接 + 最小通知服务**。通知默认只带不敏感 ID/状态，不带代码、命令、密钥；关联元数据泄露、发送频率、保留期也需声明。研发直连时也可单独接通知服务，不要求走同一条隧道。APNs 属于 best-effort，不保证每条准时送达。

### Mac 锁屏运行：已确认的验收要求

锁屏、熄屏、系统睡眠、退出登录、退出 Scry 是不同状态：

| 宿主状态 | 目标行为 |
| --- | --- |
| 已登录、Scry 运行、屏幕锁定/熄灭 | 支持 CLI/SDK、Git、构建和不依赖前台 UI 的授权任务继续运行，并能从手机启动/停止/审批 |
| 关闭 Scry 窗口但进程仍在 | 远程连接、任务与受管理终端不随窗口销毁；需解除当前窗口生命周期耦合 |
| 用户真正退出 Scry | 正常收敛运行并显示离线；不做 daemon 接管，不要求手机重新启动已退出的 App |
| 系统睡眠、合盖导致休眠、关机或退出登录 | 不承诺可用；恢复后重连并核对状态，不能重放未知命令 |
| 重启后 FileVault 尚未解锁 | 不承诺运行 |
| 任务依赖桌面 Computer Use、前台浏览器或系统授权 UI | 锁屏可用性逐能力验证；不满足时显示需解锁/不可用，不伪装普通任务继续 |

建议在启用远程控制时提供明确的“允许熄屏、保持 Mac 唤醒”选项，说明耗电和电池策略。使用 Electron 主进程的 `powerSaveBlocker.start('prevent-app-suspension')` 作为待验证实现候选；该模式保持系统活动而允许屏幕关闭，不应使用 `prevent-display-sleep` 强制亮屏。[E1] 生命周期与远程服务启停绑定，而非只在已有任务执行时启用，避免空闲睡眠后手机无法启动新任务。显式睡眠、合盖和系统强制休眠不作绕过保证。

Keychain 凭证、Provider 登录状态、网络代理和 TCC 在锁屏下的行为须真实测试；不能因为 Node 进程存在就宣称所有能力可用。

### 上架风险

- 以原生任务/审批/审阅客户端呈现，代码执行留在用户 Mac，不在 iOS 下载执行 Provider CLI。
- Apple 2.5.2 涉及下载执行代码；2.5.4 限制后台模式使用。应在早期核查签名、entitlement、网络权限和隐私披露。[A3]
- **不能拿 4.2.7 当万能上架豁免**：该条是特定 Remote Desktop Clients 规则，包含 LAN/屏幕镜像等限制。Scry 的结构化 Agent 控制端并非通用屏幕镜像；适用分类与远程能力应向审核清楚说明，不能自行保证获批。
- T3 已有商店客户端只证明此类产品有先例，不保证 Scry 或所有功能通过。正式商业化另评估账号删除、付费/IAP 和第三方 AI 数据披露。

## 8. 首发范围与内部阶段验收

以下 A/B 是内部工程里程碑，**不是削弱用户要求的只读首发版**。公开首发须达到约定的完整管理能力与 Mac 锁屏运行要求。

### 阶段 A：连接与锁屏技术 spike

主机确认扫码配对、设备密钥、托管出站连接、只读快照、客户端独立焦点，以及保持 Mac 唤醒。优先验证 SwiftUI 与 TS 协议、流式列表和后续终端组件成本。

验收：不安装 VPN、不开放路由器端口，手机蜂窝网络可连接 Mac；桌面看 A 时手机读 B 不改变桌面；Mac 先锁屏并空闲后仍可连接；熄屏不断线；睡眠和真正退出正确离线；加密身份不被中继替换。技术 spike 成功不等于生产安全验收。

### 阶段 B：完整管理操作闭环

任务新建/续聊/停止、full_access 的 Provider-specific 显示与选择、远程问题与指纹 trust 审批、授权 workspace 文件操作、受管理交互终端及 Git 结果审阅。先 Claude、再 Codex，其他 Provider 逐一验收；不支持 mid-run steer 时明确降级，不伪造实时干预。

验收：Mac 锁屏时真实开始并完成 CLI 工作；手机断连不影响已接受任务；start 响应丢失不重复 run；双端审批只生效一次；指纹变化使旧批准失效；未知终端/路径拒绝；关闭窗口不终止远程终端，退出 App 则按既有收敛语义清理。最终 archive/records 保留原有证据语义。

### 阶段 C：面向普通用户发布

完成账号恢复与设备撤销、跨版本与升级兼容、托管连接运维/限流/隐私、真机网络矩阵、安全评审和 App Store 准备；建议首发包含完成/失败/待处理 APNs。账号找回不得静默获得宿主密钥或新设备授权。Live Activities 暂缓。

验收：手机锁屏通知、通知重复/延迟、点击时审批已过期、离线主机撤销同步、客户端凭证过期、中继不可用和反复切网均有诚实状态；额外检查中继泄露/替换流量、旧设备密钥和高权限命令重放。

当前不做：完整 IDE、远程桌面屏幕控制、接管任意既有终端进程、跨主机迁移、团队 RBAC、退出 App 后继续的 daemon、绕过 OS 权限、五 Provider 全能力对齐。

工程投入判断：相较原来的 Tailscale 自用方案，首发新增云连接/设备密钥、文件和终端写入、可远程 trust、安全运维与上架成本；省掉 Android 与 daemon。现阶段不足以给可靠人日承诺，先测出连接/锁屏与服务拆分的真实工作量。

## 9. 下一步决策与边界

产品方向已确认，不再重复询问平台、发布对象或退出 App 后的需求。下一步先写技术方案，不直接动功能代码：

1. 设备配对、端到端加密、owner-device 权限、账号恢复与撤销的威胁模型和协议。
2. Electron 网关/应用服务拆分，以及锁屏/电源/窗口/退出生命周期。
3. SwiftUI 与协议生成的技术 spike，覆盖 diff/终端等复杂内容，不先做视觉页面。
4. 根据目标市场与预算选择账号/托管转发/通知部署。发布地区、最低 iOS 版本、云预算与手机后台通知首发优先级仍待确定，不擅自购买或部署外部服务。

“最大权限”的本报告解释是完整功能授权，不是自动放行所有仓库代码。若用户实际希望取消独立 trust gate，需要单独讨论具体策略与后果；不能将这四个字当作默许变更现有安全边界。

## 来源

均于 2026-09-12 获取；线上页面及 main 分支持续变化。以下来源支持已查证事实，推荐方案是本报告判断。

- [T1] [T3 Code README 与客户端入口](https://github.com/pingdotgg/t3code)
- [T2] [T3 Remote access](https://github.com/pingdotgg/t3code/blob/main/docs/user/remote-access.md)
- [T3] [T3 Architecture](https://github.com/pingdotgg/t3code/blob/main/docs/internals/overview.md) / [Remote architecture](https://github.com/pingdotgg/t3code/blob/main/docs/internals/remote.md)
- [T4] [Environment authentication](https://github.com/pingdotgg/t3code/blob/main/docs/internals/environment-auth.md)
- [T5] [T3 Connect trust boundary](https://github.com/pingdotgg/t3code/blob/main/docs/internals/t3-connect.md) / [Relay README](https://github.com/pingdotgg/t3code/blob/main/infra/relay/README.md)
- [T6] [Mobile package.json](https://github.com/pingdotgg/t3code/blob/main/apps/mobile/package.json)
- [T7] [Mobile notifications](https://github.com/pingdotgg/t3code/blob/main/docs/user/mobile-notifications.md)
- [T8] [T3 LICENSE](https://github.com/pingdotgg/t3code/blob/main/LICENSE)
- [C1] [Codex Remote](https://developers.openai.com/codex/remote)
- [C2] [Codex Remote connections](https://developers.openai.com/codex/remote-connections)
- [C3] [Codex app-server](https://developers.openai.com/codex/app-server/)
- [N1] [Tailscale Serve](https://tailscale.com/kb/1312/serve)
- [A1] [Apple：Extending your app’s background execution time](https://developer.apple.com/documentation/uikit/extending-your-app-s-background-execution-time)
- [A2] [Apple：Setting up a remote notification server](https://developer.apple.com/documentation/usernotifications/setting-up-a-remote-notification-server)
- [A3] [Apple App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/)（2.5.2、2.5.4、4.2.7）
- [E1] [Electron powerSaveBlocker](https://www.electronjs.org/docs/latest/api/power-save-blocker)（保持系统活动与保持屏幕亮起的区别；仅文档查证，未实机验证）
