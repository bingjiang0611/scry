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
