import Foundation
import RemoteTransport

#if DEBUG
extension RemoteRunStore {
  static func selfTestCatalogRefreshFlow(directory: URL) async throws -> [(String, Bool)] {
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let connection = RemoteConnection(relayHost: "fixture.invalid", relayPort: 443, relayTLS: "system",
      hostId: "catalog-fixture", anchorPEM: "fixture-anchor", deviceId: "fixture-grant")
    let key = RemoteHistoryCache.catalogKey(connection: connection)
    let old = G0Transport.RunSessionRef(sessionId: "old", providerId: "codex", cwd: "/fixture", label: "old", ts: 1)
    let next = G0Transport.RunSessionRef(sessionId: "new", providerId: "codex", cwd: "/fixture", label: "new", ts: 2)
    func store(_ label: String, limit: Int = 1_000_000) -> RemoteRunStore {
      let value = RemoteRunStore(historyDisk: RemoteHistoryCache(directory: directory.appendingPathComponent(label), byteLimit: limit),
        historyOnly: true, stateDirectory: nil)
      value.mockMode = true
      value.catalogFixture = CatalogFixture(connection: connection, fetch: { page in await page([next]); return [next] })
      return value
    }
    var checks: [(String, Bool)] = []
    let success = store("success")
    let refreshed = await success.refreshSessions()
    let saved = try await success.historyDisk.readCatalogValue(key)
    checks.append(("completePersisted", refreshed && success.catalog == .loaded([next]) && saved?.fetchedAt == success.catalogVerifiedAt && !success.catalogRefreshInFlight))

    let partial = store("partial")
    partial.catalog = .loaded([old]); partial.catalogVerifiedAt = Date(timeIntervalSince1970: 100)
    partial.catalogFixture = CatalogFixture(connection: connection, fetch: { page in await page([next]); throw URLError(.networkConnectionLost) })
    let partialResult = await partial.refreshSessions()
    checks.append(("partialRetainsCompleteList", !partialResult && partial.catalog == .loaded([old]) && partial.catalogVerifiedAt == Date(timeIntervalSince1970: 100)))
    checks.append(("partialFailureNotSuccess", { if case .partial = partial.catalogRefreshFailure { return true }; return false }()))

    let cold = store("cold")
    cold.catalogFixture = partial.catalogFixture
    _ = await cold.refreshSessions()
    checks.append(("coldPageReadableButUnverified", cold.catalog == .loaded([next]) && cold.catalogVerifiedAt == nil && cold.catalogRefreshRevision == 0))

    let rejected = store("too-small", limit: 1)
    let rejectedResult = await rejected.refreshSessions()
    checks.append(("cacheFalseNotSuccess", !rejectedResult && rejected.catalogRefreshFailure == .cacheWriteRejected && rejected.catalog == .loaded([next])))
    let blocked = directory.appendingPathComponent("blocked")
    try Data().write(to: blocked)
    let diskError = store("blocked")
    let diskResult = await diskError.refreshSessions()
    checks.append(("cacheThrowNotTransportFailure", !diskResult && { if case .cacheWrite = diskError.catalogRefreshFailure { return true }; return false }()))
    checks.append(("cacheTechnicalDetailNotInSummary", diskError.catalogRefreshFailure?.summary == ConnectionCopy.cacheWriteRejected))

    let unauthorized = store("unauthorized")
    unauthorized.catalogFixture = CatalogFixture(connection: connection, fetch: { _ in throw G0Transport.RunError.host(code: "grant_revoked") })
    _ = await unauthorized.refreshSessions()
    checks.append(("revocationNeedsPairing", unauthorized.catalogRefreshFailure?.requiresPairing == true))

    let gate = CatalogTestGate()
    let merged = store("merged")
    merged.catalogFixture = CatalogFixture(connection: connection, fetch: { page in await gate.pause(); await page([next]); return [next] })
    let first = Task { await merged.refreshSessions() }
    await gate.waitForArrival()
    merged.loadSessions(force: true)
    checks.append(("inFlightRequestCoalesced", await gate.calls == 1 && merged.catalogRefreshInFlight))
    await gate.release()
    checks.append(("coalescedRequestCompletes", await first.value))

    let staleGate = CatalogTestGate()
    let isolated = store("isolation")
    isolated.catalogFixture = CatalogFixture(connection: connection, fetch: { _ in await staleGate.pause(); return [old] })
    let staleTask = Task { await isolated.refreshSessions() }
    await staleGate.waitForArrival()
    try isolated.clearAllState()
    isolated.mockMode = true
    isolated.catalogFixture = success.catalogFixture
    let newResult = await isolated.refreshSessions()
    await staleGate.release()
    let staleResult = await staleTask.value
    let isolatedDisk = try await isolated.historyDisk.readCatalogValue(key)
    checks.append(("staleReplyCannotPublishOrPersist", newResult && !staleResult && isolated.catalog == .loaded([next]) && isolatedDisk?.sessions == [next]))

    let persistGate = CatalogTestGate()
    let lateJoin = store("late-join")
    lateJoin.catalogFixture = CatalogFixture(connection: connection, fetch: { _ in [next] },
      beforePersist: { await persistGate.pause() })
    let persistenceTask = Task { await lateJoin.refreshSessions() }
    await persistGate.waitForArrival()
    // A manual request joining now snapshots this revision, then waits on the
    // same task. Completion must still advance it after persistence succeeds.
    let joinedRevision = lateJoin.catalogRefreshRevision
    checks.append(("notSuccessfulBeforePersistence", joinedRevision == 0 && lateJoin.catalogRefreshInFlight))
    lateJoin.loadSessions(force: true)
    await persistGate.release()
    let persisted = await persistenceTask.value
    checks.append(("lateJoinObservesCompletion", persisted && lateJoin.catalogRefreshRevision > joinedRevision))

    let oldDate = Date(timeIntervalSince1970: 100)
    checks.append(("oldTimestampIncludesDate", ConnectionCopy.lastFullRefresh(oldDate).contains(oldDate.formatted(date: .abbreviated, time: .shortened))))
    let cache = store("cache-time")
    _ = try await cache.historyDisk.writeCatalog([old], key: key, epoch: 0, fetchedAt: Date(timeIntervalSince1970: 200))
    cache.catalogFixture = CatalogFixture(connection: connection, fetch: { _ in throw URLError(.cannotConnectToHost) })
    _ = await cache.refreshSessions()
    checks.append(("restoredTimeIsNotCurrentReachability", cache.catalogVerifiedAt == Date(timeIntervalSince1970: 200) && cache.catalogEvidence == .unverifiedCache(Date(timeIntervalSince1970: 200))))
    let legacy = store("legacy")
    let legacyDirectory = legacy.historyDisk.directory
    try FileManager.default.createDirectory(at: legacyDirectory, withIntermediateDirectories: true)
    let sessions = try JSONSerialization.jsonObject(with: JSONEncoder().encode([old]))
    try JSONSerialization.data(withJSONObject: ["version": 1, "key": key, "sessions": sessions])
      .write(to: legacyDirectory.appendingPathComponent("catalog-" + key + ".json"))
    legacy.catalogFixture = cache.catalogFixture
    _ = await legacy.refreshSessions()
    checks.append(("legacyTimeRemainsUnknown", legacy.catalog == .loaded([old]) && legacy.catalogVerifiedAt == nil && legacy.catalogEvidence == .unverifiedCache(nil)))
    return checks
  }
}
#endif
