import Foundation
import RemoteTransport

extension RemoteRunStore {
  var historyOlderBefore: Int? { historyWindow.flatMap { $0.hasOlder ? $0.offset : nil } }
  var historyPageSnapshot: String? { historyWindow?.snapshot }
  var historyPageSource: String? { historyWindow?.source }
  var historyNativeUnavailable: Bool { historyWindow?.sourceWarning == "native_unavailable" }
  var historyPageOffset: Int { historyWindow?.offset ?? 0 }
  // Show protected local data before opening the relay. Only an authenticated
  // host response can mark it current/reachable. The single memory entry keeps
  // large transcripts bounded; other conversations reopen from disk off-main.
  func loadHistory(providerId: String, cwd: String, externalSessionId: String, force: Bool = false, legacyFull: Bool = false,
                   onlyWhileFollowing: Bool = false, agentProfileId: String? = nil) {
    #if DEBUG
    if mockMode { return }
    #endif
    guard !historyCacheClearing, !onlyWhileFollowing || historyFollowingLatest else { return }
    prefetchTask?.cancel()
    let identity = SessionIdentity.opened(providerId: providerId, agentProfileId: agentProfileId, cwd: cwd, externalSessionId: externalSessionId, scope: targetScope)
    // The legacy history contract has no canonical turn ids. Keep the base of
    // a locally extended conversation stable rather than deduplicating by text
    // or double-rendering the same run after an archive refresh.
    let localTurns = completedLiveTurns[identity] ?? []
    let liveTurnPending = activeSessionIdentity == identity && prompt != nil
    let hasLocalTurns = !localTurns.isEmpty || liveTurnPending
    // Newer hosts tag structured page turns with the Scry run id. When every
    // local run has its host id (and the live one finished draining), the host
    // window can be read and each local copy hidden only once the host record
    // provably contains that run. Otherwise keep the stable base + local overlay.
    let localRunsMatchable = hasLocalTurns && !legacyFull && localTurns.allSatisfy { $0.hostRunId != nil } &&
      (!liveTurnPending || (liveHostRunId != nil && terminalDrainCompleted))
    if activeSessionIdentity != identity {
      guard resetRun() else { return }
      activeSessionIdentity = identity
      historyFollowingLatest = true
      commandsRequestGeneration += 1
      commandsTask?.cancel(); commandsTask = nil; commands = .idle
      history = .idle
    }
    activateModelSelection(for: identity)
    if historyTask != nil { return }
    guard let connection = loadConnection() else { history = .failed("尚未配对"); return }
    let key = RemoteHistoryCache.key(connection: connection, target: targetScope, providerId: providerId, cwd: cwd, sessionId: externalSessionId, agentProfileId: agentProfileId)
    let client = RemoteRunClient(connection: connection, executionTarget: targetScope?.targetBinding)
    let disk = historyDisk
    let requestConnectionRevision = connectionSuccessRevision
    let retainedWindow: RemoteHistoryCache.StructuredWindow? = historyWindowKey == key ? historyWindow.flatMap { page in
      historyFetchedAt.map { RemoteHistoryCache.StructuredWindow(page: page, fetchedAt: $0) }
    } : nil
    let memory = retainedWindow == nil && cachedHistory?.key == key ? cachedHistory?.snapshot : nil
    historyRequestGeneration += 1
    let request = historyRequestGeneration
    let requestGeneration = generation
    historyProgress = nil
    historyRefreshError = nil; historyStorageNotice = nil; historyCapacityLimit = false
    if historyPreviewKey != key { historyPreview = .idle; historyPreviewKey = nil }
    if case .available = historyPreview {} else { historyPreview = .loading }
    // Keep the current window until a new response actually replaces it. A
    // pending/failed refresh must not resurrect a retired full-cache base.
    if retainedWindow == nil {
      historyWindow = nil; historyWindowKey = nil
      historyFromCache = false; historyFetchedAt = nil
      if let memory { showHistory(memory, key: key, cached: true, persisted: cachedHistory?.persisted == true) }
      else if let screen = warmedScreens[key], !hasLocalTurns {
        showPreview(screen, key: key, cached: true)
      } else if case .available = historyPreview, !hasLocalTurns {
        history = .partial(historyPreviewTurns)
      } else { history = localRunsMatchable ? .baseUnavailable : .loading }
    }
    historySyncing = true
    historyTask = Task { [weak self] in
      guard let self else { return }
      @MainActor func current() -> Bool {
        !Task.isCancelled && self.historyRequestGeneration == request &&
          (!onlyWhileFollowing || self.historyFollowingLatest) &&
          self.isCurrent(requestGeneration, identity: identity) && self.loadConnection() == connection
      }
      defer {
        if self.historyRequestGeneration == request {
          self.historyTask = nil; self.historySyncing = false
        }
      }
      let diskEpoch = await disk.epoch
      var cached = memory
      var persisted = self.cachedHistory?.key == key && self.cachedHistory?.persisted == true
      var cachedPreview: G0Transport.RunHistoryPreview?
      var cachedWindow = retainedWindow
      do {
        cachedPreview = try await disk.readPreview(key)
        if cachedWindow == nil { cachedWindow = try await disk.readWindow(key) }
      }
      catch { if current() { self.historyStorageNotice = "本地首屏镜像不可用，将从主机重新读取" } }
      guard current() else { return }
      if let cachedPreview, cached == nil, cachedWindow == nil, !hasLocalTurns { self.showPreview(cachedPreview, key: key, cached: true) }
      if let cachedWindow, cached == nil, retainedWindow == nil {
        self.showHistoryWindow(cachedWindow.page, key: key, cached: true, fetchedAt: cachedWindow.fetchedAt)
      }
      if cached == nil, cachedWindow == nil || legacyFull {
        do { cached = try await disk.read(key); persisted = cached != nil }
        catch { if current() { self.historyStorageNotice = "本地缓存不可用，将从主机重新读取" } }
      }
      guard current() else { return }
      if let cached, cachedWindow == nil {
        self.showHistory(cached, key: key, cached: true, persisted: persisted)
        if !persisted { self.historyStorageNotice = "历史目前仅在内存中，尚未保存到手机缓存。" }
        if !hasLocalTurns, memory != nil, !force,
           (0..<30).contains(Date().timeIntervalSince(cached.fetchedAt)) { return }
      }
      if hasLocalTurns && !localRunsMatchable {
        if cached == nil && cachedWindow == nil { self.history = .baseUnavailable; self.historyRevision += 1 }
        let notice = cached == nil && cachedWindow == nil
          ? "历史基底未缓存，以下仅为本机运行增量；重启后重新核对完整主机历史。"
          : "保留历史基底与本机运行增量，避免重复；重启后重新核对完整主机历史。"
        self.historyStorageNotice = notice + (cached != nil && !persisted ? " 当前基底仅存内存，未写入手机缓存。" : "")
        return
      }
      @MainActor func failed(_ error: Error) {
        guard current() else { return }
        self.recordHistoryReadBackoff(key: key, error: error)
        self.showHistoryFailure(error, cached: cached, since: requestConnectionRevision)
      }
      if !force, let backoff = self.historyReadBackoff[key], backoff.until > Date() {
        // Re-entering a session whose read just failed paints the remembered
        // reason immediately. Retrying inside the window cannot succeed and only
        // burns connectivity the user may not have; the visible retry (force)
        // and the background poll still bypass it.
        self.historyRefreshError = backoff.message
        if case .loading = self.history { self.history = .failed(backoff.message) }
        return
      }
      do {
        #if DEBUG
        if self.historyTestOffline {
          throw NSError(domain: "ScryHistoryFixture", code: 1, userInfo: [NSLocalizedDescriptionKey: "isolated offline fixture"])
        }
        #endif
        // First screen reads ride the warm bulk lane: a fresh read-only transfer
        // tunnel per open paid DNS + TCP + outer TLS + relay rendezvous + inner
        // mTLS before the first byte of history, which is exactly the wait this
        // flow cannot afford on a slow network. The complete download below may
        // still open its own bounded tunnel; the recent window never does.
        do {
          if !legacyFull {
            // One request, not two. The recent window already carries the turns
            // this screen shows, and on a slow link each round trip costs most of
            // a second, so fetching a 2-turn preview first only delayed the same
            // content. The preview stays for the oversized-window case below.
            do {
              let recent = try await client.historyTurnsPage(providerId: providerId, cwd: cwd, externalSessionId: externalSessionId, before: nil, limit: 3, snapshot: nil, agentProfileId: agentProfileId)
              guard current() else { return }
              self.recordSuccess()
              // Session display may legitimately mix transcript-only legacy/fork
              // turns with run-id turns; a page without run ids cannot dedupe.
              if hasLocalTurns, !recent.turns.contains(where: { $0.runId != nil }) {
                self.historyStorageNotice = "主机历史含未标识的 legacy/fork 轮次；已保留显示，无法据文本去重本机运行。"
              }
              self.historyReadBackoff[key] = nil
              self.showHistoryWindow(recent, key: key, cached: false, fetchedAt: Date())
              do {
                let saved = try await disk.writeWindow(recent, key: key, epoch: diskEpoch)
                if current(), !saved { self.historyStorageNotice = "最近历史窗口未保存到手机缓存" }
              } catch {
                if current() { self.historyStorageNotice = "最近历史窗口未保存到手机缓存：\(Self.describe(error))" }
              }
              return
            } catch let error as G0Transport.RunError {
              guard case .host(code: "history_capacity_exceeded") = error else { throw error }
              guard current() else { return }
              // The window is too large to frame. A bounded preview is the only
              // readable surface; the notice keeps the choice explicit.
              if case .loading = self.history {
                if let preview = try? await client.historyPreview(providerId: providerId, cwd: cwd, externalSessionId: externalSessionId, agentProfileId: agentProfileId),
                   preview.available, current() {
                  self.showPreview(preview, key: key, cached: false)
                  _ = try? await disk.writePreview(preview, key: key, epoch: diskEpoch)
                  self.recordSuccess()
                }
              }
              self.historyCapacityLimit = true
              self.historyStorageNotice = "最近窗口超过传输容量；可明确选择加载完整历史。"
              self.recordFailure(error, since: requestConnectionRevision)
              if case .loading = self.history { self.history = .failed("最近窗口超过传输容量，可选择加载完整历史。") }
              return
            }
          }
          do {
            let preview = try await client.historyPreview(providerId: providerId, cwd: cwd, externalSessionId: externalSessionId, agentProfileId: agentProfileId)
            guard current() else { return }
            if preview.available {
              if cached == nil, cachedWindow == nil, !hasLocalTurns { self.showPreview(preview, key: key, cached: false) }
              self.recordSuccess()
              do {
                let saved = try await disk.writePreview(preview, key: key, epoch: diskEpoch)
                if current(), !saved { self.historyStorageNotice = "首屏镜像未保存到手机缓存" }
              } catch {
                if current() { self.historyStorageNotice = "首屏镜像保存失败：\(Self.describe(error))" }
              }
            } else if case .available = self.historyPreview {} else {
              self.historyPreview = .unavailable(preview.reason ?? "首屏证据不可用")
            }
          } catch {
            if current(), case .available = self.historyPreview {} else if current() {
              self.historyPreview = .unavailable(Self.describe(error))
            }
            // A protocol/transport failure is not an unavailable-evidence reply.
            // Preserve the first cause; do not issue pages on a failed tunnel.
            throw error
          }
          guard current() else { return }
          let started = Date()
          do {
            let snapshot = try await client.historySnapshot(providerId: providerId, cwd: cwd,
              externalSessionId: externalSessionId, cached: cached, agentProfileId: agentProfileId, progress: { [weak self] received, total in
                guard let self else { return }
                await MainActor.run {
                  guard self.historyRequestGeneration == request,
                        self.isCurrent(requestGeneration, identity: identity), self.loadConnection() == connection else { return }
                  self.historyProgress = "\(received / 1024) / \(max(1, (total + 1023) / 1024)) KB"
                }
              })
            guard current() else { return }
            self.recordSuccess()
            self.historyReadBackoff[key] = nil
            let alreadySaved = persisted && cached?.fingerprint == snapshot.fingerprint
            self.showHistory(snapshot, key: key, cached: false, persisted: alreadySaved)
            self.historySyncing = false
            #if DEBUG
            print("HISTORY network complete seconds=\(Date().timeIntervalSince(started)) unchanged=\(cached?.fingerprint == snapshot.fingerprint)")
            #endif
            if alreadySaved { return }
            do {
              let saved = try await disk.write(snapshot, key: key, epoch: diskEpoch)
              if current() {
                self.cachedHistory?.persisted = saved
                self.historyStorageNotice = saved ? nil : "会话超过 64 MB，仅保留本次内存；未写入手机缓存"
              }
            } catch {
              if current() { self.historyStorageNotice = "本地缓存保存失败：\(Self.describe(error))" }
            }
          } catch { failed(error) }
        }
      } catch { failed(error) }
    }
  }

  func loadCompleteHistory(providerId: String, cwd: String, externalSessionId: String, agentProfileId: String? = nil) {
    loadHistory(providerId: providerId, cwd: cwd, externalSessionId: externalSessionId, force: true, legacyFull: true, agentProfileId: agentProfileId)
  }
}
