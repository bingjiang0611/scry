# Scry iOS 多主机 · v2：手机只配 Mac1

状态：**用户已选交互 A（全部会话），并明确要求手机只配对 Mac1，经 Mac1 访问/发送到 Mac2，无需手机单独配对 Mac2。** 本目录仅技术方案和隔离原型，尚未实现双跳转发。用户另批准 `designs/ios-connection-feedback` 的状态精简 A 落地，两项不要混为同一个 A。

## 1. 确认后的体验与范围

```text
iPhone ── 手机现有 grant / mTLS ── Mac1 ── 现有桌面 grant / SSH+mTLS ── Mac2
                                    │                                │
                              本机执行与网关                     最终执行与证据
```

- 手机只保留 Mac1 的连接/证书。Mac1 已配对的桌面远程主机自动进入手机可用目标；Mac2 不扫码，不单独配对手机，不需要开放公网端口/中继。
- 首页默认「全部主机」，合并 Mac1/Mac2 会话，每条显示执行主机；可只筛选 Mac2。切换筛选不改变执行目标或停止已有任务。
- 新建页明确选择「执行主机」，Mac2 的路径标为「经 Mac1」。目录、Provider/profile、模型、权限、slash commands 全部来自选中的最终执行端。
- 打开 Mac2 会话后，历史、续聊、问题、停止固定归 Mac2；发送按钮写「发送到 Mac2」。新建改成 Mac1 不迁移这条会话。
- 换目标保留文字/附件草稿，清除旧目录与能力选择；重新校验附件的目标端能力/上限，工作区文件引用不能跨机复用。
- 主机管理在 Mac1 的「设置 → 远程访问」完成。手机不新增 SSH 地址/密钥，不发放新的工作区授权，不新增 Mac2 配对入口。
- **正常状态不常驻绿色“在线”或连接诊断。** 采用用户批准的状态 A：刷新成功短暂提示；失败只保留一条重试/详情提示，旧列表标明更新时间。执行路径「经 Mac1」是稳定归属信息，不是连接成功证明。

本期不做：任意转发、递归多跳、手机远程目录授权、复制 Mac2 凭据到手机、Mac1 后台 daemon、推送通知。Mac2 再连接 Mac3 不继续展开；需要多跳时重新定义授权与路由合同，不悄悄递归。

## 2. 安全语义：这次明确扩展什么

用户本次选择明确授权了 owner 手机复用 Mac1 已有的桌面远程权限：只要手机的 Mac1 owner grant 有效，即可经 Mac1 访问其既有获批桌面连接。不再要求每台机器额外手机配对，也不增加重复确认窗。

但这不是手机与 Mac2 的端到端身份：

- Mac1 终止手机 TLS，再以 **Mac1 自己的桌面设备证书**连接 Mac2。Mac1 能读取转发的内容；中继只处理手机到 Mac1 的加密传输。
- Mac2 验证的是 Mac1 的桌面 grant，不是手机证书。可附加 origin 元数据用于排障，但必须标为「Mac1 转述」，不能显示成 Mac2 独立认证了 iPhone。
- Mac1 在每个请求入口验证真实手机 peer certificate/grant；最终转发前重验 grant、目标连接、hostId/CA 与 operation。Mac2 按原合同继续重验 workspace、Provider/profile 与仓库 trust/fingerprint。
- 只允许 Mac1 内部连接目录解析出的目标。不接受手机提交 SSH 地址、证书、任意 URL、任意 op 或任意 workspace authority。无静默本机 fallback，不在失败时把 Mac2 任务发给 Mac1。
- 手机 grant 在 Mac1 撤销后禁止新的读取/发送/控制；Mac1→Mac2 grant 在 Mac2 撤销后只阻断 Mac2，不影响 Mac1 本机。对已经投递到下游的任务，撤销不等于回滚或自动停止，需从已授权的控制端核实/停止。
- 撤销与正在传输的请求有竞态：转发前重验能阻止尚未发出的请求，不能撤回已被 Mac2 接收的写操作。结果不明保持 unknown，不能宣称已取消。

## 3. 代码证据：可复用的部分与真实缺口

| 位置 | 已有能力 / 缺口 |
| --- | --- |
| `apps/ios/ScryRemote/RemoteConnection.swift`、`RemoteKeychain.swift` | 单个手机配对连接符合新要求，**不再做手机多证书目录**。v1 推荐独立配对的迁移方案废止。 |
| `src/main/remote/desktop-client.ts: catalog/history/trace/commands/submit/intentStatus/runStatus/stop/answer` | 已有 Mac1→Mac2 的受保护传输、身份固定、桌面读/执行与控制。主进程可复用它，不经 renderer/preload 转一圈。 |
| 同文件 `submit()` | 每次产生 randomUUID，并在网络写之前持久化 receipt；直接用它处理手机重试会制造另一笔下游 intent，需要稳定的来源绑定。 |
| 同文件 `catalog()` | 当前拉项目、Provider 和完整 sessionsPage 循环后返回；不能让手机多目标首屏每次都调用这份全量组合查询。 |
| `src/shared/desktop-remote.ts: DesktopRemoteSubmit` | 当前输入无手机原有 image/text attachments；转发不能静默丢附件，也不能把 Mac1 本地路径当 Mac2 路径。 |
| `src/main/remote/inner-mtls-host.ts`、`host-controller.ts`、`remote-host-service.ts` | 已有经认证的手机请求入口和本机执行入口；尚无受限执行目标协议/手机转发分支。 |
| `src/main/index.ts: listSessions/readHistoryTurnsPage` | 手机目前只读宿主本地 catalog/archive；没有联合 Mac1 的桌面远程目标。 |
| `src/shared/desktop-remote.ts: DesktopHostReadResult/history` | 桌面 history 来源是 trace archive，不能冒充手机本机路径中已有的全部原生恢复/preview capability。差异必须显式返回。 |
| `apps/ios/ScryRemote/AppModel.swift`、`RemoteRunStore.swift` | 当前身份/目录/运行只围绕一个执行端。手机连接不变，但执行目标维度必须进入 store、路由、草稿、outbox 与缓存。 |

以上是代码阅读结论，不是现有手机→Mac2已经可用。此前 iCTRL `127.0.0.1:8200` 的 device_info 返回 Connection refused，未取得手机现场；Mac1/Mac2 当前运行版本和隧道状态尚未实测。

## 4. 最小实现：复用 transport 与 receipt，不另造 Agent 执行器

### 4.1 目标目录与版本能力

- Mac1 声明新能力 `executionTargets: 1`（名称为方案提案），返回本机以及其已配对桌面连接的公开描述：不透明 targetId、显示名、固定的 hostId/CA identity、连接授权代次、能力与状态证据。不能把 SSH 参数/私钥发给手机。
- Mac1 保存的已配对但暂时断开的 Mac2 可以出现；展示最后更新时间/明确故障原因，不谎称可达。新配对或重配后的绑定由 Mac1 原有流程形成，不继承旧目标的未送达请求。
- 手机只向当前 Mac1 发送限定目标请求。协议显式区分 local 与 desktop target，禁止把缺失 target 当 Mac1 处理。旧手机请求无目标字段仍仅走现有本机入口；旧 Mac1 没有 capability 时手机保留本机能力，远程目标显示 unavailable，不假装能转发。
- 每个目标提供真实 capability；Mac2 老版本缺某能力就返回原因，不通过 Mac1 本机能力填充。为本期必要能力更新 Mac2 时仍不需要手机重新配对它。

### 4.2 请求与归属

- 在受信任 main/controller 中增加窄的 typed 目标分派：目标目录、Provider/commands、已授权目录、session page/history/status/live、submit/intent status、stop/answer。复用 DesktopRemoteClient 内部传输/校验，**不公开 raw request proxy**，不转发 desktopWorkbench 或通用文件/终端接口。
- 手机的目录浏览继续只走已有手机 `directoriesPage`/已授权项目子目录合同。不能直接借用桌面的 `desktopDirectory/selectDirectory`，后者有更宽的浏览/项目选择权限。
- 本机请求走现有 HostController 执行；Mac2 请求走 DesktopRemoteClient→Mac2 canonical 执行链。不在 Mac1 ProviderRegistry 启动同名 Provider，不创建 Mac1 本地 shadow run、SQLite 用量或 `.scry` record。Mac2 保持消息/usage/归档/record 的事实源。
- 执行上下文最少绑定：`gateway grant identity + target binding(hostId/CA/desktop grant generation) + providerId + agentProfileId + canonical cwd + externalSessionId/localId`。路由、草稿、缓存、问题、run/control ID 与所有晚到回包都验证这一范围。
- 手机仍只有 Mac1 一个 RemoteConnection。扩展执行上下文，而不是将「切目标」接到 `prepareConnectionReplacement/clearAllState`。Browse scope、newTaskTarget、openedConversationTarget 分开；保留其他目标未决任务。

### 4.3 双跳投递与崩溃恢复：关键验收门槛

```text
手机 durable outbox（intent U，目标绑定固定）
  → Mac1 校验 owner 与目标
  → 原有 desktop receipt 中原子保存：来源 U + grant identity + target binding + payload hash → 下游 intent D
  → 用同一个 D 向 Mac2 提交
  → Mac2 原 ledger 对 Mac1 证书 + D 去重
  → 回执原路返回；手机展示的目标始终是 Mac2
```

- 扩展现有 desktop receipt 的来源索引，不再维护第二份独立写日志。来源键包含手机授权身份、手机 intentId、目标授权代次；重复来源但 payload hash 不同必须拒绝。
- 把 desktop submit 的生成/持久化接缝抽成内部可复用路径；首次请求只分配一次下游 intent，重复请求先查持久 receipt。 renderer 的原 submit 行为保持不变，不能让它伪造手机来源。
- Mac1 在保存映射前崩溃：按顺序保证尚未转发；重试可重新登记。保存映射后、收到 Mac2 回执前崩溃：恢复同一个 D 查询；仅在权威确认未登记且授权仍有效时按既有合同用同一 D 续投。未知/超时不分配新 D。
- definitive pre-dispatch 拒绝与已发未知分开；安全压缩/清理 receipt 前必须满足已有终态/保留合同，不删除未知请求“解锁重试”。同一来源的并发请求合并，继承现有每连接写互斥，不顺手改变桌面 unknown receipt fence。
- stop/answer 必须按原目标/run/question 路由，不能用裸 runId 在所有目标中查找。Mac1 收到请求不代表 Mac2 已执行；UI 的 recorded、unknown、running、terminal 全部保留真实语义。

### 4.4 历史、附件与性能

- 首页首批按目标分页取 session metadata；从 DesktopRemoteClient 的全量 catalog 中拆出单页接缝，复用现有 cursor/snapshot 及校验。只拉可见会话最近窗口，不后台复制各机完整 transcript。
- Mac1 不拼造 Mac2 snapshot/更新时间；回复带最终来源、目标绑定、capability、partial/unavailable、来源时间。旧 Mac2 没有某快速 history 接口时明确降级来源，不把本机 Pi 原生恢复误投到 Mac1。
- 复用现有手机附件 wire 合同，补齐 desktop submit 的 bounded image/text bytes 转发并在 Mac1、Mac2 都校验；绝不传 Mac1 filesystem path 作为附件。若 Mac2 未声明该能力，发送前明确阻止带附件请求，可去掉附件后发纯文本，不能静默丢弃。
- 目录刷新最多两个目标并发，进行中的同目标请求合并；列表 lazy，payload 按现有帧上限分页/分块。不把桌面 4 MiB/32 MiB 的 history 结果直接塞进手机较小的 WebSocket 帧。
- 复用现有 live/watch/有界轮询与 iOS scene 生命周期；只对当前目标和有未决工作的目标维持必要观测，隐藏窗口暂停非必要刷新。容量达到现有显式上限时返回 reason，不截断后冒称完整。

## 5. 两段链路失败时，用户看到什么

| 状态 | 展示与行为 |
| --- | --- |
| 正常 | 全部会话和「经 Mac1」路径；不常驻“在线”。成功刷新短暂反馈，不表示持续在线。 |
| Mac1 可达，Mac2 失败 | 一条「Mac2 未刷新」提示，重试/详情；Mac1 会话可用。保留 Mac2 旧列表并标更新时间，不允许新发送/审批。 |
| 手机连不上 Mac1 | 一条「暂时无法连接 Mac1」提示，两目标缓存可读；两台都不可发送/审批。Mac2 可能仍运行，不能说它已停止或离线。 |
| Mac1 的手机 grant 撤销 | 阻止新读写/控制，提示在 Mac1 重新授权；不再展示为普通刷新成功。已投递下游任务不自动停止。 |
| Mac1→Mac2 grant 撤销/连接移除 | Mac2 不可操作，指向 Mac1 的远程访问设置处理；手机不出现 Mac2 扫码按钮。未决旧绑定不映射到重配后的新 grant。 |
| Mac1 尚未连接 Mac2 | 说明需在 Mac1 添加桌面远程主机；不要求手机给 Mac2 配对。 |
| Mac1 旧版 | Mac2 转发 unavailable + 更新 Mac1 的具体说明；本机请求不受影响。 |

每个屏幕只保留其相关的一条失败提示；其他技术原因放详情。范围不是“当前所有主机都失败”时不能用全局断开文案。

## 6. 预计文件落点与验收

- Gateway/main：`src/main/remote/{inner-mtls-host,host-controller,host-controller-factory,remote-host-service,desktop-client}.ts`、`src/main/index.ts`，增加窄 typed 路由、能力、receipt 来源绑定与分页；测试覆盖生产认证 wrapper，不只测纯解析函数。
- 跨端合同：扩展 `src/shared/desktop-remote.ts` 与 `experiments/remote-g0/swift/Sources/RemoteTransport/` 对应 wire/history 协议，不引入 Electron/SDK 到独立 recorder。
- iOS：`AppModel.swift`、`RemoteRunStore.swift`、`RemoteRunClient.swift`、`RemoteHistoryCache.swift` 及 Home/NewSession/Transcript/Settings。复用选择 sheet 和语义 tokens，文案统一到 iOS copy 模块。
- v1 的手机多主机 Keychain 目录/逐机配对迁移 **不再实施**；只对旧 outbox、cache/session identity 增加 local target 归属的无损迁移。旧无目标消息只属于 Mac1，不能补成当前 UI 所选的 Mac2。

| 验收场景 | 必须证明的结果 |
| --- | --- |
| 只配 Mac1 | 手机无 Mac2 key/cert，能读 Mac2 真实消息并在 Mac2 新建/续聊；Mac2 保持 SSH-only，无公网暴露 |
| 真实执行与证据 | Mac2 临时 workspace/Provider session/archive/record 对应；Mac1 不产生同一轮本地 Provider 执行与双份记录/用量 |
| 双跳丢回执/杀进程 | U→D 固定；Mac2 只建立一次 run。分别在持久化前后、网络写前后故障注入；故意每次生成 D 时测试必须失败 |
| 同名与竞态 | 两目标同 session/run/question ID、同机不同 profile、晚到回包/重复答案不串线；换新建目标不改已发送的 outbox |
| 授权与恶意 payload | 原手机证书撤销、下游撤销、错 host/CA/代次、未知 target/任意 op/越权目录全部拒绝；特权 listener 未执行 |
| 最终边界 | Mac2 workspace/trust/fingerprint gate 仍真实执行；手机未得到桌面广域目录选择/终端权限 |
| 能力与压力 | 两端版本差异、图文附件拒绝/完整转发、超大 history 分块、部分失败仍诚实，不伪造空/零/在线 |
| 真机 | iCTRL 恢复后用真实 iPhone 和两台目标、隔离 workspace 验收；真实付费 Provider 调用需明确账号/费用授权，不用模拟器代替 |
| 性能 | 热路径变更后按仓库性能闭环测请求/字节/首屏；毫秒测量串行。不以 L1 计数冒充真机更快 |

实施顺序：冻结协议/授权与失败场景 → typed 双跳只读与目标隔离 → 稳定 intent/恢复 → 新建续聊及控制/附件 → 相关安全/持久化 gate → 双机真机验收。不能只做主机下拉框。

## 7. 设计依据与版本记录

- 复用生产 `apps/ios/ScryRemote/Theme.swift`、扁平列表及 selection sheet；沿用用户选择的全部会话 A，无新增底栏。截图中的状态 A 来自 `designs/ios-connection-feedback/README.md`，与本方案结合，不再用绿色状态点堆满每条会话。
- 延续本任务已实际看过的原始参考：Termius 官方 iPhone Connections 画面 `https://termius.com/free-ssh-client-for-iphone`，仅借内容有明确主机归属；不引入其大块终端卡片/云凭据模型。Tailscale fast-user-switching 文档只作“当前选择有标记”的参考，不作为独立手机配对要求的依据。
- 历史画面 `designs/scry-ios-transcript/implementation-history-warning.png` 仅作语义色/文本密度参考，不当成当前真机截图。Craft 的根背景、光学对齐、即时 focus/hover 继续沿用；44pt 命中与 SwiftUI 原生语义来自项目约束。
- v1：独立配对路线为助手建议，未获用户认可，现被本 v2 取代。用户认可的是交互 A 与单 Mac1 配对目标；不能写成双跳实现/成品验收通过。
- 原型为合成数据，不连接凭据、不创建隧道、不发真实消息。页面工具栏可切换 Mac2 失败、Mac1 不可达、撤销、旧版、空/加载等状态。

## 8. 本轮检查与边界

- `node --test designs/scry-ios-multihost/prototype.test.mjs`：11/11。新增 Mac1 不可达时两目标禁止发送、上游手机授权撤销与下游单独撤销的区别；仍是原型状态检查，不是转发协议实现。
- v2 经 Chrome Relay 查看正常画面与「Mac2 · 经 Mac1」路径，并实际切换 Mac1 不可达场景，读回两处发送按钮 disabled。随后“详情”点击超时（结果 unknown），同 tab 一次 recover 亦超时，未重发、未改用其他浏览器。最终删除重复的每行缓存时间/主机正常状态文字，仅保留失败区来源时间；这项最终减法未再次渲染核对。
- 旧预览进程退出后重新启动了仅绑定 `127.0.0.1:8769` 的本目录静态服务。入口 `index.html`，不公开项目其余文件或凭据。用户可在本地打开检查。
- 原型 _d_meta 登记为 v2 / needs-review。用户确认的是 A 交互和单 Mac1 配对要求，不等于 v2 像素稿或双跳产品能力已验收。
- 独立的状态 A 已按用户后续要求落地原生 iOS，验证见 `../ios-connection-feedback/README.md`；该提交不实现本方案的 Mac1→Mac2 目标协议或稳定 U→D 回执。

## D-SCRY-IOS-MULTIHOST

项目范围，需求与交互方向已确认；实现与视觉成品待验收。用户本轮补充：「希望手机配对 mac1 后可以直接发送到 mac2，不需要单独配对」。设计动作：保留聚合 A，将执行路径改为经 Mac1 的受限代理，删除手机 Mac2 配对入口；目标归属和双跳回执必须显式。下次检查：手机只持有 Mac1 凭据、两端撤销分别生效、U→D 不变、没有桌面权限扩张或本机 fallback。共享条目仍为 `D-SCRY-IOS-MULTIHOST`，不把这次选择升级为全局授权策略。
