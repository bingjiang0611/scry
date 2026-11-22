import Foundation
import RemoteTransport

#if DEBUG
extension RemoteRunStore {
  static func selfTestHistoryStore(directory: URL, snapshot: RemoteHistorySnapshot) async throws -> [(String, Bool)] {
    let suite = "ScryHistoryFixture.\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: suite)!
    defer { defaults.removePersistentDomain(forName: suite) }
    let connections = RemoteConnectionStore(defaults: defaults)
    let connection = RemoteConnection(relayHost: "fixture.invalid", relayPort: 443, relayTLS: "system",
      hostId: "fixture", anchorPEM: "fixture-anchor", deviceId: "fixture-grant")
    connections.save(connection)
    let disk = RemoteHistoryCache(directory: directory)
    let key = RemoteHistoryCache.key(connection: connection, providerId: "pi", cwd: "/fixture", sessionId: "session")
    _ = try await disk.write(snapshot, key: key, epoch: 0)
    let catalogKey = RemoteHistoryCache.catalogKey(connection: connection)
    let catalogFixture = [G0Transport.RunSessionRef(sessionId: "catalog-session", externalSessionId: "session", providerId: "pi", cwd: "/fixture", label: "fixture", ts: 1)]
    _ = try await disk.writeCatalog(catalogFixture, key: catalogKey, epoch: await disk.epoch)
    let store = RemoteRunStore(connections: connections, historyDisk: disk)
    store.historyTestOffline = true
    store.commands = .loaded([.init(name: "old-project", description: "fixture", source: "custom")])
    store.loadHistory(providerId: "pi", cwd: "/fixture", externalSessionId: "session")
    await store.historyTask?.value
    let beforeIdentity = store.activeSessionIdentity
    store.prefetchHistory([.init(sessionId: "fixture", externalSessionId: "session", providerId: "pi", cwd: "/fixture", label: "fixture", ts: 1)])
    await store.prefetchTask?.value
    var checks: [(String, Bool)] = [
      ("store.catalogCacheUsesGrantNamespace", (try? await disk.readCatalog(catalogKey)) == catalogFixture),
      ("store.catalogCacheKeepsRefreshTimestamp", (try? await disk.readCatalogValue(catalogKey))?.fetchedAt != nil),
      ("store.sessionSwitchDropsOldCommands", store.slashCommands.isEmpty),
      ("store.warmingDoesNotSwitchSession", store.activeSessionIdentity == beforeIdentity && store.prompt == nil),
      ("store.warmingUsesBoundedMirror", store.warmedScreens[key]?.available == true && ((try? JSONEncoder().encode(store.warmedScreens[key]).count) ?? Int.max) <= 16 * 1024),
      ("store.offlineKeepsDiskHistory", store.history == .loaded(snapshot.turns) && store.historyFromCache && store.reachable == false),
      ("store.offlineUpdateErrorVisible", store.historyRefreshError != nil),
      ("store.failedReadIsRemembered", store.historyReadBackoff[key]?.attempts == 1)
    ]
    // Leaving and re-entering a session must not re-pay a read that just failed,
    // and must not drop the verified turns it already shows.
    store.historyTestOffline = false
    store.loadHistory(providerId: "pi", cwd: "/fixture", externalSessionId: "session")
    await store.historyTask?.value
    checks.append(("store.retryInsideWindowSkipsNetwork",
      store.historyReadBackoff[key]?.attempts == 1 && store.history == .loaded(snapshot.turns)))
    // Pending work does not prove reachability; a newer authenticated reply does.
    let transportError = NSError(domain: "ScryHistoryFixture", code: 9)
    store.reachable = true; store.connectionObservation = .reachable
    store.historyTask = Task {}; store.recordFailure(transportError)
    checks.append(("store.historyFailureDemotesWhenAlone", store.reachable == false))
    store.reachable = true; store.connectionObservation = .reachable
    store.historyTask = Task {}; store.catalogTask = Task {}
    let failedRequestRevision = store.connectionSuccessRevision
    store.recordFailure(transportError, since: failedRequestRevision)
    checks.append(("store.pendingRequestDoesNotProveReachability", store.reachable == false))
    store.recordSuccess()
    store.recordFailure(transportError, since: failedRequestRevision)
    checks.append(("store.historyFailureDoesNotOverrideConcurrentSuccess", store.reachable == true && store.connectionObservation == .reachable))
    store.historyTask?.cancel(); store.historyTask = nil; store.catalogTask?.cancel(); store.catalogTask = nil
    store.reachable = true; store.pollTask = Task {}; store.recordFailure(transportError)
    checks.append(("store.pollFailureDemotesWhenAlone", store.reachable == false))
    store.pollTask?.cancel(); store.pollTask = nil
    store.historyTask = Task {}
    store.prefetchHistory([.init(sessionId: "fixture", externalSessionId: "session", providerId: "pi", cwd: "/fixture", label: "fixture", ts: 1)])
    checks.append(("store.warmingYieldsToForeground", store.prefetchTask == nil))
    await store.prefetchTask?.value
    store.historyTask = nil
    let identity = SessionIdentity.opened(providerId: "pi", cwd: "/fixture", externalSessionId: "session")
    let request = store.historyRequestGeneration
    let requestGeneration = store.generation
    store.applyHistoryPreview([], request: request, generation: requestGeneration, identity: identity, connection: connection)
    checks.append(("store.retryKeepsVerifiedWarmContent", store.history == .loaded(snapshot.turns)))
    var foreignConnection = connection; foreignConnection.hostId = "different-host"
    connections.save(foreignConnection)
    store.applyHistoryPreview([.init(userText: "foreign host", items: [])], request: request, generation: requestGeneration, identity: identity, connection: connection)
    checks.append(("store.previewRejectsChangedConnection", store.history == .loaded(snapshot.turns)))
    connections.save(connection)
    store.historyFromCache = false
    store.applyHistoryPreview(Array(snapshot.turns.suffix(2)), request: request, generation: requestGeneration, identity: identity, connection: connection)
    checks.append(("store.networkPreviewIsPartial", store.history == .partial(Array(snapshot.turns.suffix(2))) && store.historyFetchedAt == nil))
    store.applyHistoryPreview([], request: request, generation: requestGeneration, identity: identity, connection: connection)
    checks.append(("store.retryWithdrawsNetworkPreview", store.history == .loading))
    store.showHistory(snapshot, key: key, cached: true, persisted: true)
    store.completedLiveTurns[identity] = [.init(id: "fixture-run", runId: "fixture-run", prompt: "local prompt",
      attachments: [], lifecycle: .settled, output: [], resultSummary: nil, externalSessionId: "session")]
    store.loadHistory(providerId: "pi", cwd: "/fixture", externalSessionId: "session", force: true)
    await store.historyTask?.value
    checks.append(("store.localOverlayKeepsBase", store.history == .loaded(snapshot.turns) && store.completedTurns(for: identity).count == 1 && store.historyRefreshError == nil))
    try await store.clearHistoryCache()
    checks.append(("store.clearRemovesWarmScreens", store.warmedScreens.isEmpty))
    store.applyHistoryPreview(snapshot.turns, request: request, generation: requestGeneration, identity: identity, connection: connection)
    checks.append(("store.previewRejectsClearedGeneration", store.history == .idle))
    store.loadHistory(providerId: "pi", cwd: "/fixture", externalSessionId: "session", force: true)
    await store.historyTask?.value
    checks.append(("store.missingBaseIsNotEmpty", store.history == .baseUnavailable && store.completedTurns(for: identity).count == 1))
    // A local run without its host run id must not trigger a host read that
    // could duplicate it; one with an id reads the host and keeps it visible
    // when that read fails.
    checks.append(("store.unmatchableLocalRunSkipsHostRead", store.historyRefreshError == nil))
    store.historyTestOffline = true
    store.completedLiveTurns[identity] = [.init(id: "fixture-run", runId: "fixture-run", prompt: "local prompt",
      attachments: [], lifecycle: .settled, output: [], resultSummary: nil, externalSessionId: "session", hostRunId: "scry-local")]
    store.loadHistory(providerId: "pi", cwd: "/fixture", externalSessionId: "session", force: true)
    await store.historyTask?.value
    checks.append(("store.matchableLocalRunReadsHost", store.historyRefreshError != nil && store.history == .baseUnavailable && store.completedTurns(for: identity).count == 1))
    store.history = .partial([.init(runId: "scry-older", userText: "older", items: []), .init(runId: "scry-local", userText: "local prompt", items: [])])
    checks.append(("store.hostRecordReplacesLocalRun", store.completedTurns(for: identity).isEmpty))
    store.history = .partial([.init(runId: "scry-other", userText: "local prompt", items: [])])
    checks.append(("store.samePromptIsNotRunIdentity", store.completedTurns(for: identity).count == 1))
    store.historyTestOffline = false
    func localRun(_ id: String, host: String?) -> CompletedLiveTurn {
      .init(id: id, runId: id, prompt: id, attachments: [], lifecycle: .settled, output: [], resultSummary: nil, externalSessionId: "session", hostRunId: host)
    }
    let localRuns = [localRun("a", host: "scry-a"), localRun("b", host: "scry-b")]
    checks.append(("store.dedupeKeepsNewerUnarchivedRun", turnsNotInHistory(localRuns, hostRunIds: ["scry-a"], historyHasOlder: false).map(\.id) == ["b"]))
    checks.append(("store.dedupeDropsOlderRunInOlderPages", turnsNotInHistory(localRuns, hostRunIds: ["scry-b"], historyHasOlder: true).isEmpty))
    checks.append(("store.dedupeKeepsRunMissingFromCompleteHistory", turnsNotInHistory(localRuns, hostRunIds: ["scry-b"], historyHasOlder: false).map(\.id) == ["a"]))
    checks.append(("store.dedupeWithoutIdsKeepsAll", turnsNotInHistory([localRun("c", host: nil)], hostRunIds: ["scry-c"], historyHasOlder: true).count == 1))
    store.completedLiveTurns[identity] = [.init(id: "fixture-run", runId: "fixture-run", prompt: "local prompt",
      attachments: [], lifecycle: .settled, output: [], resultSummary: nil, externalSessionId: "session")]
    store.history = .baseUnavailable
    // Exercise the actual new mirror path, not the retired byte-suffix setter.
    let preview = try JSONDecoder().decode(G0Transport.RunHistoryPreview.self, from: Data("""
      {"status":"available","source":"indexed_archive","partial":true,"truncated":true,"bytes":0,
       "turns":[{"userText":"same prompt","userTextTruncated":false,"truncated":false,"items":[{"kind":"output","text":"first answer","truncated":false}]},
                {"userText":"same prompt","userTextTruncated":false,"truncated":false,"items":[{"kind":"output","text":"latest answer","truncated":false}]}]}
      """.utf8))
    let previewKey = RemoteHistoryCache.key(connection: connection, providerId: "pi", cwd: "/fixture", sessionId: "preview-only")
    _ = try await disk.writePreview(preview, key: previewKey, epoch: await disk.epoch)
    let mirrorStore = RemoteRunStore(connections: connections, historyDisk: disk)
    mirrorStore.historyTestOffline = true
    mirrorStore.loadHistory(providerId: "pi", cwd: "/fixture", externalSessionId: "preview-only")
    await mirrorStore.historyTask?.value
    checks.append(("store.mirrorSurvivesFullFailure", mirrorStore.history == .partial(mirrorStore.historyPreviewTurns) && mirrorStore.historyPreviewTurns.count == 2 && mirrorStore.historyFromCache && mirrorStore.historyRefreshError != nil))
    let unavailable = try JSONDecoder().decode(G0Transport.RunHistoryPreview.self, from: Data("{\"status\":\"unavailable\",\"reason\":\"no_fast_evidence\"}".utf8))
    let overwritten = try await disk.writePreview(unavailable, key: previewKey, epoch: await disk.epoch)
    let preservedPreview = try await disk.readPreview(previewKey)
    checks.append(("store.unavailableCannotEraseMirror", !overwritten && preservedPreview == preview))
    mirrorStore.showHistoryFailure(G0Transport.RunError.host(code: "unknown_op"), cached: nil)
    checks.append(("store.protocolFailureKeepsMirror", mirrorStore.history == .partial(mirrorStore.historyPreviewTurns) && mirrorStore.historyFromCache))
    checks.append(("store.protocolFailureNotOffline", mirrorStore.reachable == nil && mirrorStore.connectionObservation == .protocolFailure(code: "unknown_op")))
    checks.append(("store.protocolFailureActionable", mirrorStore.historyRefreshError?.contains("重新打开") == true))
    let reopened = RemoteRunStore(connections: connections, historyDisk: disk)
    reopened.historyTestOffline = true
    reopened.loadHistory(providerId: "pi", cwd: "/fixture", externalSessionId: "preview-only")
    await reopened.historyTask?.value
    checks.append(("store.restartReadsSmallMirror", reopened.historyPreviewTurns == mirrorStore.historyPreviewTurns && reopened.historyFromCache))
    reopened.loadHistory(providerId: "pi", cwd: "/fixture", externalSessionId: "different-session", force: true)
    await reopened.historyTask?.value
    checks.append(("store.mirrorDoesNotCrossSessions", reopened.historyPreviewTurns.isEmpty))
    try await checkHistoryWindow(connection: connection, foreignConnection: foreignConnection, connections: connections, disk: disk,
                                 snapshot: snapshot, checks: &checks)
    // A history browser cannot own, restore, delete, or submit the recovery run.
    mirrorStore.runId = "unresolved-recovery"
    mirrorStore.lifecycle = .failed
    mirrorStore.observationInterrupted = true
    let recoveryIdentity = mirrorStore.activeSessionIdentity
    let recoveryOutput = mirrorStore.output
    let browser = RemoteRunStore(historyFor: mirrorStore)
    browser.historyTestOffline = true
    browser.loadHistory(providerId: "pi", cwd: "/fixture", externalSessionId: "window-only")
    await browser.historyTask?.value
    checks.append(("store.browsingDisplaysCachedHistory", browser.history == .partial(snapshot.turns) && browser.historyOlderBefore == 3 && browser.historyFromCache))
    checks.append(("store.browsingDoesNotOwnCheckpoint", browser.recoveryURL == nil))
    checks.append(("store.browsingSharesProtectedCache", browser.historyDisk === mirrorStore.historyDisk))
    checks.append(("store.browsingKeepsRecovery", mirrorStore.runId == "unresolved-recovery" && mirrorStore.activeSessionIdentity == recoveryIdentity && mirrorStore.output == recoveryOutput && mirrorStore.hasUnresolvedRun))
    checks.append(("store.browsingDoesNotRestoreRun", browser.runId == nil && browser.pollTask == nil && browser.pendingSubmission == nil))
    checks.append(("store.browsingCannotSubmit", !browser.submit(prompt: "must not execute", providerId: "pi") && !browser.submitFollowUp(prompt: "must not execute", providerId: "pi", cwd: "/fixture", resume: "session")))
    browser.resumeObservation(runId: "must not observe", providerId: "pi", cwd: "/fixture", externalSessionId: "session")
    checks.append(("store.browsingCannotPollRecovery", browser.runId == nil && browser.pollTask == nil))
    checks.append(("store.recoveryStillBlocksNewSubmission", !mirrorStore.submit(prompt: "must not execute", providerId: "pi") && !mirrorStore.submitFollowUp(prompt: "must not execute", providerId: "pi", cwd: "/fixture", resume: "session") && mirrorStore.runId == "unresolved-recovery"))
    checks.append(("store.terminalOutputErrorKeepsKnownLifecycle", !Self.observationFailure(NSError(domain: "fixture", code: 1), lifecycle: .failed).contains("运行结果未知")))
    checks.append(("store.unknownOutputErrorRemainsUnknown", Self.observationFailure(NSError(domain: "fixture", code: 1), lifecycle: .unknown).contains("运行结果未知")))
    let oldEpoch = await disk.epoch
    try await mirrorStore.clearHistoryCache()
    let resurrected = try await disk.writePreview(preview, key: previewKey, epoch: oldEpoch)
    checks.append(("store.clearRejectsLateMirror", !resurrected && mirrorStore.historyPreviewTurns.isEmpty))
    let pendingWarm = Task<Void, Never> {}
    store.prefetchTask = pendingWarm
    _ = store.resetRun()
    checks.append(("store.runTransitionCancelsWarming", pendingWarm.isCancelled))
    return checks
  }
}
#endif
