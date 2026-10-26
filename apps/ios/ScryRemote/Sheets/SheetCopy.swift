import Foundation

enum SheetCopy {
  static let questionTitle = "需要你决定"
  static let permission = "Provider 请求授权"
  static let input = "Provider 需要输入"
  static let inputPlaceholder = "请输入"
  static let cancelRequest = "取消请求"
  static let submit = "提交"
  static let submitting = "提交中…"
  static let close = "关闭"
  static let overview = "会话总览"
  static let overviewTitle = "总览"
  static let overviewSource = "数据来自 Mac 上的会话记录"
  static let sessionInfo = "会话信息"
  static let sessionID = "会话 ID"
  static let provider = "Provider"
  static let host = "主机"
  static let directory = "工作目录"
  static let notProvided = "未提供"
  static let noSession = "未建立会话"
  static let copied = "已复制"
  static let usageUnavailable = "上下文占用与累计用量：Mac 未提供"
  static let turns = "轮次"
  static let workspace = "项目文件与 Diff"
  static let workspaceScope = "当前工作区相对 HEAD，不是本会话的改动"
  static let modelTitle = "模型与推理强度"
  static let nextTurn = "用于下一轮"
  static let defaultModel = "默认"

  static func lastChecked(_ date: Date) -> String {
    "\(ConnectionCopy.historyLastChecked) \(date.formatted(date: .abbreviated, time: .shortened))"
  }

  static func context(title: String?, provider: String?) -> String {
    let provider = provider ?? notProvided
    guard let title, !title.isEmpty else { return provider }
    return "\(title) · \(provider)"
  }
}
