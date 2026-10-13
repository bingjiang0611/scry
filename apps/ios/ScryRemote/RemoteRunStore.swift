import Foundation
import RemoteTransport
#if canImport(UIKit)
import UIKit
#endif

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
  enum ConnectionObservation: Equatable {
    case unverified
    case reachable
    case transportFailure
    case hostReply(code: String)
    case protocolFailure(code: String)
  }
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
    // Decoded image bytes kept in memory only, so the sent bubble can show a
    // thumbnail and full-screen preview of exactly what was uploaded.
    let imageData: Data?

    init(name: String, kind: RemoteRunClient.Attachment.Kind, size: Int, imageData: Data? = nil) {
      self.name = name; self.kind = kind; self.size = size; self.imageData = imageData
    }

    init(_ attachment: RemoteRunClient.Attachment) {
      self.init(name: attachment.name, kind: attachment.kind, size: attachment.size,
                imageData: attachment.kind == .image ? Data(base64Encoded: attachment.dataBase64) : nil)
    }
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
    // Scry run id from the host `bound` marker; matches history page turn ids.
    var hostRunId: String? = nil
  }

  // A message the host has not acknowledged yet. It stays in the persisted
  // outbox and is resent with the same intentId until the host answers; the
  // host ledger dedupes by intentId, so a lost reply never creates a second run.
  // `failure` is set only by a definitive host rejection, never by the network.
  struct PendingSubmission: Codable, Equatable, Identifiable {
    let intentId: String
    let routing: RemoteRunClient.Routing
    let identity: SessionIdentity
    var failure: String? = nil
    var id: String { intentId }
  }

  enum DeliveryResult<Outcome> {
    case accepted(Outcome)
    case rejected(String)
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
  @Published private(set) var catalogRefreshError: String?

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
  @Published private(set) var historyCapacityLimit = false
  @Published private(set) var historyCacheClearing = false
  // Whether the host was actually reached on the LAST attempt. Paired != reachable:
  // a persisted grant only means we MAY reach the host; only a real successful
  // exchange proves it. nil = not tried yet. This is the honest source of the
  // connection status (fixes "shows offline while sending works").
  @Published private(set) var reachable: Bool?
  // `reachable` is retained for the existing link indicator; this richer value
  // prevents an authenticated business/protocol reply from being rendered as
  // transport-offline (or as a successful connected state).
  @Published private(set) var connectionObservation: ConnectionObservation = .unverified
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
  // The host Scry run id of the live run (ledger `bound` marker). Archived
  // history turns carry the same id, so the device can recognize its own run.
  @Published private(set) var liveHostRunId: String?
  @Published private(set) var activeSessionIdentity: SessionIdentity?
  @Published private(set) var observationInterrupted = false
  // Transport dropped mid-observation and is being re-established
  // automatically. Not a lifecycle: the run may still be progressing on the Mac.
  @Published private(set) var observationReconnecting = false
  @Published private(set) var stopRequesting = false
  @Published private(set) var stopRequested = false
  @Published private(set) var stopError: String?
  // Every unacknowledged submission, including the focused one. Persisted in
  // outbox.json so a killed app keeps sending after relaunch.
  @Published private(set) var outbox: [PendingSubmission] = []
  @Published private(set) var completedLiveTurns: [SessionIdentity: [CompletedLiveTurn]] = [:]
  @Published private(set) var pendingQuestions: [G0Transport.RunQuestionRequest] = []
  @Published private(set) var questionAnswering = false
  @Published private(set) var questionError: String?

  // Multi-task: every run the host proves live right now (any paired device's
  // runs plus Mac UI runs in authorized projects). Absence is "not observed".
  enum LiveRunsStatus: Equatable { case unknown, observed, unsupported, failed(String) }
  @Published private(set) var liveRuns: [G0Transport.LiveRun] = []
  @Published private(set) var liveRunsStatus: LiveRunsStatus = .unknown
  @Published private(set) var liveActionRunId: String?
  @Published private(set) var liveActionError: String?
  // Questions the host acknowledged as answered; hidden until the list catches up.
  @Published private(set) var liveAnsweredQuestions: Set<String> = []
  private var liveRunsTask: Task<Void, Never>?
  private var liveRunsRevision: String?
  private var liveHistoryTarget: SessionIdentity?
  private var liveAnswerIds: [String: String] = [:]
  // Real streamed output of one detached remote run the open transcript shows.
  // A brand-new phone session has no archive until the run ends, and remote
  // runs are not in the Mac's active-run memory, so this host output store is
  // the only live evidence. Mac runs need none: their history includes it.
  @Published private(set) var detachedRunId: String?
  @Published private(set) var detachedOutput: [OutputLine] = []
  private var detachedTask: Task<Void, Never>?

  // A run remains unresolved until its durable intent is acknowledged and a
  // terminal run has had its output drained. This derived gate is the small
  // parent-facing contract for navigation and composer admission.
  var hasUnresolvedRun: Bool {
    Self.unresolvedState(pending: pendingSubmission != nil, runId: runId,
                         drained: terminalDrainCompleted, interrupted: observationInterrupted)
  }
  var isBusy: Bool { hasUnresolvedRun }
  // A host run exists and has not reported a terminal lifecycle. Stop is a
  // request; it is offered even while reconnecting because the host may still run.
  var canStop: Bool {
    runId != nil && [.recorded, .dispatched, .running].contains(lifecycle)
  }
  var historyPreviewTurns: [G0Transport.RunHistoryTurn] {
    guard case let .available(preview) = historyPreview else { return [] }
    return preview.turns.map { turn in
      G0Transport.RunHistoryTurn(userText: turn.userText,
        items: turn.items.map { G0Transport.RunHistoryChunk(kind: $0.kind, text: $0.text) })
    }
  }

  private let connections: RemoteConnectionStore
  private var pollTask: Task<Void, Never>?
  private var deliveryTasks: [String: Task<Void, Never>] = [:]
  private var pausedDeliveries = Set<String>()
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
  var historyFollowingLatest = true
  private var historyWindow: G0Transport.RunHistoryTurnsPage?
  private var historyWindowKey: String?
  var historyOlderBefore: Int? { historyWindow.flatMap { $0.hasOlder ? $0.offset : nil } }
  var historyPageSnapshot: String? { historyWindow?.snapshot }
  var historyPageSource: String? { historyWindow?.source }
  var historyPageOffset: Int { historyWindow?.offset ?? 0 }
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

  let historyOnly: Bool

  convenience init(historyFor owner: RemoteRunStore) {
    self.init(connections: owner.connections, historyDisk: owner.historyDisk, historyOnly: true)
  }

  init(connections: RemoteConnectionStore = RemoteConnectionStore(), historyDisk: RemoteHistoryCache = RemoteHistoryCache(), historyOnly: Bool = false) {
    self.connections = connections
    self.historyDisk = historyDisk
    self.historyOnly = historyOnly
    if historyOnly { return }
    #if DEBUG
    let args = ProcessInfo.processInfo.arguments
    if args.contains("-uiPreview") || args.contains("-selfTest") || args.contains("-historyCacheTest") { return }
    #endif
    restoreOutbox()
    restoreRecoveryCheckpoint()
    for pending in outbox where pending.failure == nil { startDelivery(pending) }
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
    if historyOnly { return nil }
    return FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first?
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
      try Self.writeProtected(JSONEncoder().encode(checkpoint), to: url)
      return true
    } catch {
      submitError = "无法保存恢复记录：\(Self.describe(error))"
      return false
    }
  }

  private static func writeProtected(_ data: Data, to url: URL) throws {
    let directory = url.deletingLastPathComponent()
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
      attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
    try data.write(to: url, options: .atomic)
    try FileManager.default.setAttributes(
      [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: url.path)
  }

  private struct OutboxFile: Codable {
    let version: Int
    let hostId: String
    let items: [PendingSubmission]
  }

  private var outboxURL: URL? {
    recoveryURL?.deletingLastPathComponent().appendingPathComponent("outbox.json", isDirectory: false)
  }

  // Write the outbox before the first send: a message that is not on disk would
  // be forgotten by a killed app even though the host may never have received it.
  private func persistOutbox(_ items: [PendingSubmission]) -> Bool {
    #if DEBUG
    if mockMode || ProcessInfo.processInfo.arguments.contains("-historyCacheTest") { return true }
    #endif
    guard let url = outboxURL else {
      submitError = "无法保存待发送消息：存储目录不可用"
      return false
    }
    do {
      if items.isEmpty {
        do { try FileManager.default.removeItem(at: url) }
        catch let error as CocoaError where error.code == .fileNoSuchFile { }
        return true
      }
      guard let connection = connections.load() else {
        submitError = "无法保存待发送消息：尚未配对"
        return false
      }
      try Self.writeProtected(JSONEncoder().encode(OutboxFile(version: 1, hostId: connection.hostId, items: items)), to: url)
      return true
    } catch {
      submitError = "无法保存待发送消息：\(Self.describe(error))"
      return false
    }
  }

  private func restoreOutbox() {
    guard let url = outboxURL, FileManager.default.fileExists(atPath: url.path) else { return }
    do {
      let file = try JSONDecoder().decode(OutboxFile.self, from: Data(contentsOf: url))
      guard file.version == 1, let connection = connections.load(), file.hostId == connection.hostId else {
        submitError = "本地待发送消息不属于当前已配对主机，未发送"
        return
      }
      outbox = file.items
    } catch {
      submitError = "本地待发送消息损坏，未发送：\(Self.describe(error))"
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
      sentAttachments = checkpoint.routing?.attachments.map(SentAttachment.init) ?? []
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
        let pending = outbox.first { $0.intentId == intentId }
          ?? PendingSubmission(intentId: intentId, routing: routing, identity: checkpoint.identity)
        // A checkpoint from a build without the outbox still names an unsent intent.
        if !outbox.contains(where: { $0.intentId == intentId }) {
          outbox.append(pending)
          _ = persistOutbox(outbox)
        }
        pendingSubmission = pending
        terminalDrainCompleted = false
        lifecycle = .submitting
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

  private var connectionSuccessRevision = 0

  private func recordSuccess() {
    connectionSuccessRevision += 1
    reachable = true
    connectionObservation = .reachable
  }

  private func recordFailure(_ error: Error, since revision: Int? = nil) {
    if let runError = error as? G0Transport.RunError, case let .host(code) = runError {
      connectionSuccessRevision += 1
      if code == "unknown_op" || ["device_not_authorized", "grant_expired", "grant_revoked"].contains(code) {
        reachable = nil
      } else {
        reachable = true
      }
      connectionObservation = code == "unknown_op" ? .protocolFailure(code: code) : .hostReply(code: code)
      return
    }
    // Only a newer authenticated reply can supersede a failed request.
    // Another pending request is not evidence that the connection works.
    if let revision, connectionSuccessRevision > revision { return }
    reachable = false
    connectionObservation = .transportFailure
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
    catalogRefreshError = nil
    let requestDataGeneration = dataGeneration
    let disk = historyDisk
    let diskKey = RemoteHistoryCache.catalogKey(connection: client.connection)
    let requestConnectionRevision = connectionSuccessRevision
    catalogTask = Task { [weak self] in
      let diskEpoch = await disk.epoch
      do {
        if !hasCachedValue {
          do {
            if let cached = try await disk.readCatalog(diskKey) {
              await MainActor.run {
                guard let self, self.dataGeneration == requestDataGeneration else { return }
                self.catalog = cached.isEmpty ? .empty : .loaded(cached)
              }
            }
          } catch {
            await MainActor.run {
              guard let self, self.dataGeneration == requestDataGeneration else { return }
              self.catalogRefreshError = "本地列表缓存不可用，将核对主机：\(Self.describe(error))"
            }
          }
        }
        let list = try await client.sessions(progress: { [weak self] page in
          await MainActor.run {
            guard let self, self.dataGeneration == requestDataGeneration else { return }
            self.recordSuccess()
            self.catalog = page.isEmpty ? .empty : .loaded(page)
            // Only warm after the frozen catalog is complete. A partial page
            // must not start work for sessions that may not belong to it.
          }
        })
        await MainActor.run {
          guard let self, self.dataGeneration == requestDataGeneration else { return }
          self.catalogTask = nil
          self.recordSuccess()
          self.catalogLoadedAt = Date()
          self.catalogRefreshError = nil
          self.catalog = list.isEmpty ? .empty : .loaded(list)
          self.prefetchHistory(list)
        }
        do {
          _ = try await disk.writeCatalog(list, key: diskKey, epoch: diskEpoch)
        } catch {
          await MainActor.run {
            guard let self, self.dataGeneration == requestDataGeneration else { return }
            self.catalogRefreshError = "会话列表未保存到手机缓存：\(Self.describe(error))"
          }
        }
      } catch {
        await MainActor.run {
          guard let self, self.dataGeneration == requestDataGeneration else { return }
          self.catalogTask = nil
          self.recordFailure(error, since: requestConnectionRevision)
          if !self.catalog.hasVisibleValue { self.catalog = .failed(Self.describe(error)) }
          else { self.catalogRefreshError = Self.describe(error) }
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
  func loadHistory(providerId: String, cwd: String, externalSessionId: String, force: Bool = false, legacyFull: Bool = false,
                   onlyWhileFollowing: Bool = false) {
    #if DEBUG
    if mockMode { return }
    #endif
    guard !historyCacheClearing, !onlyWhileFollowing || historyFollowingLatest else { return }
    prefetchTask?.cancel()
    let identity = SessionIdentity.opened(providerId: providerId, cwd: cwd, externalSessionId: externalSessionId)
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
    } else if historyTask != nil { return }
    guard let connection = connections.load() else { history = .failed("尚未配对"); return }
    let key = RemoteHistoryCache.key(connection: connection, providerId: providerId, cwd: cwd, sessionId: externalSessionId)
    let client = RemoteRunClient(connection: connection)
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
        self.showHistoryFailure(error, cached: cached, since: requestConnectionRevision)
      }
      do {
        #if DEBUG
        if self.historyTestOffline {
          throw NSError(domain: "ScryHistoryFixture", code: 1, userInfo: [NSLocalizedDescriptionKey: "isolated offline fixture"])
        }
        #endif
        try await client.withHistoryConnection { [cached, persisted] reader in
          // Preview and structured recent pages share one fresh, readonly mTLS tunnel.
          if !legacyFull {
            // A first-screen preview remains explicitly partial. It also gives
            // an oversized turn a readable surface before the capacity reply.
            if case .loading = self.history {
              let preview = try await reader.preview(providerId: providerId, cwd: cwd, externalSessionId: externalSessionId)
              guard current() else { return }
              if preview.available {
                self.showPreview(preview, key: key, cached: false)
                self.recordSuccess()
              }
            }
            do {
              let recent = try await reader.turnsPage(providerId: providerId, cwd: cwd, externalSessionId: externalSessionId, before: nil, limit: 3, snapshot: nil)
              guard current() else { return }
              self.recordSuccess()
              // An older Mac (or a transcript-only window) gives no run ids, so
              // overlap with local runs cannot be proven; never risk a duplicate.
              if hasLocalTurns, !recent.turns.contains(where: { $0.runId != nil }) {
                self.historyStorageNotice = "主机历史未带运行标识，无法与本机运行去重；更新 Mac Scry 后可显示完整历史。"
                return
              }
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
              self.historyCapacityLimit = true
              self.historyStorageNotice = "最近窗口超过传输容量；可明确选择加载完整历史。"
              self.recordFailure(error, since: requestConnectionRevision)
              if case .loading = self.history { self.history = .failed("最近窗口超过传输容量，可选择加载完整历史。") }
              return
            }
          }
          do {
            let preview = try await reader.preview(providerId: providerId, cwd: cwd, externalSessionId: externalSessionId)
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
              externalSessionId: externalSessionId, cached: cached, connection: reader, progress: { [weak self] received, total in
                guard let self else { return }
                await MainActor.run {
                  guard self.historyRequestGeneration == request,
                        self.isCurrent(requestGeneration, identity: identity), self.connections.load() == connection else { return }
                  self.historyProgress = "\(received / 1024) / \(max(1, (total + 1023) / 1024)) KB"
                }
              })
            guard current() else { return }
            self.recordSuccess()
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

  func loadCompleteHistory(providerId: String, cwd: String, externalSessionId: String) {
    loadHistory(providerId: providerId, cwd: cwd, externalSessionId: externalSessionId, force: true, legacyFull: true)
  }

  private func showHistoryFailure(_ error: Error, cached: RemoteHistorySnapshot?, since revision: Int? = nil) {
    recordFailure(error, since: revision)
    historyRefreshError = Self.describe(error)
    // Keep local runs visible; a preview without run ids could duplicate them.
    if historyWindow != nil || history == .baseUnavailable { return }
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

  private func showHistoryWindow(_ page: G0Transport.RunHistoryTurnsPage, key: String, cached: Bool, fetchedAt: Date) {
    historyWindow = page
    historyWindowKey = key
    if page.totalTurns == 0 { history = .empty }
    else if page.completeness == "complete" { history = .loaded(page.turns) }
    else { history = .partial(page.turns) }
    historyFromCache = cached
    historyFetchedAt = fetchedAt
    historyRevision += 1
  }

  private func showHistory(_ snapshot: RemoteHistorySnapshot, key: String, cached: Bool, persisted: Bool) {
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

  func loadOlderHistory(providerId: String, cwd: String, externalSessionId: String) {
    guard let window = historyWindow, window.hasOlder,
          let connection = connections.load(), historyTask == nil else { return }
    let identity = SessionIdentity.opened(providerId: providerId, cwd: cwd, externalSessionId: externalSessionId)
    let requestConnectionRevision = connectionSuccessRevision
    let requestGeneration = generation
    historyRequestGeneration += 1
    let request = historyRequestGeneration
    let key = RemoteHistoryCache.key(connection: connection, providerId: providerId, cwd: cwd, sessionId: externalSessionId)
    guard historyWindowKey == key else { return }
    historySyncing = true
    historyTask = Task { [weak self] in
      guard let self else { return }
      defer {
        if self.historyRequestGeneration == request { self.historyTask = nil; self.historySyncing = false }
      }
      let epoch = await self.historyDisk.epoch
      do {
        let page = try await RemoteRunClient(connection: connection).withHistoryConnection { reader in
          try await reader.turnsPage(providerId: providerId, cwd: cwd, externalSessionId: externalSessionId,
            before: window.offset, limit: 3, snapshot: window.snapshot)
        }
        guard !Task.isCancelled, self.isCurrent(requestGeneration, identity: identity),
              self.connections.load() == connection, self.historyRequestGeneration == request else { return }
        self.recordSuccess()
        guard page.totalTurns == window.totalTurns else {
          self.historyRefreshError = "历史分页总数发生变化，保留已读取内容；请刷新最近历史。"
          return
        }
        let turns = page.turns + window.turns
        let complete = page.offset == 0 && turns.count == window.totalTurns && window.source != "active_memory"
        let combined = G0Transport.RunHistoryTurnsPage(turns: turns, offset: page.offset,
          totalTurns: window.totalTurns, hasOlder: page.hasOlder, snapshot: window.snapshot,
          source: window.source, completeness: complete ? "complete" : "partial")
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

  func refreshHistory(providerId: String, cwd: String, externalSessionId: String) async {
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
    let identity = SessionIdentity.opened(providerId: providerId, cwd: cwd, externalSessionId: externalSessionId)
    let requestGeneration = generation
    await historyTask?.value
    guard !Task.isCancelled, isCurrent(requestGeneration, identity: identity),
          let client = makeClient() else { return }
    let key = RemoteHistoryCache.key(connection: client.connection, providerId: providerId, cwd: cwd, sessionId: externalSessionId)
    if let windowKey = historyWindowKey, windowKey != key {
      loadHistory(providerId: providerId, cwd: cwd, externalSessionId: externalSessionId, force: true)
      await historyTask?.value
      return
    }
    let requestConnectionRevision = connectionSuccessRevision
    do {
      let version = try await client.historyVersion(providerId: providerId, cwd: cwd, externalSessionId: externalSessionId)
      guard !Task.isCancelled, isCurrent(requestGeneration, identity: identity) else { return }
      recordSuccess()
      guard historyNeedsRefresh(version.version) else {
        // The shown snapshot is the host's current version: the earlier failure no longer applies.
        if historyPageSnapshot == version.version { historyRefreshError = nil }
        return
      }
      loadHistory(providerId: providerId, cwd: cwd, externalSessionId: externalSessionId, force: true, onlyWhileFollowing: true)
      await historyTask?.value
    } catch {
      guard !Task.isCancelled, isCurrent(requestGeneration, identity: identity) else { return }
      recordFailure(error, since: requestConnectionRevision)
      historyRefreshError = Self.describe(error)
    }
  }

  private func historyNeedsRefresh(_ version: String) -> Bool {
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
    return Self.turnsNotInHistory(turns, hostRunIds: historyRunIds, historyHasOlder: historyOlderBefore != nil).filter {
      Self.shouldIncludeCompletedTurn($0.id, currentRunId: runId, archived: archivedActiveTurn)
    }
  }

  // Scry run ids present in the displayed host history (structured pages only).
  private var historyRunIds: Set<String> {
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
    let requestConnectionRevision = connectionSuccessRevision
    providersTask = Task { [weak self] in
      do {
        let list = try await client.providers()
        await MainActor.run {
          guard let self, self.dataGeneration == requestDataGeneration else { return }
          self.providersTask = nil
          self.recordSuccess()
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
          self.recordFailure(error, since: requestConnectionRevision)
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
          self.recordSuccess()
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
    let requestConnectionRevision = connectionSuccessRevision
    projectsTask = Task { [weak self] in
      do {
        let list = try await client.projects()
        await MainActor.run {
          guard let self, self.dataGeneration == requestDataGeneration else { return }
          self.projectsTask = nil
          self.recordSuccess()
          self.projectsLoadedAt = Date()
          self.projects = list.isEmpty ? .empty : .loaded(list)
          _ = self.restoreActiveContext()
        }
      } catch {
        await MainActor.run {
          guard let self, self.dataGeneration == requestDataGeneration else { return }
          self.projectsTask = nil
          self.recordFailure(error, since: requestConnectionRevision)
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
    let requestConnectionRevision = connectionSuccessRevision
    directoriesTask = Task { [weak self] in
      do {
        let listing = try await client.directories(path: path)
        await MainActor.run {
          guard let self, self.generation == requestGeneration,
                self.directoriesRequestGeneration == directoriesRequest else { return }
          self.directoriesTask = nil
          self.recordSuccess(); self.directories = .loaded(listing)
        }
      } catch {
        await MainActor.run {
          guard let self, self.generation == requestGeneration,
                self.directoriesRequestGeneration == directoriesRequest else { return }
          self.directoriesTask = nil
          self.recordFailure(error, since: requestConnectionRevision); self.directories = .failed(Self.describe(error))
        }
      }
    }
  }

  // Submit a durable intent. The message goes to the persisted outbox first and
  // is then delivered automatically: transport failures resend the same intentId
  // until the host answers, so a bad network only delays it (the UI spins).
  @discardableResult
  func submit(prompt: String, providerId: String, attachments: [RemoteRunClient.Attachment] = []) -> Bool {
    guard !historyOnly else { return false }
    let trimmed = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return false }
    guard !hasUnresolvedRun else {
      submitError = "当前任务仍在发送或运行中，请先返回该任务"
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
    let routing = RemoteRunClient.Routing(cwd: cwd, providerId: providerId,
                                          agentProfileId: chosenProvider?.agentProfileId, prompt: trimmed,
                                          modelId: chosenModel?.id, modelProviderId: chosenModel?.providerId,
                                          effort: chosenEffort, permissionMode: permissionMode,
                                          attachments: attachments)
    guard resetRun() else { return false }
    return sendFocused(PendingSubmission(intentId: UUID().uuidString.lowercased(), routing: routing, identity: identity),
                       attachments: attachments)
  }

  // Persist first, then show and deliver. If the outbox cannot be written the
  // send is refused (the composer keeps the draft) instead of spinning on a
  // message a killed app would forget.
  private func sendFocused(_ pending: PendingSubmission, attachments: [RemoteRunClient.Attachment]) -> Bool {
    guard persistOutbox(outbox + [pending]) else { return false }
    outbox.append(pending)
    activeSessionIdentity = pending.identity
    prompt = pending.routing.prompt
    sentAttachments = attachments.map(SentAttachment.init)
    activeRouting = pending.routing
    pendingSubmission = pending
    terminalDrainCompleted = false
    lifecycle = .submitting
    // Marks which outbox message is focused after a relaunch.
    _ = saveRecoveryCheckpoint(intentId: pending.intentId, routing: pending.routing,
                               identity: pending.identity, runId: nil)
    startDelivery(pending)
    return true
  }

  private func startDelivery(_ pending: PendingSubmission) {
    guard deliveryTasks[pending.intentId] == nil, let client = makeClient() else { return }
    deliveryTasks[pending.intentId] = Task { [weak self] in
      let result = await Self.deliver(
        submit: { try await client.submit(routing: pending.routing, intentId: pending.intentId) },
        status: { try await client.intentStatus(intentId: pending.intentId) },
        transportFailed: { error in self?.recordFailure(error) },
        pause: { attempt in
          self?.pausedDeliveries.insert(pending.intentId)
          defer { self?.pausedDeliveries.remove(pending.intentId) }
          try await Self.deliveryPause(attempt)
        })
      guard let self, let result else { return }
      self.deliveryFinished(pending, result: result, client: client)
    }
  }

  // Resend until the host answers. Only an authenticated host reply ends the
  // loop: a receipt (new or duplicate of this intentId) or a definitive
  // rejection. nil means the task was cancelled; a newer attempt owns the intent.
  static func deliver<Outcome>(submit: () async throws -> Outcome,
                               status: () async throws -> Outcome?,
                               transportFailed: (Error) -> Void,
                               pause: (Int) async throws -> Void) async -> DeliveryResult<Outcome>? {
    var attempt = 0
    while !Task.isCancelled {
      do {
        return .accepted(try await submit())
      } catch G0Transport.RunError.host(code: "intent_payload_conflict") {
        // Recorded earlier under a differently encoded payload (e.g. an app
        // update between attempts): adopt that run instead of failing.
        do {
          if let found = try await status() { return .accepted(found) }
          return .rejected("intent_payload_conflict")
        } catch let G0Transport.RunError.host(code) {
          return .rejected(code)
        } catch {
          if Task.isCancelled { return nil }
          transportFailed(error)
        }
      } catch let G0Transport.RunError.host(code) {
        return .rejected(code)
      } catch RemoteRunClient.ClientError.missingCredentials {
        return .rejected("missing_credentials")
      } catch {
        if Task.isCancelled { return nil }
        transportFailed(error)
      }
      attempt += 1
      do { try await pause(attempt) } catch { return nil }
    }
    return nil
  }

  // 1, 2, 4, then every 8 seconds. Foregrounding wakes waiting sends at once.
  private static func deliveryPause(_ attempt: Int) async throws {
    let seconds = min(8, 1 << min(attempt - 1, 3))
    try await Task.sleep(nanoseconds: UInt64(seconds) * 1_000_000_000)
  }

  // Restart sends that are waiting out a backoff (foreground). A send whose
  // request is in flight keeps going, so a large payload is not uploaded twice.
  // Resending is still safe: the host dedupes by intentId.
  private func wakeDelivery() {
    for intentId in pausedDeliveries {
      deliveryTasks.removeValue(forKey: intentId)?.cancel()
    }
    pausedDeliveries = []
    for pending in outbox where pending.failure == nil { startDelivery(pending) }
  }

  private func deliveryFinished(_ pending: PendingSubmission, result: DeliveryResult<G0Transport.RunSubmitOutcome>,
                                client: RemoteRunClient) {
    guard let index = outbox.firstIndex(where: { $0.intentId == pending.intentId }),
          outbox[index].failure == nil else { return }
    deliveryTasks.removeValue(forKey: pending.intentId)?.cancel()
    let focused = pendingSubmission?.intentId == pending.intentId
    var remaining = outbox
    switch result {
    case let .accepted(outcome):
      recordSuccess()
      remaining.remove(at: index)
      if focused { adoptSubmission(outcome, pending: pending, client: client) }
    case let .rejected(code):
      if focused {
        remaining.remove(at: index)
        pendingSubmission = nil
        lifecycle = .failed
        submitError = "Mac 拒绝了这条消息（\(code)），未执行。"
        clearRecoveryCheckpoint()
      } else {
        // Nobody is looking at this message; keep it visible on the home list.
        remaining[index].failure = code
      }
    }
    // A stale file only causes a deduped resend after relaunch; keep going.
    _ = persistOutbox(remaining)
    outbox = remaining
  }

  // Messages sent from a screen the user has since left. They keep sending in
  // the background and appear as live runs once the host records them.
  var backgroundSends: [PendingSubmission] {
    outbox.filter { $0.intentId != pendingSubmission?.intentId }
  }

  var hasUnsentMessages: Bool { outbox.contains { $0.failure == nil } }

  func backgroundSend(for identity: SessionIdentity?) -> PendingSubmission? {
    guard let identity else { return nil }
    return backgroundSends.last { $0.identity == identity && $0.failure == nil }
  }

  // Only a host-rejected message can be dismissed; an unanswered one keeps sending.
  func discardRejectedSend(_ intentId: String) {
    guard outbox.contains(where: { $0.intentId == intentId && $0.failure != nil }) else { return }
    let remaining = outbox.filter { $0.intentId != intentId }
    _ = persistOutbox(remaining)
    outbox = remaining
  }

  private func adoptSubmission(_ outcome: G0Transport.RunSubmitOutcome, pending: PendingSubmission,
                               client: RemoteRunClient) {
    runId = outcome.runId
    terminalDrainCompleted = false
    let saved = saveRecoveryCheckpoint(intentId: pending.intentId, routing: pending.routing,
                                       identity: pending.identity, runId: outcome.runId)
    pendingSubmission = nil
    if saved { submitError = nil }
    lifecycle = .recorded
    startPolling(runId: outcome.runId, client: client, generation: generation, identity: pending.identity)
  }

  private func startPolling(runId: String, client: RemoteRunClient, generation: Int,
                            identity: SessionIdentity) {
    pollTask?.cancel()
    pollTask = Task { [weak self] in
      guard let self else { return }
      var ledgerCursor = 0
      var outputCursor = 0
      var useWatch = true
      var failures = 0
      // Compacted ledgers may no longer retain the event that established an
      // older recovered run's current lifecycle. Reconcile the authoritative
      // run projection once, then continue from the server's resettable tail.
      if let state = try? await client.runState(runId: runId) {
        self.apply(runState: state, generation: generation, identity: identity)
      }
      while !Task.isCancelled {
        let requestConnectionRevision = self.connectionSuccessRevision
        var operation = "实时观察"
        do {
          let page: G0Transport.RunPollOutcome
          let questions: [G0Transport.RunQuestionRequest]
          let out: G0Transport.RunOutputPage
          var state: String?
          if useWatch {
            do {
              // One long-poll returns as soon as anything changes on the host,
              // instead of four sequential reads plus a fixed sleep.
              let watch = try await client.watch(runId: runId, cursor: ledgerCursor, outputCursor: outputCursor)
              page = watch.poll; questions = watch.questions; out = watch.output; state = watch.state
            } catch G0Transport.RunError.host(code: "unknown_op") {
              // Older Mac host: keep the legacy read sequence, still honest.
              useWatch = false
              continue
            }
          } else {
            operation = "事件读取"
            page = try await client.poll(cursor: ledgerCursor)
            operation = "问题读取"
            questions = try await client.questions(runId: runId)
            operation = "输出读取"
            out = try await client.output(runId: runId, cursor: outputCursor)
          }
          guard self.isCurrent(generation, identity: identity) else { return }
          ledgerCursor = page.cursor
          for ev in page.events where ev.runId == runId {
            self.apply(event: ev, generation: generation, identity: identity)
          }
          if let state { self.apply(runState: state, generation: generation, identity: identity) }
          if self.pendingQuestions.first?.questionId != questions.first?.questionId {
            self.pendingQuestionAnswerId = nil
            self.questionAnswering = false
            self.questionError = nil
          }
          self.pendingQuestions = questions
          outputCursor = out.cursor
          for chunk in out.chunks {
            self.append(chunk: chunk, generation: generation, identity: identity)
          }
          self.recordSuccess()
          if failures > 0 || self.observationReconnecting {
            failures = 0
            self.observationReconnecting = false
          }
          self.observationInterrupted = false
        } catch {
          guard self.isCurrent(generation, identity: identity), !Task.isCancelled else { return }
          self.recordFailure(error, since: requestConnectionRevision)
          failures += 1
          // Host-rejected reads (revoked device, unknown run) cannot heal by
          // retrying. Transport loss can: keep observing with capped backoff for
          // as long as it takes; the status row says it is reconnecting and the
          // Provider may still be running, so nothing is assumed.
          if error is G0Transport.RunError {
            self.observationReconnecting = false
            self.observationInterrupted = true
            self.submitError = Self.observationFailure(error, lifecycle: self.lifecycle, operation: operation)
            self.pollTask = nil
            return
          }
          self.observationReconnecting = true
          let delay = min(8.0, 0.5 * pow(2.0, Double(failures - 1)))
          try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
          continue
        }
        if self.isTerminal(generation: generation, identity: identity) {
          let drained = await self.drainOutput(client: client, runId: runId, cursor: outputCursor,
                                               generation: generation, identity: identity)
          guard self.isCurrent(generation, identity: identity) else { return }
          if drained {
            self.archiveActiveTurnIfNeeded()
            self.clearRecoveryCheckpoint()
            self.terminalDrainCompleted = true
            // The host archives the run before its settled marker. Read the
            // host record now so the local copy can give way to it.
            if let externalSessionId = identity.externalSessionId {
              self.loadHistory(providerId: identity.providerId, cwd: identity.cwd, externalSessionId: externalSessionId, force: true)
            }
          }
          self.pollTask = nil
          return
        }
        if !useWatch { try? await Task.sleep(nanoseconds: 800_000_000) }
      }
    }
  }

  // Interrupt the current run's Provider on the Mac. The receipt only says the
  // request was accepted; the lifecycle still comes from the real result.
  func stopRun() {
    guard let runId, !stopRequesting, let client = makeClient(),
          let identity = activeSessionIdentity else { return }
    stopRequesting = true
    stopError = nil
    let requestGeneration = generation
    Task { [weak self] in
      do {
        let status = try await client.stop(runId: runId)
        await MainActor.run {
          guard let self, self.isCurrent(requestGeneration, identity: identity) else { return }
          self.stopRequesting = false
          self.stopRequested = status != "not_running"
        }
      } catch {
        await MainActor.run {
          guard let self, self.isCurrent(requestGeneration, identity: identity) else { return }
          self.stopRequesting = false
          self.stopError = "停止请求结果未知：\(Self.describe(error))。可再次点击停止。"
        }
      }
    }
  }

  private func resumeObservation(runId: String) {
    guard !historyOnly else { return }
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

  // App returned to the foreground: open the interactive tunnel early and, if a
  // transport loss had stopped observation of an unfinished run, resume it.
  // Resuming is a read; it never re-sends a prompt or answer.
  func foregrounded() {
    guard !historyOnly, let client = makeClient() else { return }
    Task { try? await client.prewarm() }
    startLiveRuns()
    wakeDelivery()
    if observationInterrupted, pollTask == nil, !terminalDrainCompleted, runId != nil { retryObservation() }
  }

  // Resume a known host run after a view rebuild. The caller supplies the
  // session identity obtained from the host catalog, so a run id from another
  // session cannot attach to the current transcript.
  func resumeObservation(runId: String, providerId: String, cwd: String, externalSessionId: String) {
    guard !historyOnly else { return }
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
      let page: G0Transport.RunOutputPage
      do {
        page = try await client.output(runId: runId, cursor: cursor)
      } catch {
        await MainActor.run {
          guard self.isCurrent(generation, identity: identity) else { return }
          self.observationInterrupted = true
          self.submitError = Self.observationFailure(error, lifecycle: self.lifecycle, operation: "最后输出读取")
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
    // The host projects an interrupted Provider result as `settled`; keep the
    // more specific cancelled lifecycle already read from the settled marker.
    case "settled": if lifecycle != .cancelled { lifecycle = .settled }
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
        // The Provider reporting its own session id is evidence it is executing.
        if marker["event"] == "started" || marker["event"] == "session",
           lifecycle == .dispatched || lifecycle == .recorded { lifecycle = .running }
        if marker["event"] == "result" { resultSummary = Self.resultLine(marker) }
        if marker["event"] == "settled", let status = marker["status"],
           status == "cancelled" || status == "interrupted" || status == "stopped" {
          lifecycle = .cancelled
        }
        // The Provider's own session id for THIS run. Captured so a chained
        // follow-up resumes the latest session (continuous memory), not a stale id.
        if marker["event"] == "session", let ext = marker["externalSessionId"], !ext.isEmpty { liveExternalSessionId = ext }
        if marker["event"] == "bound", marker["ledgerRunId"] == runId, let id = marker["scryRunId"], !id.isEmpty { liveHostRunId = id }
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
    // Real streamed Provider output proves execution has started.
    if lifecycle == .dispatched || lifecycle == .recorded { lifecycle = .running }
    Self.coalesce(chunk, into: &output)
  }

  // Providers stream text/reasoning in small deltas. Keep those deltas as one
  // readable block instead of rendering one SwiftUI Text row per token.
  static func coalesce(_ chunk: G0Transport.RunOutputChunk, into output: inout [OutputLine]) {
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
    clearRunState()
    return true
  }

  // Leave the focused run running on the Mac and stop watching it here, so the
  // user can open another session or start a new task. An unacknowledged
  // message stays in the outbox and keeps sending in the background.
  // Its partial live turn is not archived as "completed"; the host live-run
  // list keeps showing the run, its questions and stop, and history shows its
  // content once the Provider writes it.
  func detachFocusedRun() -> Bool {
    guard !historyOnly else { return false }
    if !hasUnresolvedRun { return resetRun() }
    clearRunState()
    return true
  }

  private func clearRunState() {
    prefetchTask?.cancel()
    generation += 1
    pollTask?.cancel(); pollTask = nil
    historyTask?.cancel(); historyTask = nil
    // Unfocus only; its outbox delivery task keeps running.
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
    liveHostRunId = nil
    observationInterrupted = false
    observationReconnecting = false
    stopRequesting = false
    stopRequested = false
    stopError = nil
    terminalDrainCompleted = false
    pendingQuestions = []
    pendingQuestionAnswerId = nil
    questionAnswering = false
    questionError = nil
    archivedActiveTurn = false
    restoredControlErrors = [:]
    contextNeedsRestore = false
  }

  private func archiveActiveTurnIfNeeded() {
    guard !archivedActiveTurn, let identity = activeSessionIdentity,
          let prompt, !prompt.isEmpty, isTerminal(generation: generation, identity: identity) else { return }
    let turn = CompletedLiveTurn(id: runId ?? UUID().uuidString.lowercased(), runId: runId,
      prompt: prompt, attachments: sentAttachments, lifecycle: lifecycle, output: output,
      resultSummary: resultSummary, externalSessionId: liveExternalSessionId, hostRunId: liveHostRunId)
    completedLiveTurns[identity, default: []].append(turn)
    archivedActiveTurn = true
  }

  // Used by destructive unpair. It invalidates every outstanding request before
  // releasing the visible state, so old history/poll callbacks cannot reappear.
  func clearAllState() {
    generation += 1
    dataGeneration += 1
    stopLiveRuns()
    followDetached(nil)
    liveRuns = []; liveRunsRevision = nil; liveRunsStatus = .unknown; liveHistoryTarget = nil
    liveActionRunId = nil; liveActionError = nil; liveAnsweredQuestions = []; liveAnswerIds = [:]
    pollTask?.cancel(); pollTask = nil
    for task in deliveryTasks.values { task.cancel() }
    deliveryTasks = [:]; pausedDeliveries = []
    // Unpair discards unsent messages: they belong to the old grant.
    _ = persistOutbox([])
    outbox = []
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
    catalog = .idle; catalogRefreshError = nil; history = .idle; historyPreview = .idle; historyPreviewKey = nil; historyWindow = nil; historyWindowKey = nil; historyCapacityLimit = false; reachable = nil; connectionObservation = .unverified
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

  // Send a follow-up that CONTINUES an opened session (same Provider + cwd +
  // session id) so the conversation keeps its context. Unlike submit(), the
  // target is explicit (from the opened session), not the new-session pickers.
  // Chained follow-ups resume the LATEST reported session id when available.
  @discardableResult
  func submitFollowUp(prompt: String, providerId: String, agentProfileId: String? = nil, cwd: String, resume: String, attachments: [RemoteRunClient.Attachment] = []) -> Bool {
    guard !historyOnly else { return false }
    let trimmed = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return false }
    guard !hasUnresolvedRun else {
      submitError = "当前任务仍在发送或运行中，请先返回该任务"
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
    // One turn per conversation: a follow-up must not race its own earlier message.
    guard backgroundSend(for: identity) == nil else { return false }
    let modelId = chosenModel?.id
    let modelProviderId = chosenModel?.providerId
    let effort = chosenEffort
    let permission = permissionMode
    guard resetRun() else { return false }
    liveExternalSessionId = resumeId
    let routing = RemoteRunClient.Routing(cwd: cwd, providerId: providerId,
                                          agentProfileId: matchingProvider.agentProfileId, prompt: trimmed,
                                          modelId: modelId, modelProviderId: modelProviderId,
                                          effort: effort, permissionMode: permission,
                                          resume: resumeId, attachments: attachments)
    return sendFocused(PendingSubmission(intentId: UUID().uuidString.lowercased(), routing: routing, identity: identity),
                       attachments: attachments)
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
      ("store.sessionSwitchDropsOldCommands", store.slashCommands.isEmpty),
      ("store.warmingDoesNotSwitchSession", store.activeSessionIdentity == beforeIdentity && store.prompt == nil),
      ("store.warmingUsesBoundedMirror", store.warmedScreens[key]?.available == true && ((try? JSONEncoder().encode(store.warmedScreens[key]).count) ?? Int.max) <= 16 * 1024),
      ("store.offlineKeepsDiskHistory", store.history == .loaded(snapshot.turns) && store.historyFromCache && store.reachable == false),
      ("store.offlineUpdateErrorVisible", store.historyRefreshError != nil)
    ]
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
    checks.append(("store.healthyHistoryWatchSkipsFallback", refreshStore.historyIsWatched(windowIdentity)))
    refreshStore.loadHistory(providerId: "pi", cwd: "/fixture", externalSessionId: "window-only", force: true)
    checks.append(("store.refreshImmediatelyKeepsNewerWindow", refreshStore.history == .partial(currentWindow.turns) && refreshStore.historyPageSnapshot == "current-window"))
    await refreshStore.historyTask?.value
    checks.append(("store.failedRefreshKeepsNewerWindow", refreshStore.history == .partial(currentWindow.turns) && refreshStore.historyPageSnapshot == "current-window" && refreshStore.historyOlderBefore == 2 && refreshStore.historyPageSource == "active_memory" && refreshStore.historyFetchedAt == currentFetchedAt && refreshStore.historyRefreshError != nil))
    checks.append(("store.failedRefreshEnablesFallbackDespiteSeenVersion", !refreshStore.historyIsWatched(windowIdentity)))
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
    checks.append(("store.clearedRefreshErrorRestoresHistoryWatch", refreshStore.historyIsWatched(windowIdentity)))
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
    // Leaving an unsent message must not block a new task; it keeps sending from the outbox.
    store.outbox = [store.pendingSubmission!]
    checks.append(("pending.detachDoesNotBlock", store.detachFocusedRun() && !store.hasUnresolvedRun && store.pendingSubmission == nil))
    checks.append(("pending.detachKeepsOutbox", store.backgroundSends.map(\.intentId) == ["keep-this-intent"] &&
      store.backgroundSend(for: identity)?.routing.prompt == "same prompt"))
    store.discardRejectedSend("keep-this-intent")
    checks.append(("pending.unansweredSendNotDiscardable", store.outbox.count == 1))
    store.outbox[0].failure = "grant_revoked"
    store.discardRejectedSend("keep-this-intent")
    checks.append(("pending.rejectedSendDiscardable", store.outbox.isEmpty))
    let file = OutboxFile(version: 1, hostId: "host", items: [PendingSubmission(intentId: "a", routing: routing, identity: identity, failure: "x")])
    let decoded = (try? JSONEncoder().encode(file)).flatMap { try? JSONDecoder().decode(OutboxFile.self, from: $0) }
    checks.append(("outbox.roundTrip", decoded?.items == file.items && decoded?.hostId == "host"))
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
      SentAttachment(name: "home-reference.png", kind: .image, size: 184_320, imageData: Self.mockImageData()),
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
    // Screenshot fixtures for history failure states; no relay or host grant.
    if ProcessInfo.processInfo.arguments.contains("-uiMockHistoryFailure"), let identity = activeSessionIdentity {
      prompt = nil; output = []; runId = nil; resultSummary = nil
      liveRunsStatus = .observed
      historyRefreshError = "中继连接已关闭（1009 message too big）"
      if ProcessInfo.processInfo.arguments.contains("-uiMockBaseUnavailable") {
        history = .baseUnavailable
        completedLiveTurns[identity] = [.init(id: "preview-completed", runId: "preview-completed", prompt: "什么进度了",
          attachments: [], lifecycle: .settled, output: [.init(id: 1, kind: "output", text: "代码已修复并提交。\n\n- 表格已按行列渲染\n- 编译通过")],
          resultSummary: "输入 815 · 输出 101 · $0.01077", externalSessionId: "codex-pinned-1")]
      } else {
        history = .partial([.init(userText: "ios端输出要支持markdown 这个表格展示有问题 修复", items: [
          .init(kind: "tool", text: "bash"), .init(kind: "tool_result", text: "ok")])])
      }
    }
    // Screenshot fixture for an unacknowledged message (focused and background);
    // nothing is sent because mockMode never starts delivery.
    if ProcessInfo.processInfo.arguments.contains("-uiMockSending"), let identity = activeSessionIdentity {
      let routing = RemoteRunClient.Routing(cwd: roots[0].path, providerId: "codex", agentProfileId: nil,
                                            prompt: "有办法不会收吗 不然每次回来看代码都要重新等待 jdtls 加载")
      let focused = PendingSubmission(intentId: "mock-sending", routing: routing, identity: identity)
      let other = RemoteRunClient.Routing(cwd: roots[1].path, providerId: "pi", agentProfileId: nil, prompt: "整理今天的测试结果")
      outbox = [focused, PendingSubmission(intentId: "mock-background", routing: other,
                                           identity: .new(providerId: "pi", cwd: roots[1].path))]
      pendingSubmission = focused
      prompt = routing.prompt; sentAttachments = []; output = []; runId = nil; resultSummary = nil
      lifecycle = .submitting; terminalDrainCompleted = false
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
    if ProcessInfo.processInfo.arguments.contains("-uiMockMacStartsLater"), case let .loaded(turns) = history {
      // A full cached base reproduces the production refresh gate, rather than
      // bypassing it with a direct append that would mask a stale-history bug.
      cachedHistory = ("mock-history", .init(turns: turns, fingerprint: "mock-old", fetchedAt: Date()), false)
    }
    if ProcessInfo.processInfo.arguments.contains("-uiMockLongOutput") {
      prompt = "检查长回复滚动定位"
      output = [.init(id: 1, kind: "output", text: "## 实时回复开头\n\n" +
        String(repeating: "完整实时回复保留全部内容。\n\n", count: 150) + "## 实时回复末尾")]
    }
    if ProcessInfo.processInfo.arguments.contains("-uiMockMarkdownTable") {
      let markdown = """
      ## 性能（日志实测）
      | 问题 | 证据 | 判断 |
      |---|:---:|---:|
      | **文件树扫描太慢** | `reload_tree.bg.scan` 共 141 次，7 万多个文件单次扫描 5–117 秒。 | 文件结构一变，增量更新就退回整树扫描。 |
      | 全文搜索慢 | `search.complete` 最长 32 秒 | 两者争用磁盘 IO |

      表格之后的正文
      """
      if ProcessInfo.processInfo.arguments.contains("-uiMockMarkdownHistory") {
        history = .loaded([.init(userText: "检查性能", items: [.init(kind: "output", text: markdown)])])
        prompt = nil; output = []; runId = nil; resultSummary = nil
      } else {
        prompt = "检查性能"
        output = [.init(id: 1, kind: "output", text: markdown)]
      }
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

  // Visual-only bytes so the DEBUG chat fixture exercises thumbnail + preview.
  private static func mockImageData() -> Data? {
    #if canImport(UIKit)
    UIGraphicsImageRenderer(size: CGSize(width: 390, height: 844)).image { context in
      UIColor(red: 0.12, green: 0.2, blue: 0.35, alpha: 1).setFill(); context.fill(CGRect(x: 0, y: 0, width: 390, height: 844))
      UIColor(red: 0.45, green: 0.7, blue: 1, alpha: 1).setFill(); context.fill(CGRect(x: 24, y: 120, width: 342, height: 180))
    }.jpegData(compressionQuality: 0.8)
    #else
    nil
    #endif
  }

  private func applyMockRun(prompt: String, attachments: [RemoteRunClient.Attachment]) {
    resetRun()
    self.prompt = prompt
    sentAttachments = attachments.map(SentAttachment.init)
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
    if let cost = marker["costUsd"] { parts.append(Self.costLabel(cost)) }
    return parts.isEmpty ? "主机报告完成（未提供用量）" : parts.joined(separator: " · ")
  }

  // Provider cost is a binary float (e.g. 0.014948799999999998). Show four
  // significant digits; an unparseable value is shown verbatim, not as 0.
  static func costLabel(_ raw: String) -> String {
    guard let value = Double(raw), value.isFinite, value >= 0 else { return "$\(raw)" }
    if value == 0 { return "$0" }
    if value >= 1 { return String(format: "$%.2f", value) }
    return "$" + String(format: "%.4g", value)
  }

  var terminalLifecycleKnown: Bool {
    [.settled, .failed, .cancelled].contains(lifecycle)
  }

  private static func observationFailure(_ error: Error, lifecycle: Lifecycle, operation: String = "输出读取") -> String {
    let detail = "\(operation)：\(describe(error))"
    if [.settled, .failed, .cancelled].contains(lifecycle) {
      return "输出同步中断：\(detail)。主机已报告任务结束，输出尚未完整核对。"
    }
    return "观察中断：\(detail)。运行结果未知。"
  }

  private static func describe(_ error: Error) -> String {
    if let runError = error as? G0Transport.RunError, case let .host(code) = runError {
      if code == "unknown_op" {
        return "Mac 端不支持当前读取协议（unknown_op）。请更新 Scry，并完全退出后重新打开 Mac 端；仅覆盖安装不会更新正在运行的进程。"
      }
      return code
    }
    // Relay close/timeout reasons are untrusted diagnostics, shown as such.
    if let relay = error as? RelayTransportError {
      switch relay {
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

// MARK: - Live runs (multi-task, Mac runs)

extension RemoteRunStore {
  // Pull-to-refresh: reload the catalog and wait for that request to finish.
  func refreshSessions() async {
    loadSessions(force: true)
    await catalogTask?.value
  }

  func startLiveRuns() {
    #if DEBUG
    if mockMode { return }
    #endif
    guard !historyOnly, liveRunsTask == nil, liveRunsStatus != .unsupported, hasConnection else { return }
    liveRunsTask = Task { [weak self] in await self?.runLiveRunsLoop() }
  }

  func stopLiveRuns() {
    liveRunsTask?.cancel()
    liveRunsTask = nil
  }

  // The open transcript joins its history version to the live-run long-poll.
  // A new target restarts the poll instead of waiting up to 15 s for the old one.
  func watchHistory(_ identity: SessionIdentity?) {
    guard liveHistoryTarget != identity else { return }
    liveHistoryTarget = identity
    if identity != nil, liveRunsTask != nil { stopLiveRuns(); startLiveRuns() }
  }

  // Observing a source version is not successful reconciliation. If its read
  // failed, keep the existing paced fallback active even with an unchanged
  // long-poll version; otherwise the latest messages could stay stale forever.
  func historyIsWatched(_ identity: SessionIdentity?) -> Bool {
    liveRunsStatus == .observed && identity != nil && liveHistoryTarget == identity && historyRefreshError == nil
  }

  private func runLiveRunsLoop() async {
    var failures = 0
    var seen: (target: SessionIdentity, version: String)?
    while !Task.isCancelled {
      guard let client = makeClient() else { break }
      let target = liveHistoryTarget
      let known = target.flatMap { current in seen?.target == current ? seen?.version : nil }
      let history = target.flatMap { current in
        current.externalSessionId.map { (providerId: current.providerId, cwd: current.cwd, externalSessionId: $0, known: known) }
      }
      do {
        let outcome = try await client.liveRuns(revision: liveRunsRevision, history: history)
        if Task.isCancelled { return }
        failures = 0
        recordSuccess()
        liveRunsRevision = outcome.revision
        if liveRuns != outcome.runs {
          liveRuns = outcome.runs
          let open = Set(outcome.runs.flatMap { run in run.questions.map { "\(run.runId)\u{0}\($0.questionId)" } })
          liveAnsweredQuestions.formIntersection(open)
        }
        liveRunsStatus = .observed
        if let target, let externalSessionId = target.externalSessionId,
           let version = outcome.historyVersion?.version, version != known {
          seen = (target, version)
          // refreshHistory re-checks the version and skips an unchanged source.
          await refreshHistory(providerId: target.providerId, cwd: target.cwd, externalSessionId: externalSessionId)
        }
      } catch is CancellationError {
        return
      } catch G0Transport.RunError.host(code: "unknown_op") {
        liveRunsStatus = .unsupported
        break
      } catch {
        if Task.isCancelled { return }
        failures += 1
        liveRunsStatus = .failed(Self.describe(error))
        try? await Task.sleep(for: .seconds(min(8, 1 << min(failures, 3))))
      }
    }
    liveRunsTask = nil
  }

  // Any live run in this session, including the one this store is watching.
  func liveRun(providerId: String, cwd: String, externalSessionId: String?) -> G0Transport.LiveRun? {
    guard let externalSessionId else { return nil }
    return liveRuns.first { $0.providerId == providerId && $0.cwd == cwd && $0.externalSessionId == externalSessionId }
  }

  // A live run in this session that this store is not already watching.
  func otherLiveRun(for identity: SessionIdentity?) -> G0Transport.LiveRun? {
    guard let identity, let run = liveRun(providerId: identity.providerId, cwd: identity.cwd,
                                          externalSessionId: identity.externalSessionId),
          run.runId != runId else { return nil }
    return run
  }

  // Runs other than the watched one that wait for a decision.
  var waitingLiveRuns: [G0Transport.LiveRun] {
    liveRuns.filter { $0.runId != runId && openLiveQuestion($0) != nil }
  }

  func openLiveQuestion(_ run: G0Transport.LiveRun) -> G0Transport.RunQuestionRequest? {
    run.questions.first { !liveAnsweredQuestions.contains("\(run.runId)\u{0}\($0.questionId)") }
  }

  func followDetached(_ live: G0Transport.LiveRun?) {
    let runId = live?.origin == "remote" ? live?.runId : nil
    guard runId != detachedRunId else { return }
    detachedTask?.cancel()
    detachedTask = nil
    detachedRunId = runId
    detachedOutput = []
    guard let runId, let client = makeClient() else { return }
    detachedTask = Task { [weak self] in
      var ledgerCursor = 0, outputCursor = 0, failures = 0
      while !Task.isCancelled {
        do {
          let watch = try await client.watch(runId: runId, cursor: ledgerCursor, outputCursor: outputCursor)
          guard !Task.isCancelled, let self, self.detachedRunId == runId else { return }
          failures = 0
          ledgerCursor = watch.poll.cursor
          outputCursor = watch.output.cursor
          // Chunks arrive strictly after outputCursor, so none repeats. A
          // "truncated" marker is covered by the view's may-be-incomplete note.
          for chunk in watch.output.chunks where chunk.kind != "truncated" {
            Self.coalesce(chunk, into: &self.detachedOutput)
          }
          // The run's own terminal state ends the stream; history takes over.
          if ["settled", "failed", "cancelled"].contains(watch.state ?? "") { return }
        } catch is CancellationError {
          return
        } catch {
          if Task.isCancelled { return }
          failures += 1
          try? await Task.sleep(for: .seconds(min(8, 1 << min(failures, 3))))
        }
      }
    }
  }

  func stopLiveRun(_ run: G0Transport.LiveRun) {
    guard liveActionRunId == nil, let client = makeClient() else { return }
    liveActionRunId = run.runId
    liveActionError = nil
    Task { [weak self] in
      do {
        _ = try await client.stop(runId: run.runId)
        self?.liveActionRunId = nil
      } catch {
        self?.liveActionRunId = nil
        self?.liveActionError = "停止请求结果未知：\(Self.describe(error))。可再次点击停止。"
      }
    }
  }

  func answerLiveQuestion(_ run: G0Transport.LiveRun, request: G0Transport.RunQuestionRequest,
                          answers: [String: String], cancel: Bool = false) {
    guard liveActionRunId == nil, let client = makeClient() else { return }
    let key = "\(run.runId)\u{0}\(request.questionId)"
    // A retry after an unknown outcome reuses the answer id (remote runs dedupe by it).
    let answerId = liveAnswerIds[key] ?? UUID().uuidString.lowercased()
    liveAnswerIds[key] = answerId
    liveActionRunId = run.runId
    liveActionError = nil
    let response = G0Transport.RunQuestionResponse(runId: run.runId, questionId: request.questionId,
                                                   behavior: cancel ? "cancelled" : "answered",
                                                   answers: cancel ? nil : answers)
    Task { [weak self] in
      do {
        _ = try await client.answerQuestion(runId: run.runId, answerId: answerId, response: response)
        self?.liveAnswerIds[key] = nil
        self?.liveAnsweredQuestions.insert(key)
        self?.liveActionRunId = nil
      } catch G0Transport.RunError.host(code: "question_not_pending") {
        self?.liveAnswerIds[key] = nil
        self?.liveAnsweredQuestions.insert(key)
        self?.liveActionRunId = nil
        self?.liveActionError = "该问题已不再等待（可能已在 Mac 或其他设备上回答或关闭）。"
      } catch {
        self?.liveActionRunId = nil
        self?.liveActionError = "回答结果未知：\(Self.describe(error))。再次提交会复用同一回答标识。"
      }
    }
  }
}
