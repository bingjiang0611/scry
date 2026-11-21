import Foundation
import RemoteTransport

extension ConnectionCopy {
  static let targetGatewayOffline = "在这台 Mac 上打开 Scry 后才能使用其他主机"
  static let targetsUnavailable = "当前主机暂未启用其他主机转发"

  static func describeKnownHostError(_ code: String) -> String? {
    switch code {
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
