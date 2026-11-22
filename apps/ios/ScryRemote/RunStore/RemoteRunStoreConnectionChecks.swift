import Foundation
import RemoteTransport

#if DEBUG
extension RemoteRunStore {
  static func selfTestConnectionReplacement() -> [(String, Bool)] {
    let suite = "ScryConnectionReplacement.\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: suite)!
    defer { defaults.removePersistentDomain(forName: suite) }
    let connections = RemoteConnectionStore(defaults: defaults)
    let old = RemoteConnection(relayHost: "a.invalid", relayPort: 443, relayTLS: "system", hostId: "a", anchorPEM: "a", deviceId: "a")
    let new = RemoteConnection(relayHost: "b.invalid", relayPort: 443, relayTLS: "system", hostId: "b", anchorPEM: "b", deviceId: "b")
    connections.save(old)
    let model = AppModel(connections: connections)
    model.markReachable(true)
    model.markObservation(.unverified)
    let unknownIsOffline = model.link == .offline(host: old.relayHost) && model.connectionNotice == nil
    model.markReachable(true)
    model.markObservation(.hostReply(code: "grant_revoked"))
    let revokedIsOffline = model.link == .offline(host: old.relayHost)
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(suite)
    defer { try? FileManager.default.removeItem(at: directory) }
    let store = RemoteRunStore(connections: connections, stateDirectory: directory)
    let identity = SessionIdentity.new(providerId: "codex", cwd: "/fixture")
    let pending = PendingSubmission(intentId: "old-intent", routing: .init(cwd: "/fixture", providerId: "codex", agentProfileId: nil, prompt: "old prompt"), identity: identity)
    var checks: [(String, Bool)] = [("connection.modelUnverifiedNotGreen", unknownIsOffline), ("connection.modelRevokedNotGreen", revokedIsOffline)]
    store.outbox = [pending]
    do {
      try store.prepareConnectionReplacement(new)
      checks.append(("replacement.pendingRefused", false))
    } catch {
      checks.append(("replacement.pendingRefused", connections.load() == old && store.outbox == [pending]))
    }
    store.outbox = []
    store.chosen = .init(path: "/old-host", label: "Old host")
    do {
      let migrated = RemoteConnection(relayHost: "new-route.invalid", relayPort: 443, relayTLS: "system", hostId: "a", anchorPEM: "a", deviceId: "a")
      try store.prepareConnectionReplacement(migrated)
      checks.append(("replacement.sameGrantRetainsContext", store.chosen?.path == "/old-host"))
      try store.prepareConnectionReplacement(new)
      checks.append(("replacement.newGrantClearsContext", store.chosen == nil && store.outbox.isEmpty && store.deliveryTasks.isEmpty && store.connectionObservation == .unverified))
    } catch { checks.append(("replacement.cleanup", false)) }
    // Real filesystem failures in an isolated directory. No production outbox,
    // recovery record, history or Keychain material is touched.
    for file in ["outbox.json", "active-run.json"] {
      do {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let url = directory.appendingPathComponent(file)
        try Data("private prompt".utf8).write(to: url)
        try FileManager.default.setAttributes([.posixPermissions: 0o500], ofItemAtPath: directory.path)
        defer { try? FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: directory.path); try? FileManager.default.removeItem(at: url) }
        store.chosen = .init(path: "/must-retain", label: "Must retain")
        do {
          try store.clearAllState()
          checks.append(("cleanup.\(file)FailureVisible", false))
        } catch {
          checks.append(("cleanup.\(file)FailureVisible", store.chosen?.path == "/must-retain" && FileManager.default.fileExists(atPath: url.path)))
        }
      } catch { checks.append(("cleanup.\(file)Fixture", false)) }
    }
    return checks
  }

  static func selfTestCatalogRefreshProjection() -> [(String, Bool)] {
    let store = RemoteRunStore()
    let fixture = G0Transport.RunSessionRef(sessionId: "refresh-fixture", externalSessionId: "session",
      providerId: "codex", cwd: "/fixture", label: "fixture", ts: 1)
    store.catalog = .loaded([fixture])
    let before = store.catalogRefreshRevision
    store.applyCatalogRefreshFixture()
    return [
      ("refreshCompletesThroughFixture", store.catalogRefreshRevision == before + 1 && !store.catalogRefreshInFlight),
      ("refreshMarksVerified", { if case let .verified(date) = store.catalogEvidence { return date == store.catalogVerifiedAt }; return false }()),
      ("refreshKeepsContents", store.catalog == .loaded([fixture]))
    ]
  }

  actor CatalogTestGate {
    private var paused = false
    private var waiter: CheckedContinuation<Void, Never>?
    private var arrival: CheckedContinuation<Void, Never>?
    private(set) var calls = 0

    func pause() async {
      calls += 1
      paused = true
      arrival?.resume(); arrival = nil
      await withCheckedContinuation { waiter = $0 }
    }
    func waitForArrival() async {
      if paused { return }
      await withCheckedContinuation { arrival = $0 }
    }
    func release() { waiter?.resume(); waiter = nil }
  }
}
#endif
