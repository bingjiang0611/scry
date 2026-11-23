import Foundation
import RemoteTransport

#if DEBUG
extension RemoteRunStore {
  static func checkTargetStartup(suite: String, directory: URL, connections: RemoteConnectionStore,
                                 disk: RemoteHistoryCache, connection: RemoteConnection, gateway: String,
                                 identity: SessionIdentity, checks: inout [(String, Bool)]) async throws {
    let startupSuite = suite + ".startup"
    let startupDefaults = UserDefaults(suiteName: startupSuite)!
    defer { startupDefaults.removePersistentDomain(forName: startupSuite) }
    let startup = ExecutionTargetCoordinator(connections: connections, historyDisk: disk, defaults: startupDefaults,
      stateDirectory: directory.appendingPathComponent("startup"))
    let unmocked = RemoteRunStore(connections: connections, historyDisk: disk,
      stateDirectory: directory.appendingPathComponent("unmocked"))
    checks.append(("catalog.detailsFixtureRequiresMockIsolation", !unmocked.prepareRefreshDetailsFixture() && unmocked.catalogFixture == nil))
    startup.localStore.mockMode = true
    let localGate = CatalogTestGate(), discoveryGate = CatalogTestGate()
    let localSession = G0Transport.RunSessionRef(sessionId: "local", externalSessionId: "local", providerId: "pi", cwd: "/repo", label: "local", ts: 1)
    startup.localStore.catalogFixture = CatalogFixture(connection: connection, fetch: { _ in await localGate.pause(); return [localSession] })
    startup.targetCatalogFixture = { await discoveryGate.pause(); throw G0Transport.RunError.host(code: "unknown_op") }
    let refresh = Task { await startup.refreshHome() }
    await discoveryGate.waitForArrival()
    await localGate.waitForArrival()
    await localGate.release()
    await startup.localStore.catalogTask?.value
    startup.rebuildHomeSessions()
    checks.append(("catalog.localContentDoesNotWaitForDiscovery", startup.homeSessions.first?.session == localSession && startup.homeLoading))
    await discoveryGate.release()
    _ = await refresh.value
    checks.append(("catalog.localRefreshNotDuplicatedAfterDiscovery", startup.localStore.catalogRefreshRevision == 1 && !startup.homeLoading))
    checks.append(("catalog.discoveryPreservesUnsupportedOperation", startup.homeFailure?.technicalDetail.contains("unknown_op") == true && startup.homeFailure == startup.discoveryIssue))
    startup.localStore.catalogFixture = CatalogFixture(connection: connection, fetch: { _ in [localSession] })
    for (error, evidence) in [(RelayTransportError.timedOut(stage: "target-discovery-upgrade"), "target-discovery-upgrade"),
                              (.closed(code: 1006, reason: "fixture-close"), "1006 fixture-close")] {
      startup.targetCatalogFixture = { throw error }
      let completed = await startup.refreshHome()
      checks.append(("catalog.discoveryDiagnostic.\(evidence)", !completed && startup.homeFailure == startup.discoveryIssue &&
        startup.homeFailure?.technicalDetail.contains(evidence) == true &&
        startup.homeFailure?.technicalDetail.contains("执行主机发现失败") == true && startup.lastFullRefresh == nil))
    }
    startup.targetCatalogFixture = { .init(version: 1, gateway: .init(hostId: connection.hostId, label: "gateway"), targets: []) }
    let recovered = await startup.refreshHome()
    checks.append(("catalog.discoverySuccessClearsDiagnostic", recovered && startup.homeFailure == nil && startup.discoveryIssue == nil && startup.lastFullRefresh != nil))
    let lastComplete = startup.lastFullRefresh
    let lastLocalRevision = startup.localStore.catalogRefreshRevision
    startup.targetCatalogFixture = { throw RelayTransportError.timedOut(stage: "after-complete") }
    let failedAgain = await startup.refreshHome()
    checks.append(("catalog.failedDiscoveryDoesNotAdvanceCompleteTimestamp", !failedAgain && startup.lastFullRefresh == lastComplete && startup.localStore.catalogRefreshRevision > lastLocalRevision))

    let delayedSuite = suite + ".delayed"
    let delayedDefaults = UserDefaults(suiteName: delayedSuite)!
    defer { delayedDefaults.removePersistentDomain(forName: delayedSuite) }
    let delayedCoordinator = ExecutionTargetCoordinator(connections: connections, historyDisk: disk,
      defaults: delayedDefaults, stateDirectory: directory.appendingPathComponent("delayed"))
    checks.append(("catalog.initialLivePollingWaitsForForeground", delayedCoordinator.localStore.liveRunsTask == nil))
    let delayedDiscoveryGate = CatalogTestGate()
    delayedCoordinator.foregrounded()
    let delayedTarget = G0Transport.ExecutionTargetRef(id: "delayed", binding: String(repeating: "d", count: 64),
      hostId: "mac-delayed", label: "Delayed Mac", state: "connected")
    delayedCoordinator.targetCatalogFixture = {
      await delayedDiscoveryGate.pause()
      return .init(version: 1, gateway: .init(hostId: connection.hostId, label: "gateway"), targets: [delayedTarget])
    }
    let delayedDiscovery = Task { await delayedCoordinator.refreshTargets() }
    await delayedDiscoveryGate.waitForArrival()
    delayedCoordinator.backgrounded()
    await delayedDiscoveryGate.release()
    await delayedDiscovery.value
    let delayedScope = ExecutionTargetScope(gatewayHostId: connection.hostId, target: delayedTarget, gatewayIdentity: gateway)
    let delayedStore = delayedCoordinator.store(for: delayedScope)
    checks.append(("catalog.backgroundedDiscoveryCannotStartLivePolling", delayedStore.liveRunsTask == nil && !delayedStore.liveRunsForegroundEligible))
    delayedCoordinator.foregrounded()
    checks.append(("catalog.foregroundedResumesLivePollingEligibility", delayedStore.liveRunsForegroundEligible && delayedStore.liveRunsTask != nil))
    delayedStore.watchHistory(identity)
    checks.append(("catalog.foregroundHistoryChangeRestartsPolling", delayedStore.liveRunsForegroundEligible && delayedStore.liveRunsTask != nil && delayedStore.liveHistoryTarget == identity))
    delayedStore.stopLiveRuns()
    delayedStore.startLiveRuns()
    checks.append(("catalog.foregroundCancellationCanRestartPolling", delayedStore.liveRunsForegroundEligible && delayedStore.liveRunsTask != nil))
    delayedCoordinator.backgrounded()

    let corruptSuite = suite + ".corrupt"
    let corruptDefaults = UserDefaults(suiteName: corruptSuite)!
    defer { corruptDefaults.removePersistentDomain(forName: corruptSuite) }
    let descriptorKey = "com.scry.remote.execution-targets." + gateway
    let unreadable = Data("unreadable target index".utf8)
    corruptDefaults.set(unreadable, forKey: descriptorKey)
    let corrupt = ExecutionTargetCoordinator(connections: connections, historyDisk: disk, defaults: corruptDefaults,
      stateDirectory: directory.appendingPathComponent("corrupt"))
    var replacementBlocked = false, unpairBlocked = false
    do { try corrupt.prepareConnectionReplacement(connection) }
    catch ConnectionReplacementError.recoveryUnavailable { replacementBlocked = true }
    do { try await corrupt.clearAllState() }
    catch ConnectionReplacementError.recoveryUnavailable { unpairBlocked = true }
    checks.append(("recovery.unreadableIndexBlocksAuthorityChanges", corrupt.recoveryUnavailable && !corrupt.hasPendingWork && replacementBlocked && unpairBlocked))
    corrupt.localStore.catalogVerifiedAt = Date()
    corrupt.targetCatalogFixture = { .init(version: 1, gateway: .init(hostId: connection.hostId, label: "gateway"), targets: []) }
    await corrupt.refreshTargets()
    checks.append(("recovery.discoveryDoesNotEraseUnreadableIndex", corrupt.recoveryUnavailable && corrupt.lastFullRefresh == nil && corruptDefaults.data(forKey: descriptorKey) == unreadable))
  }
}
#endif
