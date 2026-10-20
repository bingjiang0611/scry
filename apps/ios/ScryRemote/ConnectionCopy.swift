import Foundation

// Copy for the connection and catalog feedback surface. Keeping this small
// vocabulary in one place prevents the home projection from inventing a second
// set of status meanings.
enum ConnectionCopy {
  static let historyProfileUnavailable = "这份历史缺少可核实的 Profile 来源，未读取其他 Profile 的记录。"
  static let historyProfileUnverified = "主机未证明历史使用了所选 Profile。请更新并重启 Mac1 与执行主机上的 Scry。"
  static let homeTitle = "远程"
  static let settings = "设置"
  static let connectMac = "连接 Mac"
  static let allHosts = "全部主机"
  static let pinned = "已置顶"
  static let projects = "项目"
  static let searchResults = "搜索结果"
  static let searchSessions = "搜索会话"
  static let newTask = "新任务"
  static let noPreview = "(无预览)"
  static let noSession = "未建立会话"
  static let readingSessions = "正在读取会话…"
  static let noMatches = "没有匹配的会话"
  static let changeSearch = "试试其他关键词。"
  static let noSessions = "主机还没有会话"
  static let createFirstTask = "点击右下角，从 iPhone 发起第一项任务。"
  static let noMac = "还没有连接 Mac"
  static let pairInstructions = "在 Mac 的 Scry 中打开“连接 iPhone”，然后扫描配对码。"
  static let noGatewayForNewTask = "尚未连接 Mac，无法创建会话。"
  static let unconnected = "未连接"
  static let sending = "发送中"
  static let running = "任务进行中"
  static let starting = "启动中"
  static let activeRuns = "进行中"
  static let interruptedRun = "观察中断，主机可能仍在运行"
  static let remove = "移除"
  static func returnToTask(_ host: String) -> String { "返回当前任务 · \(host)" }
  static func pendingMessages(_ host: String) -> String { "待发送与核实 · \(host)" }
  static func rejectedMessage(_ code: String) -> String { "Mac 拒绝了这条消息（\(code)），未执行" }
  static func rowContext(host: String?, project: String, provider: String) -> String {
    [host, project, provider.uppercased()].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
  }
  static func newTaskInProject(_ project: String) -> String { "在 \(project) 中新建任务" }
  static let executionHost = "执行主机"
  static let selectExecutionHost = "选择执行主机"
  static let gatewayHost = "Mac1"
  static let throughGateway = "经 Mac1"
  static let localExecutionHost = "本机 Mac1"
  static let targetRecoveryUnavailable = "无法核实原执行主机的待处理消息。请先恢复主机信息，暂不能替换或清除配对。"
  static let pendingBeforePair = "仍有消息在发送或任务未结束，完成后再重新配对。"
  static let pendingBeforeUnpair = "仍有消息待发送、结果待核实或任务未结束。完成后再清除配对，不会停止主机上的运行。"
  static let targetResultUnknown = "尚未确认这条消息的执行结果。已保留消息和原执行主机，不会自动改投或重发。"
  static let reconcileResult = "核实发送结果"
  static let targetCapacity = "保留的执行主机已达上限，请先核实未完成的消息。"
  static let targetDiscoveryFailure = "暂时无法更新执行主机，已保留原目标。"
  static let forwardingUnsupported = "Mac1 尚不支持转发（unknown_op），请更新 Mac1 上的 Scry。"
  static func targetDiscoveryDiagnostic(_ detail: String) -> String { "执行主机发现失败：\(detail)" }
  static func relayTLSHandshakeFailure(_ detail: String) -> String { "外层中继 TLS 握手失败：\(detail)" }
  static func hostTLSHandshakeFailure(_ detail: String) -> String { "内层主机 mTLS 握手失败：\(detail)" }
  static let targetMetadataUnavailable = "手机保存的执行主机信息无法读取，请刷新主机列表。"
  static func targetRefreshFailure(_ label: String) -> String { "\(label) 的会话列表未完整更新" }
  static let targetPickerSubtitle = "手机仅通过已配对的 Mac1 访问目标主机"
  static let targetUnavailable = "该执行主机尚未刷新可用能力，暂不能创建会话。"
  static let targetSendUnavailable = "该执行主机尚未刷新可用能力，无法发送"
  static let notPaired = "尚未配对"
  static let refresh = "刷新会话"
  static let refreshing = "正在刷新会话…"
  static let more = "更多选项"
  static let refreshSuccess = "刷新成功"
  static let refreshFailure = "会话列表刷新失败"
  static let partialRefreshFailure = "列表未完整更新"
  static let cacheWriteRejected = "列表已更新，未保存到手机"
  static let cacheReadFailure = "手机缓存无法读取，正在核对主机"
  static let authorizationFailure = "访问授权已失效，请重新配对"
  static let protocolFailure = "主机暂不支持读取会话，请更新 Scry"
  static let pairAgain = "重新配对"
  static let lastRunning = "上次：运行中"
  static let done = "完成"
  static let pairing = "配对"
  static let pairingSaved = "已保存配对，不代表当前可达"
  static let pairingAbsent = "未保存配对"
  static let connectionAddress = "连接地址"
  static let unavailableAddress = "未提供"
  static let listRequest = "本次列表请求"
  static let retry = "重试"
  static let details = "详情"
  static let technicalDetails = "技术详情"
  static let detailsTitle = "会话列表刷新"
  static let unverifiedCache = "尚未核对 · 下拉刷新"
  static let noFullRefresh = "尚无完整刷新时间"
  static let cacheWriteRejectedTechnical = "缓存写入返回未保存"
  #if DEBUG
  static let fixtureTransportFailure = "fixture transport failure"
  static let fixturePartialFailure = "fixture partial page failure"
  #endif

  static func lastFullRefresh(_ date: Date?) -> String {
    guard let date else { return noFullRefresh }
    return "上次完整刷新：\(date.formatted(date: Calendar.current.isDateInToday(date) ? .omitted : .abbreviated, time: .shortened))"
  }

}
