import Foundation

// Copy touched by the R2 home/composer redesign. Shared legacy copy stays in
// ConnectionCopy.swift; keeping this extension separate avoids growing that file.
extension ConnectionCopy {
  static let tabActivity = "动态"
  static let homeNeedsReply = "需要回复"
  static let sectionRunning = "进行中"
  static let homeWaiting = "待回答"
  static let activityEmpty = "暂无需要回复或进行中的任务，其他会话在「项目」里"
  static func activityOverflow(_ count: Int) -> String { "另有 \(count) 条，请搜索定位" }
  static let expanded = "已展开"
  static let collapsed = "已收起"
  static let sendMessage = "发送"
  static let hideKeyboard = "收起键盘"
  static let attachmentMenu = "附件"
  static let photoLibrary = "照片图库"
  static let textOrCodeFile = "文本或代码文件"
  static let defaultApproval = "默认审批"
  static func permissionMenu(_ label: String) -> String { "权限 · \(label)" }
  static func permissionLocked(_ label: String) -> String { "已由 Mac 锁定为\(label)" }
  static func attachmentAndPermission(_ label: String) -> String { "添加附件与权限，当前\(label)" }
  static func composerAgent(_ label: String) -> String { "Agent：\(label)" }
  static func lockedComposerAgent(_ label: String) -> String { "已锁定 Agent：\(label)" }
  static let attachmentCountLimit = "附件最多 4 项"
  static let attachmentNameLimit = "附件名称过长"
  static func attachmentSizeLimit(_ name: String) -> String { "\(name) 超过 512 KB；请压缩后重试" }
  static let attachmentTotalLimit = "附件总大小不能超过 700 KB"
  static let ignoredExtraImages = "附件最多 4 项，已忽略多余图片"
  static let unreadableImage = "无法读取所选图片"
  static func imageReadFailed(_ reason: String) -> String { "图片读取失败：\(reason)" }
  static let imageBudgetFailed = "无法把所选图片压缩到剩余附件额度内"
  static let ignoredExtraFiles = "附件最多 4 项，已忽略多余文件"
  static func sourceFileLimit(_ name: String) -> String { "\(name) 过大；图片原文件需小于 24 MB，文本需小于 512 KB" }
  static func fileImageBudgetFailed(_ name: String) -> String { "无法把 \(name) 压缩到剩余附件额度内" }
  static func nonUTF8File(_ name: String) -> String { "\(name) 不是可读取的 UTF-8 文本文件" }
  static func fileReadFailed(_ reason: String) -> String { "文件读取失败：\(reason)" }
}
