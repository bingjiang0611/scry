# iOS 会话连续阅读修复

用户要求：用户输入不能漏显；历史内容应靠滚动访问，不使用“阅读全文”“显示本轮较早内容”“查看更早的消息”。

- 复用现有 `ConversationScrollView` 与 Markdown block renderer，不新增阅读页或交互样式。
- 删除最近 2 轮、最后 16 段、前 500 字的显示限制。历史 Markdown 在 UI actor 外解析，轮次、段落仍按滚动懒加载。
- 打开的会话持续核对历史，不再依赖打开时的 `isActive`。Mac 后续开始的新一轮和终态归档都能触发读取。
- 内容布局增长时仅为正在跟随末尾的读者保持最新位置；主动向上阅读时不抢位置。
- 保留与已有会话组件一致的工具/思考详情折叠和“回到最新”。不改变 remote history 合同、审批或缓存证据语义。

验证：iOS simulator build 通过；remote gateway / trace-output 33 项 unit tests 通过。新增原生 UI 回归覆盖多轮、20 段、长输入、长 Markdown 和打开后 Mac 新增输入。旧“点击阅读全文”用例被新的连续滚动用例替换，因为用户明确拒绝该交互。

未验证：模拟器 XCTest device-service 连接失败，26.5 与 26.3 两次启动均超时，未获得 UI 测试结果；独立 history-cache fixture 的模拟器安装/启动也超时。截图中的真实会话没有完成手机复验。这些构建/传输检查不等于真实 UI 验收。历史图片附件的传输缺失不在本次文字显示修复中解决。

首次构建被并行工作区中的 `WorkspaceBrowserView.swift` DEBUG raw-string 语法错误阻挡；另一个写入方修正后才继续。构建检查还发现本次新增 scroll geometry API 不支持项目的 iOS 17 下限，已改为现有 GeometryReader / PreferenceKey 模式并重新构建通过。
