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
  static let openMenu = "打开菜单"
  static let back = "返回"
  static let cancel = "取消"
  static let session = "会话"
  static let projectFilesAndDiff = "项目文件与 Diff"
  static let returnToLatest = "回到最新"
  static let result = "结果"
  static let slashCommands = "斜杠命令"
  static let refreshSlashCommands = "刷新斜杠命令"
  static let noProviderCommands = "当前 Provider 未返回可用命令"
  static let noMatchingCommands = "没有匹配的命令"
  static func viewAttachment(_ name: String) -> String { "查看 \(name)" }
  static func removeAttachment(_ name: String) -> String { "移除 \(name)" }
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
  static func moreWithStatus(_ status: String) -> String { "\(more)，\(status)" }
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
  static let historyStatus = "历史状态"
  static let historyDetailsTitle = "历史证据"
  static let historySyncIssue = "同步问题"
  static let historyStorageIssue = "本地存储"
  static let historyFromCache = "本地缓存 · 尚未核对 Mac"
  static let historyCheckingCache = "正在核对本地缓存"
  static let historyPartial = "部分历史 · 完整性尚未核对"
  static let historyStorageLimited = "历史存储受限"
  static let historySyncFailed = "历史同步失败，显示上次内容，正在重试"
  static let historyUnavailable = "无法读取 Mac 上的会话记录，正在重试"
  static let historyReading = "正在读取 Mac 上的会话记录"
  static let historyEarlierUnavailable = "未读到 Mac 上更早的记录（不代表没有）"
  static let historyVerified = "历史快照已核对；文件 Diff 需在 Mac 查看"
  static let historyStateUnavailable = "历史状态不可用"
  static let noReadableHistory = "这条会话没有可读取的历史记录，你仍可以在下方继续对话。"
  static let historyRefresh = "刷新会话"
  static let historyLastChecked = "上次核对"
  static let historyNotChecked = "尚未核对主机"
  static func historyRecentComplete(_ source: String) -> String { "最近完整历史 · \(source) · 可继续加载更早轮次" }
  static func historyLastCheckedText(_ date: Date) -> String {
    "\(historyLastChecked)：\(date.formatted(date: .abbreviated, time: .shortened))"
  }
  static let unverifiedCache = "尚未核对 · 下拉刷新"
  static let noFullRefresh = "尚无完整刷新时间"
  static let cacheWriteRejectedTechnical = "缓存写入返回未保存"

  static let pairHeading = "让 iPhone 安全连接 Scry"
  static let pairLead = "在 Mac 的 Scry 中打开“连接 iPhone”，然后扫描一次性配对码。"
  static let pairStepScan = "扫描 Mac 上显示的二维码"
  static let pairStepVerify = "核对两端显示的设备指纹"
  static let pairStepApprove = "在 Mac 上确认访问权限"
  static let pairTrust = "中继只传输端到端加密字节。设备私钥、Provider 凭据与执行都留在你的设备上。"
  static let scanPairingCode = "扫描配对码"
  static let pairingProving = "正在验证设备密钥…"
  static func pairingAwaiting(_ fingerprint: String) -> String { "等待 Mac 确认\n指纹 \(fingerprint.prefix(16).uppercased())…" }
  static func pairingPaired(_ deviceId: String) -> String { "已配对 · 设备 \(deviceId.prefix(8))…" }
  static let pairingCodeWrongApp = "这不是 Scry 配对码。请在 Mac 的 Scry 中重新打开“连接 iPhone”并扫描二维码。"
  static let pairingCodeInvalid = "配对码无效或已损坏。请在 Mac 上刷新配对码后重试。"
  static let pairingCodeExpired = "配对码已失效。请在 Mac 上生成新的配对码后重试。"
  static let pairingAlreadyRegistered = "这个 iPhone 已在 Mac 上登记。请先在 Mac 上移除旧设备，再重新配对。"
  static let pairingProofChanged = "配对验证信息已变化。请关闭两端配对页，重新生成配对码后再试。"
  static let pairingDenied = "Mac 未完成配对。请在 Mac 上重新生成配对码后重试。"
  static let pairingRevoked = "这台 iPhone 的访问已在 Mac 上撤销。请重新生成配对码并获得授权。"
  static let pairingTimeout = "等待 Mac 确认超时。请确认 Mac 上仍显示配对请求，然后重试。"
  static let pairingConnectionFailed = "无法连接到 Mac 完成配对。请确认 Mac 上的 Scry 保持打开并检查网络，然后重试。"

  static let connectionSection = "连接"
  static let localDataSection = "本地数据"
  static let securitySection = "安全"
  static let pairedMac = "已配对的 Mac"
  static let repairPairing = "重新配对"
  static let repairPairingDetail = "替换此设备的远程授权"
  static let localHistoryCache = "会话缓存"
  static let localHistoryCacheSummary = "最多 64 MB、20 个会话；关闭 App 后保留"
  static let localHistoryCachePolicy = "缓存受 iOS 数据保护且不备份。清除缓存不影响 Mac 上的会话或未发送草稿。"
  static let clearingHistoryCache = "正在清除缓存…"
  static let clearHistoryCache = "清除本机会话缓存"
  static let historyCacheCleared = "本地历史缓存已清除，不影响 Mac 上的会话和未发送草稿。"
  static func historyCacheClearFailed(_ detail: String) -> String { "缓存清除失败：\(detail)" }
  static let clearLocalPairing = "清除本机配对"
  static let clearPairingTitle = "清除此 iPhone 的配对？"
  static let clearPairingAction = "清除配对"
  static let clearPairingMessage = "将删除本机凭据、草稿和历史缓存。再次连接需要在 Mac 上重新授权；不会停止 Mac 上正在运行的任务。"

  static let chooseWorkspaceFirst = "先选择工作目录，再选择 Provider"
  static let chooseTaskContext = "发送前请在“新任务”中选择项目与 Provider"
  static let chooseProviderToSend = "选择 Provider 后即可发送"
  static let providerControlsUnavailable = "所选 Provider 设置不可用"
  static let refreshProviderControls = "重新读取设置"
  static func providerControlsObserved(_ observedAt: Double?) -> String {
    guard let observedAt else { return "主机快照；读取时间未知" }
    let date = Date(timeIntervalSince1970: observedAt / 1000)
    return "主机读取于 \(date.formatted(date: .abbreviated, time: .shortened))"
  }
  static let providerControlsLoading = "正在读取所选 Provider 设置…"
  static let legacyProviderControls = "旧版主机能力快照；发送时由主机重验"
  static let restoredModelUnavailable = "恢复的 Model 当前不可用，已阻止静默替换"
  static let restoredEffortUnavailable = "恢复的推理强度当前不可用，已阻止静默替换"
  static let restoredPermissionUnavailable = "恢复的权限模式当前不可用，已阻止静默替换"
  static let modelUnavailable = "所选模型不属于当前 Provider"
  static let effortUnavailable = "所选推理强度不属于当前模型"
  static let permissionUnavailable = "所选权限不属于当前 Provider"
  static let authorizedProjects = "已授权项目"
  static let chooseThisFolder = "选择此文件夹"
  static let subfolders = "子文件夹"
  static let noSubfolders = "此文件夹没有子文件夹"
  static let focusedTaskNeedsDecision = "任务正在等待你的决定 · 查看"
  static func otherTasksNeedDecision(_ count: Int) -> String {
    count > 1 ? "\(count) 个任务等待你的决定 · 查看" : "另一个任务等待你的决定 · 查看"
  }

  #if DEBUG
  static let fixtureTransportFailure = "fixture transport failure"
  static let fixturePartialFailure = "fixture partial page failure"
  #endif

  static func lastFullRefresh(_ date: Date?) -> String {
    guard let date else { return noFullRefresh }
    return "上次完整刷新：\(date.formatted(date: Calendar.current.isDateInToday(date) ? .omitted : .abbreviated, time: .shortened))"
  }

}
