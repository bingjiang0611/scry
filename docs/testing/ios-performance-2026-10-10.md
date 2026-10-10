# iOS 连接与历史读取性能修复：验收进度

日期：2026-10-10。**代码与本地检查已完成；修复后真机录屏和性能验收尚未完成。**

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
- iOS `com.scry.remote` 0.1.8 (9) 已开发签名覆盖安装，保留原数据与配对。
- Mac 并行工作流曾覆盖安装不含历史分页修复的包。已重新构建并覆盖安装包含修复的包，部署后须核对实际运行进程的资源身份，不能仅凭版本号或安装成功宣称新主机已经加载。
- **修复后真机录屏、首屏/完整最近历史/更早历史/缓存重开计时均待执行，暂无前后性能提升百分比。**

真实视频、截图、会话正文和详细日志存于 ignored 的 `.local/ios-performance-validation/`，不提交或公开。下一步是在确认新主机加载后，保持手机解锁，对同一会话进行只读录屏与计时，再补齐最终结果。

## 已知边界

- Claude 主机端仍解析完整原生 transcript，不能声称常数时间历史读取。
- 来源版本由源元数据和 live revision 表示，不是全历史内容 digest。continuation token 使用进程级 HMAC；Mac 重启后旧 token 可能失效，缓存正文仍可显示，用户显式刷新重新建立窗口。
- 单轮超出 structured 容量时，完整 byte-history 是显式操作，可能较慢；不会自动下载或把预览标成完整。
- unsigned simulator 的 Keychain 与物理 file-protection 检查跳过；不能替代真机验证。
