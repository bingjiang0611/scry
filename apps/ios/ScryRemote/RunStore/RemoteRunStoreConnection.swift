import Foundation
import RemoteTransport

extension RemoteRunStore {
  // A persisted PUBLIC connection descriptor means this device is paired and may
  // attempt a run; reachability of the host is only known by trying.
  var hasConnection: Bool {
    #if DEBUG
    if mockMode { return true }
    #endif
    return loadConnection() != nil
  }
  var hostLabel: String? {
    #if DEBUG
    if mockMode { return "Studio Mac" }
    #endif
    return loadConnection()?.relayHost
  }

  // Provenance next to evidence names the host the user picked ("Mac1"), not the
  // relay hostname the connection happens to use.
  var scopeLabel: String { targetScope?.label ?? ConnectionCopy.gatewayHost }

  var hasRecoverableRun: Bool {
    pendingSubmission != nil || runId != nil
  }

  // Preview fixtures can run inside an already paired installation. Every
  // transport path (including paged history) must use this gate, not the
  // persisted descriptor directly. Do not clear or replace the real pairing.
  func loadConnection() -> RemoteConnection? {
    #if DEBUG
    if mockMode || ProcessInfo.processInfo.arguments.contains("-uiPreview") { return nil }
    #endif
    guard let connection = connections.load() else { return nil }
    if let targetScope, !targetScope.isLocal {
      guard targetScope.targetBinding != nil,
            boundGatewayIdentity == RemoteHistoryCache.catalogKey(connection: connection) else { return nil }
    }
    return connection
  }

  func makeClient() -> RemoteRunClient? {
    guard let connection = loadConnection() else { return nil }
    return RemoteRunClient(connection: connection, executionTarget: targetScope?.targetBinding)
  }

  func downloadFile(cwd: String, target: String,
                    progress: @escaping @MainActor (Int, Int?) -> Void) async throws -> URL {
    guard let client = makeClient() else { throw RemoteRunClient.ClientError.missingCredentials }
    let generation = dataGeneration
    let sink = RemoteFileDownloadSink()
    var id: String?
    do {
      var result = try await client.fileDownload(.open(cwd: cwd, target: target))
      var offset = 0
      var total: Int?
      var name: String?
      while true {
        try Task.checkCancellation()
        guard dataGeneration == generation, loadConnection() == client.connection else { throw CancellationError() }
        guard case let .page(page) = result else { throw RemoteRunClient.ClientError.invalidFileDownload }
        let bytes = try page.bytes(expectedOffset: offset, expectedID: id)
        guard name == nil || name == page.name,
              total == nil || total == page.totalBytes else { throw RemoteRunClient.ClientError.invalidFileDownload }
        if id == nil { try await sink.start(name: page.name, mimeType: page.mimeType) }
        id = page.id; name = page.name; total = page.totalBytes
        try await sink.write(bytes)
        offset = page.nextOffset
        guard dataGeneration == generation, loadConnection() == client.connection else { throw CancellationError() }
        progress(offset, total)
        if !page.hasMore {
          let url = try await sink.finish()
          try Task.checkCancellation()
          guard dataGeneration == generation, loadConnection() == client.connection else { throw CancellationError() }
          return url
        }
        result = try await client.fileDownload(.read(cwd: cwd, id: page.id, offset: offset))
      }
    } catch {
      await sink.remove()
      if let id { _ = try? await client.fileDownload(.close(cwd: cwd, id: id)) }
      throw error
    }
  }

  func readWorkspace(_ query: G0Transport.WorkspaceQuery) async throws -> G0Transport.WorkspaceResult {
    guard let client = makeClient() else { throw RemoteRunClient.ClientError.missingCredentials }
    let requestGeneration = dataGeneration
    let result: G0Transport.WorkspaceResult
    #if DEBUG
    if let workspaceReaderFixture { result = try await workspaceReaderFixture(client, query) }
    else { result = try await client.workspace(query) }
    #else
    result = try await client.workspace(query)
    #endif
    try Task.checkCancellation()
    guard dataGeneration == requestGeneration, loadConnection() == client.connection else { throw CancellationError() }
    return result
  }

  func updateTargetAvailability(_ available: Bool) {
    executionTargetAvailable = targetScope?.isLocal == false ? available : true
  }

  func isFresh(_ date: Date?, within interval: TimeInterval) -> Bool {
    guard let date else { return false }
    return Date().timeIntervalSince(date) < interval
  }

  func recordSuccess() {
    connectionSuccessRevision += 1
    reachable = true
    connectionObservation = .reachable
  }

  func recordFailure(_ error: Error, since revision: Int? = nil) {
    if error is G0Transport.HistoryProfileError {
      connectionSuccessRevision += 1
      reachable = nil
      connectionObservation = .protocolFailure(code: "history_profile_unverified")
      return
    }
    if let runError = error as? G0Transport.RunError, case let .host(code) = runError {
      connectionSuccessRevision += 1
      if ConnectionCopy.isProtocolFailure(code) || ["device_not_authorized", "grant_expired", "grant_revoked"].contains(code) {
        reachable = nil
      } else {
        reachable = true
      }
      connectionObservation = ConnectionCopy.isProtocolFailure(code) ? .protocolFailure(code: code) : .hostReply(code: code)
      return
    }
    // Only a newer authenticated reply can supersede a failed request.
    // Another pending request is not evidence that the connection works.
    if let revision, connectionSuccessRevision > revision { return }
    reachable = false
    connectionObservation = .transportFailure
  }

  enum ConnectionReplacementError: LocalizedError {
    case pendingWork, recoveryUnavailable
    var errorDescription: String? {
      switch self {
      case .pendingWork: return ConnectionCopy.pendingBeforePair
      case .recoveryUnavailable: return ConnectionCopy.targetRecoveryUnavailable
      }
    }
  }

  func prepareConnectionReplacement(_ connection: RemoteConnection) throws {
    guard let previous = loadConnection(),
          previous.hostId != connection.hostId || previous.deviceId != connection.deviceId || previous.anchorPEM != connection.anchorPEM else { return }
    guard !hasUnsentMessages, !hasUnresolvedRun else { throw ConnectionReplacementError.pendingWork }
    // Routing-only migration retains the same grant. A different host/grant
    // must not inherit its metadata, pending sends, polls or recovery record.
    try clearAllState()
  }

  // Used by destructive unpair and grant replacement. Storage failure must
  // reach the caller before it removes the credentials or claims success.
  func clearAllState() throws {
    #if DEBUG
    let skipDisk = mockMode || ProcessInfo.processInfo.arguments.contains("-historyCacheTest")
    #else
    let skipDisk = false
    #endif
    if !skipDisk {
      if let url = outboxURL { try Self.removeStateFile(at: url) }
      if let url = recoveryURL { try Self.removeStateFile(at: url) }
    }
    generation += 1
    dataGeneration += 1
    stopLiveRuns()
    followDetached(nil)
    liveRuns = []; liveRunsRevision = nil; liveRunsStatus = .unknown; liveHistoryTarget = nil
    liveActionRunId = nil; liveActionError = nil; liveAnsweredQuestions = []; liveAnswerIds = [:]
    pollTask?.cancel(); pollTask = nil
    for task in deliveryTasks.values { task.cancel() }
    deliveryTasks = [:]; pausedDeliveries = []; attemptedDeliveryIntentIds = []
    // Persisted files were removed successfully before releasing their state.
    outbox = []
    catalogTask?.cancel(); catalogTask = nil
    prefetchGeneration += 1
    prefetchTask?.cancel(); prefetchTask = nil; warmedScreens.removeAll()
    historyTask?.cancel(); historyTask = nil
    providersTask?.cancel(); providersTask = nil
    providerControlsRequestID += 1
    providerControlsTask?.cancel(); providerControlsTask = nil; providerControlsLoaded = false
    commandsTask?.cancel(); commandsTask = nil
    projectsTask?.cancel(); projectsTask = nil
    directoriesTask?.cancel(); directoriesTask = nil
    pendingSubmission = nil
    activeRouting = nil
    projects = .idle; directories = .idle; chosen = nil
    modelSelectionSession = nil; modelSelections = []
    providers = .idle; commands = .idle; chosenProvider = nil; chosenModelId = nil; chosenEffort = nil; permissionMode = "default"
    catalog = .idle; catalogRefreshFailure = nil; catalogEvidence = .none; catalogVerifiedAt = nil; catalogRefreshInFlight = false; history = .idle; historyPreview = .idle; historyPreviewKey = nil; historyWindow = nil; historyWindowKey = nil; historyCapacityLimit = false; reachable = nil; connectionObservation = .unverified
    catalogLoadedAt = nil; providersLoadedAt = nil; projectsLoadedAt = nil; commandCache = [:]; cachedHistory = nil; historyFollowingLatest = true
    historyRequestGeneration += 1
    historySyncing = false; historyFromCache = false; historyFetchedAt = nil
    historyProgress = nil; historyRefreshError = nil; historyStorageNotice = nil
    lifecycle = .unknown; output = []; seenOutputSequences = []; prompt = nil; sentAttachments = []
    runId = nil; submitError = nil; truncated = false; resultSummary = nil
    liveExternalSessionId = nil; liveHostRunId = nil; activeSessionIdentity = nil
    observationInterrupted = false; observationReconnecting = false; stopRequesting = false; stopRequested = false; stopError = nil; terminalDrainCompleted = false
    pendingQuestions = []; pendingQuestionAnswerId = nil; questionAnswering = false; questionError = nil
    completedLiveTurns = [:]
    archivedActiveTurn = false
    restoredControlErrors = [:]
    contextNeedsRestore = false
    #if DEBUG
    mockMode = false
    #endif
  }

  static func describe(_ error: Error) -> String {
    if error is G0Transport.HistoryProfileError { return ConnectionCopy.historyProfileUnverified }
    if let runError = error as? G0Transport.RunError, case let .host(code) = runError {
      if let mapped = ConnectionCopy.describeKnownHostError(code) { return mapped }
      if code == "unknown_op" {
        return "Mac 端不支持当前读取协议（unknown_op）。请更新 Scry，并完全退出后重新打开 Mac 端；仅覆盖安装不会更新正在运行的进程。"
      }
      return code
    }
    // Relay close/timeout reasons are untrusted diagnostics, shown as such.
    if let relay = error as? RelayTransportError {
      switch relay {
      case let .tlsHandshake(layer, detail):
        switch layer {
        case .relay: return ConnectionCopy.relayTLSHandshakeFailure(detail)
        case .host: return ConnectionCopy.hostTLSHandshakeFailure(detail)
        }
      case let .closed(code, _) where code == RelayTransportError.hostOfflineCloseCode:
        // The relay saw no live connection from the Mac at all; retrying now
        // cannot reach it. This is the relay's observation, not proof.
        return "Mac 当前不在线（中继未看到它的连接）：可能已休眠、断网或 Scry 未运行。唤醒 Mac 后会自动重连。"
      case let .closed(code, _) where code == RelayTransportError.noHostLegCloseCode:
        return "Mac 在线但暂时没有空闲中继通道（no_host_leg），请稍后重试。"
      case let .closed(code, reason):
        return "中继连接已关闭（\(code.map(String.init) ?? "无关闭码")\(reason.isEmpty ? "" : " \(reason)")）"
      case let .timedOut(stage):
        return "连接 Mac 超时（\(stage)）；请确认 Mac 未休眠且 Scry 正在运行"
      case .frameTooLarge:
        return "Mac 一次发来的数据超过手机接收上限（invalidFrameLength）。请把 Mac Scry 更新到 0.2.174 或更高，并完全退出后重新打开。"
      }
    }
    return "\(error)"
  }
}
