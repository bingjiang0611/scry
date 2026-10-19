import Foundation

// Copy for the connection and catalog feedback surface. Keeping this small
// vocabulary in one place prevents the home projection from inventing a second
// set of status meanings.
enum ConnectionCopy {
  static let homeTitle = "远程"
  static let settings = "设置"
  static let connectMac = "连接 Mac"
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
