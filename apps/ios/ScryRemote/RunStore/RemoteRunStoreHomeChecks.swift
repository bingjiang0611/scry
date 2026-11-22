import Foundation
import RemoteTransport

#if DEBUG
extension RemoteRunStore {
  actor CatalogTestCounter {
    private(set) var value = 0
    func next() -> Int { value += 1; return value }
    func reset() { value = 0 }
  }

  static func selfTestHomeRecovery(directory: URL) async throws -> [(String, Bool)] {
    let suite = "ScryHomeRecovery.\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: suite)!
    defer { defaults.removePersistentDomain(forName: suite) }
    let connections = RemoteConnectionStore(defaults: defaults)
    let connection = RemoteConnection(relayHost: "fixture.invalid", relayPort: 443, relayTLS: "system",
      hostId: "gateway", anchorPEM: "fixture-anchor", deviceId: "phone")
    connections.save(connection)
    let session = G0Transport.RunSessionRef(sessionId: "local", externalSessionId: "local", providerId: "pi", cwd: "/repo", label: "local", ts: 1)
    let coordinator = ExecutionTargetCoordinator(connections: connections,
      historyDisk: RemoteHistoryCache(directory: directory), stateDirectory: nil)
    let store = coordinator.localStore
    store.mockMode = true
    var discoveryCalls = 0
    let reads = CatalogTestCounter()
    coordinator.targetCatalogFixture = {
      discoveryCalls += 1
      return .init(version: 1, gateway: .init(hostId: connection.hostId, label: "Mac1"), targets: [])
    }
    store.catalogFixture = CatalogFixture(connection: connection, fetch: { _ in
      if await reads.next() == 1 { throw RelayTransportError.timedOut(stage: "lane-response") }
      return [session]
    })
    coordinator.selectFilter(.target(coordinator.localScope))
    coordinator.foregrounded()
    coordinator.setHomeVisible(true)
    let wait = CatalogTestGate()
    coordinator.recoveryWait = { _ in await wait.pause() }
    let first = await coordinator.refreshHome()
    await wait.waitForArrival()
    var checks: [(String, Bool)] = [
      ("recovery.initialFailureIsVisible", !first && coordinator.homeFailure != nil),
      ("recovery.localFilterSkipsDiscovery", discoveryCalls == 0),
      ("recovery.diagnosticHasHostAndStage", coordinator.refreshIssues.first?.diagnostic.contains("bulk") == true && coordinator.refreshIssues.first?.diagnostic.contains("lane-response") == true)
    ]
    await wait.release()
    await coordinator.finishRecoveryForCheck()
    let recoveredReads = await reads.value
    checks.append(("recovery.transientReadRecoversWithoutTap", recoveredReads == 2 && coordinator.homeFailure == nil && coordinator.lastFullRefresh != nil && coordinator.homeSessions.first?.session == session))

    // A foreground refresh must not repeatedly retry an authorization failure.
    await reads.reset()
    store.catalogFixture = CatalogFixture(connection: connection, fetch: { _ in
      _ = await reads.next(); throw G0Transport.RunError.host(code: "device_not_authorized")
    })
    _ = await coordinator.refreshHome()
    await coordinator.finishRecoveryForCheck()
    coordinator.foregrounded()
    await coordinator.finishRecoveryForCheck()
    let authorizationReads = await reads.value
    checks.append(("recovery.authorizationNotRetried", authorizationReads == 1 && store.catalogRefreshFailure?.requiresPairing == true))
    coordinator.selectFilter(.all)
    coordinator.foregrounded()
    await coordinator.finishRecoveryForCheck()
    let filteredAuthorizationReads = await reads.value
    checks.append(("recovery.filterCannotRetryAuthorization", filteredAuthorizationReads == 1))
    coordinator.selectFilter(.target(coordinator.localScope))

    await reads.reset()
    store.catalogFixture = CatalogFixture(connection: connection, fetch: { _ in
      _ = await reads.next(); throw RelayTransportError.tlsHandshake(layer: .host, detail: "verification failed")
    })
    _ = await coordinator.refreshHome()
    coordinator.selectFilter(.all)
    coordinator.foregrounded()
    await coordinator.finishRecoveryForCheck()
    let tlsReads = await reads.value
    checks.append(("recovery.filterCannotRetryTLS", tlsReads == 1 && store.catalogRefreshFailure?.allowsAutomaticRecovery == false))
    coordinator.selectFilter(.target(coordinator.localScope))

    await reads.reset()
    var waits = 0
    coordinator.recoveryWait = { _ in waits += 1 }
    store.catalogFixture = CatalogFixture(connection: connection, fetch: { _ in
      _ = await reads.next(); throw RelayTransportError.timedOut(stage: "fixture-outage")
    })
    _ = await coordinator.refreshHome()
    await coordinator.finishRecoveryForCheck()
    let outageReads = await reads.value
    checks.append(("recovery.boundedBurst", outageReads == 4 && waits == 3 && coordinator.homeFailure != nil))

    let backgroundWait = CatalogTestGate()
    coordinator.recoveryWait = { _ in await backgroundWait.pause() }
    await reads.reset()
    _ = await coordinator.refreshHome()
    await backgroundWait.waitForArrival()
    coordinator.backgrounded()
    await backgroundWait.release()
    await coordinator.finishRecoveryForCheck()
    let backgroundReads = await reads.value
    checks.append(("recovery.backgroundStopsRetries", backgroundReads == 1))

    // Per-host results stay independent. A target authorization failure never
    // invalidates the local verified catalog or asks to replace the gateway grant.
    coordinator.setHomeVisible(false)
    coordinator.selectFilter(.all)
    let target = G0Transport.ExecutionTargetRef(id: "mac2", binding: String(repeating: "a", count: 64), hostId: "mac2", label: "Mac2", state: "connected")
    coordinator.targetCatalogFixture = { .init(version: 1, gateway: .init(hostId: connection.hostId, label: "Mac1"), targets: [target]) }
    await coordinator.refreshTargets()
    let remote = coordinator.store(for: coordinator.discoveredTargets[0])
    remote.mockMode = true
    let remoteReads = CatalogTestCounter()
    remote.catalogFixture = CatalogFixture(connection: connection, fetch: { _ in
      _ = await remoteReads.next(); throw G0Transport.RunError.host(code: "device_not_authorized")
    })
    store.catalogFixture = CatalogFixture(connection: connection, fetch: { _ in [session] })
    _ = await coordinator.refreshHome()
    let issue = coordinator.refreshIssues.first
    checks.append(("recovery.failedHostDoesNotInvalidateHealthyHost", coordinator.homeSessions.first?.session == session && store.catalogRefreshFailure == nil && issue?.scope.hostId == "mac2" && issue?.failure.requiresPairing == false))
    let targetReads = await remoteReads.value
    checks.append(("recovery.targetAuthNotAutomatic", issue?.failure.allowsAutomaticRecovery == false && targetReads == 1))

    let discoveryWait = CatalogTestGate()
    coordinator.targetCatalogFixture = {
      await discoveryWait.pause()
      return .init(version: 1, gateway: .init(hostId: connection.hostId, label: "Mac1"), targets: [target])
    }
    // Clear only the fixture's previous denial, so this models a fresh foreground
    // refresh interrupted while its discovery request is already in flight.
    remote.catalogRefreshFailure = nil
    await remoteReads.reset()
    coordinator.setHomeVisible(true)
    coordinator.foregrounded()
    await discoveryWait.waitForArrival()
    coordinator.backgrounded()
    await discoveryWait.release()
    await coordinator.finishRecoveryForCheck()
    let cancelledReads = await remoteReads.value
    checks.append(("recovery.backgroundDuringDiscoveryStartsNoTargetRead", cancelledReads == 0))
    return checks
  }
}
#endif
