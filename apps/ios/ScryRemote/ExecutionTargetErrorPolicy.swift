import Foundation
import RemoteTransport

extension ConnectionCopy {
  static let targetGatewayOffline = "在这台 Mac 上打开 Scry 后才能使用其他主机"
  static let targetsUnavailable = "当前主机暂未启用其他主机转发"

  static let updatePhoneProtocol = "请更新 iPhone 上的 Scry，再连接这台 Mac。"
  static let updateMacProtocol = "请更新并重新打开 Mac 上的 Scry，再连接。"
  static let updateBothProtocols = "iPhone 和 Mac 上的 Scry 协议版本不同。请更新两端的 Scry 后重试。"
  static let subscriptionUnavailable = "Mac 未提供所需的会话订阅。请更新并重新打开 Mac 上的 Scry。"

  static func isProtocolFailure(_ code: String) -> Bool {
    ["protocol_upgrade_client", "protocol_upgrade_host", "protocol_mismatch", "subscribe_unsupported", "unknown_op"].contains(code)
  }

  static func describeKnownHostError(_ code: String) -> String? {
    switch code {
    case "protocol_upgrade_client": return updatePhoneProtocol
    case "protocol_upgrade_host": return updateMacProtocol
    case "protocol_mismatch": return updateBothProtocols
    case "subscribe_unsupported": return subscriptionUnavailable
    case "history_profile_unavailable": return historyProfileUnavailable
    case "history_profile_required": return historyProfileUnverified
    case "execution_target_gateway_offline": return targetGatewayOffline
    case "execution_targets_unavailable": return targetsUnavailable
    default: return nil
    }
  }
}

enum ExecutionTargetDiscoveryErrorOutcome {
  case unavailable
  case issue(RemoteRunStore.CatalogRefreshFailure)
}

enum ExecutionTargetErrorPolicy {
  @MainActor static func classifyDiscoveryError(_ error: Error) -> ExecutionTargetDiscoveryErrorOutcome {
    if case G0Transport.RunError.host(code: "execution_targets_unavailable") = error {
      return .unavailable
    }
    let detail: String
    if case G0Transport.RunError.host(code: "unknown_op") = error {
      detail = ConnectionCopy.forwardingUnsupported
    } else {
      detail = RemoteRunStore.describe(error)
    }
    let diagnostic = ConnectionCopy.targetDiscoveryDiagnostic(detail)
    if case let G0Transport.RunError.host(code) = error {
      if ["device_not_authorized", "grant_expired", "grant_revoked"].contains(code) {
        return .issue(.authorization(diagnostic))
      }
      if code == "execution_target_gateway_offline" {
        return .issue(.transport(diagnostic, retryable: false))
      }
      return .issue(.protocolMismatch(diagnostic))
    }
    return .issue(.transport(diagnostic, retryable: RelayTransportError.permitsReadRecovery(error)))
  }
}
