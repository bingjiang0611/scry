import Foundation
import RemoteTransport

// Copy for the connection and catalog feedback surface. Keeping this small
// vocabulary in one place prevents the home projection from inventing a second
// set of status meanings.
enum ConnectionCopy {
  enum FileOpen {
    static let saveOrShare = "保存或分享"
    static let displayMode = "显示方式"
    static let preview = "预览"
    static let source = "源码"
    static let downloading = "正在从 Mac 读取…"
    static let retry = "重新读取"
    static let fromStart = "回到开头"
    static let nextPage = "读取下一页"
    static let offlineHTML = "只读 HTML 快照；不加载外部样式、脚本或图片。"
    static let noPreview = "手机不支持预览此格式。可以保存原文件，或用其他 App 打开。"
    static let noProject = "尚未确定文件所属的项目，请从会话中打开文件。"
    static let localLinkTitle = "Mac 本机链接"
    static let fileTitle = "Mac 文件"
    static func progress(_ received: Int, _ total: Int?) -> String {
      let read = ByteCountFormatter.string(fromByteCount: Int64(received), countStyle: .file)
      guard let total else { return read }
      return "\(read) / \(ByteCountFormatter.string(fromByteCount: Int64(total), countStyle: .file))"
    }
    static func page(_ start: Int, _ end: Int, _ total: Int) -> String { "字节 \(start)–\(end) / \(total)" }
    static func failure(_ error: Error) -> String {
      if let host = error as? G0Transport.RunError, case let .host(code) = host {
        switch code {
        case "ENOENT", "file_not_found": return "Mac 上未找到这个文件，请检查文件是否仍在原位置。"
        case "EACCES", "EPERM": return "Mac 没有读取这个文件的权限。"
        case "not_a_regular_file": return "这是目录或特殊文件，请选择普通文件。"
        case "file_download_changed": return "文件在传输中发生变化，请重新读取。"
        case "local_http_404": return "Mac 本机服务未找到这个地址。"
        case "file_download_timeout": return "读取超时，请确认 Mac 和本机服务仍在运行。"
        case "unknown_op", "file_download_unavailable": return "Mac 暂不支持文件下载，请更新并重启 Scry。"
        default: break
        }
      }
      if (error as NSError).code == CocoaError.fileWriteOutOfSpace.rawValue { return "手机空间不足，未保存文件。" }
      return "无法读取文件。请确认 Mac 在线、文件可读，或本机服务仍在运行。"
    }
  }
  static let historyProfileUnavailable = "这份历史缺少可核实的 Profile 来源，未读取其他 Profile 的记录。"
  static let historyProfileUnverified = "主机未确认会话历史的读取范围。请更新并重启 Mac1 与执行主机上的 Scry。"
  static let historyNativeUnavailable = "已显示 Scry 归档；Provider 原生历史未能核对"
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
  static func hostRefreshFailure(_ host: String, discovery: Bool, summary: String) -> String {
    discovery ? "\(host) · 主机发现失败" : "\(host) · \(summary)"
  }
  static func refreshDiagnostic(host: String, discovery: Bool, cache: Bool, verifiedAt: Date?, detail: String) -> String {
    let stage = cache ? "手机缓存 · 本地存储" : (discovery ? "主机发现 · control" : "会话列表 · bulk")
    return "主机：\(host)\n阶段：\(stage)\n\(lastFullRefresh(verifiedAt))\n\(detail)"
  }
  static let partialRefreshFailure = "列表未完整更新"
  static let cacheWriteRejected = "列表已更新，未保存到手机"
  static let cacheReadFailure = "手机缓存无法读取，正在核对主机"
  static let authorizationFailure = "访问授权已失效，请重新配对"
  static let protocolFailure = "主机暂不支持读取会话，请更新 Scry"
  static let pairAgain = "重新配对"
  static let lastRunning = "上次：运行中"
  static let done = "完成"
  static let ok = "知道了"
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
  static let chooseProviderToSend = "选择 Provider 后即可发送"
  static let selectedModelUnavailable = "所选模型当前不可用，请重新选择模型或自动模型。"
  static let selectedEffortUnavailable = "所选推理强度当前不可用，请重新选择。"
  static let model = "模型"
  static let automaticModel = "自动模型"
  static let reasoningEffort = "推理强度"
  static let defaultEffort = "默认"
  static func modelAndEffort(_ model: String, _ effort: String) -> String { "模型 \(model)，推理强度 \(effort)" }
  static let authorizedProjects = "已授权项目"
  static let chooseThisFolder = "选择此文件夹"
  static let subfolders = "子文件夹"
  static let noSubfolders = "此文件夹没有子文件夹"
  static let focusedTaskNeedsDecision = "任务正在等待你的决定 · 查看"
  static func otherTasksNeedDecision(_ count: Int) -> String {
    count > 1 ? "\(count) 个任务等待你的决定 · 查看" : "另一个任务等待你的决定 · 查看"
  }

  // 首屏 + 抽屉（Codex 式入口）
  static let drawer = "会话"
  static let drawerClose = "关闭会话列表"
  static let drawerOpen = "打开会话列表"
  static let tabRecent = "最近"
  static let tabProjects = "项目"
  static let tabTools = "工具"
  static let sectionNeedsYou = "需要你"
  static let sectionPinned = "置顶"
  static let sectionArchived = "已存档"
  static let seeAll = "查看全部"
  static let archivedEmpty = "没有已存档会话"
  static let archivedPolicy = "存档只隐藏会话，不删除 Mac 上的记录。"
  static let archivedSessions = "已存档会话"
  static let archivedSessionsDetail = "查看、恢复或永久删除"
  static let archivedFetchedNone = "尚未读取"
  static let newSession = "新建会话"
  static let noRecent = "还没有会话"
  static let noRecentDetail = "在下方输入任务，交给 Mac 上的 Agent 执行。"
  static let noHostSession = "这个会话还没有可核对的会话 ID，暂不能操作。"
  static let sessionActionRejected = "Mac 没有应用这次修改，请刷新后再试。"
  static let sessionActionFailedTitle = "操作未完成"
  static let clearSearch = "清除搜索"
  static let filterHosts = "切换执行主机"
  static let renameRejected = "标题不能为空，且不超过 256 个字符。"
  static func sessionDeleteIncomplete(_ failed: Int) -> String { "删除未完成，\(failed) 项没有清理，请重试。" }
  static func sessionActionFailed(_ detail: String) -> String { "操作未完成：\(detail)" }
  static func sessionActionApplied(_ action: String) -> String { "已\(action)" }
  static let actionPin = "置顶"
  static let actionUnpin = "取消置顶"
  static let actionRename = "重命名"
  static let actionArchive = "存档"
  static let actionArchiveAndStop = "存档并停止"
  static let actionRestore = "恢复"
  static let actionDelete = "永久删除"
  static let undo = "撤销"
  static let archivedToast = "已存档"
  static let restoredToast = "已恢复"
  static let archivedRunningConfirmTitle = "存档并停止这个任务？"
  static let archivedRunningConfirmBody = "这个会话正在运行。存档会先停止它，之后可在设置 → 已存档会话里恢复。"
  static let deleteConfirmTitle = "永久删除这个会话？"
  static let deleteConfirmBody = "Mac 上的会话记录会被删除，且无法撤销。"
  static let renameTitle = "重命名会话"
  static let renameField = "会话标题"
  static let save = "保存"
  static let composerPlaceholder = "安排一个任务…"
  static let composerNeedsProject = "先选择项目"
  static let composerNeedsProvider = "先选择 Provider"
  static let composerProject = "项目"
  static let composerProvider = "Provider"
  static let composerUnavailable = "连接后可输入"
  static let chooseFolderTitle = "选择文件夹"
  static let chooseFolderSubtitle = "可浏览 Mac 已授权项目内的任意文件夹"
  static let readingFolders = "读取文件夹…"
  static let noAuthorizedProjects = "没有已授权的项目"
  static let noAuthorizedProjectsDetail = "先在 Mac 的 Scry 中授权目录；iPhone 不能自行扩大访问范围。"
  static let foldersUnreadable = "无法读取文件夹"
  static let chooseProviderTitle = "选择 Provider"
  static let chooseProviderSubtitle = "仅显示主机当前可用的服务"
  static let readingProviders = "读取主机可用的 Provider…"
  static let noProviders = "没有可用的 Provider"
  static let noProvidersDetail = "先在 Mac 的 Scry 中登录或配置 Provider。"
  static let providersUnreadable = "无法读取 Provider"
  static let hostReadAt = "读取"
  static func provenance(_ host: String, _ time: String) -> String { "来自 \(host) · \(time) \(hostReadAt)" }
  // A panel that has not completed its first read has no timestamp to claim.
  static func panelProvenance(_ host: String, readAt: String?) -> String {
    guard let readAt else { return "来自 \(host) · \(archivedFetchedNone)" }
    return "来自 \(host) · \(readAt) \(hostReadAt)"
  }
  static let unavailable = "不可用"
  static let unavailableDetail = "这次读取没有返回这项数据。"
  static let moreRows = "再加载"
  static func rowsLimited(_ shown: Int) -> String { "已显示前 \(shown) 条" }

  // 工具面板（P3）：只读投影，动作仍在 Mac 上。
  static let toolsNote = "只读投影：数值来自 Mac 最近一次读取，操作在 Mac 上完成。"
  static func toolUnavailable(_ reason: String) -> String { "不可用 · \(reason)" }
  static let toolMissingCapability = "Mac 未提供这项能力"
  static let toolNotOnPhone = "手机端暂未提供"
  static let toolRefresh = "刷新"
  static let toolRange7 = "7 天"
  static let toolRange30 = "30 天"
  static let toolRange90 = "90 天"
  static let analyticsTitle = "用量分析"
  static let analyticsCost = "成本"
  static let analyticsCostNote = "按 Provider 公布单价估算"
  static let analyticsCostPartial = "部分模型没有单价，成本是下界"
  static let analyticsTokens = "Token"
  static let analyticsBreakdown = "构成"
  static let analyticsByModel = "按模型"
  static let analyticsByDay = "按日"
  static let analyticsDailyCost = "每日成本"
  static let analyticsDailyTokens = "每日 Token"
  static let analyticsByProvider = "按 Provider"
  static let analyticsTokenCoverage = "Token 覆盖度"
  static let analyticsDetail = "明细"
  static let analyticsApprox = "≈"
  static let analyticsLowerBound = "下界"
  static let llmTitle = "LLM 性能"
  static let llmRunning = "正在运行"
  static let llmHistory = "历史"
  static let llmSpeed = "速度"
  static let llmFirstToken = "首字延迟"
  static let llmCoverage = "覆盖度"
  static let llmCompare = "模型对比"
  static let llmEmpty = "这段时间没有历史样本"
  static let mcpTitle = "MCP 信任"
  static let mcpLive = "运行时"
  static let mcpPolicy = "策略"
  static let mcpFindings = "风险发现"
  static let mcpInventory = "Fleet 清单"
  static let mcpAudit = "策略与审计"
  static let mcpRefresh = "刷新 MCP 状态"
  static let mcpScan = "扫描当前 MCP"
  static let mcpNoFindings = "这次扫描没有发现风险项"
  static let mcpReadOnly = "手机只读：信任与策略在 Mac 上修改。"
  static let mcpScanNote = "只有刷新会重新做一次静态只读扫描；不连接服务器，也不授权任何配置。"
  static let mcpScanUnavailable = "这次没有可读的扫描报告"
  static let mcpSeverityCritical = "严重"
  static let mcpSeverityHigh = "高"
  static let mcpSeverityMedium = "中"
  static let mcpSeverityLow = "低"
  static let mcpSeverityInfo = "提示"
  static func mcpSeverity(_ value: String) -> String {
    switch value {
    case "critical": return mcpSeverityCritical
    case "high": return mcpSeverityHigh
    case "medium": return mcpSeverityMedium
    case "low": return mcpSeverityLow
    default: return mcpSeverityInfo
    }
  }
  static func mcpDecision(_ value: String) -> String {
    switch value {
    case "block": return "策略拦截"
    case "warn": return "策略警告"
    default: return "策略放行"
    }
  }
  static let panelStale = "这次读取较旧，可能已变化"
  static let panelMacOnly = "这项操作只能在 Mac 上完成"
  static let panelLoadFailed = "这次读取失败"
  static let panelUnsupported = "这台 Mac 的 Scry 版本还不支持这个面板，请更新 Mac 端。"

  #if DEBUG
  static let fixtureTransportFailure = "fixture transport failure"
  static let fixturePartialFailure = "fixture partial page failure"
  #endif

  static func lastFullRefresh(_ date: Date?) -> String {
    guard let date else { return noFullRefresh }
    return "上次完整刷新：\(date.formatted(date: Calendar.current.isDateInToday(date) ? .omitted : .abbreviated, time: .shortened))"
  }

}
