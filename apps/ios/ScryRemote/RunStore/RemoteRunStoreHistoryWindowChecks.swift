import Foundation
import RemoteTransport

#if DEBUG
extension RemoteRunStore {
  static func checkHistoryWindow(connection: RemoteConnection, foreignConnection: RemoteConnection, connections: RemoteConnectionStore,
                                 disk: RemoteHistoryCache, snapshot: RemoteHistorySnapshot,
                                 checks: inout [(String, Bool)]) async throws {
    let windowKey = RemoteHistoryCache.key(connection: connection, providerId: "pi", cwd: "/fixture", sessionId: "window-only")
    let window = G0Transport.RunHistoryTurnsPage(turns: snapshot.turns, offset: 3,
      totalTurns: 3 + snapshot.turns.count, hasOlder: true, snapshot: "window-version", source: "indexed_archive", completeness: "partial")
    checks.append(("store.windowMirrorSaved", try await disk.writeWindow(window, key: windowKey, epoch: await disk.epoch)))
    let windowStore = RemoteRunStore(connections: connections, historyDisk: disk)
    windowStore.historyTestOffline = true
    windowStore.loadHistory(providerId: "pi", cwd: "/fixture", externalSessionId: "window-only")
    await windowStore.historyTask?.value
    checks.append(("store.offlineWindowRetainsWholeTurns", windowStore.history == .partial(snapshot.turns) && windowStore.historyFromCache))
    checks.append(("store.offlineWindowRetainsOlderCursor", windowStore.historyOlderBefore == 3 && windowStore.historyPageOffset == 3))
    let windowIdentity = SessionIdentity.opened(providerId: "pi", cwd: "/fixture", externalSessionId: "window-only")
    windowStore.completedLiveTurns[windowIdentity] = [.init(id: "local-window-run", runId: "local-window-run", prompt: "local window prompt",
      attachments: [], lifecycle: .settled, output: [], resultSummary: nil, externalSessionId: "window-only")]
    windowStore.loadHistory(providerId: "pi", cwd: "/fixture", externalSessionId: "window-only", force: true)
    await windowStore.historyTask?.value
    checks.append(("store.localOverlayKeepsPartialWindowBase", windowStore.history == .partial(snapshot.turns) && windowStore.completedTurns(for: windowIdentity).count == 1))
    let olderOnly = G0Transport.RunHistoryTurnsPage(turns: snapshot.turns, offset: 0,
      totalTurns: 3 + snapshot.turns.count, hasOlder: false, snapshot: "window-version", source: "indexed_archive", completeness: "partial")
    do {
      _ = try await disk.writeWindow(olderOnly, key: windowKey, epoch: await disk.epoch)
      checks.append(("store.rejectOlderOnlyAsTailCache", false))
    } catch { checks.append(("store.rejectOlderOnlyAsTailCache", true)) }
    // A retired full snapshot must not outrank a newer readable window while
    // another refresh is pending or fails, including its provenance/cursor.
    let refreshStore = RemoteRunStore(connections: connections, historyDisk: disk)
    refreshStore.historyTestOffline = true
    refreshStore.activeSessionIdentity = windowIdentity
    refreshStore.cachedHistory = (windowKey, snapshot, true)
    let currentWindow = G0Transport.RunHistoryTurnsPage(turns: [snapshot.turns.last!], offset: 2,
      totalTurns: 3, hasOlder: true, snapshot: "current-window", source: "active_memory", completeness: "partial")
    let currentFetchedAt = Date(timeIntervalSince1970: 1_700_000_000)
    refreshStore.showHistoryWindow(currentWindow, key: windowKey, cached: false, fetchedAt: currentFetchedAt)
    refreshStore.liveRunsStatus = .observed
    refreshStore.liveHistoryTarget = windowIdentity
    checks.append(("store.healthyHistoryWatchKeepsVersion", refreshStore.verifiedHistoryVersion("current-window") == "current-window"))
    refreshStore.loadHistory(providerId: "pi", cwd: "/fixture", externalSessionId: "window-only", force: true)
    checks.append(("store.refreshImmediatelyKeepsNewerWindow", refreshStore.history == .partial(currentWindow.turns) && refreshStore.historyPageSnapshot == "current-window"))
    await refreshStore.historyTask?.value
    checks.append(("store.failedRefreshKeepsNewerWindow", refreshStore.history == .partial(currentWindow.turns) && refreshStore.historyPageSnapshot == "current-window" && refreshStore.historyOlderBefore == 2 && refreshStore.historyPageSource == "active_memory" && refreshStore.historyFetchedAt == currentFetchedAt && refreshStore.historyRefreshError != nil))
    checks.append(("store.failedRefreshKeepsVersionEligible", refreshStore.verifiedHistoryVersion("current-window") == nil))
    connections.save(foreignConnection)
    refreshStore.loadHistory(providerId: "pi", cwd: "/fixture", externalSessionId: "window-only", force: true)
    await refreshStore.historyTask?.value
    checks.append(("store.retainedWindowCannotCrossConnection", refreshStore.historyPageSnapshot == nil && refreshStore.history != .partial(currentWindow.turns)))
    connections.save(connection)
    refreshStore.cachedHistory = (windowKey, snapshot, true)
    let completeWindow = G0Transport.RunHistoryTurnsPage(turns: [snapshot.turns.last!], offset: 0,
      totalTurns: 1, hasOlder: false, snapshot: "complete-window", source: "indexed_archive", completeness: "complete")
    refreshStore.showHistoryWindow(completeWindow, key: windowKey, cached: false, fetchedAt: currentFetchedAt)
    refreshStore.showHistory(snapshot, key: windowKey, cached: false, persisted: true)
    checks.append(("store.fullSnapshotReplacesDifferentWindowBase", refreshStore.history == .loaded(snapshot.turns) && refreshStore.historyPageSnapshot == nil))
    // Freshness is about the displayed source version, not how much history
    // was previously read. Only an explicit reader position may defer rebasing.
    checks.append(("store.latestRefreshesFullCache", refreshStore.historyNeedsRefresh("new-version")))
    let extendedWindow = G0Transport.RunHistoryTurnsPage(turns: Array(repeating: snapshot.turns.last!, count: 4), offset: 0,
      totalTurns: 4, hasOlder: false, snapshot: "extended-window", source: "indexed_archive", completeness: "complete")
    refreshStore.showHistoryWindow(extendedWindow, key: windowKey, cached: false, fetchedAt: currentFetchedAt)
    checks.append(("store.latestRefreshesExtendedWindow", refreshStore.historyNeedsRefresh("new-version")))
    refreshStore.historyFollowingLatest = false
    checks.append(("store.readerPositionKeepsExtendedWindow", !refreshStore.historyNeedsRefresh("new-version") && refreshStore.historyPageSnapshot == "extended-window"))
    refreshStore.showHistoryWindow(currentWindow, key: windowKey, cached: false, fetchedAt: currentFetchedAt)
    checks.append(("store.readerPositionKeepsRecentWindow", !refreshStore.historyNeedsRefresh("new-version") && refreshStore.historyPageSnapshot == "current-window"))
    refreshStore.loadHistory(providerId: "pi", cwd: "/fixture", externalSessionId: "window-only", force: true, onlyWhileFollowing: true)
    checks.append(("store.automaticRefreshCannotStartWhileReadingOlder", refreshStore.historyTask == nil && refreshStore.historyPageSnapshot == "current-window"))
    refreshStore.historyFollowingLatest = true
    refreshStore.loadHistory(providerId: "pi", cwd: "/fixture", externalSessionId: "window-only", force: true, onlyWhileFollowing: true)
    refreshStore.historyFollowingLatest = false
    await refreshStore.historyTask?.value
    checks.append(("store.readerMovedDuringRefreshKeepsWindow", refreshStore.historyPageSnapshot == "current-window" && refreshStore.historyRefreshError == nil))
    refreshStore.historyFollowingLatest = true
    checks.append(("store.returnToLatestRefreshes", refreshStore.historyNeedsRefresh("new-version")))
    checks.append(("store.displayedVersionSkipsRefresh", !refreshStore.historyNeedsRefresh("current-window")))
    checks.append(("store.clearedRefreshErrorRestoresKnownVersion", refreshStore.verifiedHistoryVersion("current-window") == "current-window"))
  }
}
#endif
