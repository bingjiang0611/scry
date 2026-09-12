import SwiftUI

// Truthful UI state. This app renders the accepted v2 chrome, but the remote
// host protocol (tasks, chat, files, terminal) is NOT implemented yet, so the
// model never fabricates sessions or "connected" state. Empty/unpaired/offline
// are real states with honest copy, matching v2's own offline/empty semantics.
// It must never display invented tasks, a green "connected" dot, or fake
// approvals to look complete.

enum AuthState: Equatable {
  case signedOut
  case signingIn
  case signedIn(name: String)
  case failed(String)
}

// A host binding is only "connected" when a real, currently-live owner-device
// grant + transport exists. None of that is wired here, so the honest maximum
// this app can represent today is signedIn + notPaired.
enum HostLink: Equatable {
  case notPaired
  case pairing
  case offline(host: String)
  case connected(host: String)

  var host: String? {
    switch self {
    case .notPaired, .pairing: return nil
    case let .offline(host), let .connected(host): return host
    }
  }
  var isConnected: Bool { if case .connected = self { return true }; return false }
}

enum Route: Hashable { case home, newSession, chat, pair }

@MainActor
final class AppModel: ObservableObject {
  @Published var auth: AuthState = .signedOut
  @Published var link: HostLink = .notPaired
  @Published var route: Route = .home
  @Published var query: String = ""

  // No fabricated sessions. Until a real host feed exists this stays empty and
  // the UI shows a truthful empty state rather than mock rows.
  @Published private(set) var sessions: [Session] = []

  var signedIn: Bool { if case .signedIn = auth { return true }; return false }

  func statusText() -> String {
    switch link {
    case .notPaired: return "未连接 · 请在 Mac 上配对"
    case .pairing: return "配对中 · 等待 Mac 确认"
    case .offline: return "离线 · 显示缓存"
    case .connected: return "锁屏 · 系统醒着"
    }
  }

  #if DEBUG
  // DEBUG-only visual verification harness driven by launch arguments. It only
  // forces view state so screens can be screenshotted without a paid Sign in
  // with Apple entitlement. It is NOT real authentication and NOT a real host
  // grant, and it never injects fabricated sessions.
  func applyUIPreviewArguments() {
    let args = ProcessInfo.processInfo.arguments
    guard args.contains("-uiPreview") else { return }
    auth = .signedIn(name: "预览")
    link = args.contains("-connected") ? .connected(host: "Studio Mac") : .notPaired
    if let index = args.firstIndex(of: "-route"), index + 1 < args.count {
      switch args[index + 1] {
      case "home": route = .home
      case "new": route = .newSession
      case "chat": route = .chat
      case "pair": route = .pair
      default: break
      }
    }
  }
  #endif

  func reset() {
    auth = .signedOut
    link = .notPaired
    route = .home
    query = ""
    sessions = []
  }
}

struct Session: Identifiable, Hashable {
  let id: String
  let title: String
  let provider: String
  let model: String
}
