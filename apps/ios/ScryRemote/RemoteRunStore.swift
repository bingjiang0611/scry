import Foundation
import RemoteTransport

// Device-side observable state for ONE remote run, driven strictly by what the
// host proves over the granted-cert inner mTLS channel (RemoteRunClient). It
// never fabricates a lifecycle, an assistant reply, a token/cost number or a
// file diff (CLAUDE.md 证据不能说谎):
//
//   - Lifecycle comes only from the durable ledger poll/run projection: recorded/dispatched/
//     started/settled/failed/cancelled. "recorded" is NOT "executed".
//   - Output comes only from the separate output-content poll: the assistant's
//     real streamed text/reasoning/tool activity, a LIVE cache that may be
//     incomplete or truncated (labeled as such), never presented as complete.
//   - Token/cost, when shown, come only from the ledger `result` marker (exact
//     Provider-canonical evidence); they are never re-derived from output text.
//   - A transport failure surfaces verbatim; we never pretend "offline" success.
@MainActor
final class RemoteRunStore: ObservableObject {
  enum ProjectsState: Equatable {
    case idle
    case loading
    case loaded([G0Transport.RunProjectRef])
    case empty
    case failed(String)
  }

  enum DirectoriesState: Equatable {
    case idle
    case loading
    case loaded(G0Transport.RunDirectoryListing)
    case failed(String)
  }

  // Host-advertised Providers for the new-session picker. Mirrors the host's real
  // describe(); we never invent a provider or fake availability.
  enum ProvidersState: Equatable {
    case idle
    case loading
    case loaded([G0Transport.RunProviderRef])
    case empty
    case failed(String)
  }

  enum CommandsState: Equatable {
    case idle
    case loading
    case loaded([G0Transport.RunCommandRef])
    case empty(String?)
    case failed(String)
  }

  // The device-observable lifecycle. `.unknown` = we have not learned a state
  // yet (e.g. before any poll), never shown as success.
  enum Lifecycle: String, Equatable {
    case unknown, submitting, recorded, dispatched, running, settled, failed, cancelled
  }

  struct OutputLine: Identifiable, Equatable {
    let id: Int      // per-run output seq
    let kind: String // output | reasoning | tool | tool_result | truncated
    let text: String
  }
  struct SentAttachment: Identifiable, Equatable {
    let id = UUID()
    let name: String
    let kind: RemoteRunClient.Attachment.Kind
    let size: Int
  }

  // A transport response is only allowed to mutate the session that initiated
  // it. The local id keeps consecutive new sessions distinct until the host
  // reports an external Provider session id.
  struct SessionIdentity: Codable, Hashable, Equatable {
    let providerId: String
    let cwd: String
    let externalSessionId: String?
    let localId: String?

    static func opened(providerId: String, cwd: String, externalSessionId: String) -> SessionIdentity {
      SessionIdentity(providerId: providerId, cwd: cwd, externalSessionId: externalSessionId, localId: nil)
    }

    static func new(providerId: String, cwd: String) -> SessionIdentity {
      SessionIdentity(providerId: providerId, cwd: cwd, externalSessionId: nil, localId: UUID().uuidString.lowercased())
    }
  }

  struct CompletedLiveTurn: Identifiable, Equatable {
    let id: String
    let runId: String?
    let prompt: String
    let attachments: [SentAttachment]
    let lifecycle: Lifecycle
    let output: [OutputLine]
    let resultSummary: String?
    let externalSessionId: String?
  }

  private struct PendingSubmission {
    let intentId: String
    let routing: RemoteRunClient.Routing
    let identity: SessionIdentity
  }

  private struct RecoveryCheckpoint: Codable {
    let version: Int
    let hostId: String
    let intentId: String?
    let routing: RemoteRunClient.Routing?
    let identity: SessionIdentity
    let runId: String?
  }

  @Published private(set) var projects: ProjectsState = .idle
  @Published private(set) var directories: DirectoriesState = .idle
  @Published private(set) var chosen: G0Transport.RunProjectRef?
  @Published private(set) var providers: ProvidersState = .idle
  @Published private(set) var commands: CommandsState = .idle
  @Published private(set) var chosenProvider: G0Transport.RunProviderRef?
  @Published private(set) var chosenModelId: String?
  @Published private(set) var chosenEffort: String?
  @Published private(set) var permissionMode: String = "default"

  var modelOptions: [G0Transport.RunModelOption] { chosenProvider?.models ?? [] }
  var effortOptions: [G0Transport.RunControlOption] {
    if let chosenModelId, let model = modelOptions.first(where: { $0.selectionId == chosenModelId }) {
      return model.efforts ?? []
    }
    return chosenProvider?.efforts ?? []
  }
  var chosenModel: G0Transport.RunModelOption? {
    guard let chosenModelId else { return nil }
    return modelOptions.first(where: { $0.selectionId == chosenModelId })
  }
  var controlsReady: Bool {
    guard restoredControlsError == nil, let provider = chosenProvider else { return false }
    if let permissions = provider.permissions {
      guard permissions.contains(where: { $0.id == permissionMode }) else { return false }
    } else if permissionMode != "default" {
      return false
    }
    if let chosenModelId, !(provider.models ?? []).contains(where: { $0.selectionId == chosenModelId }) { return false }
    if let chosenEffort, !effortOptions.contains(where: { $0.id == chosenEffort }) { return false }
    return true
  }

  // The host's session catalog (the SAME conversations the Mac lists). Loaded
  // from the host over the granted-cert channel; never fabricated. Opening a
  // session's full transcript on the phone is a separate host read.
  enum CatalogState: Equatable {
    case idle
    case loading
    case loaded([G0Transport.RunSessionRef])
    case empty
    case failed(String)

    fileprivate var hasVisibleValue: Bool {
      if case .loaded = self { return true }
      if case .empty = self { return true }
      return false
    }
  }
  @Published private(set) var catalog: CatalogState = .idle

  enum HistoryPreviewState: Equatable {
    case idle
    case loading
    case available(G0Transport.RunHistoryPreview)
    case unavailable(String)
  }

  // The REAL conversation content of the opened session (read-only replay).
  enum HistoryState: Equatable {
    case idle
    case loading
    case loaded([G0Transport.RunHistoryTurn])
    case partial([G0Transport.RunHistoryTurn])
    case empty
    case baseUnavailable
    case failed(String)
  }
  @Published private(set) var history: HistoryState = .idle
  @Published private(set) var historyPreview: HistoryPreviewState = .idle
  @Published private(set) var historyRevision = 0
  @Published private(set) var historySyncing = false
  @Published private(set) var historyFromCache = false
  @Published private(set) var historyFetchedAt: Date?
  @Published private(set) var historyProgress: String?
  @Published private(set) var historyRefreshError: String?
  @Published private(set) var historyStorageNotice: String?
  @Published private(set) var historyCacheClearing = false
  // Whether the host was actually reached on the LAST attempt. Paired != reachable:
  // a persisted grant only means we MAY reach the host; only a real successful
  // exchange proves it. nil = not tried yet. This is the honest source of the
  // connection status (fixes "shows offline while sending works").
  @Published private(set) var reachable: Bool?
  @Published private(set) var lifecycle: Lifecycle = .unknown
  @Published private(set) var output: [OutputLine] = []
  // The user's own submitted message, echoed immediately as a chat bubble
  // (ChatGPT/Codex style) so the person sees exactly what they sent. This is the
  // literal local input, not host-derived, and is labeled as the user turn.
  @Published private(set) var prompt: String?
  @Published private(set) var sentAttachments: [SentAttachment] = []
  @Published private(set) var runId: String?
  @Published private(set) var submitError: String?
  @Published private(set) var truncated = false
  // Provider-canonical result evidence, surfaced verbatim from the ledger
  // `result` marker only. nil until the host reports it; never a fabricated 0.
  @Published private(set) var resultSummary: String?
  // The Provider session id the live run reported (from the ledger `session`
  // marker). Lets a follow-up into an opened session resume the LATEST id.
  @Published private(set) var liveExternalSessionId: String?
  @Published private(set) var activeSessionIdentity: SessionIdentity?
  @Published private(set) var observationInterrupted = false
  @Published private(set) var retryAvailable = false
  @Published private(set) var completedLiveTurns: [SessionIdentity: [CompletedLiveTurn]] = [:]
  @Published private(set) var pendingQuestions: [G0Transport.RunQuestionRequest] = []
  @Published private(set) var questionAnswering = false
  @Published private(set) var questionError: String?

  // A run remains unresolved until its durable intent is acknowledged and a
  // terminal run has had its output drained. This derived gate is the small
  // parent-facing contract for navigation and composer admission.
  var hasUnresolvedRun: Bool {
    Self.unresolvedState(pending: pendingSubmission != nil, runId: runId,
                         drained: terminalDrainCompleted, interrupted: observationInterrupted)
  }
  var isBusy: Bool { hasUnresolvedRun }
  var historyPreviewTurns: [G0Transport.RunHistoryTurn] {
    guard case let .available(preview) = historyPreview else { return [] }
    return preview.turns.map { turn in
      G0Transport.RunHistoryTurn(userText: turn.userText,
        items: turn.items.map { G0Transport.RunHistoryChunk(kind: $0.kind, text: $0.text) })
    }
  }

  private let connections: RemoteConnectionStore
  private var pollTask: Task<Void, Never>?
  private var submitTask: Task<Void, Never>?
  private var catalogTask: Task<Void, Never>?
  private var historyTask: Task<Void, Never>?
  private var providersTask: Task<Void, Never>?
  private var commandsTask: Task<Void, Never>?
  private var projectsTask: Task<Void, Never>?
  private var directoriesTask: Task<Void, Never>?
  private var generation = 0
  // Catalog/provider/project requests are independent of the currently opened
  // run. `resetRun()` must not make their useful replies disappear.
  private var dataGeneration = 0
  private var catalogLoadedAt: Date?
  private var providersLoadedAt: Date?
  private var projectsLoadedAt: Date?
  private var commandCache: [String: G0Transport.RunCommandCatalog] = [:]
  private let historyDisk: RemoteHistoryCache
  private var prefetchTask: Task<Void, Never>?
  private var prefetchGeneration = 0
  private var warmedScreens: [String: G0Transport.RunHistoryPreview] = [:]
  private var cachedHistory: (key: String, snapshot: RemoteHistorySnapshot, persisted: Bool)?
  private var historyRequestGeneration = 0
  private var historyPreviewKey: String?
  private var pendingSubmission: PendingSubmission?
  private var activeRouting: RemoteRunClient.Routing?
  private var seenOutputSequences = Set<Int>()
  private var archivedActiveTurn = false
  @Published private(set) var terminalDrainCompleted = false
  private var contextNeedsRestore = false
  private var directoriesRequestGeneration = 0
  private var commandsRequestGeneration = 0
  private var latestProviderPreference: (id: String?, agentProfileId: String?) = (nil, nil)
  private enum RestoredControl { case model, effort, permission }
  private var restoredControlErrors: [RestoredControl: String] = [:]
  private var restoredControlsError: String? { restoredControlErrors.values.first }
  private var pendingQuestionAnswerId: String?

  private static let catalogFreshness: TimeInterval = 60
  private static let metadataFreshness: TimeInterval = 5 * 60
  #if DEBUG
  private var mockMode = false
  private var historyTestOffline = false
  #endif

  init(connections: RemoteConnectionStore = RemoteConnectionStore(), historyDisk: RemoteHistoryCache = RemoteHistoryCache()) {
    self.connections = connections
    self.historyDisk = historyDisk
    #if DEBUG
    let args = ProcessInfo.processInfo.arguments
    if args.contains("-uiPreview") || args.contains("-selfTest") || args.contains("-historyCacheTest") { return }
    #endif
    restoreRecoveryCheckpoint()
  }

  // A persisted PUBLIC connection descriptor means this device is paired and may
  // attempt a run; reachability of the host is only known by trying.
  var hasConnection: Bool {
    #if DEBUG
    if mockMode { return true }
    #endif
    return connections.load() != nil
  }
  var hostLabel: String? {
    #if DEBUG
    if mockMode { return "Studio Mac" }
    #endif
    return connections.load()?.relayHost
  }

  var hasRecoverableRun: Bool {
    pendingSubmission != nil || runId != nil
  }

  private func makeClient() -> RemoteRunClient? {
    guard let connection = connections.load() else { return nil }
    return RemoteRunClient(connection: connection)
  }

  private var recoveryURL: URL? {
    FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first?
      .appendingPathComponent("ScryRemote", isDirectory: true)
      .appendingPathComponent("active-run.json", isDirectory: false)
  }

  private func saveRecoveryCheckpoint(intentId: String?, routing: RemoteRunClient.Routing?,
                                      identity: SessionIdentity, runId: String?) -> Bool {
    guard let connection = connections.load(), let url = recoveryURL else {
      submitError = "无法保存恢复记录：尚未配对或存储目录不可用"
      return false
    }
    let checkpoint = RecoveryCheckpoint(version: 1, hostId: connection.hostId, intentId: intentId,
                                        routing: routing, identity: identity, runId: runId)
    do {
      let directory = url.deletingLastPathComponent()
      try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
        attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
      try JSONEncoder().encode(checkpoint).write(to: url, options: .atomic)
      try FileManager.default.setAttributes(
        [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: url.path)
      return true
    } catch {
      submitError = "无法保存恢复记录：\(Self.describe(error))"
      return false
    }
  }

  private func clearRecoveryCheckpoint() {
    #if DEBUG
    if mockMode || ProcessInfo.processInfo.arguments.contains("-historyCacheTest") { return }
    #endif
    guard let url = recoveryURL else { return }
    do { try FileManager.default.removeItem(at: url) }
    catch let error as CocoaError where error.code == .fileNoSuchFile { }
    catch { submitError = "无法清除恢复记录：\(Self.describe(error))" }
  }

  private func restoreRecoveryCheckpoint() {
    guard let url = recoveryURL, FileManager.default.fileExists(atPath: url.path) else { return }
    do {
      let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
      guard let size = attributes[.size] as? NSNumber, size.intValue <= 2 * 1024 * 1024 else {
        throw CocoaError(.fileReadCorruptFile)
      }
      let checkpoint = try JSONDecoder().decode(RecoveryCheckpoint.self, from: Data(contentsOf: url))
      guard checkpoint.version == 1, let connection = connections.load(), checkpoint.hostId == connection.hostId else {
        submitError = "本地恢复记录不属于当前已配对主机"
        return
      }
      activeSessionIdentity = checkpoint.identity
      activeRouting = checkpoint.routing
      contextNeedsRestore = true
      prompt = checkpoint.routing?.prompt
      sentAttachments = checkpoint.routing?.attachments.map {
        SentAttachment(name: $0.name, kind: $0.kind, size: $0.size)
      } ?? []
      if let runId = checkpoint.runId {
        self.runId = runId
        terminalDrainCompleted = false
        lifecycle = .recorded
        if let client = makeClient() {
          startPolling(runId: runId, client: client, generation: generation, identity: checkpoint.identity)
        } else {
          observationInterrupted = true
          submitError = "已恢复运行标识，但当前配对凭据不可用"
        }
      } else if let intentId = checkpoint.intentId, let routing = checkpoint.routing {
        pendingSubmission = PendingSubmission(intentId: intentId, routing: routing, identity: checkpoint.identity)
        terminalDrainCompleted = false
        lifecycle = .submitting
        retryAvailable = true
        submitError = "上次提交结果未知。可重试核对；将复用原 intent ID，不会创建重复任务。"
      } else {
        submitError = "本地恢复记录不完整，未自动执行任何操作"
      }
    } catch {
      submitError = "本地恢复记录损坏，未自动执行任何操作：\(Self.describe(error))"
    }
  }

  private func isFresh(_ date: Date?, within interval: TimeInterval) -> Bool {
    guard let date else { return false }
    return Date().timeIntervalSince(date) < interval
  }

  func chooseProject(_ ref: G0Transport.RunProjectRef) {
    chosen = ref
    if let provider = chosenProvider {
      loadCommands(providerId: provider.id, cwd: ref.path, agentProfileId: provider.agentProfileId)
    }
  }
  func chooseProvider(_ ref: G0Transport.RunProviderRef) {
    restoredControlErrors = [:]
    chosenProvider = ref
    chosenModelId = nil
    chosenEffort = nil
    permissionMode = ref.permissions?.first(where: { $0.id == "default" })?.id ?? ref.permissions?.first?.id ?? "default"
    if let cwd = chosen?.path { loadCommands(providerId: ref.id, cwd: cwd, agentProfileId: ref.agentProfileId) }
  }
  func chooseModel(_ id: String?) {
    guard id == nil || modelOptions.contains(where: { $0.selectionId == id }) else { return }
    restoredControlErrors[.model] = nil
    restoredControlErrors[.effort] = nil
    chosenModelId = id
    chosenEffort = nil
  }
  func chooseEffort(_ id: String?) {
    guard id == nil || effortOptions.contains(where: { $0.id == id }) else { return }
    restoredControlErrors[.effort] = nil
    chosenEffort = id
  }
  func choosePermission(_ id: String) {
    guard chosenProvider?.permissions?.contains(where: { $0.id == id }) == true else { return }
    restoredControlErrors[.permission] = nil
    permissionMode = id
  }

  // Load the host session catalog so the phone's session list shows the SAME
  // conversations the Mac has. Returning from a transcript uses the warm value
  // immediately; a fresh cache performs no network request at all.
  func loadSessions(force: Bool = false) {
    #if DEBUG
    if mockMode { return }
    #endif
    let hasCachedValue = catalog.hasVisibleValue
    if !force, hasCachedValue, isFresh(catalogLoadedAt, within: Self.catalogFreshness) { return }
    guard catalogTask == nil else { return }
    guard let client = makeClient() else {
      if !hasCachedValue { catalog = .failed("尚未配对") }
      return
    }
    if !hasCachedValue { catalog = .loading }
    let requestDataGeneration = dataGeneration
    catalogTask = Task { [weak self] in
      do {
        let list = try await client.sessions()
        await MainActor.run {
          guard let self, self.dataGeneration == requestDataGeneration else { return }
          self.catalogTask = nil
          self.reachable = true
          self.catalogLoadedAt = Date()
          self.catalog = list.isEmpty ? .empty : .loaded(list)
          self.prefetchHistory(list)
        }
      } catch {
        await MainActor.run {
          guard let self, self.dataGeneration == requestDataGeneration else { return }
          self.catalogTask = nil
          self.reachable = false
          if !hasCachedValue { self.catalog = .failed(Self.describe(error)) }
        }
      }
    }
  }

  // At most two small previews while browsing; never download full history.
  // An established readonly tunnel closes on cancellation, so foreground reads
  // take priority. Before channel establishment, NIO/upgrade deadlines still apply.
  private func prefetchHistory(_ sessions: [G0Transport.RunSessionRef]) {
    guard prefetchTask == nil, historyTask == nil, !historyCacheClearing, !hasUnresolvedRun,
          let connection = connections.load() else { return }
    let recent = Array(sessions.filter { $0.externalSessionId?.isEmpty == false }
      .sorted { $0.ts > $1.ts }.prefix(2))
    let keys = Set(recent.compactMap { session -> String? in
      guard let external = session.externalSessionId else { return nil }
      return RemoteHistoryCache.key(connection: connection, providerId: session.providerId, cwd: session.cwd, sessionId: external)
    })
    warmedScreens = warmedScreens.filter { keys.contains($0.key) }
    let requestDataGeneration = dataGeneration
    let warmingGeneration = prefetchGeneration
    let disk = historyDisk
    prefetchTask = Task { [weak self] in
      guard let self else { return }
      @MainActor func current() -> Bool {
        !Task.isCancelled && self.dataGeneration == requestDataGeneration &&
          self.prefetchGeneration == warmingGeneration && self.historyTask == nil &&
          self.connections.load() == connection
      }
      var missing: [(G0Transport.RunSessionRef, String)] = []
      for session in recent {
        guard !Task.isCancelled, self.dataGeneration == requestDataGeneration,
              self.prefetchGeneration == warmingGeneration,
              self.connections.load() == connection, let external = session.externalSessionId else { break }
        let key = RemoteHistoryCache.key(connection: connection, providerId: session.providerId, cwd: session.cwd, sessionId: external)
        do {
          let cached = try await disk.readPreview(key)
          guard !Task.isCancelled, self.prefetchGeneration == warmingGeneration,
                self.dataGeneration == requestDataGeneration, self.connections.load() == connection else { break }
          if let cached { self.warmScreen(cached, key: key) }
          else { missing.append((session, key)) }
        } catch {
          // Prefetch is an optional read, never a connectivity/business receipt.
          // Opening the session owns visible errors and its authoritative read.
          if Task.isCancelled { break }
        }
      }
      #if DEBUG
      if self.historyTestOffline {
        if self.prefetchGeneration == warmingGeneration { self.prefetchTask = nil }
        return
      }
      #endif
      if current(), !missing.isEmpty {
        let epoch = await disk.epoch
        do {
          try await RemoteRunClient(connection: connection).withHistoryConnection { [missing] reader in
            for (session, key) in missing {
              guard current(), let external = session.externalSessionId else { return }
              let preview = try await reader.preview(providerId: session.providerId, cwd: session.cwd, externalSessionId: external)
              guard current() else { return }
              if preview.available {
                self.warmScreen(preview, key: key)
                _ = try await disk.writePreview(preview, key: key, epoch: epoch)
              }
            }
          }
        } catch { /* Optional warming never claims connectivity or replaces foreground errors. */ }
      }
      if self.prefetchGeneration == warmingGeneration { self.prefetchTask = nil }
    }
  }

  private func warmScreen(_ preview: G0Transport.RunHistoryPreview, key: String) {
    let encoder = JSONEncoder()
    encoder.outputFormatting = .withoutEscapingSlashes
    guard preview.available, preview.turns.count <= 2,
          (try? encoder.encode(preview).count) ?? Int.max <= 16 * 1024 else { return }
    warmedScreens[key] = preview
  }

  // Show protected local data before opening the relay. Only an authenticated
  // host response can mark it current/reachable. The single memory entry keeps
  // large transcripts bounded; other conversations reopen from disk off-main.
  func loadHistory(providerId: String, cwd: String, externalSessionId: String, force: Bool = false) {
    #if DEBUG
    if mockMode { return }
    #endif
    guard !historyCacheClearing else { return }
    prefetchTask?.cancel()
    let identity = SessionIdentity.opened(providerId: providerId, cwd: cwd, externalSessionId: externalSessionId)
    // The legacy history contract has no canonical turn ids. Keep the base of
    // a locally extended conversation stable rather than deduplicating by text
    // or double-rendering the same run after an archive refresh.
    let hasLocalTurns = !(completedLiveTurns[identity] ?? []).isEmpty ||
      (activeSessionIdentity == identity && prompt != nil)
    if activeSessionIdentity != identity {
      guard resetRun() else { return }
      activeSessionIdentity = identity
      commandsRequestGeneration += 1
      commandsTask?.cancel(); commandsTask = nil; commands = .idle
      history = .idle
    } else if historyTask != nil { return }
    guard let connection = connections.load() else { history = .failed("尚未配对"); return }
    let key = RemoteHistoryCache.key(connection: connection, providerId: providerId, cwd: cwd, sessionId: externalSessionId)
    let client = RemoteRunClient(connection: connection)
    let disk = historyDisk
    let memory = cachedHistory?.key == key ? cachedHistory?.snapshot : nil
    historyRequestGeneration += 1
    let request = historyRequestGeneration
    let requestGeneration = generation
    historyFromCache = false; historyFetchedAt = nil; historyProgress = nil
    historyRefreshError = nil; historyStorageNotice = nil
    if historyPreviewKey != key { historyPreview = .idle; historyPreviewKey = nil }
    if case .available = historyPreview {} else { historyPreview = .loading }
    if let memory { showHistory(memory, key: key, cached: true, persisted: cachedHistory?.persisted == true) }
    else if let screen = warmedScreens[key], !hasLocalTurns {
      showPreview(screen, key: key, cached: true)
    } else if case .available = historyPreview, !hasLocalTurns {
      history = .partial(historyPreviewTurns)
    } else { history = .loading }
    historySyncing = true
    historyTask = Task { [weak self] in
      guard let self else { return }
      @MainActor func current() -> Bool {
        !Task.isCancelled && self.historyRequestGeneration == request &&
          self.isCurrent(requestGeneration, identity: identity) && self.connections.load() == connection
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
      do { cachedPreview = try await disk.readPreview(key) }
      catch { if current() { self.historyStorageNotice = "本地首屏镜像不可用，将从主机重新读取" } }
      guard current() else { return }
      if let cachedPreview, cached == nil, !hasLocalTurns { self.showPreview(cachedPreview, key: key, cached: true) }
      if cached == nil {
        do { cached = try await disk.read(key); persisted = cached != nil }
        catch { if current() { self.historyStorageNotice = "本地缓存不可用，将从主机重新读取" } }
      }
      guard current() else { return }
      if let cached {
        self.showHistory(cached, key: key, cached: true, persisted: persisted)
        if !persisted { self.historyStorageNotice = "历史目前仅在内存中，尚未保存到手机缓存。" }
        if !hasLocalTurns, memory != nil, !force,
           (0..<30).contains(Date().timeIntervalSince(cached.fetchedAt)) { return }
      }
      if hasLocalTurns {
        if cached == nil { self.history = .baseUnavailable; self.historyRevision += 1 }
        let notice = cached == nil
          ? "历史基底未缓存，以下仅为本机运行增量；重启后重新核对完整主机历史。"
          : "保留历史基底与本机运行增量，避免重复；重启后重新核对完整主机历史。"
        self.historyStorageNotice = notice + (cached != nil && !persisted ? " 当前基底仅存内存，未写入手机缓存。" : "")
        return
      }
      @MainActor func failed(_ error: Error) {
        guard current() else { return }
        self.showHistoryFailure(error, cached: cached)
      }
      do {
        #if DEBUG
        if self.historyTestOffline {
          throw NSError(domain: "ScryHistoryFixture", code: 1, userInfo: [NSLocalizedDescriptionKey: "isolated offline fixture"])
        }
        #endif
        try await client.withHistoryConnection { [cached, persisted] reader in
          // Preview and all complete pages share one fresh, readonly mTLS tunnel.
          do {
            let preview = try await reader.preview(providerId: providerId, cwd: cwd, externalSessionId: externalSessionId)
            guard current() else { return }
            if preview.available {
              if cached == nil, !hasLocalTurns { self.showPreview(preview, key: key, cached: false) }
              self.reachable = true
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
              externalSessionId: externalSessionId, cached: cached, connection: reader, progress: { [weak self] received, total in
                guard let self else { return }
                await MainActor.run {
                  guard self.historyRequestGeneration == request,
                        self.isCurrent(requestGeneration, identity: identity), self.connections.load() == connection else { return }
                  self.historyProgress = "\(received / 1024) / \(max(1, (total + 1023) / 1024)) KB"
                }
              })
            guard current() else { return }
            self.reachable = true
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

  private func showHistoryFailure(_ error: Error, cached: RemoteHistorySnapshot?) {
    if let runError = error as? G0Transport.RunError, case .host(code: "unknown_op") = runError {
      // An authenticated host replied: this is protocol mismatch, not offline.
      reachable = true
    } else { reachable = false }
    historyRefreshError = Self.describe(error)
    if cached == nil, case .available = historyPreview {
      history = .partial(historyPreviewTurns)
    } else if cached == nil { history = .failed(Self.describe(error)) }
  }

  private func applyHistoryPreview(_ turns: [G0Transport.RunHistoryTurn], request: Int,
                                   generation: Int, identity: SessionIdentity, connection: RemoteConnection) {
    guard !Task.isCancelled, historyRequestGeneration == request,
          isCurrent(generation, identity: identity), connections.load() == connection else { return }
    // A snapshot retry withdraws unverified network content, not a previously
    // verified warm screen. A nonempty new preview has no full digest receipt.
    if turns.isEmpty && historyFromCache { return }
    history = turns.isEmpty ? .loading : .partial(turns)
    historyFromCache = false; historyFetchedAt = nil
    historyRevision += 1
  }

  private func showPreview(_ preview: G0Transport.RunHistoryPreview, key: String, cached: Bool) {
    guard preview.available else { return }
    historyPreview = .available(preview); historyPreviewKey = key
    history = .partial(historyPreviewTurns)
    historyFromCache = cached; historyFetchedAt = nil
    historyRevision += 1
  }

  private func showHistory(_ snapshot: RemoteHistorySnapshot, key: String, cached: Bool, persisted: Bool) {
    let rendered: Bool
    switch history { case .loaded, .empty: rendered = true; default: rendered = false }
    let unchanged = rendered && cachedHistory?.key == key &&
      cachedHistory?.snapshot.fingerprint == snapshot.fingerprint
    cachedHistory = (key, snapshot, persisted)
    // Digest identity avoids an O(transcript) comparison on every validation.
    if !unchanged {
      history = snapshot.turns.isEmpty ? .empty : .loaded(snapshot.turns)
      historyRevision += 1
    }
    historyFromCache = cached
    historyFetchedAt = snapshot.fetchedAt
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
    history = .idle; historyPreview = .idle; historyPreviewKey = nil; historySyncing = false; historyFromCache = false
    historyFetchedAt = nil; historyProgress = nil; historyRefreshError = nil; historyStorageNotice = nil
    try await historyDisk.clear()
  }

  func refreshHistory(providerId: String, cwd: String, externalSessionId: String) async {
    #if DEBUG
    if mockMode {
      if ProcessInfo.processInfo.arguments.contains("-uiMockMacStartsLater"), case let .loaded(turns) = history {
        let prompt = "Mac 后来新增的用户输入"
        if turns.last?.userText != prompt {
          history = .loaded(turns + [.init(userText: prompt, items: [.init(kind: "output", text: "Mac 后来新增的回复")])])
          historyRevision += 1
        }
      }
      return
    }
    #endif
    let identity = SessionIdentity.opened(providerId: providerId, cwd: cwd, externalSessionId: externalSessionId)
    let requestGeneration = generation
    await historyTask?.value
    guard !Task.isCancelled, isCurrent(requestGeneration, identity: identity) else { return }
    loadHistory(providerId: providerId, cwd: cwd, externalSessionId: externalSessionId, force: true)
    await historyTask?.value
  }

  // Re-opening the same session does not discard its live observation. If the
  // view was left while a run was active, resume its poll using the known run id.
  func prepareForSession(providerId: String, cwd: String, externalSessionId: String) {
    let identity = SessionIdentity.opened(providerId: providerId, cwd: cwd, externalSessionId: externalSessionId)
    if activeSessionIdentity == identity {
      if let runId, pollTask == nil,
         observationInterrupted || !isTerminal(generation: generation, identity: identity) {
        resumeObservation(runId: runId)
      }
      if !hasUnresolvedRun { loadHistory(providerId: providerId, cwd: cwd, externalSessionId: externalSessionId) }
      return
    }
    loadHistory(providerId: providerId, cwd: cwd, externalSessionId: externalSessionId)
  }

  func completedTurns(for identity: SessionIdentity) -> [CompletedLiveTurn] {
    let turns = completedLiveTurns[identity] ?? []
    // Only stable run identity can deduplicate evidence; repeated prompt text
    // is not identity ("continue" may legitimately appear many times).
    guard identity == activeSessionIdentity else { return turns }
    return turns.filter {
      Self.shouldIncludeCompletedTurn($0.id, currentRunId: runId, archived: archivedActiveTurn)
    }
  }

  // Load the Providers the host offers. Only available ones are selectable (an
  // unavailable Provider cannot run). We deliberately do NOT auto-select a
  // default: describe() reports a Provider as available from CLI presence/auth,
  // which does not guarantee a run succeeds (e.g. a Provider whose CLI crashes on
  // launch). Auto-picking the first would silently send the first turn to a
  // Provider the user never chose - exactly the failure the owner hit. Requiring
  // an explicit pick (canSend gates on chosenProvider) keeps the choice honest.
  // If a previously-chosen Provider is no longer available, clear it.
  func loadProviders(preferredId: String? = nil, preferredAgentProfileId: String? = nil, force: Bool = false) {
    // This is updated before any cache/single-flight decision. A late response
    // therefore applies the latest screen preference, never its stale closure.
    latestProviderPreference = (preferredId, preferredAgentProfileId)
    #if DEBUG
    if mockMode {
      applyPreferredProvider(preferredId, agentProfileId: preferredAgentProfileId)
      _ = restoreActiveContext()
      return
    }
    #endif
    let hasCachedValue: Bool
    switch providers { case .loaded, .empty: hasCachedValue = true; default: hasCachedValue = false }
    applyPreferredProvider(preferredId, agentProfileId: preferredAgentProfileId)
    _ = restoreActiveContext()
    if !force, hasCachedValue, isFresh(providersLoadedAt, within: Self.metadataFreshness) { return }
    guard providersTask == nil else { return }
    guard let client = makeClient() else {
      if !hasCachedValue { providers = .failed("尚未配对") }
      return
    }
    if !hasCachedValue { providers = .loading }
    let requestDataGeneration = dataGeneration
    providersTask = Task { [weak self] in
      do {
        let list = try await client.providers()
        await MainActor.run {
          guard let self, self.dataGeneration == requestDataGeneration else { return }
          self.providersTask = nil
          self.reachable = true
          self.providersLoadedAt = Date()
          let usable = list.filter { $0.available }
          self.providers = usable.isEmpty ? .empty : .loaded(usable)
          if let chosen = self.chosenProvider {
            if let refreshed = usable.first(where: { Self.sameProviderContext($0, chosen) }) {
              self.chosenProvider = refreshed
              if let modelId = self.chosenModelId, !(refreshed.models ?? []).contains(where: { $0.selectionId == modelId }) {
                self.chosenModelId = nil
                self.chosenEffort = nil
              } else if let effort = self.chosenEffort, !self.effortOptions.contains(where: { $0.id == effort }) {
                self.chosenEffort = nil
              }
              if !(refreshed.permissions ?? []).contains(where: { $0.id == self.permissionMode }) {
                self.permissionMode = refreshed.permissions?.first(where: { $0.id == "default" })?.id ?? refreshed.permissions?.first?.id ?? "default"
              }
            } else {
              self.chosenProvider = nil
              self.chosenModelId = nil
              self.chosenEffort = nil
              self.permissionMode = "default"
            }
          }
          self.applyPreferredProvider(self.latestProviderPreference.id,
                                      agentProfileId: self.latestProviderPreference.agentProfileId)
          self.restoreActiveContext()
        }
      } catch {
        await MainActor.run {
          guard let self, self.dataGeneration == requestDataGeneration else { return }
          self.providersTask = nil
          self.reachable = false
          if !hasCachedValue { self.providers = .failed(Self.describe(error)) }
        }
      }
    }
  }

  private static func sameProviderContext(_ lhs: G0Transport.RunProviderRef, _ rhs: G0Transport.RunProviderRef) -> Bool {
    lhs.id == rhs.id && lhs.agentProfileId == rhs.agentProfileId
  }

  private func applyPreferredProvider(_ preferredId: String?, agentProfileId: String?) {
    guard let preferredId, case let .loaded(items) = providers else { return }
    let preferred = items.first(where: { $0.id == preferredId && $0.agentProfileId == agentProfileId })
    guard let preferred else {
      // Never resume under another Provider or profile when the preferred
      // identity is unavailable.
      chosenProvider = nil
      chosenModelId = nil
      chosenEffort = nil
      restoredControlErrors = [:]
      permissionMode = "default"
      return
    }
    guard chosenProvider.map({ !Self.sameProviderContext($0, preferred) }) ?? true else { return }
    chooseProvider(preferred)
  }

  // Rehydrate a recovered run's original routing without selecting a nearby
  // provider/profile or silently changing its controls. Metadata loaders call
  // this after their authoritative lists arrive; unavailable values stay
  // visibly unavailable and keep submission gated.
  @discardableResult
  func restoreActiveContext() -> Bool {
    guard contextNeedsRestore, let routing = activeRouting else { return false }
    // The host still authorizes the canonical path at submit. This only restores
    // a previously granted descendant for presentation, not a new grant.
    if case let .loaded(projects) = projects {
      chosen = projects.contains(where: { routing.cwd == $0.path || routing.cwd.hasPrefix($0.path + "/") })
        ? .init(path: routing.cwd, label: URL(fileURLWithPath: routing.cwd).lastPathComponent) : nil
    } else if case .empty = projects { chosen = nil }
    if case let .loaded(providers) = providers {
      chosenProvider = providers.first(where: {
        $0.id == routing.providerId && $0.agentProfileId == routing.agentProfileId
      })
      restoredControlErrors = [:]
      guard let provider = chosenProvider else {
        chosenModelId = nil
        chosenEffort = nil
        permissionMode = "default"
        return false
      }
      if let modelId = routing.modelId {
        if let model = (provider.models ?? []).first(where: { $0.id == modelId && $0.providerId == routing.modelProviderId }) {
          chosenModelId = model.selectionId
        } else {
          chosenModelId = nil
          restoredControlErrors[.model] = "恢复的 Model 当前不可用，已阻止静默替换"
        }
      } else {
        chosenModelId = nil
      }
      if let effort = routing.effort {
        if (provider.models?.first(where: { $0.selectionId == chosenModelId })?.efforts ?? provider.efforts ?? []).contains(where: { $0.id == effort }) {
          chosenEffort = effort
        } else {
          chosenEffort = nil
          restoredControlErrors[.effort] = "恢复的推理强度当前不可用，已阻止静默替换"
        }
      } else {
        chosenEffort = nil
      }
      if let permission = routing.permissionMode {
        if provider.permissions?.contains(where: { $0.id == permission }) == true || (provider.permissions == nil && permission == "default") {
          permissionMode = permission
        } else {
          permissionMode = permission
          restoredControlErrors[.permission] = "恢复的权限模式当前不可用，已阻止静默替换"
        }
      } else {
        permissionMode = "default"
      }
      if chosen != nil, commands == .idle {
        loadCommands(providerId: routing.providerId, cwd: routing.cwd,
                     agentProfileId: routing.agentProfileId)
      }
      if chosen != nil && restoredControlsError == nil {
        contextNeedsRestore = false
        return true
      }
      return false
    }
    chosenProvider = nil
    chosenModelId = nil
    chosenEffort = nil
    return false
  }

  func loadActiveContext() {
    guard contextNeedsRestore, let routing = activeRouting else { return }
    loadProjects()
    loadProviders(preferredId: routing.providerId, preferredAgentProfileId: routing.agentProfileId)
    restoreActiveContext()
  }

  func loadCommands(providerId: String, cwd: String, agentProfileId: String? = nil, force: Bool = false) {
    #if DEBUG
    if mockMode { return }
    #endif
    let key = providerId + "\u{1f}" + (agentProfileId ?? "") + "\u{1f}" + cwd
    commandsRequestGeneration += 1
    let requestGeneration = commandsRequestGeneration
    commandsTask?.cancel()
    commandsTask = nil
    if !force, let cached = commandCache[key] {
      commands = cached.commands.isEmpty ? .empty(cached.reason) : .loaded(cached.commands)
      return
    }
    guard let client = makeClient() else { commands = .failed("尚未配对"); return }
    commands = .loading
    let requestDataGeneration = dataGeneration
    commandsTask = Task { [weak self] in
      do {
        let catalog = try await client.commands(providerId: providerId, cwd: cwd, agentProfileId: agentProfileId)
        await MainActor.run {
          guard let self, self.dataGeneration == requestDataGeneration,
                self.commandsRequestGeneration == requestGeneration else { return }
          self.commandsTask = nil
          self.reachable = true
          self.commandCache[key] = catalog
          self.commands = catalog.commands.isEmpty ? .empty(catalog.reason) : .loaded(catalog.commands)
        }
      } catch {
        await MainActor.run {
          guard let self, self.dataGeneration == requestDataGeneration,
                self.commandsRequestGeneration == requestGeneration else { return }
          self.commandsTask = nil
          self.commands = .failed(Self.describe(error))
        }
      }
    }
  }

  var slashCommands: [G0Transport.RunCommandRef] {
    if case let .loaded(items) = commands { return items }
    return []
  }

  var slashCommandsLoading: Bool {
    if case .loading = commands { return true }
    return false
  }

  var slashCommandsReason: String? {
    switch commands {
    case let .empty(reason): return reason
    case let .failed(reason): return reason
    default: return nil
    }
  }

  // Load the host-authorized project directories. The phone can never authorize
  // a new one; it only chooses among these, and the host re-checks on submit.
  func loadProjects(force: Bool = false) {
    #if DEBUG
    if mockMode { return }
    #endif
    let hasCachedValue: Bool
    switch projects { case .loaded, .empty: hasCachedValue = true; default: hasCachedValue = false }
    if !force, hasCachedValue, isFresh(projectsLoadedAt, within: Self.metadataFreshness) { return }
    guard projectsTask == nil else { return }
    guard let client = makeClient() else {
      if !hasCachedValue { projects = .failed("尚未配对，无法读取项目") }
      return
    }
    if !hasCachedValue { projects = .loading }
    let requestDataGeneration = dataGeneration
    projectsTask = Task { [weak self] in
      do {
        let list = try await client.projects()
        await MainActor.run {
          guard let self, self.dataGeneration == requestDataGeneration else { return }
          self.projectsTask = nil
          self.reachable = true
          self.projectsLoadedAt = Date()
          self.projects = list.isEmpty ? .empty : .loaded(list)
          _ = self.restoreActiveContext()
        }
      } catch {
        await MainActor.run {
          guard let self, self.dataGeneration == requestDataGeneration else { return }
          self.projectsTask = nil
          self.reachable = false
          if !hasCachedValue { self.projects = .failed(Self.describe(error)) }
        }
      }
    }
  }

  // Browse exactly one hierarchy level. A nil path requests authorized roots;
  // the host rejects every path outside those roots before reading the folder.
  func loadDirectories(path: String? = nil) {
    #if DEBUG
    if mockMode { loadMockDirectories(path: path); return }
    #endif
    guard let client = makeClient() else { directories = .failed("尚未配对，无法读取文件夹"); return }
    directoriesRequestGeneration += 1
    let directoriesRequest = directoriesRequestGeneration
    directoriesTask?.cancel()
    directories = .loading
    let requestGeneration = generation
    directoriesTask = Task { [weak self] in
      do {
        let listing = try await client.directories(path: path)
        await MainActor.run {
          guard let self, self.generation == requestGeneration,
                self.directoriesRequestGeneration == directoriesRequest else { return }
          self.directoriesTask = nil
          self.reachable = true; self.directories = .loaded(listing)
        }
      } catch {
        await MainActor.run {
          guard let self, self.generation == requestGeneration,
                self.directoriesRequestGeneration == directoriesRequest else { return }
          self.directoriesTask = nil
          self.reachable = false; self.directories = .failed(Self.describe(error))
        }
      }
    }
  }

  // Submit a durable intent. Until a receipt arrives the state is explicitly
  // submitting; a transport-unknown result keeps the same intentId available
  // for a user retry, rather than creating a second host run.
  @discardableResult
  func submit(prompt: String, providerId: String, attachments: [RemoteRunClient.Attachment] = []) -> Bool {
    let trimmed = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return false }
    guard !hasUnresolvedRun else {
      submitError = "当前任务仍在观察或提交核对中，请先返回并继续该任务"
      return false
    }
    guard let cwd = chosen?.path else { submitError = "请先选择一个主机已授权的项目"; return false }
    guard let provider = chosenProvider, provider.id == providerId, controlsReady else {
      submitError = "当前 Provider 控件不可用，已阻止身份或权限切换"
      return false
    }
    #if DEBUG
    if mockMode { applyMockRun(prompt: trimmed, attachments: attachments); return true }
    #endif
    guard makeClient() != nil else { submitError = "尚未配对"; return false }
    let identity = SessionIdentity.new(providerId: providerId, cwd: cwd)
    guard resetRun() else { return false }
    activeSessionIdentity = identity
    self.prompt = trimmed
    sentAttachments = attachments.map { SentAttachment(name: $0.name, kind: $0.kind, size: $0.size) }
    let routing = RemoteRunClient.Routing(cwd: cwd, providerId: providerId,
                                          agentProfileId: chosenProvider?.agentProfileId, prompt: trimmed,
                                          modelId: chosenModel?.id, modelProviderId: chosenModel?.providerId,
                                          effort: chosenEffort, permissionMode: permissionMode,
                                          attachments: attachments)
    activeRouting = routing
    pendingSubmission = PendingSubmission(intentId: UUID().uuidString.lowercased(), routing: routing, identity: identity)
    terminalDrainCompleted = false
    lifecycle = .submitting
    submitPending()
    return true
  }

  // Retry only the unresolved submission. The intent id and routing are kept
  // byte-for-byte stable so a late first receipt is an idempotent duplicate.
  func retrySubmission() {
    guard pendingSubmission != nil, lifecycle == .submitting else { return }
    submitError = "正在重新核对提交结果…"
    submitPending()
  }

  private func submitPending() {
    guard let pending = pendingSubmission, let client = makeClient() else { return }
    guard saveRecoveryCheckpoint(intentId: pending.intentId, routing: pending.routing,
                                 identity: pending.identity, runId: nil) else {
      retryAvailable = true
      return
    }
    submitTask?.cancel()
    let requestGeneration = generation
    submitTask = Task { [weak self] in
      do {
        let outcome = try await client.submit(routing: pending.routing, intentId: pending.intentId)
        await MainActor.run {
          guard let self, self.isCurrent(requestGeneration, identity: pending.identity) else { return }
          self.reachable = true
          self.runId = outcome.runId
          self.terminalDrainCompleted = false
          let saved = self.saveRecoveryCheckpoint(intentId: pending.intentId, routing: pending.routing,
                                                   identity: pending.identity, runId: outcome.runId)
          self.pendingSubmission = nil
          self.retryAvailable = false
          if saved { self.submitError = nil }
          self.lifecycle = .recorded
          self.startPolling(runId: outcome.runId, client: client, generation: requestGeneration, identity: pending.identity)
        }
      } catch {
        await MainActor.run {
          guard let self, self.isCurrent(requestGeneration, identity: pending.identity) else { return }
          self.reachable = false
          self.lifecycle = .submitting
          self.retryAvailable = true
          self.submitError = "提交结果未知：\(Self.describe(error))。请重试核对，不会创建新的任务。"
        }
      }
    }
  }

  private func startPolling(runId: String, client: RemoteRunClient, generation: Int,
                            identity: SessionIdentity) {
    pollTask?.cancel()
    pollTask = Task { [weak self] in
      guard let self else { return }
      var ledgerCursor = 0
      var outputCursor = 0
      // Compacted ledgers may no longer retain the event that established an
      // older recovered run's current lifecycle. Reconcile the authoritative
      // run projection once, then continue from the server's resettable tail.
      if let state = try? await client.runState(runId: runId) {
        self.apply(runState: state, generation: generation, identity: identity)
      }
      while !Task.isCancelled {
        do {
          let page = try await client.poll(cursor: ledgerCursor)
          ledgerCursor = page.cursor
          for ev in page.events where ev.runId == runId {
            self.apply(event: ev, generation: generation, identity: identity)
          }
          let questions = try await client.questions(runId: runId)
          guard self.isCurrent(generation, identity: identity) else { return }
          if self.pendingQuestions.first?.questionId != questions.first?.questionId {
            self.pendingQuestionAnswerId = nil
            self.questionAnswering = false
            self.questionError = nil
          }
          self.pendingQuestions = questions
          let out = try await client.output(runId: runId, cursor: outputCursor)
          outputCursor = out.cursor
          for chunk in out.chunks {
            self.append(chunk: chunk, generation: generation, identity: identity)
          }
          await MainActor.run { [weak self] in
            guard let self, self.isCurrent(generation, identity: identity) else { return }
            self.reachable = true
            self.observationInterrupted = false
          }
        } catch {
          // An observation failure is not a Provider terminal state. Stop here
          // and say exactly that, so a stale/unknown result cannot look settled.
          await MainActor.run {
            guard self.isCurrent(generation, identity: identity) else { return }
            self.reachable = false
            self.observationInterrupted = true
            self.submitError = "观察中断：\(Self.describe(error))。运行结果未知。"
            self.pollTask = nil
          }
          return
        }
        if self.isTerminal(generation: generation, identity: identity) {
          let drained = await self.drainOutput(client: client, runId: runId, cursor: outputCursor,
                                               generation: generation, identity: identity)
          await MainActor.run {
            guard self.isCurrent(generation, identity: identity) else { return }
            if drained {
              self.archiveActiveTurnIfNeeded()
              self.clearRecoveryCheckpoint()
              self.terminalDrainCompleted = true
            }
            self.pollTask = nil
          }
          return
        }
        try? await Task.sleep(nanoseconds: 800_000_000)
      }
    }
  }

  private func resumeObservation(runId: String) {
    guard let identity = activeSessionIdentity, let client = makeClient() else { return }
    observationInterrupted = false
    terminalDrainCompleted = false
    submitError = nil
    startPolling(runId: runId, client: client, generation: generation, identity: identity)
  }

  func answerPendingQuestion(answers: [String: String], cancel: Bool = false) {
    #if DEBUG
    if mockMode {
      pendingQuestions = []
      return
    }
    #endif
    guard !questionAnswering, let request = pendingQuestions.first, let runId,
          let identity = activeSessionIdentity, let client = makeClient() else { return }
    let answerId = pendingQuestionAnswerId ?? UUID().uuidString.lowercased()
    pendingQuestionAnswerId = answerId
    questionAnswering = true
    questionError = nil
    let requestGeneration = generation
    Task { [weak self] in
      do {
        let response = G0Transport.RunQuestionResponse(
          runId: runId, questionId: request.questionId,
          behavior: cancel ? "cancelled" : "answered",
          answers: cancel ? nil : answers
        )
        _ = try await client.answerQuestion(runId: runId, answerId: answerId, response: response)
        await MainActor.run {
          guard let self, self.isCurrent(requestGeneration, identity: identity),
                self.pendingQuestions.first?.questionId == request.questionId else { return }
          self.pendingQuestions.removeFirst()
          self.pendingQuestionAnswerId = nil
          self.questionAnswering = false
          self.questionError = nil
        }
      } catch {
        await MainActor.run {
          guard let self, self.isCurrent(requestGeneration, identity: identity),
                self.pendingQuestions.first?.questionId == request.questionId else { return }
          self.questionAnswering = false
          self.questionError = "回答结果未知：\(Self.describe(error))。再次提交会复用同一回答标识。"
        }
      }
    }
  }

  func retryObservation() {
    guard observationInterrupted, let runId else { return }
    resumeObservation(runId: runId)
  }

  // Resume a known host run after a view rebuild. The caller supplies the
  // session identity obtained from the host catalog, so a run id from another
  // session cannot attach to the current transcript.
  func resumeObservation(runId: String, providerId: String, cwd: String, externalSessionId: String) {
    let identity = SessionIdentity.opened(providerId: providerId, cwd: cwd, externalSessionId: externalSessionId)
    if activeSessionIdentity != identity {
      guard resetRun() else { return }
      activeSessionIdentity = identity
    }
    self.runId = runId
    terminalDrainCompleted = false
    if lifecycle == .unknown { lifecycle = .recorded }
    _ = saveRecoveryCheckpoint(intentId: nil, routing: activeRouting, identity: identity, runId: runId)
    resumeObservation(runId: runId)
  }

  private func drainOutput(client: RemoteRunClient, runId: String, cursor: Int,
                          generation: Int, identity: SessionIdentity) async -> Bool {
    var cursor = cursor
    while !Task.isCancelled {
      guard let page = try? await client.output(runId: runId, cursor: cursor) else {
        await MainActor.run {
          guard self.isCurrent(generation, identity: identity) else { return }
          self.observationInterrupted = true
          self.submitError = "观察中断：无法读取运行的最后输出，运行结果未知。"
        }
        return false
      }
      let next = page.cursor
      for chunk in page.chunks {
        append(chunk: chunk, generation: generation, identity: identity)
      }
      // The host's cursor is authoritative. Stop only when the page is empty or
      // did not advance; this drains arbitrarily many pages, including >400 chunks.
      if !Self.shouldContinueDrain(cursor: cursor, next: next, chunkCount: page.chunks.count) { return true }
      cursor = next
    }
    return false
  }

  nonisolated private static func responseMatches(currentGeneration: Int, requestGeneration: Int,
                                                   currentIdentity: SessionIdentity?, requestIdentity: SessionIdentity) -> Bool {
    currentGeneration == requestGeneration && currentIdentity == requestIdentity
  }

  nonisolated private static func shouldContinueDrain(cursor: Int, next: Int, chunkCount: Int) -> Bool {
    chunkCount > 0 && next > cursor
  }

  nonisolated private static func shouldIncludeCompletedTurn(_ turnId: String, currentRunId: String?, archived: Bool) -> Bool {
    !(archived && currentRunId == turnId)
  }

  nonisolated private static func unresolvedState(pending: Bool, runId: String?, drained: Bool,
                                                   interrupted: Bool) -> Bool {
    pending || (runId != nil && (!drained || interrupted))
  }

  nonisolated private static func followUpIdentity(current: SessionIdentity?, providerId: String,
                                                    cwd: String, originalResume: String) -> SessionIdentity {
    current.flatMap { identity in
      identity.providerId == providerId && identity.cwd == cwd ? identity : nil
    } ?? SessionIdentity.opened(providerId: providerId, cwd: cwd, externalSessionId: originalResume)
  }

  private func isCurrent(_ requestGeneration: Int, identity: SessionIdentity) -> Bool {
    Self.responseMatches(currentGeneration: generation, requestGeneration: requestGeneration,
                         currentIdentity: activeSessionIdentity, requestIdentity: identity)
  }

  private func isTerminal(generation: Int, identity: SessionIdentity) -> Bool {
    isCurrent(generation, identity: identity) &&
      (lifecycle == .settled || lifecycle == .failed || lifecycle == .cancelled)
  }

  private func apply(runState state: String, generation: Int, identity: SessionIdentity) {
    guard isCurrent(generation, identity: identity) else { return }
    switch state {
    case "recorded": if lifecycle == .unknown || lifecycle == .submitting { lifecycle = .recorded }
    case "dispatched": if lifecycle != .running { lifecycle = .dispatched }
    case "settled": lifecycle = .settled
    case "failed": lifecycle = .failed
    case "cancelled": lifecycle = .cancelled
    default: break
    }
  }

  private func apply(event ev: G0Transport.RunLedgerEvent, generation: Int, identity: SessionIdentity) {
    guard isCurrent(generation, identity: identity) else { return }
    switch ev.kind {
    case "intent_recorded": if lifecycle == .unknown { lifecycle = .recorded }
    case "run_dispatched": if lifecycle == .recorded || lifecycle == .unknown { lifecycle = .dispatched }
    case "run_progress":
      // Honest lifecycle markers only. 'started' promotes to running; 'result'
      // carries Provider-canonical usage we surface verbatim (never synthesized).
      if let detail = ev.detail, let marker = Self.marker(detail) {
        if marker["event"] == "started", lifecycle == .dispatched || lifecycle == .recorded { lifecycle = .running }
        if marker["event"] == "result" { resultSummary = Self.resultLine(marker) }
        if marker["event"] == "settled", let status = marker["status"],
           status == "cancelled" || status == "interrupted" || status == "stopped" {
          lifecycle = .cancelled
        }
        // The Provider's own session id for THIS run. Captured so a chained
        // follow-up resumes the latest session (continuous memory), not a stale id.
        if marker["event"] == "session", let ext = marker["externalSessionId"], !ext.isEmpty { liveExternalSessionId = ext }
      }
    case "run_settled": if lifecycle != .cancelled { lifecycle = .settled }
    case "run_failed": lifecycle = .failed; if let d = ev.detail, submitError == nil { submitError = "主机报告失败：\(d)" }
    case "run_cancelled": lifecycle = .cancelled
    default: break
    }
  }

  private func append(chunk: G0Transport.RunOutputChunk, generation: Int, identity: SessionIdentity) {
    guard isCurrent(generation, identity: identity) else { return }
    if chunk.kind == "truncated" { truncated = true; return }
    // Coalescing replaces the visible row id with the newest seq, so the array
    // alone cannot remember every consumed chunk. Keep an explicit cursor set;
    // observation recovery starts from cursor 0 and must not append old deltas
    // a second time before reaching the live tail.
    guard seenOutputSequences.insert(chunk.seq).inserted else { return }
    // Providers stream text/reasoning in small deltas. Keep those deltas as one
    // readable block instead of rendering one SwiftUI Text row per token.
    if let last = output.last, last.kind == chunk.kind,
       chunk.kind == "output" || chunk.kind == "reasoning" {
      output[output.count - 1] = OutputLine(id: chunk.seq, kind: chunk.kind, text: last.text + chunk.text)
    } else {
      output.append(OutputLine(id: chunk.seq, kind: chunk.kind, text: chunk.text))
    }
  }

  @discardableResult
  func resetRun() -> Bool {
    guard !hasUnresolvedRun else {
      submitError = "当前任务仍未完成观察或提交核对，已保留原运行"
      return false
    }
    archiveActiveTurnIfNeeded()
    prefetchTask?.cancel()
    generation += 1
    pollTask?.cancel(); pollTask = nil
    submitTask?.cancel(); submitTask = nil
    historyTask?.cancel(); historyTask = nil
    pendingSubmission = nil
    activeRouting = nil
    clearRecoveryCheckpoint()
    lifecycle = .unknown
    output = []
    seenOutputSequences = []
    prompt = nil
    sentAttachments = []
    runId = nil
    truncated = false
    resultSummary = nil
    submitError = nil
    liveExternalSessionId = nil
    observationInterrupted = false
    terminalDrainCompleted = false
    retryAvailable = false
    pendingQuestions = []
    pendingQuestionAnswerId = nil
    questionAnswering = false
    questionError = nil
    archivedActiveTurn = false
    restoredControlErrors = [:]
    contextNeedsRestore = false
    return true
  }

  private func archiveActiveTurnIfNeeded() {
    guard !archivedActiveTurn, let identity = activeSessionIdentity,
          let prompt, !prompt.isEmpty, isTerminal(generation: generation, identity: identity) else { return }
    let turn = CompletedLiveTurn(id: runId ?? UUID().uuidString.lowercased(), runId: runId,
      prompt: prompt, attachments: sentAttachments, lifecycle: lifecycle, output: output,
      resultSummary: resultSummary, externalSessionId: liveExternalSessionId)
    completedLiveTurns[identity, default: []].append(turn)
    archivedActiveTurn = true
  }

  // Used by destructive unpair. It invalidates every outstanding request before
  // releasing the visible state, so old history/poll callbacks cannot reappear.
  func clearAllState() {
    generation += 1
    dataGeneration += 1
    pollTask?.cancel(); pollTask = nil
    submitTask?.cancel(); submitTask = nil
    catalogTask?.cancel(); catalogTask = nil
    prefetchGeneration += 1
    prefetchTask?.cancel(); prefetchTask = nil; warmedScreens.removeAll()
    historyTask?.cancel(); historyTask = nil
    providersTask?.cancel(); providersTask = nil
    commandsTask?.cancel(); commandsTask = nil
    projectsTask?.cancel(); projectsTask = nil
    directoriesTask?.cancel(); directoriesTask = nil
    pendingSubmission = nil
    activeRouting = nil
    clearRecoveryCheckpoint()
    projects = .idle; directories = .idle; chosen = nil
    providers = .idle; commands = .idle; chosenProvider = nil; chosenModelId = nil; chosenEffort = nil; permissionMode = "default"
    catalog = .idle; history = .idle; historyPreview = .idle; historyPreviewKey = nil; reachable = nil
    catalogLoadedAt = nil; providersLoadedAt = nil; projectsLoadedAt = nil; commandCache = [:]; cachedHistory = nil
    historyRequestGeneration += 1
    historySyncing = false; historyFromCache = false; historyFetchedAt = nil
    historyProgress = nil; historyRefreshError = nil; historyStorageNotice = nil
    lifecycle = .unknown; output = []; seenOutputSequences = []; prompt = nil; sentAttachments = []
    runId = nil; submitError = nil; truncated = false; resultSummary = nil
    liveExternalSessionId = nil; activeSessionIdentity = nil
    observationInterrupted = false; terminalDrainCompleted = false; retryAvailable = false
    pendingQuestions = []; pendingQuestionAnswerId = nil; questionAnswering = false; questionError = nil
    completedLiveTurns = [:]
    archivedActiveTurn = false
    restoredControlErrors = [:]
    contextNeedsRestore = false
    #if DEBUG
    mockMode = false
    #endif
  }

  // Send a follow-up that CONTINUES an opened session (same Provider + cwd +
  // session id) so the conversation keeps its context. Unlike submit(), the
  // target is explicit (from the opened session), not the new-session pickers.
  // Chained follow-ups resume the LATEST reported session id when available.
  @discardableResult
  func submitFollowUp(prompt: String, providerId: String, agentProfileId: String? = nil, cwd: String, resume: String, attachments: [RemoteRunClient.Attachment] = []) -> Bool {
    let trimmed = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return false }
    guard !hasUnresolvedRun else {
      submitError = "当前任务仍在观察或提交核对中，请先返回并继续该任务"
      return false
    }
    guard !resume.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
      submitError = "缺少原会话标识，已阻止切换会话继续"
      return false
    }
    #if DEBUG
    if mockMode { applyMockRun(prompt: trimmed, attachments: attachments); liveExternalSessionId = resume; return true }
    #endif
    guard makeClient() != nil else { submitError = "尚未配对"; return false }
    let resumeId = liveExternalSessionId ?? resume
    // The routing resume id may advance after each Provider turn, but the UI
    // identity must remain the originally opened conversation. Otherwise every
    // new native id moves completed turns to a key the current transcript view
    // does not query, making the previous exchange disappear again.
    let identity = Self.followUpIdentity(current: activeSessionIdentity, providerId: providerId,
                                         cwd: cwd, originalResume: resume)
    let matchingProvider = chosenProvider?.id == providerId && chosenProvider?.agentProfileId == agentProfileId ? chosenProvider : nil
    guard let matchingProvider, controlsReady else {
      submitError = agentProfileId == nil ? "当前 Provider 控件不可用" : "原 Agent Profile 当前不可用，已阻止切换身份继续会话"
      return false
    }
    if let active = activeSessionIdentity, (active.providerId != providerId || active.cwd != cwd) {
      submitError = "当前会话身份不匹配，已阻止切换会话继续"
      return false
    }
    let modelId = chosenModel?.id
    let modelProviderId = chosenModel?.providerId
    let effort = chosenEffort
    let permission = permissionMode
    guard resetRun() else { return false }
    activeSessionIdentity = identity
    self.prompt = trimmed
    sentAttachments = attachments.map { SentAttachment(name: $0.name, kind: $0.kind, size: $0.size) }
    liveExternalSessionId = resumeId
    let routing = RemoteRunClient.Routing(cwd: cwd, providerId: providerId,
                                          agentProfileId: matchingProvider.agentProfileId, prompt: trimmed,
                                          modelId: modelId, modelProviderId: modelProviderId,
                                          effort: effort, permissionMode: permission,
                                          resume: resumeId, attachments: attachments)
    activeRouting = routing
    pendingSubmission = PendingSubmission(intentId: UUID().uuidString.lowercased(), routing: routing, identity: identity)
    terminalDrainCompleted = false
    lifecycle = .submitting
    submitPending()
    return true
  }

  #if DEBUG
  // Pure checks used by the launch self-test; they exercise the invariants that
  // do not require a relay or Provider.
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
    let store = RemoteRunStore(connections: connections, historyDisk: disk)
    store.historyTestOffline = true
    store.commands = .loaded([.init(name: "old-project", description: "fixture", source: "custom")])
    store.loadHistory(providerId: "pi", cwd: "/fixture", externalSessionId: "session")
    await store.historyTask?.value
    let beforeIdentity = store.activeSessionIdentity
    store.prefetchHistory([.init(sessionId: "fixture", externalSessionId: "session", providerId: "pi", cwd: "/fixture", label: "fixture", ts: 1)])
    await store.prefetchTask?.value
    var checks: [(String, Bool)] = [
      ("store.sessionSwitchDropsOldCommands", store.slashCommands.isEmpty),
      ("store.warmingDoesNotSwitchSession", store.activeSessionIdentity == beforeIdentity && store.prompt == nil),
      ("store.warmingUsesBoundedMirror", store.warmedScreens[key]?.available == true && ((try? JSONEncoder().encode(store.warmedScreens[key]).count) ?? Int.max) <= 16 * 1024),
      ("store.offlineKeepsDiskHistory", store.history == .loaded(snapshot.turns) && store.historyFromCache && store.reachable == false),
      ("store.offlineUpdateErrorVisible", store.historyRefreshError != nil)
    ]
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
    checks.append(("store.protocolFailureNotOffline", mirrorStore.reachable == true))
    checks.append(("store.protocolFailureActionable", mirrorStore.historyRefreshError?.contains("重新打开") == true))
    let reopened = RemoteRunStore(connections: connections, historyDisk: disk)
    reopened.historyTestOffline = true
    reopened.loadHistory(providerId: "pi", cwd: "/fixture", externalSessionId: "preview-only")
    await reopened.historyTask?.value
    checks.append(("store.restartReadsSmallMirror", reopened.historyPreviewTurns == mirrorStore.historyPreviewTurns && reopened.historyFromCache))
    reopened.loadHistory(providerId: "pi", cwd: "/fixture", externalSessionId: "different-session", force: true)
    await reopened.historyTask?.value
    checks.append(("store.mirrorDoesNotCrossSessions", reopened.historyPreviewTurns.isEmpty))
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

  static func selfTestInteractionState() -> [(String, Bool)] {
    // -selfTest skips restoring disk state; mockMode prevents any checkpoint
    // deletion. Exercise the real admission and projection methods in memory.
    let store = RemoteRunStore()
    store.mockMode = true
    var checks: [(String, Bool)] = []
    let identity = SessionIdentity.new(providerId: "codex", cwd: "/fixture")
    let routing = RemoteRunClient.Routing(cwd: "/fixture", providerId: "codex", agentProfileId: nil, prompt: "same prompt")
    store.activeSessionIdentity = identity
    store.pendingSubmission = PendingSubmission(intentId: "keep-this-intent", routing: routing, identity: identity)
    store.lifecycle = .submitting
    checks.append(("pending.resetRejected", !store.resetRun() && store.pendingSubmission?.intentId == "keep-this-intent"))
    checks.append(("pending.submitRejected", !store.submit(prompt: "next", providerId: "codex") && store.pendingSubmission?.intentId == "keep-this-intent"))
    store.pendingSubmission = nil
    store.runId = "first"; store.prompt = "same prompt"; store.lifecycle = .settled
    checks.append(("drain.blocksReset", !store.resetRun()))
    store.terminalDrainCompleted = true
    store.output = [.init(id: 1, kind: "output", text: "tail")]
    store.archiveActiveTurnIfNeeded()
    checks.append(("completed.noDuplicate", store.completedTurns(for: identity).isEmpty))
    checks.append(("completed.resetAccepted", store.resetRun()))
    checks.append(("completed.tailRetained", store.completedTurns(for: identity).first?.output.last?.text == "tail"))
    store.runId = "second"; store.prompt = "same prompt"; store.lifecycle = .settled
    store.terminalDrainCompleted = true; store.archiveActiveTurnIfNeeded(); _ = store.resetRun()
    checks.append(("completed.repeatedPromptPreserved", store.completedTurns(for: identity).count == 2))
    store.chosenProvider = .init(id: "codex", label: "Codex", available: true, modelId: nil,
      permissions: [.init(id: "default", label: "Default", description: "Ask")])
    store.restoredControlErrors[.model] = "missing"
    store.choosePermission("default")
    checks.append(("recovery.permissionCannotReplaceModel", !store.controlsReady))
    store.chooseEffort(nil)
    checks.append(("recovery.effortCannotReplaceModel", !store.controlsReady))
    store.chooseModel(nil)
    checks.append(("recovery.explicitModelChoice", store.controlsReady))
    return checks
  }

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

  // Visual-only fixtures for `-uiPreview -uiMockData`. They deliberately never
  // touch Keychain, relay, Provider, ledger, or Release execution paths.
  func applyUIPreviewArguments() {
    guard ProcessInfo.processInfo.arguments.contains("-uiPreview"),
          ProcessInfo.processInfo.arguments.contains("-uiMockData") else { return }
    mockMode = true
    reachable = true

    let roots = [
      G0Transport.RunProjectRef(path: "/Users/demo/Projects/scry", label: "scry"),
      G0Transport.RunProjectRef(path: "/Users/demo/Projects/rate-native", label: "rate-native"),
      G0Transport.RunProjectRef(path: "/Users/demo/Work/atlas-web", label: "atlas-web")
    ]
    projects = .loaded(roots)
    chosen = G0Transport.RunProjectRef(path: "/Users/demo/Projects/scry/apps/ios", label: "ios")

    let efforts = [
      G0Transport.RunControlOption(id: "low", label: "低", description: "更快响应", isDefault: true),
      G0Transport.RunControlOption(id: "medium", label: "中", description: "平衡速度与推理"),
      G0Transport.RunControlOption(id: "high", label: "高", description: "更深入推理"),
      G0Transport.RunControlOption(id: "xhigh", label: "极高", description: "复杂任务")
    ]
    let permissions = [
      G0Transport.RunControlOption(id: "default", label: "默认审批", description: "危险操作前询问", isDefault: true),
      G0Transport.RunControlOption(id: "auto_review", label: "自动审查", description: "按策略自动处理"),
      G0Transport.RunControlOption(id: "full_access", label: "完全访问", description: "仅由设备所有者显式选择")
    ]
    let availableProviders = [
      G0Transport.RunProviderRef(id: "codex", label: "Codex", available: true, modelId: "gpt-5.6-sol",
        models: [G0Transport.RunModelOption(id: "gpt-5.6-sol", label: "GPT-5.6", isDefault: true, efforts: efforts)],
        efforts: efforts, permissions: permissions),
      G0Transport.RunProviderRef(id: "pi", label: "Pi · Rotom", available: true, agentProfileId: "pi:rotom",
        modelId: "gpt-6-astra", models: [
          G0Transport.RunModelOption(id: "gpt-6-astra", providerId: "openai", label: "GPT-6 Astra", isDefault: true, efforts: efforts),
          G0Transport.RunModelOption(id: "claude-opus", providerId: "anthropic", label: "Claude Opus", efforts: efforts)
        ], efforts: efforts, permissions: permissions),
      G0Transport.RunProviderRef(id: "qoder", label: "Qoder", available: true, modelId: "ultimate",
        models: [G0Transport.RunModelOption(id: "ultimate", label: "Ultimate", isDefault: true)], permissions: permissions),
      G0Transport.RunProviderRef(id: "opencode", label: "OpenCode", available: true, modelId: nil,
        models: [], permissions: [permissions[0], permissions[2]])
    ]
    providers = .loaded(availableProviders)
    chooseProvider(availableProviders[0])
    commands = .loaded([
      .init(name: "review", description: "审查当前改动", argumentHint: "[范围]", source: "builtin"),
      .init(name: "compact", description: "压缩当前会话上下文", source: "builtin"),
      .init(name: "rate-workflow", description: "运行项目工作流", argumentHint: "<任务>", source: "custom")
    ])

    let now = Date().timeIntervalSince1970 * 1_000
    catalog = .loaded([
      G0Transport.RunSessionRef(sessionId: "mock-pinned-1", externalSessionId: "codex-pinned-1", providerId: "codex", cwd: roots[0].path,
        label: "重构远程会话列表并统一信息层级", ts: now - 8 * 60_000, pinnedAt: now - 60_000),
      G0Transport.RunSessionRef(sessionId: "mock-pinned-2", externalSessionId: "qoder-pinned-2", providerId: "qoder", cwd: roots[1].path,
        label: "排查支付页偶发白屏与恢复流程", ts: now - 36 * 60_000, pinnedAt: now - 120_000),
      G0Transport.RunSessionRef(sessionId: "mock-scry-1", externalSessionId: "codex-scry-1", providerId: "codex", cwd: roots[0].path,
        label: "完成 iOS 工作目录选择器和附件发送", ts: now - 2 * 3_600_000),
      G0Transport.RunSessionRef(sessionId: "mock-scry-2", externalSessionId: "qoder-scry-2", providerId: "qoder", cwd: roots[0].path,
        label: "修复手机续聊在 Mac 端不可见的问题", ts: now - 5 * 3_600_000),
      G0Transport.RunSessionRef(sessionId: "mock-scry-running", providerId: "codex", cwd: roots[0].path,
        label: "正在分析大规模测试失败…", ts: now - 4 * 60_000),
      G0Transport.RunSessionRef(sessionId: "mock-rate-1", externalSessionId: "codex-rate-1", providerId: "codex", cwd: roots[1].path,
        label: "优化首页滚动性能并补充回归测试", ts: now - 24 * 3_600_000),
      G0Transport.RunSessionRef(sessionId: "mock-atlas-1", externalSessionId: "opencode-atlas-1", providerId: "opencode", cwd: roots[2].path,
        label: "实现登录错误态与离线重试体验", ts: now - 3 * 86_400_000)
    ])

    history = .loaded([
      G0Transport.RunHistoryTurn(userText: "请检查 iOS 远程首页的信息层级，并给出可以直接落地的修改。", items: [
        G0Transport.RunHistoryChunk(kind: "reasoning", text: "我会先检查会话分组、状态信息和底部操作区。"),
        G0Transport.RunHistoryChunk(kind: "tool", text: "读取 HomeView.swift"),
        G0Transport.RunHistoryChunk(kind: "tool_result", text: "1  # HomeView.swift\n2  会话列表与项目分组\n3  搜索、新建与运行状态\n4  Provider 元信息\n5  连接状态与时间语境\n6  底部 Composer 控制\n7  无文件修改\n8  共读取 281 行"),
        G0Transport.RunHistoryChunk(kind: "output", text: "发现 **三个主要问题**：项目与会话的视觉层级接近、运行状态缺少时间语境、底部搜索和新建操作抢占了过多空间。建议先压缩标题区，再把 `Provider` 与时间放入会话元信息。")
      ]),
      G0Transport.RunHistoryTurn(userText: "按 Codex Refined 的方向继续，先不要加入底栏。", items: [
        G0Transport.RunHistoryChunk(kind: "output", text: "已保留无底栏结构，并将导航、内容与证据层分开。下一步可以重点比较列表密度和 Composer 的控制层级。")
      ])
    ])

    runId = "mock-run-visual-only"
    prompt = "把首页改成更紧凑的项目分组，同时保留真实运行证据。"
    sentAttachments = [
      SentAttachment(name: "home-reference.png", kind: .image, size: 184_320),
      SentAttachment(name: "notes.md", kind: .text, size: 4_812)
    ]
    lifecycle = .settled
    terminalDrainCompleted = true
    output = [
      OutputLine(id: 1, kind: "reasoning", text: "先对齐信息架构，再调整视觉密度。"),
      OutputLine(id: 2, kind: "tool", text: "编辑 HomeView.swift"),
      OutputLine(id: 3, kind: "tool_result", text: "3 个区块已更新 · 0 个错误"),
      OutputLine(id: 4, kind: "output", text: "## 已完成\n\n首页已按 **置顶 + 项目** 重新组织，并保留 [运行证据](https://example.com/evidence)。\n\n- 会话标题成为主信息\n- `Provider`、更新时间和状态降为轻量元信息\n- 底部仅保留搜索与新建入口\n\n```swift\nLazyVStack(spacing: 12) {\n  sessionRows\n}\n```")
    ]
    resultSummary = "输入 18,420 · 输出 1,286 · $0.084"
    liveExternalSessionId = "codex-mock-session"
    loadMockDirectories(path: chosen?.path)
    activeSessionIdentity = .opened(providerId: "codex", cwd: roots[0].path, externalSessionId: "codex-pinned-1")
    if ProcessInfo.processInfo.arguments.contains("-uiMockFirstScreen") {
      let turns = (1...40).map { index in
        G0Transport.RunHistoryTurn(userText: "模拟历史消息 \(index)", items: [
          .init(kind: "output", text: index == 40 ? "# 历史 Markdown 标题\n\n- 列表项目\n\n```swift\nlet answer = 42\n```\n\n" + String(repeating: "长消息保留完整内容，可按需展开。\n\n", count: 600) + "## 完整内容末尾" : "模拟回复 \(index)")])
      }
      history = ProcessInfo.processInfo.arguments.contains("-uiMockPartialHistory") ? .partial(Array(turns.suffix(2))) : .loaded(turns)
      historyFromCache = true; historyFetchedAt = Date()
      prompt = nil; output = []; runId = nil; resultSummary = nil
      if ProcessInfo.processInfo.arguments.contains("-uiMockPartialHistory"), let identity = activeSessionIdentity {
        completedLiveTurns[identity] = [.init(id: "preview-completed", runId: "preview-completed", prompt: "模拟本机已完成续聊",
          attachments: [], lifecycle: .settled, output: [.init(id: 1, kind: "output", text: "模拟续聊结果必须保留")],
          resultSummary: nil, externalSessionId: "codex-pinned-1")]
      }
    }
    if ProcessInfo.processInfo.arguments.contains("-uiMockContinuousHistory") {
      history = .loaded([
        .init(userText: "最早一轮的用户输入", items: [.init(kind: "output", text: "最早一轮的回复")]),
        .init(userText: "第二轮用户输入", items: [.init(kind: "output", text: "第二轮回复")]),
        .init(userText: "技能和mcp不用检测数量了 点击进入的时候再加载吧 这样可以节省性能", items:
          (1...20).map { .init(kind: "output", text: "本轮第 \($0) 段内容") }),
        .init(userText: String(repeating: "完整用户输入。", count: 90) + "用户输入末尾", items: [
          .init(kind: "output", text: "# 长回复开头\n\n" + String(repeating: "完整回复。", count: 100) +
            "\n\n## 五百字之后的标题\n\n- 列表项目\n\n```swift\nlet answer = 42\n```\n\n## 长回复末尾")
        ])
      ])
      historyFromCache = true; historyFetchedAt = Date()
      prompt = nil; output = []; runId = nil; resultSummary = nil
    }
    if ProcessInfo.processInfo.arguments.contains("-uiMockLoading") {
      history = .loading; prompt = nil; output = []; runId = nil; resultSummary = nil
    }
    if ProcessInfo.processInfo.arguments.contains("-uiMockQuestion") {
      // Explicitly synthetic sheet fixture; it never reaches answerQuestion.
      let fixture = #"{"runId":"fixture-run","questionId":"fixture-question","questionKind":"input","questions":[{"header":"录屏验证 · 模拟请求","question":"输入一段多行说明","options":[],"multiSelect":false,"inputMode":"multiline"}]}"#
      pendingQuestions = [try! JSONDecoder().decode(G0Transport.RunQuestionRequest.self, from: Data(fixture.utf8))]
    }
  }

  private func loadMockDirectories(path: String?) {
    let scry = G0Transport.RunProjectRef(path: "/Users/demo/Projects/scry", label: "scry")
    let ios = G0Transport.RunProjectRef(path: "\(scry.path)/apps/ios", label: "ios")
    switch path {
    case nil:
      directories = .loaded(G0Transport.RunDirectoryListing(directories: [scry,
        G0Transport.RunProjectRef(path: "/Users/demo/Projects/rate-native", label: "rate-native"),
        G0Transport.RunProjectRef(path: "/Users/demo/Work/atlas-web", label: "atlas-web")]))
    case scry.path:
      directories = .loaded(G0Transport.RunDirectoryListing(current: scry, directories: [
        G0Transport.RunProjectRef(path: "\(scry.path)/apps", label: "apps"),
        G0Transport.RunProjectRef(path: "\(scry.path)/docs", label: "docs"),
        G0Transport.RunProjectRef(path: "\(scry.path)/src", label: "src")
      ]))
    case "\(scry.path)/apps":
      directories = .loaded(G0Transport.RunDirectoryListing(
        current: G0Transport.RunProjectRef(path: "\(scry.path)/apps", label: "apps"), parent: scry,
        directories: [ios, G0Transport.RunProjectRef(path: "\(scry.path)/apps/desktop", label: "desktop")]))
    case ios.path:
      directories = .loaded(G0Transport.RunDirectoryListing(current: ios,
        parent: G0Transport.RunProjectRef(path: "\(scry.path)/apps", label: "apps"), directories: [
          G0Transport.RunProjectRef(path: "\(ios.path)/ScryRemote", label: "ScryRemote")
        ]))
    default:
      let current = G0Transport.RunProjectRef(path: path ?? scry.path, label: (path ?? scry.path).split(separator: "/").last.map(String.init) ?? "文件夹")
      directories = .loaded(G0Transport.RunDirectoryListing(current: current, parent: scry, directories: []))
    }
  }

  private func applyMockRun(prompt: String, attachments: [RemoteRunClient.Attachment]) {
    resetRun()
    self.prompt = prompt
    sentAttachments = attachments.map { SentAttachment(name: $0.name, kind: $0.kind, size: $0.size) }
    runId = "mock-run-visual-only"
    lifecycle = .settled
    terminalDrainCompleted = true
    output = [OutputLine(id: 1, kind: "output", text: "这是 DEBUG 视觉预览回复；没有连接 Provider，也没有写入真实 ledger。")]
    resultSummary = "Mock 数据 · 不代表真实用量"
  }
  #endif

  // Cancels only this phone's observation task; it cannot stop the Mac Provider.
  func stopObservation() { pollTask?.cancel(); pollTask = nil }

  // Parse a lifecycle marker JSON object into a flat [String:String]; only the
  // string-valued fields we render are kept, numbers are stringified.
  private static func marker(_ json: String) -> [String: String]? {
    guard let data = json.data(using: .utf8),
          let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
    var out: [String: String] = [:]
    for (k, v) in obj {
      if let s = v as? String { out[k] = s }
      else if let n = v as? NSNumber { out[k] = n.stringValue }
      else if let b = v as? Bool { out[k] = b ? "true" : "false" }
    }
    return out
  }

  private static func resultLine(_ marker: [String: String]) -> String {
    var parts: [String] = []
    if let ti = marker["tokensIn"] { parts.append("输入 \(ti)") }
    if let to = marker["tokensOut"] { parts.append("输出 \(to)") }
    if let cost = marker["costUsd"] { parts.append("$\(cost)") }
    return parts.isEmpty ? "主机报告完成（未提供用量）" : parts.joined(separator: " · ")
  }

  private static func describe(_ error: Error) -> String {
    if let runError = error as? G0Transport.RunError, case let .host(code) = runError {
      if code == "unknown_op" {
        return "Mac 端不支持当前读取协议（unknown_op）。请更新 Scry，并完全退出后重新打开 Mac 端；仅覆盖安装不会更新正在运行的进程。"
      }
      return code
    }
    return "\(error)"
  }
}
