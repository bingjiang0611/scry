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

安装和真机自测已完成。下一步由用户手动体验，或在界面自动化可用后，只读打开同一真实历史，验证首次下载、返回重开、结束进程重开及缓存状态提示，再记录实际耗时与视频。真实发送/审批/执行不属于本次验证范围。
