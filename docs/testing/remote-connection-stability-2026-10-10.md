# iOS 连接失败追踪：0.1.7 (8) / Mac 0.2.163

## 真实失败，不用推测代替

用户再次反馈“无法读取会话”。手机已连接，Mac 当时安装 0.2.162，已不是之前的旧进程。对先前明确指定的 Pi 会话做认证只读诊断；未发送消息、审批或真实 Provider 任务。

1. 初次真实请求失败：`handshakeFailed(... EOF during handshake)`。
2. 诊断版随后被 iOS Security 拒绝启动。重新构建和本地 codesign 校验通过仍被拒绝；用户在手机确认信任、能打开后恢复诊断。没有卸载或重新配对。原 `/tmp` 构建/日志在继续时已不存在，后续证据放在 ignored `.local/ios-stability/`，不声称能复读被删除的原文件。
3. 加阶段记录后，catalog 阶段超过 90 秒未完成，devicectl 被外层时限终止。恢复普通启动，不能把超时当成功。
4. 普通请求修复后的探针可进入预览与全量读取。最近一次：preview 7371.8 ms，第一全页 262,144/8,855,577 bytes 用时 4314.0 ms；到 1,310,720 bytes 时累计 35960.3 ms，随后明确失败：`closed(code: 1000, reason: "peer_closed")`。完整 SHA256 **未完成**。这时 Mac 仍运行 0.2.162，尚未加载本次主机改动。

这些结果没有证明失败的唯一原因，也没有证明高失败率已改善。特别是完整历史中途 peer close，不能靠本地测试归因或报成完成。

## 已证实的代码问题与修复

- WSS 注册成功就调用 inner TLS server，使没有手机接入的 warm leg 提前进入握手计时。现在 WSS `readyEvent` 使用首个入站密文事件 `relaySession`，先挂 inner server，再交付原始字节；等待池/活动池边界和八条默认总上限不变。localhost 真实 WebSocket 回归在旧实现先 FAIL（idle 时已经 serve 一次），新实现通过。这证明时序缺陷，不直接证明它造成了上述每一次真实 EOF。
- 普通 `ProbeHandler` 没有握手/响应 deadline，且处理器在 channel 已关闭后装入时收不到 `channelInactive`，Promise 会一直等待。改为观察 `closeFuture`（含已经关闭）、握手 10 秒/响应 30 秒截止、单次 settle 并清理计时。复用历史处理器相同的时限，没有扩大测试或网络超时。
- WebSocket close 原来直接关闭，TLS 只能报告匿名 EOF。现在先传播 bounded close code/reason；这是不可信诊断文本，不是认证证据。历史超时也带 handshake/response 阶段。
- 删除按异常字符串猜测的自动三次 exchange replay。连接丢失不证明请求未执行；用户显式重连/intent 对账仍由原状态机处理，不绕过未决 run，也不引入未知写操作重发。
- DEBUG 只读 session probe 增加 catalog/preview/full-progress 阶段和聚合字节时序，不记录正文、证书或 token。

## 验证与失败保留

- Swift 新 fixture 初次因为异步 `pipeline.addHandler(...).wait()` 在 EmbeddedEventLoop 没驱动而挂住；调查后终止确属本次的 xctest PID，改用与生产一致的 syncOperations。然后旧实现稳定出现三项失败：already-closed 请求不 settle、握手/响应均无限等待。修复后 Swift 全套 **15 PASS**，包含正常回复不被 close/deadline 改写、关闭原因保留。
- Node 22.22.1 / npm 10.9.4：typecheck、完整 unit **2453 PASS /3 SKIP**、shell PASS；三项真实费用/账号探针关闭。CLI release 检查 **563 PASS** 与 package smoke 通过；pack/resource/外链/security smoke、renderer UI（含 Credits）通过。
- Signed Debug iphoneos 构建和 codesign 通过；覆盖安装后真机 history **49 PASS**、self **39 PASS**，0 FAIL /0 SKIP，已恢复普通启动。未清真实缓存、改配对/授权或删草稿。未将 fixture 成功当成真实会话成功。
- 本次没有 UI 样式修改、没有新增截图验收。此前 coverage 失败不因本次普通 unit 通过而改写。

## 下一验收边界

Mac 新运行进程加载 0.2.163 后，重新对同一会话只读核对预览、进度、完整 digest 与暖重开；仍失败时保留第一个具体错误。真实首屏/失败率/完整下载仍待验收，不承诺毫秒级。Mac 覆盖安装不等于活动 runtime 更新；当前助手依附 Scry，不用 detached helper 规避退出。

私有日志与回执：`.local/ios-stability/`（ignored，不上传）。
