import Foundation
import RemoteTransport

extension RemoteRunStore {
  // Transport trouble clears quickly; a host contract mismatch cannot succeed
  // until the Mac is updated, so it is remembered for longer instead of
  // retrying the same doomed read on every visit.
  func recordHistoryReadBackoff(key: String, error: Error) {
    let attempts = min((historyReadBackoff[key]?.attempts ?? 0) + 1, 4)
    let contractFailure = error is G0Transport.HistoryProfileError
      || (error as? G0Transport.RunError).map { if case .host = $0 { return true }; return false } ?? false
    let window: TimeInterval = contractFailure ? 120 : min(30, 4 * Double(attempts))
    historyReadBackoff[key] = HistoryReadBackoff(message: Self.describe(error),
      until: Date().addingTimeInterval(window), attempts: attempts)
  }

  func showHistoryFailure(_ error: Error, cached: RemoteHistorySnapshot?, since revision: Int? = nil) {
    recordFailure(error, since: revision)
    historyRefreshError = Self.describe(error)
    // Keep local runs visible; a preview without run ids could duplicate them.
    if historyWindow != nil || history == .baseUnavailable { return }
    if cached == nil, case .available = historyPreview {
      history = .partial(historyPreviewTurns)
    } else if cached == nil { history = .failed(Self.describe(error)) }
  }

  func applyHistoryPreview(_ turns: [G0Transport.RunHistoryTurn], request: Int,
                                   generation: Int, identity: SessionIdentity, connection: RemoteConnection) {
    guard !Task.isCancelled, historyRequestGeneration == request,
          isCurrent(generation, identity: identity), loadConnection() == connection else { return }
    // A snapshot retry withdraws unverified network content, not a previously
    // verified warm screen. A nonempty new preview has no full digest receipt.
    if turns.isEmpty && historyFromCache { return }
    history = turns.isEmpty ? .loading : .partial(turns)
    historyFromCache = false; historyFetchedAt = nil
    historyRevision += 1
  }

  func showPreview(_ preview: G0Transport.RunHistoryPreview, key: String, cached: Bool) {
    guard preview.available else { return }
    historyPreview = .available(preview); historyPreviewKey = key
    history = .partial(historyPreviewTurns)
    historyFromCache = cached; historyFetchedAt = nil
    historyRevision += 1
  }

  func showHistoryWindow(_ page: G0Transport.RunHistoryTurnsPage, key: String, cached: Bool, fetchedAt: Date) {
    historyWindow = page
    historyWindowKey = key
    if page.totalTurns == 0 { history = .empty }
    else if page.completeness == "complete" { history = .loaded(page.turns) }
    else { history = .partial(page.turns) }
    historyFromCache = cached
    historyFetchedAt = fetchedAt
    historyRevision += 1
  }

  func showHistory(_ snapshot: RemoteHistorySnapshot, key: String, cached: Bool, persisted: Bool) {
    let rendered: Bool
    switch history { case .loaded, .empty: rendered = true; default: rendered = false }
    let unchanged = historyWindow == nil && rendered && cachedHistory?.key == key &&
      cachedHistory?.snapshot.fingerprint == snapshot.fingerprint
    cachedHistory = (key, snapshot, persisted)
    historyWindow = nil; historyWindowKey = nil
    // Digest identity avoids an O(transcript) comparison on every validation.
    if !unchanged {
      history = snapshot.turns.isEmpty ? .empty : .loaded(snapshot.turns)
      historyRevision += 1
    }
    historyFromCache = cached
    historyFetchedAt = snapshot.fetchedAt
  }

  func loadOlderHistory(providerId: String, cwd: String, externalSessionId: String, agentProfileId: String? = nil) {
    guard let window = historyWindow, window.hasOlder,
          let connection = loadConnection(), historyTask == nil else { return }
    let identity = SessionIdentity.opened(providerId: providerId, agentProfileId: agentProfileId, cwd: cwd, externalSessionId: externalSessionId, scope: targetScope)
    let requestConnectionRevision = connectionSuccessRevision
    let requestGeneration = generation
    historyRequestGeneration += 1
    let request = historyRequestGeneration
    let key = RemoteHistoryCache.key(connection: connection, target: targetScope, providerId: providerId, cwd: cwd, sessionId: externalSessionId, agentProfileId: agentProfileId)
    guard historyWindowKey == key else { return }
    historySyncing = true
    historyTask = Task { [weak self] in
      guard let self else { return }
      defer {
        if self.historyRequestGeneration == request { self.historyTask = nil; self.historySyncing = false }
      }
      let epoch = await self.historyDisk.epoch
      do {
        let page = try await RemoteRunClient(connection: connection, executionTarget: targetScope?.targetBinding).withHistoryConnection { reader in
          try await reader.turnsPage(providerId: providerId, cwd: cwd, externalSessionId: externalSessionId,
            before: window.offset, limit: 3, snapshot: window.snapshot, agentProfileId: agentProfileId)
        }
        guard !Task.isCancelled, self.isCurrent(requestGeneration, identity: identity),
              self.loadConnection() == connection, self.historyRequestGeneration == request else { return }
        self.recordSuccess()
        guard page.totalTurns == window.totalTurns else {
          self.historyRefreshError = "历史分页总数发生变化，保留已读取内容；请刷新最近历史。"
          return
        }
        let turns = page.turns + window.turns
        let complete = page.offset == 0 && turns.count == window.totalTurns && window.source != "active_memory"
        let combined = G0Transport.RunHistoryTurnsPage(turns: turns, offset: page.offset,
          totalTurns: window.totalTurns, hasOlder: page.hasOlder, snapshot: window.snapshot,
          source: window.source, completeness: complete ? "complete" : "partial",
          sourceWarning: window.sourceWarning ?? page.sourceWarning)
        self.showHistoryWindow(combined, key: key, cached: false, fetchedAt: Date())
        do {
          let saved = try await self.historyDisk.writeWindow(combined, key: key, epoch: epoch)
          if self.historyRequestGeneration == request, !saved { self.historyStorageNotice = "已读取历史超过手机缓存容量，本次仅保留在内存中。" }
        } catch {
          if self.historyRequestGeneration == request { self.historyStorageNotice = "历史窗口保存失败：\(Self.describe(error))" }
        }
      } catch {
        guard !Task.isCancelled, self.isCurrent(requestGeneration, identity: identity),
              self.historyRequestGeneration == request else { return }
        self.historyRefreshError = Self.describe(error)
        self.recordFailure(error, since: requestConnectionRevision)
      }
    }
  }

  func clearHistoryCache() async throws {
    historyCacheClearing = true
    defer { historyCacheClearing = false }
    historyRequestGeneration += 1
    prefetchGeneration += 1
    prefetchTask?.cancel(); prefetchTask = nil
    warmedScreens.removeAll()
    historyTask?.cancel()
    historyTask = nil
    cachedHistory = nil
    historyWindow = nil; historyWindowKey = nil
    history = .idle; historyPreview = .idle; historyPreviewKey = nil; historySyncing = false; historyFromCache = false
    historyFetchedAt = nil; historyProgress = nil; historyRefreshError = nil; historyStorageNotice = nil
    try await historyDisk.clear()
  }

  func refreshHistory(providerId: String, cwd: String, externalSessionId: String, agentProfileId: String? = nil,
                      observedVersion: String? = nil) async {
    #if DEBUG
    if mockMode {
      if ProcessInfo.processInfo.arguments.contains("-uiMockMacStartsLater"), case let .loaded(turns) = history {
        let prompt = "Mac 后来新增的用户输入"
        if turns.last?.userText != prompt, historyNeedsRefresh("mock-mac-later") {
          let updated = turns + [.init(userText: prompt, items: [.init(kind: "output", text: "Mac 后来新增的回复")])]
          showHistoryWindow(.init(turns: Array(updated.suffix(3)), offset: max(0, updated.count - 3),
            totalTurns: updated.count, hasOlder: updated.count > 3, snapshot: "mock-mac-later",
            source: "indexed_archive", completeness: "partial"), key: "mock-history", cached: false, fetchedAt: Date())
        }
      }
      return
    }
    #endif
    let identity = SessionIdentity.opened(providerId: providerId, agentProfileId: agentProfileId, cwd: cwd, externalSessionId: externalSessionId, scope: targetScope)
    let requestGeneration = generation
    await historyTask?.value
    guard !Task.isCancelled, isCurrent(requestGeneration, identity: identity),
          let client = makeClient() else { return }
    let key = RemoteHistoryCache.key(connection: client.connection, target: targetScope, providerId: providerId, cwd: cwd, sessionId: externalSessionId, agentProfileId: agentProfileId)
    if let windowKey = historyWindowKey, windowKey != key {
      loadHistory(providerId: providerId, cwd: cwd, externalSessionId: externalSessionId, force: true, agentProfileId: agentProfileId)
      await historyTask?.value
      return
    }
    let requestConnectionRevision = connectionSuccessRevision
    do {
      let version: String
      if let observedVersion { version = observedVersion }
      else {
        version = try await client.historyVersion(providerId: providerId, cwd: cwd, externalSessionId: externalSessionId,
                                                  agentProfileId: agentProfileId).version
      }
      guard !Task.isCancelled, isCurrent(requestGeneration, identity: identity) else { return }
      recordSuccess()
      guard historyNeedsRefresh(version) else {
        // The shown snapshot is the host's current version: the earlier failure no longer applies.
        if historyPageSnapshot == version { historyRefreshError = nil }
        return
      }
      loadHistory(providerId: providerId, cwd: cwd, externalSessionId: externalSessionId, force: true, onlyWhileFollowing: true, agentProfileId: agentProfileId)
      await historyTask?.value
    } catch {
      guard !Task.isCancelled, isCurrent(requestGeneration, identity: identity) else { return }
      recordFailure(error, since: requestConnectionRevision)
      historyRefreshError = Self.describe(error)
    }
  }

  func historyNeedsRefresh(_ version: String) -> Bool {
    if historyPageSnapshot == version { return false }
    // Keep an old snapshot only while the user is actually reading it. A large
    // cache or loaded older pages must not pin the latest-message view forever.
    if !historyFollowingLatest, historyWindow != nil || cachedHistory != nil {
      historyStorageNotice = "Mac 有新消息；已保留当前阅读位置，点“回到最新”同步最近消息。"
      return false
    }
    return true
  }

  // Re-opening the same session does not discard its live observation. If the
  // view was left while a run was active, resume its poll using the known run id.
  func prepareForSession(providerId: String, cwd: String, externalSessionId: String, agentProfileId: String? = nil) {
    let identity = SessionIdentity.opened(providerId: providerId, agentProfileId: agentProfileId, cwd: cwd, externalSessionId: externalSessionId, scope: targetScope)
    if activeSessionIdentity == identity {
      if let runId, pollTask == nil,
         observationInterrupted || !isTerminal(generation: generation, identity: identity) {
        resumeObservation(runId: runId)
      }
      if !hasUnresolvedRun { loadHistory(providerId: providerId, cwd: cwd, externalSessionId: externalSessionId, agentProfileId: agentProfileId) }
      return
    }
    loadHistory(providerId: providerId, cwd: cwd, externalSessionId: externalSessionId, agentProfileId: agentProfileId)
  }

  func completedTurns(for identity: SessionIdentity, historyRendered: Bool = true) -> [CompletedLiveTurn] {
    let turns = completedLiveTurns[identity] ?? []
    // Only stable run identity can deduplicate evidence; repeated prompt text
    // is not identity ("continue" may legitimately appear many times).
    guard identity == activeSessionIdentity else { return turns }
    // ChatView renders only local turns, including after recovery. Archive
    // reconciliation can replace them only on a screen that renders the archive.
    let visible = historyRendered ? Self.turnsNotInHistory(turns, hostRunIds: historyRunIds, historyHasOlder: historyOlderBefore != nil) : turns
    return visible.filter {
      Self.shouldIncludeCompletedTurn($0.id, currentRunId: runId, archived: archivedActiveTurn)
    }
  }

  // Scry run ids present in the displayed host history (structured pages only).
  var historyRunIds: Set<String> {
    switch history {
    case let .loaded(turns), let .partial(turns): return Set(turns.compactMap(\.runId))
    default: return []
    }
  }

  // The finished live run is already shown by the host record; avoid a second copy.
  var liveTurnInHistory: Bool {
    guard terminalDrainCompleted, let id = liveHostRunId else { return false }
    return historyRunIds.contains(id)
  }

  var detachedTurnInHistory: Bool {
    guard let id = detachedHostRunId else { return false }
    return historyRunIds.contains(id)
  }

  // A local run is hidden only when the host page contains its run id. Older
  // local runs before a matched one were archived earlier: when the window has
  // older pages they live there; when it is complete they are kept because the
  // host provably lacks them (e.g. a failed best-effort archive write).
  nonisolated static func turnsNotInHistory(_ turns: [CompletedLiveTurn], hostRunIds: Set<String>,
                                            historyHasOlder: Bool) -> [CompletedLiveTurn] {
    func inHistory(_ turn: CompletedLiveTurn) -> Bool { turn.hostRunId.map(hostRunIds.contains) == true }
    guard let lastMatched = turns.lastIndex(where: inHistory) else { return turns }
    return turns.enumerated().filter { index, turn in
      !inHistory(turn) && (index > lastMatched || !historyHasOlder)
    }.map(\.element)
  }
}
