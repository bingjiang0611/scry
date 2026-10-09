# iOS 会话历史缓存与加载优化 — 2026-10-08

## 范围与原因

用户反馈打开会话长时间停留在“正在同步会话”，并明确允许将数据保存在手机上。

旧路径只有进程内缓存；完整历史按 64 KiB 顺序分页，每页单独经过中继与双层 TLS，全部下载/校验后才展示。前次真机历史读取曾超过 25 秒观察期限，但本次没有拿这个时间当作可复现的性能基准。

本次版本 **0.1.2 (3)**，保留 v5 布局和现有配对。只改 iOS 历史读取、缓存和必要状态提示，不调用真实 Provider，也不修改主机授权协议。

## 行为合同

- 冷启动读取 `Caches/ScryHistory`，先展示已有完整历史，再在后台核对主机。缓存不证明主机在线或授权仍有效；旧内容、同步时间、后台失败分别显示。
- 缓存键包含 host、anchor、device grant、provider、cwd、session。普通退出登录保留；设置提供清除入口，解除配对先清除缓存。
- 原子写入、iOS Complete Data Protection、排除备份；不存配对私钥或未发送草稿。历史正文仍是隐私数据。
- 最多 **64 MiB / 20 个会话**，按写入时间淘汰；超限历史仅保留本次内存并提示。iOS 也可以自行回收 Caches，因此它不是永久备份。
- 单条内存缓存：同进程 30 秒内重开可免请求；从磁盘读取的缓存总会后台核对。快照未变只读第一页，不重建长文本，也不重写已成功保存的文件；此前保存失败时仍允许重试。
- 快照改变后最多两个分页并发，按 cursor 重新排序；仍验证 page size、cursor、total、snapshot 和完整 SHA256。保持既有最多三次快照变化重读，256 MiB 协议读取上限。
- 切换会话/主机、清除缓存时，generation 和磁盘 actor epoch 拒绝过期结果及清除后的旧写入。终态最终刷新先等待进行中的下载，避免最后一次读取被去重丢掉。

### 有意保留的边界

历史协议没有稳定 turn ID，无法证明远端快照已经包含哪条本机运行。对已有本机运行增量的会话，暂时保留历史基底 + 本机增量，不重新混入主机快照；界面明确提示重启后再核对完整主机历史。基底丢失时标为 unavailable，不能显示成空历史。升级这条策略需要主机提供可核对的稳定 turn ID/覆盖证据，不能按重复 prompt 猜测去重。

首次没有缓存仍需下载完整历史，弱网/TLS 故障并未由缓存根治。超过当前缓存/完整快照边界、或持续变化的大会话仍难以读取时，应升级服务端稳定分页/增量协议，而不是继续增加客户端重试。

## 最终源代码验证

- Debug Simulator、签名 Debug iphoneos（generic destination）、无签名 Release iphoneos：均构建成功。
- 隔离 Simulator `-historyCacheTest`：**20 PASS、0 FAIL**；Complete Data Protection 属性检查 **1 SKIP**（模拟器不提供该属性，真机仍强制检查）。覆盖乱序页、未变仅一请求、坏 digest/cursor、授权命名空间、重新创建 cache actor 后读取、排除备份、损坏文件、容量边界、清除后晚写，以及真实 store 路径的离线缓存/更新错误/本机增量/基底缺失状态。
- 隔离 Simulator 原 `-selfTest`：**31 PASS、0 FAIL**；Keychain 仍因 unsigned simulator entitlement 缺失跳过。
- `npm run test:unit -- src/main/remote/remote-gateway.test.ts`：**23 PASS**，包括完整历史分页和快照 fence。
- 故意将 epoch 相等保护放宽为 `<=`：`lateWriteRejected`、`clearPersists` 两项确实失败。恢复保护、重建并重跑后全部通过；变异版仅安装到隔离 Simulator。
- 150,062-byte 合成历史在最终模拟器运行中磁盘读取约 4.61 ms。这只测 actor 读取/解码，不是手机 UI 首帧、冷启动或真实网络性能。
- `git diff --check` 通过。Swift 编译负责 iOS 类型检查；未执行无关桌面全量发布 gate。

## 首轮失败与未验证

- 指定手机 destination 的首次 build 退出 70：设备 unavailable，之后改用 generic iphoneos 构建；未把此失败说成已安装。
- 首次 Swift 编译发现局部函数 MainActor 隔离错误，显式标注隔离后通过。
- 前两次缓存测试的 Data Protection 断言失败，后一次打印确认 Simulator 的 protection attribute 为 nil。只在 Simulator 明确跳过；未移除真机断言。
- 复核修复了终态刷新被去重、自动刷新重复本机增量、缺失基底被当空历史、保存失败后丢失警告等问题。终态归档时序的真实网络重放仍未验证。
- 初次手机 unavailable，重连后又因锁屏而无法挂载 developer disk image；用户解锁后已覆盖安装 **0.1.2 (3)**，未卸载。安装和自测结果见下节；真实界面验收仍受自动化启动失败阻塞，无本次真机录像。
- 未测真实弱网注入、锁屏时缓存读取、首次下载/进程重启的真实耗时、真实 Provider 执行或付费操作。

## 重连后的真机验证

- iPhone 17 Pro / `00008150-001A29A926D8401C`：安装前源码和应用 SHA256 与构建 manifest 一致，安装回执成功，设备应用列表确认 **0.1.2 / 3**。
- 真机 `-historyCacheTest`：**21 PASS、0 FAIL、0 SKIP**，包括 Complete Data Protection 文件属性、排除备份及临时目录/独立 defaults 中的缓存与 store 场景。合成历史读取约 0.217 ms，仅为 fixture 的磁盘读取/解码，不代表真实会话 UI 速度。
- 真机 `-selfTest`：**36 PASS、0 FAIL、0 SKIP**，包括隔离 Keychain 场景；不把测试凭据成功说成真实主机连通成功。
- 安装后读取应用公开连接描述，确认已有 host/anchor/device grant 描述仍存在；未重新配对、未清除真实缓存或真实凭据。
- WDA 首次启动指向缺失的默认 DerivedData 产物；改为已存在的专用产物后，63 秒报 `Timed out while enabling automation mode`。停止继续排障，未将自动化失败归因于 App，也未宣称已验证历史重开/杀进程重开的真实耗时。
- 已停止本次端口转发，两个 WDA xcodebuild 进程均已退出；最终无 mock/self-test 参数普通启动 Scry。未发送真实任务，没有新真机录像。

## 证据与下一步

本地忽略目录 `.local/ios-history-cache-2026-10-08/` 保存最终构建/测试、首轮失败、变异测试与源码/应用哈希；不上传隐私资料。构建产物：

`/tmp/scry-ios-reinstall.uzxNTU/DerivedData/Build/Products/Debug-iphoneos/ScryRemote.app`

0.1.2 安装和真机自测已完成。下面记录用户继续反馈后的 0.1.3；0.1.2 的验收不能作为新版本证明。真实发送/审批/执行仍不属于验证范围。

## 0.1.3 (4)：首屏优先，取消首次同步提示

用户反馈 0.1.2 仍慢，要求“不要有首次同步的提示，用户无感，把首次载入做到毫秒级”。这是性能目标和对上一版的否定，不是已达到毫秒级的证据。

### 改动与保留边界

- 冷读取第一分页获得 snapshot/total 后，优先取最后一至两页（最多 128 KiB），仅解码其中完整的最近两轮。若有可读消息，不再等待所有旧历史；尾部分页在完整拼接中复用，不重复下载。
- 预览明确为 `partial`，不是完成校验的快照。串中的引号、反斜杠、嵌套对象和 UTF-8 边界由有界反向结构扫描定位；最终仍用标准 JSONDecoder 解码。重试撤回未校验网络预览；错误不写磁盘，完整 SHA256 通过后才缓存。
- 首屏仅渲染最近两轮，按需展开较早的 20 轮；每轮默认最后 16 个内容块、每块及 prompt 默认最多 500 字符，完整原文可展开。并非删除历史或改写归档。使用从结尾距离的**展示**身份维持尾部预览→完整快照的视图；它不充当 canonical turn ID，也不用于业务去重。
- 在列表读取时，仅预热两个最近会话的**已有磁盘缓存**，每个首屏保留至多 128 KiB 文本；没有增加冷网络预取。现有 NIO exchange 不随 Swift cancellation 立即关闭，额外预取可能争抢前台中继，因此未采用该方案。切会话/clear/unpair 的 generation/connection fence 保留。
- 首屏前不并发加载 Provider/command 元信息；有内容或明确失败/基底 unavailable 后再读取。切换身份立即撤销上一项目 commands，避免延迟加载期间暴露陈旧命令。
- 没有“首次同步”或常驻同步说明。正常等待读取仅有无文字骨架；部分/缓存状态由时钟图标及右上角菜单显式呈现；真实错误仍显示。未用空屏/假成功掩盖无内容。

### 验证

- 当前源码 Debug Simulator、签名 Debug iphoneos、无签名 Release iphoneos：构建成功，设备产物签名验证通过。
- Simulator `-historyCacheTest`：36 PASS、0 FAIL，Data Protection 属性 1 SKIP；原自测 31 PASS、0 FAIL，Keychain 1 SKIP。
- 新 800 KiB 合成历史证明：只读第 0 页与最后两页（三个请求，两个网络回合）即可发布完整最近两轮，其余旧分页尚未读取；完整返回仍校验全部 bytes。还验证 Unicode/引号/反斜杠的每个字节起点、超大不完整轮不伪造、尾部页不重复请求、变更配对拒绝旧预览、重试保留有效本地内容/撤回未校验内容、前台优先、清除与 commands 隔离。
- 故意移除预览 connection fence：`store.previewRejectsChangedConnection` 确实 FAIL。恢复并重跑后通过；变异版只在隔离 Simulator 执行。
- 主机 gateway 原有 23 项测试通过；本次没有修改主机或 transport 协议。
- 原生 Simulator 合成截图检查了长内容展开入口、partial 保留本机已完成续聊、无同步文案的骨架。初次 loading fixture 因残留 mock runId 被 Root 导到 Chat，修正 fixture 后重拍；初始白色启动帧及错误路径截图保留，不算成功。截图不证明实际触摸、展开、旧消息锚点、动态字体或真实耗时。

### 尚未达到的目标

**没有实测证明任意首次载入达到毫秒级。** Host 在第一个分页前仍读取/合并/序列化整段历史；网络 RTT、TLS 与主机读取不能由客户端消除。最近单轮大于尾部窗口时，完整轮预览不可用，仍等待完整读取。若这些情况持续阻塞首屏，应升级主机稳定 turn/chunk 首屏 API 与索引/增量镜像，不继续猜测截断 JSON 或增加重试。

本轮手机起初 unavailable，随后再次在线。已覆盖安装 **0.1.3 (4)**，应用列表和 install receipt 确认；真机历史测试 **37 PASS / 0 FAIL / 0 SKIP**，原自测 **36 PASS / 0 FAIL / 0 SKIP**。这些自测不证明真实首屏性能。

### 实机读取验收失败（必须保留）

WDA 本轮启动成功。无 mock 参数普通启动、进入已有 DEBUG 本地登录后，真实主机会话列表成功读取，配对有效；仅打开之前的 Pi Pocket 会话，**未发送消息或处理审批**。

- `first-open-timing.json` 从点击前开始做有界 AX 观察：约 40 秒截止时仍没有采样到正文，随后的原生截图确认仍为骨架。脚本按长正文节点筛选，不是毫秒级帧计时，也不证明没有任何短暂/短文本出现；不能据此给精确首帧数值。
- 私有录像 `live-firstscreen.mp4` 全部解码通过；30 秒间隔 contact sheet 前 12 帧持续是列表/骨架。该采样与截图支持“仍很慢”，不冒充逐帧性能测量。通知/聊天等隐私只保留本地。
- 当前手机 Caches 列表未见 `ScryHistory` 文件夹，尚未证明这个真实会话完成快照并写入缓存。缓存重开/杀进程重开的真实性能本次未验收。
- 只读检查安装中的 Mac App **0.2.153**：其打包代码存在 64 KiB historyPage 与 30 秒 snapshot 缓存，排除了明显分页大小不兼容；只检查了相关代码片段，不是全包审核。
- 只读解析该会话三个 trace archive 文件的顶层/文件大小（约 1.20 MB、155 KB、109 KB）；不是完整正文阅读，也不是 wire history 大小。主机首次响应前全量读取/合并，以及超大单轮无完整尾部预览是已知结构限制，但**尚未定位这次卡顿具体发生在主机读、TLS、分页还是快照重试**。
- 因验收失败，不能把 0.1.3 描述成已解决慢加载或已达毫秒级。下一步需要加首屏链路时序诊断，并考虑主机稳定 turn/chunk 首屏索引和手机提前镜像，不能再只隐藏提示或增加客户端重试。
- 主机目录标记多条会话运行中；未重启/更新 Mac App，也未停止 Agent。已恢复 iPhone 普通首页，本次 WDA、端口转发、录像进程全部退出；设备进程清单无 WDA Runner，仅保留正常 Scry App。

本轮忽略目录 `.local/ios-firstscreen-2026-10-08/` 保存源码/应用 hashes、构建/测试、变异失败、最终源代码合成截图。设计反馈更新已登记的 `D-20261008-scry-ios-continuity` 来源，索引 build 与“首屏” search 可命中；全库 check 因其他仓库既有 `P-PI-MODEL-SELECTOR` 路径缺失退出 1，未擅自修改该记录。

## 受限 SAFE LOCAL CODE lane：structured historyPreview（未部署）

本轮仅修改源码和隔离 fixture，未重启/安装 Mac App、未调用真实 Provider/API、未写真实 userData/DB/transcript，也未覆盖 `.local/ios-firstscreen-2026-10-08` 或 `.local/ios-history-cache-2026-10-08`。新验证日志写入 `/tmp/scry-ios-preview-next/`。

- 主机新增 `historyPreview`：沿用已认证 peer certificate、workspace/cwd 与现有 remote controller/gateway 路径；`status: unavailable` 与真实空历史分离。活跃内存 run 优先；否则仅调用 `readTraceArchivePageAsync({ limit: 2 })`，不调用完整 transcript/history。Claude 无快速 archive 证据明确 unavailable。
- preview 最多两轮、每轮两个最近 item、每项 UTF-8 安全短摘录，gateway 对 JSON 保留约 16 KiB 上限，并保留 `source`、`partial`、`truncated`。`readMode` 区分 indexed、index rebuild、legacy monolithic，未把 legacy 全量读取伪装成常数时间。
- Swift transport/RunClient 先取一次 typed preview，再执行既有完整分页与 SHA256 校验；已删除 byte-suffix JSON parser。iOS 在同一 `RemoteHistoryCache` actor 内以 `preview-` mirror 分开保存，沿用保护、备份排除、host/anchor/grant/provider/cwd/session key、entry/byte limit、clear epoch；完整缓存合同不变。
- 目录 preload 只读最多两个已有 preview mirror，不发起冷网络预取；前台 request generation、connection、clear epoch 仍拒绝陈旧展示/写入。preview 仍是 partial，不是完整 digest receipt。

### 本轮验证与缺口

- `npm run typecheck`：通过。
- `npx vitest run src/main/remote/remote-gateway.test.ts src/main/remote/inner-mtls-host.test.ts src/main/transcript-archive.test.ts`：59 tests passed；覆盖 authorized/denied preview、malformed query、unavailable 与空历史区分、Unicode/16 KiB bound、archive page 既有 index 行为。
- `cd experiments/remote-g0/swift && swift build`：通过。
- 首次 iOS Debug Simulator build 因 self-test 局部变量重名失败；修复后 `xcodebuild ... -derivedDataPath /tmp/scry-ios-preview-next/DerivedData CODE_SIGNING_ALLOWED=NO build` 通过。仅构建，未安装/启动 App。
- 上述为第一版 WIP 的检查，不代表以下修复版或真机验收。

## 2026-10-09：首屏预览回归修复（源码，未部署）

- JSON 转义字节预算不再丢弃整个真实轮次；保留来源截断标记，`bytes` 等于实际编码长度。活动/归档正文投影只遍历最近 256 个事件，每字段至多 2,048 UTF-16 单元，再交由 Gateway 限制为两轮、两条目与 16 KiB。不展开外置工具结果，也不假造结果。
- 归档支持 Claude，并分别报告 `indexed_archive`、`index_rebuild`、`monolithic`；后两种仍可能读完整旧归档，不能承诺冷启动常数耗时或毫秒级。
- 手机先读小镜像、再读完整磁盘快照；镜像实际进入 partial 正文、更新渲染 revision。失败/unavailable 不覆盖好镜像，跨会话不复用；预览传输及镜像含封装上限均为 17 KiB，完整历史仍必须通过 SHA256。
- 删除完整下载的额外尾页阶段与重复预览绘制；不显示首次同步成功提示。保护文件、备份排除、授权命名空间、clear epoch 与本地运行增量语义保留。
- Gateway 控制字符回归先失败、修复后通过；四个受影响 Node 测试文件共 65 PASS。`npm run typecheck`、`npm run build` 通过。
- Simulator 历史检查首次新增 unavailable 场景失败：Swift 原合成解码器错误要求 unavailable 也含 turns。修复为按 status 解码后 42 PASS / 0 FAIL，保护属性 SKIP。新增镜像失败保留、重启读取、跨会话隔离、unavailable 不擦除、clear 后晚写拒绝五项。
- 最终 17 KiB 传输限制版本 Debug Simulator 编译通过；最后安装尝试因该 Simulator 已 Shutdown 返回 code 405，未启动这份最终二进制。此前一次安装超时后以安装文件 SHA256 与构建文件一致核验，不以超时假装未安装。
- `-selfTest` launch 100 秒超时、无结果；未算通过。全量 `npm test` 240 秒超时并见 worker IPC channel closed；检查资源与进程后改为两个 worker 的全量 unit 仍在 240 秒被中止，期间 recorder/Git diff fixture 有断言失败及 5 秒超时；shell 阶段未执行。保留首轮日志，不改无关测试、断言或超时，未声称全量通过。
- 未更新桌面/手机、未重启 Scry、未发送 Provider 消息。真实首屏、完整校验、暖重开及进程重启耗时仍未验收；手机已有 0.1.3 (4) 不包含这套新协议。下一步需通过部署 gate、安装匹配桌面/手机版本，再进行同一 Pi 会话的认证只读验收。

## 2026-10-09：0.1.4 (5) / 桌面 0.2.157 安装候选

### 实现范围

- 预览和完整历史分页共用一个新鲜 TLS 1.3 mTLS tunnel。显式 opt-in `keepAlive`，仅允许 `historyPreview/historyPage`；每次请求重查 grant，证书到期拒绝后续数据，禁止 pipelining，30 秒空闲关闭，host 关闭时销毁通道。旧客户端仍按单次交换关闭。
- 新客户端请求 256 KiB 页，旧客户端默认仍为 64 KiB。两个待处理读取在单通道上串行发送，接收有长度/超时限制；断线/取消清理等待 Promise。已建立通道随 Swift cancellation 关闭；建立前仍依赖 NIO/upgrade deadlines，不声称所有阶段立即取消。
- 同一范围的并发组装共享一个 Promise；完整历史逐 turn 序列化并让出主循环。缓存至多四个快照、合计 256 MiB；只有明确 snapshot 的续页延长 30 秒有效期，无 snapshot 的首请求重新读取当前事实，不因滑动 TTL 永久陈旧。完整内容超限报错，不截断后冒充完整。
- 手机完整数据拼装、SHA256、JSON decode 使用 `@concurrent`，保留 snapshot/cursor/完整 digest 校验。移除多余尾页读取阶段；不从 prompt 派生 canonical identity。
- 完整缓存写入同时生成小镜像：最后两轮/每轮两项，每段约 1 KiB JSON 编码预算。完整内容超过磁盘预算也可保存镜像；epoch、grant/anchor/provider/cwd/session namespace、保护属性和 backup exclusion 不变。
- 浏览列表至多预热两个小预览，不回填完整历史；前台优先，fixture offline guard 在网络前执行。预热不声称在线，不覆盖前台错误或真实执行状态。
- 首屏保持两轮与每轮 16 项、每项 500 Unicode scalar 摘要；较早项每次增加 20。全文通过原生 TextKit 2 只读 sheet 显示，不在首屏解析整段 Markdown。sheet 持有阅读快照，回填不替换正在阅读的正文；真实手机点击/焦点行为仍待验收。

### 检查与首次失败

- Node 24.18.0：最终定向 **67 PASS**；完整 unit **2424 PASS / 3 SKIP**，shell PASS。三项真实账号/费用探针明确关闭。完整 unit 使用 `--maxWorkers=1`，没有修改 fixture 超时或断言。
- `npm run typecheck`、`check:cli-release`（**563 PASS**，CLI package smoke）、`pack:artifact`（含 packaged resource/security smoke）、`test:renderer:ui`（含 Credits）通过。桌面为开发签名产物，未公证；不是公开发布。
- Swift package **11 PASS**：串行发送、单握手、大小限制、断线/取消、握手及页超时、异常额外回复。首轮 EmbeddedChannel 未激活导致 5 次失败，改为 fixture 内 `connect`（无真实 TCP）后通过，未修改传输断言。
- Node 首轮边界测试仍把 65,537 视为越界，按新的 256 KiB 合同将拒绝边界改为 262,145，保留拒绝断言。
- 新增 slash-heavy 预览回归：有效约 12 KiB host JSON 在默认 Swift slash escaping 下超过镜像预算，保存/读取两项先 FAIL。镜像编码统一 `withoutEscapingSlashes` 后两项 PASS；不是扩大 17 KiB 上限。
- 最终 Simulator 历史 **45 PASS / 0 FAIL / 1 SKIP**（Data Protection），原自测 **31 PASS / 0 FAIL / 1 SKIP**（unsigned Keychain）。Debug Simulator 与签名 iphoneos 构建通过；既有 deprecated/onChange 与 unnecessary-try 警告未顺手修改。
- **覆盖率入口未通过**：并发 2、随后单 worker 两次均只有既有 `runtime.test.ts` 的九张 10 MiB 图片验收在 5 秒超时；两次均 2423 PASS / 1 FAIL / 3 SKIP。随后无 coverage 的该文件 23 PASS、完整 unit 2424 PASS。观察到约 10.6 GiB swap，但未证明因果；没有降低覆盖率范围、跳过断言或增加超时。

### 部署/验收状态

- 以上证明编译、隔离 fixture 和可安装产物检查，**不证明真实手机首屏或毫秒级性能**。Mac 已原子覆盖安装 0.2.157，Info/version、签名与 app.asar 对照通过，保留上一版 backup；当前助手依附的运行进程尚未重启，不将磁盘版本当作活动 runtime 证据。手机最初 CoreDevice `unavailable`，用户连接 USB 并解锁后恢复 available (paired)，已覆盖安装 **0.1.4 (5)**；安装回执与应用 inventory 匹配，真机历史 **46 PASS / 0 FAIL / 0 SKIP**、原自测 **36 PASS / 0 FAIL / 0 SKIP**，随后恢复无测试参数的正常启动。没有卸载、清除真实缓存、重新配对或发送 Provider 消息。该结果仍不是首屏性能或真实全文阅读交互验收。
- 完整旧 archive/index rebuild 仍可能 materialize legacy 正文，单个超大 turn 的序列化也没有恒定耗时保证。若真实只读验收仍慢，按 source/read-mode 与首可读/首全页/完整 SHA 分段定位，再考虑专用 bounded 索引或 worker；不靠重试、隐藏错误或放宽完整性校验掩盖。
- 版本匹配后由用户验收：首次打开同一会话、暖重开、进程重启、阅读全文、较早内容和相邻会话切换。配对、已有缓存、未决 run 和草稿不得通过卸载/清空绕过。未发送真实 Provider 消息、审批或付费操作。

## 0.1.5 (6)：真实 unknown_op 与旧 Mac runtime

用户再次反馈点击会话慢并显示“暂时无法读取会话”。认证只读 `-sessionReadProbe` 对此前明确指定的 Pi 会话返回 **`RunError.host(code: "unknown_op")`**，不是猜测网络不通；读取成功/首屏耗时未取得。Mac 安装目录虽为 0.2.157，实际进程仍从 2026-10-08 22:20 运行，尚未重启加载新协议。此前仅覆盖安装、未验证活动 runtime 是交付缺口。

手机另有真实错误处理问题：preview 的协议/传输错误被吞掉，随后仍在同一 tunnel 发完整分页请求，第一错误被后续断线覆盖。现改为保留首因并结束 transfer；明确的 `status: unavailable` 仍可继续完整历史读取，缓存/小镜像和 generation/connection fence 不变。`unknown_op` 是已认证主机回复，不当作离线；错误正文直接给出“更新并完全退出后重新打开 Mac”的操作，同时保留原始错误码。没有新增自动重试、协议猜测或权限降级。

新增实际 failure projection 回归三项：镜像保留、协议错误不标离线、可操作提示。旧投影先有后两项 FAIL；修复后通过。Simulator **48 PASS /0 FAIL /1 Protection SKIP**、原自测 **31 PASS /0 FAIL /1 Keychain SKIP**；Swift transport **11 PASS**。签名 iphoneos 构建通过，覆盖安装 **0.1.5 (6)** 后 inventory 确认，真机历史 **49 PASS /0 FAIL /0 SKIP**、原自测 **36 PASS /0 FAIL /0 SKIP**，恢复正常启动。没有清除真实缓存或重新配对。

本次仅改 Swift store/error 展示与 iOS 版本，Node/主机源码及已安装 0.2.157 未改，未重跑前段 Node 全量/pack gate；前段 coverage 失败仍保留。没有可用 mobile-mcp/WDA 控制通路，未证明新错误文本的真机点击/焦点效果，更未证明正常正文恢复或毫秒级。下一步必须让 Mac **真正退出并重新打开**（不是只关窗口），再对同一会话执行认证只读 probe 与实际点击验收。当前助手依附该 Mac 进程，不通过 detached helper 规避生命周期退出。

## 0.1.6 (7) / Mac 0.2.158：空闲中继池与 Markdown 全文

用户反馈重启后仍有高失败率、Markdown 不支持。重查 Mac 已是新进程；同一显式 Pi 会话的真实认证只读 probe **成功一次**：preview 2036.8 ms /604 bytes，首全页 2371.1 ms，完整校验 25177.9 ms /5,229,142 bytes /19 turns。不是毫秒级首屏证明，也没有据此推算失败率；本次没有捕获到该真实请求失败的 wire 错误。

确认另一可复现的容量缺陷：`ReverseTunnelTransport` 默认两条腿，但只在 close 后补充。长历史 tunnel 加预热/控件请求可占完可用腿，Worker 明确返回 `no_host_leg`。修复 WSS 收到首次设备密文时发出一次消费通知，将等待池与活动连接分开补充；默认保留两条等待腿，至多八条总连接。达到上限仍可能 busy；扩容必须基于实际并发证据，不通过无限建连或增加客户端重试兜底。消费通知不是授权，mTLS/grant/expiry 和完整历史校验不变。不能把这个局部缺陷直接当作用户所有失败的已证实原因。

- 回归旧实现先 FAIL（两个消费后仍仅两条、预期四条）；修复后通过。另用真实 localhost WebSocket upgrade/frame 验证首次入站字节只通知一次且正文不变。四个 remote 文件 **41 PASS**。
- 手机全文恢复复用现有 Markdown 块渲染，`@concurrent` 解析一次后 lazy 布局；标题、列表、引用、链接、代码块支持沿用现有边界，不声称全部 CommonMark/GFM。摘要限制不变，完整内容未删。Simulator native AX 已实际打开/观察标题列表代码块/关闭/重开；截图私有留存。
- 新增 XCTest 点击用例，但 Simulator 两次启动分别 240s/180s 超时，第二次有 `DTServiceHubClient failed to bless service hub`，测试没有执行。停止本次 runner 并重启同一 owned Simulator 后仍失败，没有放大断言超时。物理设备 UI runner 构建因 `No Accounts`/缺少 `com.scry.remote.uitests.xctrunner` profile 失败；普通 App 签名构建成功。Native AX fixture 验证与 XCTest 失败分开记载。
- Simulator 历史 **48 PASS /1 Protection SKIP**、原自测加 Markdown 三项 **34 PASS /1 Keychain SKIP**；真机覆盖安装 **0.1.6 (7)**、inventory 确认，历史 **49 PASS**、自测 **39 PASS**，均 0 FAIL，恢复正常启动。没有卸载、清真实缓存、重新配对或 Provider 消息。
- 并行终端/renderer WIP 未纳入本次安装：用 `adfc6e1` + 本次明确路径 diff 的临时源码快照（非替换历史 subagent）验证/打包，依赖 APFS clone 隔离。Node24 完整 unit **2430 PASS /3 SKIP**、shell/typecheck 通过；CLI 验证 563 PASS，但 npm12 的 pack JSON 已变为按包名对象，既有 smoke 的数组断言失败。未改 smoke；按项目 Node22.22.1/npm10.9.4 环境重跑 CLI package smoke 通过，随后 pack/resource/security smoke 与 renderer UI（含 Credits）通过。前段 coverage 失败仍保留，没有补造覆盖率。
- 真实高失败率改善、两端新版本运行后的 UI 首可读/暖重开仍待验收。安装目录和运行进程版本须分开核实，不能再把覆盖安装写成协议已生效。
