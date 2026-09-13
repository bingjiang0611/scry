import SwiftUI
#if canImport(UIKit)
import UIKit
#endif

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

// Honest pairing UI state. A fingerprint means the device PROVED possession and
// is waiting for the Mac operator to confirm; it is NOT paired yet. Only a
// host-issued grant flips to .paired. Failures surface verbatim, never as a
// fake success.
enum PairingUIState: Equatable {
  case idle
  case scanning
  case proving
  case awaitingConfirmation(fingerprint: String)
  case paired(deviceId: String)
  case failed(String)
}

@MainActor
final class AppModel: ObservableObject {
  @Published var auth: AuthState = .signedOut
  @Published var link: HostLink = .notPaired
  @Published var route: Route = .home
  @Published var query: String = ""
  @Published var pairing: PairingUIState = .idle
  private var pairingTask: Task<Void, Never>?
  private let connections = RemoteConnectionStore()

  // No fabricated sessions. Until a real host feed exists this stays empty and
  // the UI shows a truthful empty state rather than mock rows.
  @Published private(set) var sessions: [Session] = []

  var signedIn: Bool { if case .signedIn = auth { return true }; return false }

  // A persisted PUBLIC connection descriptor means this device already paired
  // (key + granted cert live in the Keychain); it does NOT need to scan a new QR.
  var hasConnection: Bool { connections.load() != nil }
  var connectionHost: String? { connections.load()?.relayHost }

  init() {
    // Restore the paired state on launch so an already-paired device is never
    // forced to re-scan. Paired != reachable: we show .offline(host) until a real
    // exchange proves the host is reachable (markReachable), never a fake dot.
    if let host = connections.load()?.relayHost { link = .offline(host: host) }
  }

  // Honest connection status from the run channel: a real successful exchange
  // proves reachability (.connected); a transport failure demotes to .offline.
  // Only meaningful when a grant exists; never fabricates a connected dot.
  func markReachable(_ ok: Bool) {
    guard let host = connectionHost else { return }
    link = ok ? .connected(host: host) : .offline(host: host)
  }

  func statusText() -> String {
    switch link {
    case .notPaired: return "未连接 · 请在 Mac 上配对"
    case .pairing: return "配对中 · 等待 Mac 确认"
    case .offline: return "已配对 · 尚未验证可达"
    case .connected: return "已连接 · 主机可达"
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

  // Drive the real device-side pairing: parse the scanned scry1: code, prove key
  // possession over the relay (inner TLS 1.3 mTLS to the host), then poll until
  // the Mac operator confirms and a grant is issued. Runs the PROVEN
  // RemotePairingClient; no state is faked.
  func beginPair(scanned: String) {
    pairingTask?.cancel()
    let code: PairingCode
    do { code = try PairingCode.parse(scanned) }
    catch { pairing = .failed("配对码无法识别：\(error)"); return }
    pairing = .proving
    link = .pairing
    let label = deviceLabel()
    pairingTask = Task { [weak self] in
      let client = RemotePairingClient()
      do {
        var progress = try await client.prove(code: code, deviceLabel: label)
        // Poll across the operator's confirmation window; the pairing code TTL
        // (~2 min) bounds this, and prove() is idempotent for the same key.
        for _ in 0..<90 {
          if Task.isCancelled { return }
          switch progress {
          case let .awaitingConfirmation(fingerprint):
            await self?.setPairing(.awaitingConfirmation(fingerprint: fingerprint))
            try await Task.sleep(nanoseconds: 2_000_000_000)
            progress = try await client.refresh(code: code, deviceLabel: label)
          case let .paired(deviceId, _):
            // Persist the PUBLIC connection descriptor so run operations can reach
            // the same host again without a fresh QR (key + cert stay in Keychain).
            let connection = RemoteConnection(relayHost: code.relayHost, relayPort: code.relayPort,
              relayTLS: code.relayTLS.rawValue, hostId: code.hostId, anchorPEM: code.anchorPEM, deviceId: deviceId)
            await self?.setPaired(deviceId: deviceId, host: code.relayHost, connection: connection)
            return
          case let .denied(reason):
            await self?.setPairing(.failed("Mac 拒绝了配对：\(reason)"))
            return
          case let .revoked(deviceId):
            await self?.setPairing(.failed("该设备已被吊销：\(deviceId)"))
            return
          }
        }
        await self?.setPairing(.failed("等待 Mac 确认超时，请重试。"))
      } catch {
        if Task.isCancelled { return }
        await self?.setPairing(.failed("配对失败：\(error)"))
      }
    }
  }

  private func setPairing(_ state: PairingUIState) { pairing = state }
  private func setPaired(deviceId: String, host: String, connection: RemoteConnection) {
    connections.save(connection)
    pairing = .paired(deviceId: deviceId)
    // A live grant now exists and the run channel is wired (RemoteRunClient). We
    // show an honest offline-but-paired link (reachability is only learned by an
    // actual run, never faked) and, critically, LEAVE the pairing screen: a
    // successful grant must not be a dead end. Briefly hold on "已配对" so the
    // success is visible, then land on the new-session picker.
    link = .offline(host: host)
    Task { [weak self] in
      try? await Task.sleep(nanoseconds: 1_200_000_000)
      guard let self else { return }
      await MainActor.run {
        if case .paired = self.pairing {
          self.pairing = .idle
          self.route = .newSession
        }
      }
    }
  }

  private func deviceLabel() -> String {
#if canImport(UIKit)
    return UIDevice.current.name
#else
    return "iPhone"
#endif
  }

  func cancelPairing() {
    pairingTask?.cancel()
    pairingTask = nil
    pairing = .idle
    if case .pairing = link { link = .notPaired }
  }

  func reset() {
    pairingTask?.cancel()
    pairingTask = nil
    pairing = .idle
    auth = .signedOut
    link = .notPaired
    route = .home
    query = ""
    sessions = []
    connections.clear()
  }
}

struct Session: Identifiable, Hashable {
  let id: String
  let title: String
  let provider: String
  let model: String
}
