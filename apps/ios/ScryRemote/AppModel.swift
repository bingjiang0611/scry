import SwiftUI
import RemoteTransport

// Truthful UI state for the v5 Codex Refined interface. Connection, catalog,
// history and run state come only from the paired host; empty/unpaired/offline
// remain first-class UI states. The app must never display invented tasks, a
// green connected dot, Agent output or approvals merely to look complete.

// A host binding is only "connected" when a real, currently-live owner-device
// grant and successful transport exchange exist. A persisted grant alone is
// represented as offline until a request proves reachability.
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

// Which read-only host panel a route shows. Kept with the route so the model
// layer does not depend on a view file.
enum ToolKind: String, CaseIterable, Identifiable {
  case analytics, llmPerformance, mcpTrust
  var id: String { rawValue }
  var title: String {
    switch self {
    case .analytics: return ConnectionCopy.analyticsTitle
    case .llmPerformance: return ConnectionCopy.llmTitle
    case .mcpTrust: return ConnectionCopy.mcpTitle
    }
  }
  var panelKind: G0Transport.ToolPanelKind {
    switch self {
    case .analytics: return .analytics
    case .llmPerformance: return .llmPerformance
    case .mcpTrust: return .mcpTrust
    }
  }
}

enum Route: Hashable { case home, newSession, chat, pair, transcript, settings, toolPanel(ToolKind) }

// The session the owner opened to READ its past conversation (read-only replay).
// Plain identity fields (no transport coupling); externalSessionId is required -
// a session with none is not yet resumable/readable and is not opened.
struct OpenedSession: Equatable {
  let providerId: String
  let agentProfileId: String?
  let cwd: String
  let externalSessionId: String
  let label: String
  let isActive: Bool
  let scope: ExecutionTargetScope?

  init(providerId: String, agentProfileId: String? = nil, cwd: String,
       externalSessionId: String, label: String, isActive: Bool = false,
       scope: ExecutionTargetScope? = nil) {
    self.providerId = providerId; self.agentProfileId = agentProfileId; self.cwd = cwd
    self.externalSessionId = externalSessionId; self.label = label; self.isActive = isActive; self.scope = scope
  }

  var identity: RemoteRunStore.SessionIdentity {
    .opened(providerId: providerId, agentProfileId: agentProfileId, cwd: cwd,
            externalSessionId: externalSessionId, scope: scope)
  }
}

// Honest pairing UI state. A fingerprint means the device PROVED possession and
// is waiting for the Mac operator to confirm; it is NOT paired yet. Only a
// host-issued grant flips to .paired. Failures keep the technical evidence for
// disclosure without making internal codes the primary instruction.
struct PairingFailure: Equatable {
  let message: String
  let technicalDetail: String?

  init(message: String, technicalDetail: String? = nil) {
    self.message = message
    self.technicalDetail = technicalDetail
  }
}

enum PairingUIState: Equatable {
  case idle
  case scanning
  case proving
  case awaitingConfirmation(fingerprint: String)
  case paired(deviceId: String)
  case failed(PairingFailure)
}

@MainActor
final class AppModel: ObservableObject {
  @Published var link: HostLink = .notPaired
  @Published var route: Route = .home
  @Published var query: String = ""
  @Published var pairing: PairingUIState = .idle
  // The session currently opened for read-only transcript replay (nil = none).
  @Published var openedSession: OpenedSession?
  @Published var readOnlyTranscript = false
  // The focused run's question sheet. App-level because questions belong to the
  // run; a screen's status strip reopens it after the user dismisses it.
  @Published var showRunQuestion = false

  // Opening another session leaves a run with a host receipt running on the
  // Mac (its status, questions and stop stay reachable via the live-run list).
  // Only an unacknowledged submission keeps the read-only browse fallback.
  func open(_ session: OpenedSession, run: RemoteRunStore) {
    let identity = session.identity
    readOnlyTranscript = run.hasUnresolvedRun && identity != run.activeSessionIdentity && !run.detachFocusedRun()
    openedSession = session
    route = .transcript
  }
  // Drafts belong to a conversation, not to a disposable route view. They stay
  // in memory only; attachments are never written to plaintext preferences.
  enum DraftKey: Hashable {
    case newTask(ExecutionTargetScope)
    case conversation(RemoteRunStore.SessionIdentity)
  }
  struct ComposerDraft {
    var text = ""
    var attachments: [DraftAttachment] = []
  }
  private struct ScopedDraftKey: Hashable {
    let gatewayIdentity: String?
    let key: DraftKey
  }
  @Published private var drafts: [ScopedDraftKey: ComposerDraft] = [:]
  @Published private var draftAliases: [ScopedDraftKey: RemoteRunStore.SessionIdentity] = [:]

  private func scopedDraftKey(_ key: DraftKey) -> ScopedDraftKey {
    let gateway: String?
    switch key {
    case let .newTask(scope): gateway = scope.gatewayIdentity
    case let .conversation(identity):
      // Legacy local session ids stay wire/cache compatible, but drafts and
      // aliases must still be isolated when the paired gateway grant changes.
      gateway = identity.gatewayIdentity ?? connections.load().map { RemoteHistoryCache.catalogKey(connection: $0) }
    }
    return ScopedDraftKey(gatewayIdentity: gateway, key: key)
  }

  func bindDraft(externalSessionId: String, to identity: RemoteRunStore.SessionIdentity) {
    let external = RemoteRunStore.SessionIdentity.opened(providerId: identity.providerId,
      agentProfileId: identity.agentProfileId, cwd: identity.cwd, externalSessionId: externalSessionId,
      scope: identity.scope)
    let source = scopedDraftKey(.conversation(identity))
    let destination = ScopedDraftKey(gatewayIdentity: source.gatewayIdentity, key: .conversation(external))
    draftAliases[destination] = draftAliases[source] ?? identity
  }

  func composerDraft(for key: DraftKey) -> Binding<ComposerDraft> {
    var resolved = scopedDraftKey(key)
    if case .conversation = key, let original = draftAliases[resolved] {
      resolved = ScopedDraftKey(gatewayIdentity: resolved.gatewayIdentity, key: .conversation(original))
    }
    let frozen = resolved
    return Binding(get: { self.drafts[frozen] ?? ComposerDraft() }, set: { self.drafts[frozen] = $0 })
  }
  @Published private(set) var destructiveActionError: String?
  @Published private(set) var connectionObservation: RemoteRunStore.ConnectionObservation = .unverified
  @Published private(set) var connectionNotice: String?
  private var pairingTask: Task<Void, Never>?
  private let connections: RemoteConnectionStore
  let targetCoordinator: ExecutionTargetCoordinator

  // No fabricated sessions. Until a real host feed exists this stays empty and
  // the UI shows a truthful empty state rather than mock rows.
  @Published private(set) var sessions: [Session] = []

  var canShowWorkspace: Bool {
    #if DEBUG
    if ProcessInfo.processInfo.arguments.contains("-uiPreview") { return true }
    #endif
    return hasConnection
  }

  // A persisted PUBLIC connection descriptor means this device already paired
  // (key + granted cert live in the Keychain); it does NOT need to scan a new QR.
  var hasConnection: Bool { connections.load() != nil }
  var connectionHost: String? { connections.load()?.relayHost }

  init(connections: RemoteConnectionStore = RemoteConnectionStore(), historyDisk: RemoteHistoryCache = RemoteHistoryCache(),
       stateDirectory: URL? = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first?.appendingPathComponent("ScryRemote", isDirectory: true)) {
    self.connections = connections
    self.targetCoordinator = ExecutionTargetCoordinator(connections: connections, historyDisk: historyDisk, stateDirectory: stateDirectory)
    // Restore the paired state on launch so an already-paired device is never
    // forced to re-scan. Paired != reachable: we show .offline(host) until a real
    // exchange proves the host is reachable (markReachable), never a fake dot.
    if let host = connections.load()?.relayHost { link = .offline(host: host) }
  }

  // A green link requires a successful transport exchange. Host business errors
  // (including revocation/unavailable) remain visibly paired but never become
  // connected; their exact code stays available in this projection.
  func markReachable(_ ok: Bool) {
    guard let host = connectionHost else { return }
    link = ok ? .connected(host: host) : .offline(host: host)
    if ok { connectionObservation = .reachable; connectionNotice = nil }
    else if connectionObservation == .unverified { connectionObservation = .transportFailure }
  }

  func markObservation(_ observation: RemoteRunStore.ConnectionObservation) {
    connectionObservation = observation
    guard let host = connectionHost else { return }
    switch observation {
    case .reachable:
      link = .connected(host: host); connectionNotice = nil
    case .transportFailure:
      link = .offline(host: host); connectionNotice = "未收到主机响应，传输状态未知。"
    case .unverified:
      link = .offline(host: host)
      connectionNotice = nil
    case let .hostReply(code):
      // A valid authenticated reply proves transport reachability. Snapshot,
      // capacity and unavailable errors must not erase an already-proven green
      // link; revoked grants are the explicit exception.
      if Self.isRevocation(code) { link = .offline(host: host) }
      connectionNotice = "主机已响应，但本次操作不可用（\(code)）。"
    case let .protocolFailure(code):
      link = .offline(host: host)
      connectionNotice = "主机已响应，但协议不匹配（\(code)）。请更新并完全退出后重新打开 Mac。"
    }
  }

  private static func isRevocation(_ code: String) -> Bool {
    ["device_not_authorized", "grant_expired", "grant_revoked"].contains(code)
  }

  func statusText() -> String {
    switch link {
    case .notPaired: return "未连接 · 请在 Mac 上配对"
    case .pairing: return "配对中 · 等待 Mac 确认"
    case .offline:
      switch connectionObservation {
      case let .hostReply(code): return "已配对 · 主机已响应（\(code)）"
      case let .protocolFailure(code): return "已配对 · 协议不匹配（\(code)）"
      case .transportFailure: return "已配对 · 传输失败"
      default: return "已配对 · 尚未验证可达"
      }
    case .connected: return "已连接 · 主机可达"
    }
  }

  #if DEBUG
  // DEBUG-only visual verification harness driven by launch arguments. It can
  // pair with `RemoteRunStore`'s explicit `-uiMockData` fixtures for UI review.
  // It is NOT real authentication or a real host grant and is compiled out of
  // Release builds.
  func applyUIPreviewArguments(runStore: RemoteRunStore) {
    let args = ProcessInfo.processInfo.arguments
    guard args.contains("-uiPreview") else { return }
    link = args.contains("-connected") ? .connected(host: "Studio Mac") : .notPaired
    if let index = args.firstIndex(of: "-route"), index + 1 < args.count {
      switch args[index + 1] {
      case "home": route = .home
      case "new": route = .newSession
      case "chat": route = .chat
      case "pair": route = .pair
      case "settings": route = .settings
      case "transcript": route = .transcript
      default: break
      }
    }
    if args.contains("-uiMockData") {
      openedSession = OpenedSession(providerId: "codex", cwd: "/Users/demo/Projects/scry",
                                    externalSessionId: "codex-pinned-1",
                                    label: "重构远程会话列表并统一信息层级")
    }
    // DEBUG-only real-transport harness for an attached physical device. This
    // bypasses only the camera gesture; PairingCode parsing, key possession,
    // relay WSS, inner mTLS and Mac confirmation all remain production paths.
    if let index = args.firstIndex(of: "-pairCode"), index + 1 < args.count {
      route = .pair
      beginPair(scanned: args[index + 1], runStore: runStore)
    }
  }
  #endif

  // Drive the real device-side pairing: parse the scanned scry1: code, prove key
  // possession over the relay (inner TLS 1.3 mTLS to the host), then poll until
  // the Mac operator confirms and a grant is issued. Runs the PROVEN
  // RemotePairingClient; no state is faked.
  func beginPair(scanned: String, runStore: RemoteRunStore) {
    guard !targetCoordinator.recoveryUnavailable else {
      pairing = .failed(.init(message: ConnectionCopy.targetRecoveryUnavailable)); return
    }
    guard !targetCoordinator.hasPendingWork, !runStore.hasUnsentMessages, !runStore.hasUnresolvedRun else {
      pairing = .failed(.init(message: RemoteRunStore.ConnectionReplacementError.pendingWork.localizedDescription))
      return
    }
    pairingTask?.cancel()
    let code: PairingCode
    do { code = try PairingCode.parse(scanned) }
    catch { pairing = .failed(Self.pairingCodeFailure(error)); return }
    pairing = .proving
    link = .pairing
    route = .pair // Keep the grant receipt visible when QR-only onboarding unlocks the workspace.
    let label = RemoteDeviceModel.currentLabel
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
            try await self?.setPaired(deviceId: deviceId, host: code.relayHost, connection: connection, runStore: runStore)
            return
          case let .denied(reason):
            // A host may already know this device key while its public relay
            // coordinates changed (for example, LAN -> official WSS). If the
            // existing grant pins the exact same host identity and CA, retain
            // that grant and update routing only; no secret/key material changes.
            if reason == "device_key_already_registered",
               let existing = self?.connections.load(),
               existing.hostId == code.hostId,
               existing.anchorPEM == code.anchorPEM {
              let migrated = RemoteConnection(relayHost: code.relayHost, relayPort: code.relayPort,
                relayTLS: code.relayTLS.rawValue, hostId: existing.hostId,
                anchorPEM: existing.anchorPEM, deviceId: existing.deviceId)
              try await self?.setPaired(deviceId: existing.deviceId, host: code.relayHost, connection: migrated, runStore: runStore)
              return
            }
            await self?.setPairing(.failed(Self.pairingDeniedFailure(reason)))
            return
          case let .revoked(deviceId):
            await self?.setPairing(.failed(.init(message: ConnectionCopy.pairingRevoked,
                                                  technicalDetail: "deviceId=\(deviceId)")))
            return
          }
        }
        await self?.setPairing(.failed(.init(message: ConnectionCopy.pairingTimeout)))
      } catch {
        if Task.isCancelled { return }
        await self?.setPairing(.failed(.init(message: ConnectionCopy.pairingConnectionFailed,
                                             technicalDetail: String(reflecting: error))))
      }
    }
  }

  private static func pairingCodeFailure(_ error: Error) -> PairingFailure {
    let message: String
    switch error as? PairingCode.ParseError {
    case .badPrefix: message = ConnectionCopy.pairingCodeWrongApp
    case .badBase64, .badJSON, .invalidField: message = ConnectionCopy.pairingCodeInvalid
    case nil: message = ConnectionCopy.pairingCodeInvalid
    }
    return .init(message: message, technicalDetail: String(describing: error))
  }

  private static func pairingDeniedFailure(_ code: String) -> PairingFailure {
    let message: String
    switch code {
    case "pairing_expired", "pairing_not_active", "unknown_pairing", "invalid_pairing_proof":
      message = ConnectionCopy.pairingCodeExpired
    case "device_key_already_registered":
      message = ConnectionCopy.pairingAlreadyRegistered
    case "pairing_candidate_changed", "device_proof_required", "channel_key_mismatch":
      message = ConnectionCopy.pairingProofChanged
    default:
      message = ConnectionCopy.pairingDenied
    }
    return .init(message: message, technicalDetail: code)
  }

  private func setPairing(_ state: PairingUIState) {
    pairing = state
    if case .failed = state {
      link = connectionHost.map { .offline(host: $0) } ?? .notPaired
    }
  }
  private func setPaired(deviceId: String, host: String, connection: RemoteConnection, runStore: RemoteRunStore) throws {
    try targetCoordinator.prepareConnectionReplacement(connection)
    connections.save(connection)
    targetCoordinator.connectionChanged()
    openedSession = nil
    readOnlyTranscript = false
    showRunQuestion = false
    connectionObservation = .unverified
    connectionNotice = nil
    // Re-pairing keeps canShowWorkspace true, so RootView's pairing-change
    // observer will not restart the feed cleared with the previous grant.
    targetCoordinator.foregrounded()
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
          if self.targetCoordinator.beginNewTask() { self.route = .newSession }
        }
      }
    }
  }

  func cancelPairing() {
    pairingTask?.cancel()
    pairingTask = nil
    pairing = .idle
    if case .pairing = link { link = connectionHost.map { .offline(host: $0) } ?? .notPaired }
  }

  var canGoBack: Bool { canShowWorkspace && route != .home }

  func goBack() {
    guard canGoBack else { return }
    if route == .pair { cancelPairing() }
    route = .home
  }

  // Clear downloaded private history before removing its grant. If either
  // storage or Keychain cleanup fails, do not claim a successful unpair.
  func destructiveUnpair(runStore: RemoteRunStore) async {
    destructiveActionError = nil
    do {
      try await targetCoordinator.clearAllState()
      try RemoteKeychain().clearAll()
      connections.clear()
      targetCoordinator.connectionChanged()
      pairingTask?.cancel(); pairingTask = nil
      pairing = .idle; link = .notPaired; connectionObservation = .unverified; connectionNotice = nil; route = .home
      query = ""; sessions = []; drafts = [:]; draftAliases = [:]
    } catch {
      destructiveActionError = "无法清除本机配对凭据：\(error)。未报告为已清除，请重试。"
    }
  }

}

struct Session: Identifiable, Hashable {
  let id: String
  let title: String
  let provider: String
  let model: String
}
