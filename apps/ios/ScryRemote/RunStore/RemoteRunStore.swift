import Foundation
import Observation
import CryptoKit
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
@Observable
final class RemoteRunStore {
  var projects: ProjectsState = .idle
  var directories: DirectoriesState = .idle
  var chosen: G0Transport.RunProjectRef?
  var providers: ProvidersState = .idle
  var commands: CommandsState = .idle
  var chosenProvider: G0Transport.RunProviderRef?
  var chosenModelId: String?
  var chosenEffort: String?
  var permissionMode: String = "default"
  var providerControlsLoading = false
  var providerControlsError: String? = nil
  var providerDiscoverySupported: Bool? = nil

  // The host's session catalog (the SAME conversations the Mac lists). Loaded
  // from the host over the granted-cert channel; never fabricated. Opening a
  // session's full transcript on the phone is a separate host read.
  enum CatalogState: Equatable {
    case idle
    case loading
    case loaded([G0Transport.RunSessionRef])
    case empty
    case failed(String)

    var hasVisibleValue: Bool {
      if case .loaded = self { return true }
      if case .empty = self { return true }
      return false
    }
  }
  var catalog: CatalogState = .idle
  enum CatalogEvidence: Equatable {
    case none
    case unverifiedCache(Date?)
    case verified(Date)
  }
  enum CatalogRefreshFailure: Equatable {
    case transport(String, retryable: Bool = true)
    case partial(String, retryable: Bool = true)
    case cacheRead(String)
    case cacheWriteRejected
    case cacheWrite(String)
    case authorization(String)
    case protocolMismatch(String)
    case target(label: String, detail: String, retryable: Bool = false)

    var allowsAutomaticRecovery: Bool {
      switch self {
      case let .transport(_, retryable), let .partial(_, retryable): return retryable
      case let .target(_, _, retryable): return retryable
      default: return false
      }
    }

    var summary: String {
      switch self {
      case .partial: return ConnectionCopy.partialRefreshFailure
      case .cacheWriteRejected, .cacheWrite: return ConnectionCopy.cacheWriteRejected
      case .cacheRead: return ConnectionCopy.cacheReadFailure
      case .transport: return ConnectionCopy.refreshFailure
      case .authorization: return ConnectionCopy.authorizationFailure
      case let .protocolMismatch(detail):
        let upgradeMessages = [ConnectionCopy.updatePhoneProtocol, ConnectionCopy.updateMacProtocol,
                               ConnectionCopy.updateBothProtocols, ConnectionCopy.subscriptionUnavailable]
        return upgradeMessages.contains(detail) ? detail : ConnectionCopy.protocolFailure
      case let .target(label, _, _): return ConnectionCopy.targetRefreshFailure(label)
      }
    }

    var requiresPairing: Bool {
      if case .authorization = self { return true }
      return false
    }

    var technicalDetail: String {
      switch self {
      case let .transport(detail, _), let .partial(detail, _), let .cacheRead(detail), let .cacheWrite(detail),
           let .authorization(detail), let .protocolMismatch(detail): return detail
      case .cacheWriteRejected: return ConnectionCopy.cacheWriteRejectedTechnical
      case let .target(_, detail, _): return detail
      }
    }
  }
  var catalogRefreshFailure: CatalogRefreshFailure?
  var catalogEvidence: CatalogEvidence = .none
  var catalogVerifiedAt: Date?
  var catalogRefreshInFlight = false
  var catalogRefreshRevision = 0

  // The archived catalog is a separate, explicitly requested read. It is not
  // written to the disk cache, so an archived row can never appear as current
  // state after an offline start.
  var archivedCatalog: CatalogState = .idle
  var archivedFetchedAt: Date?
  var archivedLoading = false
  var archivedFailure: String?
  // One visible tool panel at a time, so a stale reply can never overwrite a
  // newer request's evidence.
  enum ToolPanelState: Equatable {
    case idle
    case loading
    case loaded(G0Transport.ToolPanelPayload)
    case failed(String)
  }
  var toolPanel: ToolPanelState = .idle
  var toolPanelRequest = 0

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
  var history: HistoryState = .idle
  var historyPreview: HistoryPreviewState = .idle
  var historyRevision = 0
  var historySyncing = false
  var historyFromCache = false
  var historyFetchedAt: Date?
  var historyProgress: String?
  var historyRefreshError: String?
  var historyStorageNotice: String?
  var historyCapacityLimit = false
  // A failed history read is remembered for a short window so leaving and
  // re-entering a session does not re-pay a whole doomed round trip (14s on a
  // stale host, 30s on a dead network). A host-contract failure is remembered
  // longer than a transport failure because repeating it cannot succeed until
  // the Mac runs current code.
  struct HistoryReadBackoff { let message: String; let until: Date; let attempts: Int }
  var historyReadBackoff: [String: HistoryReadBackoff] = [:]
  var historyCacheClearing = false
  // Whether the host was actually reached on the LAST attempt. Paired != reachable:
  // a persisted grant only means we MAY reach the host; only a real successful
  // exchange proves it. nil = not tried yet. This is the honest source of the
  // connection status (fixes "shows offline while sending works").
  var reachable: Bool?
  // Remote targets require a fresh catalog capability/state before new writes;
  // the legacy local lane remains usable when reachability has not been proven.
  var executionTargetAvailable = true
  // `reachable` is retained for the existing link indicator; this richer value
  // prevents an authenticated business/protocol reply from being rendered as
  // transport-offline (or as a successful connected state).
  var connectionObservation: ConnectionObservation = .unverified
  var lifecycle: Lifecycle = .unknown
  // D1: the host's queue slot and hold for this run. nil when the host did not report one, which is
  // not the same as "not queued" — the lifecycle decides that.
  var queuePosition: Int?
  var queueHeld = false
  var output: [OutputLine] = []
  // The user's own submitted message, echoed immediately as a chat bubble
  // (ChatGPT/Codex style) so the person sees exactly what they sent. This is the
  // literal local input, not host-derived, and is labeled as the user turn.
  var prompt: String?
  var sentAttachments: [SentAttachment] = []
  var runId: String?
  var submitError: String?
  var truncated = false
  // Provider-canonical result evidence, surfaced verbatim from the ledger
  // `result` marker only. nil until the host reports it; never a fabricated 0.
  var resultSummary: String?
  // The Provider session id the live run reported (from the ledger `session`
  // marker). Lets a follow-up into an opened session resume the LATEST id.
  var liveExternalSessionId: String?
  // The host Scry run id of the live run (ledger `bound` marker). Archived
  // history turns carry the same id, so the device can recognize its own run.
  var liveHostRunId: String?
  var activeSessionIdentity: SessionIdentity?
  var observationInterrupted = false
  // Transport dropped mid-observation and is being re-established
  // automatically. Not a lifecycle: the run may still be progressing on the Mac.
  var observationReconnecting = false
  var stopRequesting = false
  var stopRequested = false
  var stopError: String?
  // Every unacknowledged submission, including the focused one. Persisted in
  // outbox.json so a killed app keeps sending after relaunch.
  var outbox: [PendingSubmission] = []
  var completedLiveTurns: [SessionIdentity: [CompletedLiveTurn]] = [:]
  var pendingQuestions: [G0Transport.RunQuestionRequest] = []
  var questionAnswering = false
  var questionError: String?

  // Multi-task: every run the host proves live right now (any paired device's
  // runs plus Mac UI runs in authorized projects). Absence is "not observed".
  enum LiveRunsStatus: Equatable { case unknown, observed, unsupported, failed(String) }
  var liveRuns: [G0Transport.LiveRun] = []
  var liveRunsStatus: LiveRunsStatus = .unknown
  var liveActionRunId: String?
  var liveActionError: String?
  // Questions the host acknowledged as answered; hidden until the list catches up.
  var liveAnsweredQuestions: Set<String> = []
  var liveRunsTask: Task<Void, Never>?
  var liveRunsForegroundEligible = false
  var liveRunsRevision: String?
  var liveHistoryTarget: SessionIdentity?
  var liveAnswerIds: [String: String] = [:]
  // Real streamed output of one detached remote run the open transcript shows.
  // A brand-new phone session has no archive until the run ends, and remote
  // runs are not in the Mac's active-run memory, so this host output store is
  // the only live evidence. Mac runs need none: their history includes it.
  var detachedRunId: String?
  var detachedHostRunId: String?
  var detachedOutput: [OutputLine] = []
  var detachedTask: Task<Void, Never>?

  // A run remains unresolved until its durable intent is acknowledged and a
  // terminal run has had its output drained. This derived gate is the small
  let connections: RemoteConnectionStore
  let targetScope: ExecutionTargetScope?
  let boundGatewayIdentity: String?
  let prefetchEnabled: Bool
  var pollTask: Task<Void, Never>?
  var deliveryTasks: [String: Task<Void, Never>] = [:]
  var pausedDeliveries = Set<String>()
  // MainActor-local mirror of markers already written or reserved for write.
  // It prevents a later stale snapshot from erasing another item's marker.
  var attemptedDeliveryIntentIds = Set<String>()
  var catalogTask: Task<Void, Never>?
  var catalogRequestID = 0
  var historyTask: Task<Void, Never>?
  var providersTask: Task<Void, Never>?
  var providerControlsTask: Task<Void, Never>?
  var providerControlsRequestID = 0
  var providerControlsLoaded = false
  var providerControlsCwd: String?
  var providerControlsNeedDefaults = true
  var commandsTask: Task<Void, Never>?
  var projectsTask: Task<Void, Never>?
  var directoriesTask: Task<Void, Never>?
  var generation = 0
  // Catalog/provider/project requests are independent of the currently opened
  // run. `resetRun()` must not make their useful replies disappear.
  var dataGeneration = 0
  var catalogLoadedAt: Date?
  var providersLoadedAt: Date?
  var projectsLoadedAt: Date?
  var commandCache: [String: G0Transport.RunCommandCatalog] = [:]
  let historyDisk: RemoteHistoryCache
  let stateDirectory: URL?
  var prefetchTask: Task<Void, Never>?
  var prefetchGeneration = 0
  var warmedScreens: [String: G0Transport.RunHistoryPreview] = [:]
  var cachedHistory: (key: String, snapshot: RemoteHistorySnapshot, persisted: Bool)?
  var historyFollowingLatest = true
  var historyWindow: G0Transport.RunHistoryTurnsPage?
  var historyWindowKey: String?
  var historyRequestGeneration = 0
  var historyPreviewKey: String?
  var pendingSubmission: PendingSubmission?
  var activeRouting: RemoteRunClient.Routing?
  // Composer selection belongs to a conversation, not to the focused run.
  // Starting a new task can leave that run alive with its frozen routing.
  var modelSelectionSession: SessionIdentity?
  struct ModelSelection: Codable {
    let key: String
    let modelId: String?
    let effort: String?
  }
  var modelSelections: [ModelSelection] = []
  static let modelSelectionsKey = "com.scry.remote.model-selections.v1"
  var seenOutputSequences = Set<Int>()
  var archivedActiveTurn = false
  var terminalDrainCompleted = false
  var contextNeedsRestore = false
  var directoriesRequestGeneration = 0
  var commandsRequestGeneration = 0
  var latestProviderPreference: (id: String?, agentProfileId: String?) = (nil, nil)
  enum RestoredControl { case model, effort, permission }
  var storedRestoredControlErrors: [RestoredControl: String] = [:]
  var pendingQuestionAnswerId: String?

  static let catalogFreshness: TimeInterval = 60
  static let metadataFreshness: TimeInterval = 5 * 60
  #if DEBUG
  var mockMode = false
  // Fixture: the first archived-catalog read fails, the retry confirms an empty list.
  var archiveFixtureReadCount = 0
  // Fixture: the host reports a permission the restored choice no longer names.
  var forcedStalePermission =
    ProcessInfo.processInfo.arguments.contains("-uiForceStalePermission")
  var historyTestOffline = false
  // Test data enters the real catalog request/caching path; other transports
  // remain disabled by mockMode and cannot reach stored credentials.
  struct CatalogFixture {
    let connection: RemoteConnection
    let fetch: @Sendable (@escaping @Sendable ([G0Transport.RunSessionRef]) async -> Void) async throws -> [G0Transport.RunSessionRef]
    var beforePersist: @Sendable () async -> Void = {}
  }
  var catalogFixture: CatalogFixture?
  var workspaceReaderFixture: ((RemoteRunClient, G0Transport.WorkspaceQuery) async throws -> G0Transport.WorkspaceResult)?
  #endif

  let historyOnly: Bool

  convenience init(historyFor owner: RemoteRunStore) {
    self.init(connections: owner.connections, historyDisk: owner.historyDisk, historyOnly: true,
              targetScope: owner.targetScope, prefetchEnabled: false)
  }

  init(connections: RemoteConnectionStore = RemoteConnectionStore(), historyDisk: RemoteHistoryCache = RemoteHistoryCache(), historyOnly: Bool = false,
       stateDirectory: URL? = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first?.appendingPathComponent("ScryRemote", isDirectory: true),
       targetScope: ExecutionTargetScope? = nil, prefetchEnabled: Bool = true) {
    let expectedGateway = targetScope?.isLocal == false
      ? targetScope?.gatewayIdentity ?? connections.load().map { RemoteHistoryCache.catalogKey(connection: $0) }
      : nil
    let namespacedDirectory: URL?
    if let stateDirectory, let targetScope, !targetScope.isLocal {
      let fields = [expectedGateway ?? "", targetScope.gatewayHostId, targetScope.targetId ?? "", targetScope.binding ?? "", targetScope.hostId]
      let data = try! JSONEncoder().encode(fields)
      let namespace = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
      namespacedDirectory = stateDirectory.appendingPathComponent("targets", isDirectory: true)
        .appendingPathComponent(namespace, isDirectory: true)
    } else {
      namespacedDirectory = stateDirectory
    }
    self.connections = connections
    self.historyDisk = historyDisk
    self.targetScope = targetScope
    self.boundGatewayIdentity = expectedGateway
    self.prefetchEnabled = prefetchEnabled
    self.stateDirectory = namespacedDirectory
    self.historyOnly = historyOnly
    self.executionTargetAvailable = targetScope?.isLocal != false
    if historyOnly { return }
    #if DEBUG
    let args = ProcessInfo.processInfo.arguments
    if args.contains("-uiPreview") || args.contains("-selfTest") || args.contains("-historyCacheTest") { return }
    #endif
    restoreOutbox()
    restoreRecoveryCheckpoint()
    for pending in outbox where pending.failure == nil && pending.uncertainty == nil && pending.attempted != true { startDelivery(pending) }
  }

  var connectionSuccessRevision = 0
  var archivedTask: Task<Bool, Never>?
}
