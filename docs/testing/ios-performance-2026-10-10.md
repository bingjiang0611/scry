# iOS 连接与历史读取性能修复：验收进度

日期：2026-10-10。**已录制修复后真机视频，并修复旧任务恢复阻挡只读浏览的问题；新认证历史读取仍出现握手超时，性能验收未完成。**

## 修复内容

- 连接状态依据已认证主机响应与传输失败区分。业务错误不等于离线；协议不支持和授权失效明确降级。只有请求开始后的新认证响应可以覆盖其较晚返回的传输失败，另一个待完成请求不构成成功证据。
- 会话列表先展示第一页，再沿冻结 snapshot 继续分页；每次请求仍检查当前授权。保护目录中的列表缓存按连接授权隔离，本地缓存读失败不阻止核对主机。
- 历史首屏读取最近的完整 turns，不自动下载整个历史。保留来源、总数、偏移、snapshot 与更早页 cursor；预览、活动内存及未覆盖全部历史的窗口始终标记 partial。
- 生产提取使用实际 trace flattening。Claude 保留原生 transcript 与 archive merge 路径；其他 Provider 使用有界 archive window。
- 大响应按整轮退让并保留 cursor，不裁剪正文或工具证据。单轮仍超过 6 MiB 时提供显式完整历史入口。
- 保留离线窗口、本机运行增量和更早页位置。后台版本检查不丢掉用户已经展开的内容。Markdown 缓存绑定正文来源，避免复用视图时展示旧文本。
- 只读列表/历史复用串行 TLS lane。读取截止条件是连续 30 秒无字节进展，不是整个响应必须在 30 秒内完成；帧容量、取消和握手边界仍保留。

未增加权限，不卸载、不清空手机数据、不重新配对，也不发送真实 Agent 任务。

## 验证证据与范围

| 检查 | 结果 / 范围 |
| --- | --- |
| 首次定向检查 | 发现目录错误文案回归与 unused import；已修复，原失败日志保留 |
| 首轮完整 Node suite | 2495 passed / 3 skipped；真实账号和费用探针未执行 |
| Swift transport package | 21 passed，包含响应持续进展超过 30 秒的真实本地连接 fixture |
| 旧正文过滤器 mutation | 隔离 mock 旧逻辑，7 项中 4 项按预期失败；证明回归测试可识别正文丢失 |
| 后续源码复核 | 删除未必要的目录分页缓存，保留每次现查授权；修正并发连接证据与列表缓存读取/epoch 时机 |
| 当前 revision 定向 Node suite | 7 files / 85 tests passed，显式排除 `.local/**` |
| 当前 revision typecheck / build | 通过 |
| 当前 revision 完整 Node suite | 执行达到工具 120 秒截止，无完整最终结果；不得算通过。未发现测试进程残留；保留部分日志 |
| 当前 iOS device / simulator build | 通过；device 使用开发签名，不是发布验收 |
| 当前隔离 simulator history-cache test | DONE failures=0；包括 pending 请求不证明连接成功、新认证响应保留连接证据、离线窗口、更早 cursor、本机 overlay、拒绝 older-only tail cache |
| shell / renderer UI | 先前最终实现检查通过；组件/隔离 App fixture 不替代手机验收 |
| 当前 Mac 包检查 / Electron smoke | 通过；包含安全 IPC、会话历史恢复与原生资源检查 |

全量测试排除 `.local/**` 是因为该 ignored 目录包含备份源码及故意失败的 mutation fixture，不改变正式测试断言或范围。

## 真机与部署状态

- 修复前保留了真实手机 100 秒录屏，804×1748，编码 24 fps。观察到 `Inappropriate operation for state`，后来列表及会话打开成功。52.5 秒只是采样时已出现列表的上界，不是精确首屏时间；视频编码帧率不是设备帧率测量。
- iOS `com.scry.remote` 0.1.8 (9)、后续 0.1.9 (10) 均开发签名覆盖安装，保留原数据与配对。0.1.9 经用户重新验证开发者 App 后启动成功。
- Mac 并行工作流曾覆盖安装不含历史分页修复的包。已重新构建并覆盖安装包含修复的包，部署后须核对实际运行进程的资源身份，不能仅凭版本号或安装成功宣称新主机已经加载。
- 已核对实际 Mac 主机进程加载的 asar 与安装包身份一致；该版本包含结构化历史分页。此身份检查不证明某条新网络连接成功。
- 两段 0.1.8 修复后视频均为 240 秒。列表可见、刷新后仍可见；打开基线会话被另一旧任务的恢复 gate 阻挡。不能把缓存可见算成认证首页完成。只读重试旧任务发生在第二段视频结束后，只有 source/截图/事件证据。
- 0.1.9 新视频为 360 秒，804×1748、编码 24 fps。基线会话点击从视频 29.238 秒开始，29.604 秒返回；30.508 秒完成的 UI source 已显示真实缓存正文及只读恢复提示，不再弹切换阻挡。**1.270 秒仅是点击开始至 source 返回的缓存可见上界，包含 WDA 开销；不是新认证历史延迟，也不是逐帧首屏时间。**
- 视频 54.686 秒的 source 显示历史更新失败；146.902 秒菜单 source 明确为 `timedOut(stage: "inner-handshake")`。此错误出现在请求发出前的内层 TLS 握手，不能归因于 questions/history 业务 handler。该 history 错误来自 one-shot 检查，不能当成持久 history lane 的握手结果。
- 原恢复任务显示主机已报告失败、输出尚未完整核对；保留实际错误及失败操作，不再将已知 terminal lifecycle 写成运行结果未知。未知 lifecycle 仍保持未知与提交阻挡。
- 覆盖安装前后 `active-run.json` SHA-256 相同。浏览后的再次文件核对未完成：设备服务随后不可用，WDA runner 已退出、HTTP 代理连接被重置。不得宣称已完成浏览后磁盘一致性核验。
- **新认证首屏、完整最近历史、更早页与 warm reopen 性能仍未验收；无性能提升百分比。**

真实视频、截图、会话正文和详细日志存于 ignored 的 `.local/ios-performance-validation/`，不提交或公开。视频编码帧率不是设备渲染帧率；实际 MJPEG 设置为 10 fps。

## 旧任务恢复与只读浏览修复

- 原 store 继续持有运行身份、恢复 checkpoint、输出与提交 admission；保留 unresolved gate，不把 terminal 状态当成输出 drain 已完成。
- 其他会话使用 route-scoped history-only store，复用原连接与保护缓存。不恢复或删除 checkpoint，禁止提交、续聊与启动 run observation；返回恢复任务仍使用原 store。
- 只读页不显示 composer，不加载可变运行控件，最终源码也隐藏新任务菜单。会话草稿仍由原 AppModel 按原键保存，不迁移、不清空。
- 最新隔离 simulator history-cache 检查：**69 项 passed，DONE failures=0**。新增检查证明实际缓存窗口可读、older cursor 保留、原 recovery 不变、history-only 不持有 checkpoint/不轮询/不能提交，原 unresolved store 仍拒绝新提交，以及已知/未知 lifecycle 错误语义。
- 保留首次检查失败：并行共用 DerivedData 导致 device build 数据库锁；另一命令达到截止，未当作通过。确认 build 结束、无残留测试进程后改为串行检查。随后新增内容断言失败，原因是 fixture 先清除了 `session` 缓存；改为读取本测试明确保存的 `window-only` 窗口，并检查准确 turns/cursor，而非删除或弱化断言。
- 真机验证针对已安装的 read-only 实现；最后的菜单隐藏与中性提示文案尚未在真机重放。需恢复设备连接后覆盖安装最终构建并继续检查。
- 传输根因仍未证明，不盲目延长握手时限、不自动重试、不更改配对或 Relay 部署。下一步为隔离生产桥接组合回归，以及不记录正文/凭据的逐通道握手阶段诊断。若需要重启当前宿主启用诊断，应先交接并由用户完全退出重开。

## 后续窗口与真机布局复核

- 手机重新连接、开发者 App 验证后，0.1.9（10）成功启动。再次复制的恢复 checkpoint 与原副本 SHA-256 相同。随后现场目录列举显示零文件；未独立追踪清理事件，不宣称 checkpoint 永远保留或旧输出已经完整核对，也未手动删除或恢复该文件。
- 新认证的最近历史读取曾成功返回 `active_memory` 窗口。它是部分证据，不是完整 archive 验收；此前的 `inner-handshake` 失败仍保留，根因未证明。传输 focused 检查为 3 files / 15 tests，尚未覆盖完整生产 WebSocket→pool→inner-mTLS 组合。
- 修复刷新时旧完整缓存覆盖较新窗口的问题：保留正文、来源、核对时间及 older cursor；连接作用域变化不复用旧窗口；显式完整快照不跨表示形式沿用旧 fingerprint 去重。两项窗口回归在修复前失败，修复后通过。最终 simulator 检查 **73 PASS、1 data-protection SKIP、DONE failures=0**；signed device build、签名验证及 diff check 通过。
- 真机 0.1.10（11）布局复核：此前正文区域持续空白。设备缓存 JSON 完整解析后汇总为 3 轮 / 597 条目、约 1.2 MB、offset=3 / total=6、`active_memory + partial`，未逐条阅读全文。将 turn 内嵌套 `LazyVStack` 改为透明 `Group`，让 conversation 统一懒布局；同一基线冷启动重放后首份 UI 采样已可见真实工具调用、结果及思考入口。点击开始至这份采样完成为 **1.162 秒上界**，包含 WDA 开销，属于缓存正文首屏，不是新认证历史时延或设备 FPS。
- 修复后向上阅读数段真实历史，正文可见；尚未到达并验收更早页加载入口，也没有 warm reopen 或长时稳定性完整结果。较长 WDA scroll 发生 30/65 秒工具超时，不计为产品加载时延。读取后发现手机已切到其他 App，停止界面操作；删除无关 App 的意外 source/screenshot 并移除事件正文。只保留最后已确认 Scry 画面的录像前缀约 156.25 秒，不将不确定尾段算作验收。
- **最终 0.1.10（12）已签名覆盖安装，未卸载、重配对、清缓存或发送任务；不再启动或操作正在使用的手机界面。** 最后的完整快照去重分支仅由 focused simulator 验证，build 12 尚未真机重放。布局成功录像来自 build 11；两者不能混作同一端到端结果。剩余项为新认证列表/历史量化、更早页、warm reopen、长时连接稳定性与旧恢复输出的独立收敛核验；无总体性能提升百分比。

## 已知边界

- Claude 主机端仍解析完整原生 transcript，不能声称常数时间历史读取。
- 来源版本由源元数据和 live revision 表示，不是全历史内容 digest。continuation token 使用进程级 HMAC；Mac 重启后旧 token 可能失效，缓存正文仍可显示，用户显式刷新重新建立窗口。
- 单轮超出 structured 容量时，完整 byte-history 是显式操作，可能较慢；不会自动下载或把预览标成完整。
- unsigned simulator 的 Keychain 与物理 file-protection 检查跳过；不能替代真机验证。
