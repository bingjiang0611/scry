# Scry iOS 远程操作调研

调研日期：2026-09-12。状态：研究与建议，非已批准技术方案，未实现。

## 1. 结论

**值得做，但应定位为「Scry 的移动控制端」，不是把 Electron 搬到 iOS，也不是手机本地运行 Provider CLI。**

建议形态：iPhone 发起/继续任务、查看进展、处理审批、审阅改动；Provider、凭证、项目、执行与 canonical evidence 继续由 Mac 持有。

优先路径：

1. 抽取少量不依赖窗口的应用服务，为 Mac Scry 增加默认关闭、按设备和项目授权的远程网关。
2. React Native / Expo 建独立移动客户端，共享 TypeScript 合同和纯状态逻辑，不直接复用桌面 DOM/CSS。
3. 内部版本先通过 Tailscale HTTPS 连接，不先建设账号系统和公网中继。
4. 首轮验证成功后再做推送、免 VPN 配网与后台宿主；独立 daemon 不是第一步前提。

**不是“加一个 WebSocket 就够了”。** 主要工程量在服务边界、多端一致性、安全授权、断线恢复和宿主生命周期，而非手机页面。

## 2. 研究范围与证据限制

- 暂按单用户、iPhone 控制本人 Mac 上的 Scry 调研；不默认包含团队共享、任意终端接管、云端执行或桌面屏幕控制。
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
Scry iOS（独立移动 UI）
  │ HTTPS：配对 / 快照 / 历史 / 受限命令
  │ WSS：按 run/session 订阅事件
  │ 首期经 Tailscale HTTPS 到达宿主
  ▼
Mac Remote Gateway（默认关闭）
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
- **后续**：若确认需要关 App、登录后自启、常驻 Mac mini，再拆独立宿主进程及 launchd/升级/凭证管理；桌面和手机成为平等客户端。
- `src/core/turn-recorder/` 保持 Electron/SQLite/Provider SDK-free；新的远程协议不进入 recorder core。
- SQLite 是 Scry 可降级组件，不能直接假定 T3 的“DB 单事务事件源”可移植。命令账本的持久方案另定；无可靠 receipt 存储时拒绝远程写入或明确禁止自动重试，不悄悄退化为可能重复执行。

### 手机技术栈选择

| 选项 | 判断 |
| --- | --- |
| React Native / Expo | 默认建议。契合现有 TS/React，能共享合同/纯逻辑，已有 T3 参考；审批、Markdown、diff、长列表仍需移动专用组件和实机性能验证 |
| SwiftUI | 若明确只做 Apple、极重原生体验且愿意维护第二套客户端逻辑，可优先；需要协议生成/契约测试，不能把 TS 类型共享收益算进去 |
| PWA / Capacitor | 可以快速验证窄闭环；不等于将桌面 renderer 托管即可运行，也不能假定包装后的后台/推送行为一致；不推荐直接把三栏桌面界面缩小当正式首版 |

**先固定远程协议和最小闭环，再定 UI 框架细节。** iOS 独占与未来 Android 需求尚待用户决定。

### 连接方式选择

| 方式 | 适合阶段 | 代价 / 边界 |
| --- | --- | --- |
| Tailscale + HTTPS + Scry 配对 | 自用/内部 TestFlight 首选；能覆盖外网而不自行开放公网入口 | 两端加入 tailnet，有安装和组织网络限制；仍需应用级鉴权 |
| 局域网 HTTPS 直连 | 开发/受控部署备选 | 手机和 Mac 必须可达；证书、iOS 本地网络权限、切网需处理；不默认退回明文 |
| 托管 tunnel/relay + 账号 + 配对 | 面向普通用户的第二阶段 | DNS/TLS、设备身份、撤销、服务成本、可用性、滥用控制和隐私责任 |
| 自研 P2P/WebRTC | 暂缓 | NAT/TURN、网络切换与移动后台增加复杂度；P2P 标签不能证明安全或无需服务器 |

Tailscale Serve 可将本地服务通过 tailnet 内 HTTPS 暴露；不是公网 Funnel。本次未实际配置或修改任何网络路由。[N1]

## 6. 首版安全与一致性合同

**Scry 仍不是安全沙箱。** 项目/scope 限制的是远程 API 权限，不证明 Provider 只能访问项目内文件；获准任务及工具最终以本机用户权限执行。`full_access` 的 Provider-specific 含义和独立仓库 trust gate 必须继续保留，不能把“手机已配对”解释为更强隔离或一揽子执行授权。

1. **配对不等于全权访问**：主机端确认，短时单次配对凭证换成可撤销设备身份；二维码不得包含长期通用 token。Keychain/安全存储保存设备私钥或凭证，日志不得记录它们。
2. **认证不等于授权**：建议区分 session/read、run/start、run/stop、question/respond、workspace/read 等 scope，并绑定宿主、项目及 run；管理配对和改变 trust 策略不授予普通手机会话。
3. **保留 trust gate**：首次或指纹变化的 MCP/Hook/plugin 执行继续 fail closed。首版可留在 Mac 确认，手机必须明确显示“等待主机授权”，不得自动允许或无限伪装运行。
4. **已有自动授权例外不能藏起来**：仓库当前 recorder commitHook 默认 auto_grant，远程启动也可能触发本机脚本。沿用并如实显示 source:auto，不改成“手机用户已批准”，不在本次研究中变更策略。
5. **同一意图不能因重连重复执行**：start/reply/stop 使用 clientCommandId、payload hash 和可查询 receipt；相同 ID 不同内容拒绝。客户端超时显示 unknown/待确认，查服务端结果，不盲重发。receipt 不证明 Provider 已完成，不能对外宣称跨系统 exactly-once。
6. **审批竞态由宿主裁决**：两端答同一请求，仅仍有效的一次响应生效；后来的返回 already_resolved/stale，包含可审计的 device/operator 信息。断网不自动批准。
7. **多端读状态相互独立**：focused session 属于客户端；执行目标使用显式项目/session/run 身份。同会话写入需串行或显式拒绝 busy，不做隐式抢占。
8. **重连是协议，不是 socket 自动重开**：需要宿主 epoch、event sequence、cursor、快照版本、缺口补齐；进程重启/窗口丢事件时可以要求 resync，旧实例审批和命令不得误用于新实例。
9. **证据与传输状态分开**：保留 exact/estimated/partial/unavailable、provenance；离线缓存是缓存，不代表当前 run 状态。手机只显示 Scry 所有的会话 catalog，不顺手收编任意终端会话。
10. **限制数据面**：按订阅分发；历史按字节/条数分页；附件按需读取；canonical path、symlink、敏感文件再校验。首版不开放任意路径、任意命令或 terminalWrite API。
11. **兼容和撤销必须可测**：协商 protocol/capability；拒绝未知写入能力；撤销设备终止订阅并阻止后续操作。TLS 是基线；若将来承诺中继不可读，则另行设计经评审的端到端加密和设备密钥生命周期，不能仅以 WSS 充当证明。

## 7. iOS 后台、宿主睡眠和 App Store

### 后台不是永久在线连接

Apple 说明普通 App 进入后台后会被挂起，额外后台执行时间是有限的，不能靠滥用音频/VoIP 保活来维持 Agent WebSocket。[A1][A3]

因此分为：

- 前台：WSS 实时更新，掉线后查快照/补齐。
- 后台：任务在 Mac 继续；若要主动提醒，需要 APNs。
- 回前台/点通知：通知只作唤起线索，重新鉴权并查询真实状态；不得把通知到达当作任务成功或审批授权。

APNs 需要持有推送资质的 provider server。技术上可自建，甚至个人 Mac 可作为发送方；但商业客户端不能把共享 APNs 私钥分发给所有 Mac。产品化通常需要小型推送服务。[A2]

推送和远程数据通道可以分开：**Tailscale 数据连接 + 最小通知服务**是有效组合，不必为推送同时做完整远程中继。通知默认只带不敏感 ID/状态，不带代码、命令、密钥；关联元数据泄露、发送频率、保留期也需声明。APNs 属于 best-effort，不保证每条准时送达。

### Mac 睡眠和退出

远程连接不能让已睡眠或断网的 Mac 自动继续执行。首版必须显示 awake/offline/disconnected/unknown，不承诺合盖可用。保持唤醒需用户明确启用并提示耗电；不把无窗口留进程当作后台服务保证。

### 上架风险

- 以原生任务/审批/审阅客户端呈现，代码执行留在用户 Mac，不在 iOS 下载执行 Provider CLI。
- Apple 2.5.2 涉及下载执行代码；2.5.4 限制后台模式使用。应在早期核查签名、entitlement、网络权限和隐私披露。[A3]
- **不能拿 4.2.7 当万能上架豁免**：该条是特定 Remote Desktop Clients 规则，包含 LAN/屏幕镜像等限制。Scry 的结构化 Agent 控制端并非通用屏幕镜像；适用分类与远程能力应向审核清楚说明，不能自行保证获批。
- T3 已有商店客户端只证明此类产品有先例，不保证 Scry 或所有功能通过。正式商业化另评估账号删除、付费/IAP 和第三方 AI 数据披露。

## 8. MVP 与阶段验收

### 阶段 A：远程只读闭环

单 Mac、明确授权项目、单手机；设备配对/撤销、连接状态、项目/会话列表、当前 run、历史、文本/diff 只读。先修纯读取 API、客户端独立焦点与快照订阅。

验收：桌面看 A 时手机读 B 不改变桌面；切 Wi-Fi/蜂窝、锁屏回前台后无错会话/假完成；未授权项目不可读；设备撤销后立即失权。

### 阶段 B：受限操作闭环

先以 Claude 主路径验证新建/续聊、停止、受支持的请求回复；第二个接 Codex，验证 capability 不同仍能诚实展示。其他 Provider 后续逐一接入，不能默认 parity。Provider 不支持 mid-run steer 时只允许完成后续聊或明确的 stop，不伪造“实时干预”。

验收：start 已被接受但响应丢失，不产生重复 run；双端审批只生效一次；过期审批拒绝；Provider/trust 等待状态可区分；手机断连不影响已授权任务继续；最终 archive/records 的证据语义不变。

**A+B 构成首个可用内测版**，但没有后台推送时必须明确这一限制。

### 阶段 C：形成日常可用产品

完成/失败/待审批 APNs；按反馈选择免 VPN 连接、账号体系；需要无人值守才拆独立宿主。Live Activities 在通知稳定后再做。

验收：真机锁屏通知、通知重复/延迟、点击时请求已过期、主机离线、跨版本客户端、凭证过期与撤销、隧道故障、升级恢复均有诚实状态。

首版明确不做：完整代码编辑器、交互终端、远程桌面、跨主机迁移、团队 RBAC、手机直接配置并授权任意 MCP/Hook、五 Provider 全能力对齐。

工程投入判断：客户端壳和基础列表是较小部分；应用服务拆分、幂等与重连、trust/审批、多端回归是主要部分；免配置中继/推送/daemon/上架是另一个工作包。现阶段不足以给可靠人日承诺，先用 A 阶段技术 spike 测出边界改造量。

## 9. 进入设计前需要决定

1. **先自用还是面向普通用户发布？** 自用推荐先接受 Tailscale；普通用户免配置诉求意味着更早投入云控制面。
2. **仅 iOS 还是未来 Android？** 默认 RN/Expo；强 Apple-only 原生偏好时再比较 SwiftUI。
3. **首版是否必须锁屏提醒、退出桌面 App 后继续运行？** 两者分别增加推送服务和宿主拆分，不应混成一个“远程连接”需求。
4. **手机拥有多大操作权？** 建议首版仅受限项目的任务操作与普通请求回复，首次仓库执行 trust 仍由 Mac 确认。

下一步建议：先确认上述范围，再写远程协议/授权威胁模型与阶段 A 的 spike 计划；不直接开始全功能 iOS 重写。

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
