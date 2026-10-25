import Foundation

// Conversation presentation only. Host evidence is displayed verbatim.
enum ConversationCopy {
  static func context(project: String?, provider: String?) -> String {
    [project, provider].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
  }
  static let liveCache = "实时输出可能不完整；运行结束后以会话记录为准。"
  static let reasoning = "思考过程"
  static let toolResult = "工具结果"
  static func tools(_ count: Int, truncated: Bool) -> String { "\(truncated ? "至少 " : "")\(count) 个工具调用" }
  static func tool(_ text: String) -> String { "工具调用：\(text)" }
  static let expanded = "已展开"
  static let collapsed = "已折叠"
  static let copy = "复制"
  static let details = "本轮详情"
  static func usage(_ value: String?, pending: Bool) -> String { "用量 · " + (value ?? (pending ? "运行结束后由 Mac 提供" : "Mac 未提供")) }
  static func runID(_ value: String?) -> String { "Run · " + (value ?? "未提供") }
  static let failed = "运行失败"
  static let cancelled = "已停止"
  static let noOutput = "未读取到输出"
  static let truncated = "输出已达上限，内容被截断"
  static let newTask = "新任务"
  static let settings = "设置"
  static let startTitle = "开始一段新会话"
  static let startDetail = "你发送的消息会在这里显示；Agent 的执行状态与输出从主机实时读取，不沿用其他会话。"
  static let stopTitle = "停止这次运行？"
  static let stop = "停止运行"
  static let stopDetail = "请求 Agent 停止，结果以 Agent 实际结束为准。"
  static let connectedInput = "连接后可输入"
  static let busyInput = "运行结束后可发送，先写也行"
  static let followUpInput = "继续这段对话…"
  static let pairedMac = "已配对的 Mac"
  static let disconnected = "未连接"
  static let loadHistory = "加载完整历史（完整字节传输）"
  static let loadHistoryHint = "明确选择后下载完整历史；不会裁剪内容"
  static let olderHistory = "正在读取更早历史…"
  static let loadOlderHistory = "加载更早的完整历史"
  static let olderHistoryHint = "仅读取更早轮次，不会裁剪当前历史"
  static let failedHistory = "暂时无法读取会话"
  static func failedHistoryDetail(_ reason: String) -> String { reason + "\n已输入的草稿会保留。" }
  static let errorDetails = "错误详情"
  static let retryHistory = "重新读取"
  static func liveState(mac: Bool, stopping: Bool, waiting: Bool) -> String {
    (mac ? "Mac · " : "") + (stopping ? "停止中" : waiting ? "等待决定" : "运行中")
  }
}
