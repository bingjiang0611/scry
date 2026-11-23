import Foundation
import RemoteTransport

#if DEBUG
extension RemoteRunStore {
  nonisolated static func selfTestRecoveryCheckpointRoundTrip() -> Bool {
    let identity = SessionIdentity.new(providerId: "codex", cwd: "/repo")
    let attachment = RemoteRunClient.Attachment(kind: .text, name: "note.txt", mimeType: "text/plain",
                                                dataBase64: "cmF3", size: 3)
    let routing = RemoteRunClient.Routing(cwd: "/repo", providerId: "codex", agentProfileId: nil,
                                          prompt: "continue", attachments: [attachment])
    let checkpoint = RecoveryCheckpoint(version: 1, hostId: "host", intentId: UUID().uuidString.lowercased(),
                                        routing: routing, identity: identity, runId: nil)
    guard let data = try? JSONEncoder().encode(checkpoint),
          let decoded = try? JSONDecoder().decode(RecoveryCheckpoint.self, from: data) else { return false }
    return decoded.version == 1 && decoded.hostId == "host" && decoded.intentId == checkpoint.intentId &&
      decoded.routing == routing && decoded.identity == identity && decoded.runId == nil
  }

  nonisolated static func selfTestGenerationIsolation() -> Bool {
    let a = SessionIdentity.opened(providerId: "codex", cwd: "/a", externalSessionId: "one")
    let b = SessionIdentity.opened(providerId: "codex", cwd: "/b", externalSessionId: "two")
    return responseMatches(currentGeneration: 2, requestGeneration: 2, currentIdentity: b, requestIdentity: b) &&
      !responseMatches(currentGeneration: 2, requestGeneration: 1, currentIdentity: b, requestIdentity: b) &&
      !responseMatches(currentGeneration: 2, requestGeneration: 2, currentIdentity: b, requestIdentity: a)
  }

  nonisolated static func selfTestDrain(cursor: Int, next: Int, chunkCount: Int) -> Bool {
    shouldContinueDrain(cursor: cursor, next: next, chunkCount: chunkCount) &&
      !shouldContinueDrain(cursor: next, next: next, chunkCount: chunkCount) &&
      !shouldContinueDrain(cursor: cursor, next: next, chunkCount: 0)
  }

  #if DEBUG
  // Opt-in FLOW probe (`-openFlowProbe`): replays the exact user loop — open a
  // session, leave the screen, open it again — against the real persisted cache
  // and the paired host, and prints how long until content is on screen versus
  // how long the background refresh takes. Paint (what the user waits for) is
  // separated from settle (network) because a slow network must never delay the
  // repaint of history this device already verified.
  static func runOpenFlowProbeIfRequested() {
    guard ProcessInfo.processInfo.arguments.contains("-openFlowProbe") else { return }
    func argumentValue(_ name: String) -> String? {
      guard let argument = ProcessInfo.processInfo.arguments.first(where: { $0.hasPrefix(name + "=") }) else { return nil }
      return String(argument.dropFirst(name.count + 1))
    }
    Task { @MainActor in
      guard let provider = argumentValue("-provider"), let cwd = argumentValue("-cwd"),
            let external = argumentValue("-session") else {
        print("OPENFLOW FAIL reason=missing-target")
        exit(1)
      }
      @MainActor func describe(_ state: HistoryState) -> String {
        switch state {
        case .idle: return "idle"
        case .loading: return "loading"
        case .empty: return "empty"
        case .baseUnavailable: return "baseUnavailable"
        case .failed(let message): return "failed(\(message.prefix(30)))"
        case .partial(let turns): return "partial(\(turns.count))"
        case .loaded(let turns): return "loaded(\(turns.count))"
        }
      }
      let profile = argumentValue("-profile")
      @MainActor func open(_ store: RemoteRunStore, _ label: String) async {
        let start = Date()
        store.loadHistory(providerId: provider, cwd: cwd, externalSessionId: external, agentProfileId: profile)
        let paint = describe(store.history)
        let paintMs = Int(Date().timeIntervalSince(start) * 1000)
        let settleStart = Date()
        await store.historyTask?.value
        let settleMs = Int(Date().timeIntervalSince(settleStart) * 1000)
        print("OPENFLOW \(label) paintMs=\(paintMs) paint=\(paint) window=\(store.historyWindow?.turns.count ?? -1)"
          + " settleMs=\(settleMs) after=\(describe(store.history)) error=\(store.historyRefreshError ?? "-")"
          + " notice=\(store.historyStorageNotice ?? "-") cache=\(store.historyFromCache)")
      }
      let store = RemoteRunStore()
      // What a launched app looks like: the scene-active prewarm has run, so the
      // bulk lane is open before the first tap.
      store.foregrounded()
      try? await Task.sleep(nanoseconds: 2_500_000_000)
      await open(store, "warm-launch-open")
      await open(RemoteRunStore(), "cold-open")
      await open(store, "reopen-after-back")
      await open(store, "reopen-again")
      // A fresh store shares only the on-disk mirror, like a relaunched app.
      await open(RemoteRunStore(), "relaunch-open")
      print("OPENFLOW DONE")
      exit(0)
    }
    RunLoop.current.run()
  }
  #endif

  nonisolated static func selfTestStateGates() -> Bool {
    !unresolvedState(pending: false, runId: nil, drained: false, interrupted: false) &&
      unresolvedState(pending: true, runId: nil, drained: false, interrupted: false) &&
      unresolvedState(pending: false, runId: "run", drained: false, interrupted: false) &&
      unresolvedState(pending: false, runId: "run", drained: true, interrupted: true) &&
      !unresolvedState(pending: false, runId: "run", drained: true, interrupted: false) &&
      !shouldIncludeCompletedTurn("current", currentRunId: "current", archived: true) &&
      shouldIncludeCompletedTurn("old", currentRunId: "current", archived: true) &&
      shouldIncludeCompletedTurn("old", currentRunId: "old", archived: false)
  }

  nonisolated static func selfTestFollowUpIdentity() -> Bool {
    let opened = SessionIdentity.opened(providerId: "codex", cwd: "/repo", externalSessionId: "original")
    let kept = followUpIdentity(current: opened, providerId: "codex", cwd: "/repo", originalResume: "latest")
    let replaced = followUpIdentity(current: opened, providerId: "qoder", cwd: "/repo", originalResume: "qoder")
    return kept == opened && replaced.externalSessionId == "qoder" && replaced != opened
  }
}
#endif
