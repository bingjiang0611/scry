import Foundation
import RemoteTransport

// Device-side observable state for ONE remote run, driven strictly by what the
// host proves over the granted-cert inner mTLS channel (RemoteRunClient). It
// never fabricates a lifecycle, an assistant reply, a token/cost number or a
// file diff (CLAUDE.md 证据不能说谎):
//
//   - Lifecycle comes only from the durable ledger poll: recorded/dispatched/
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
  struct SessionIdentity: Hashable, Equatable {
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

  @Published private(set) var projects: ProjectsState = .idle
  @Published private(set) var directories: DirectoriesState = .idle
  @Published private(set) var chosen: G0Transport.RunProjectRef?
  @Published private(set) var providers: ProvidersState = .idle
  @Published private(set) var commands: CommandsState = .idle
  @Published private(set) var chosenProvider: G0Transport.RunProviderRef?
  @Published private(set) var chosenEffort: String?
  @Published private(set) var permissionMode: String = "default"

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

  // The REAL conversation content of the opened session (read-only replay).
  enum HistoryState: Equatable {
    case idle
    case loading
    case loaded([G0Transport.RunHistoryTurn])
    case empty
    case failed(String)
  }
  @Published private(set) var history: HistoryState = .idle
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

  private let connections = RemoteConnectionStore()
  private var pollTask: Task<Void, Never>?
  private var submitTask: Task<Void, Never>?
  private var catalogTask: Task<Void, Never>?
  private var historyTask: Task<Void, Never>?
  private var providersTask: Task<Void, Never>?
  private var commandsTask: Task<Void, Never>?
  private var projectsTask: Task<Void, Never>?
  private var generation = 0
  // Catalog/provider/project requests are independent of the currently opened
  // run. `resetRun()` must not make their useful replies disappear.
  private var dataGeneration = 0
  private var catalogLoadedAt: Date?
  private var providersLoadedAt: Date?
  private var projectsLoadedAt: Date?
  private var commandCache: [String: G0Transport.RunCommandCatalog] = [:]
  private var historyCache: [SessionIdentity: HistoryState] = [:]
  private var pendingSubmission: PendingSubmission?
  private var seenOutputSequences = Set<Int>()
  private var archivedActiveTurn = false

  private static let catalogFreshness: TimeInterval = 60
  private static let metadataFreshness: TimeInterval = 5 * 60
  #if DEBUG
  private var mockMode = false
  #endif

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

  private func makeClient() -> RemoteRunClient? {
    guard let connection = connections.load() else { return nil }
    return RemoteRunClient(connection: connection)
  }

  private func isFresh(_ date: Date?, within interval: TimeInterval) -> Bool {
    guard let date else { return false }
    return Date().timeIntervalSince(date) < interval
  }

  func chooseProject(_ ref: G0Transport.RunProjectRef) {
    chosen = ref
    if let providerId = chosenProvider?.id { loadCommands(providerId: providerId, cwd: ref.path) }
  }
  func chooseProvider(_ ref: G0Transport.RunProviderRef) {
    chosenProvider = ref
    chosenEffort = ref.efforts?.first(where: { $0.isDefault == true })?.id ?? ref.efforts?.first?.id
    permissionMode = ref.permissions?.first(where: { $0.id == "default" })?.id ?? ref.permissions?.first?.id ?? "default"
    if let cwd = chosen?.path { loadCommands(providerId: ref.id, cwd: cwd) }
  }
  func chooseEffort(_ id: String) {
    guard chosenProvider?.efforts?.contains(where: { $0.id == id }) == true else { return }
    chosenEffort = id
  }
  func choosePermission(_ id: String) {
    guard chosenProvider?.permissions?.contains(where: { $0.id == id }) == true else { return }
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

  // Load one session's real conversation content. Successful transcripts are
  // cached per identity for the app lifetime, so switching away and reopening a
  // conversation does not download and parse the same history again.
  func loadHistory(providerId: String, cwd: String, externalSessionId: String, force: Bool = false) {
    #if DEBUG
    if mockMode { return }
    #endif
    let identity = SessionIdentity.opened(providerId: providerId, cwd: cwd, externalSessionId: externalSessionId)
    if activeSessionIdentity != identity {
      resetRun()
      activeSessionIdentity = identity
    }
    if !force, let cached = historyCache[identity] {
      history = cached
      return
    }
    let cached = historyCache[identity]
    guard let client = makeClient() else {
      history = cached ?? .failed("尚未配对")
      return
    }
    historyTask?.cancel()
    let requestGeneration = generation
    history = cached ?? .loading
    historyTask = Task { [weak self] in
      do {
        let turns = try await client.history(providerId: providerId, cwd: cwd, externalSessionId: externalSessionId)
        await MainActor.run {
          guard let self, self.isCurrent(requestGeneration, identity: identity) else { return }
          self.historyTask = nil
          self.reachable = true
          let state: HistoryState = turns.isEmpty ? .empty : .loaded(turns)
          self.historyCache[identity] = state
          self.history = state
        }
      } catch {
        await MainActor.run {
          guard let self, self.isCurrent(requestGeneration, identity: identity) else { return }
          self.historyTask = nil
          self.reachable = false
          self.history = cached ?? .failed(Self.describe(error))
        }
      }
    }
  }

  // Re-opening the same session does not discard its live observation. If the
  // view was left while a run was active, resume its poll using the known run id.
  func prepareForSession(providerId: String, cwd: String, externalSessionId: String) {
    let identity = SessionIdentity.opened(providerId: providerId, cwd: cwd, externalSessionId: externalSessionId)
    if activeSessionIdentity == identity {
      if let runId, pollTask == nil, !isTerminal(generation: generation, identity: identity) {
        resumeObservation(runId: runId)
      }
      if history == .idle { loadHistory(providerId: providerId, cwd: cwd, externalSessionId: externalSessionId) }
      return
    }
    loadHistory(providerId: providerId, cwd: cwd, externalSessionId: externalSessionId)
  }

  func completedTurns(for identity: SessionIdentity) -> [CompletedLiveTurn] {
    completedLiveTurns[identity] ?? []
  }

  // Load the Providers the host offers. Only available ones are selectable (an
  // unavailable Provider cannot run). We deliberately do NOT auto-select a
  // default: describe() reports a Provider as available from CLI presence/auth,
  // which does not guarantee a run succeeds (e.g. a Provider whose CLI crashes on
  // launch). Auto-picking the first would silently send the first turn to a
  // Provider the user never chose - exactly the failure the owner hit. Requiring
  // an explicit pick (canSend gates on chosenProvider) keeps the choice honest.
  // If a previously-chosen Provider is no longer available, clear it.
  func loadProviders(preferredId: String? = nil, force: Bool = false) {
    #if DEBUG
    if mockMode {
      applyPreferredProvider(preferredId)
      return
    }
    #endif
    let hasCachedValue: Bool
    switch providers { case .loaded, .empty: hasCachedValue = true; default: hasCachedValue = false }
    applyPreferredProvider(preferredId)
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
          if let chosen = self.chosenProvider, !usable.contains(where: { $0.id == chosen.id }) {
            self.chosenProvider = nil
            self.chosenEffort = nil
            self.permissionMode = "default"
          }
          self.applyPreferredProvider(preferredId)
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

  private func applyPreferredProvider(_ preferredId: String?) {
    guard let preferredId, case let .loaded(items) = providers,
          let preferred = items.first(where: { $0.id == preferredId }), chosenProvider?.id != preferredId else { return }
    chooseProvider(preferred)
  }

  func loadCommands(providerId: String, cwd: String, force: Bool = false) {
    #if DEBUG
    if mockMode { return }
    #endif
    let key = providerId + "\u{1f}" + cwd
    if !force, let cached = commandCache[key] {
      commands = cached.commands.isEmpty ? .empty(cached.reason) : .loaded(cached.commands)
      return
    }
    commandsTask?.cancel()
    guard let client = makeClient() else { commands = .failed("尚未配对"); return }
    commands = .loading
    let requestDataGeneration = dataGeneration
    commandsTask = Task { [weak self] in
      do {
        let catalog = try await client.commands(providerId: providerId, cwd: cwd)
        await MainActor.run {
          guard let self, self.dataGeneration == requestDataGeneration else { return }
          self.commandsTask = nil
          self.reachable = true
          self.commandCache[key] = catalog
          self.commands = catalog.commands.isEmpty ? .empty(catalog.reason) : .loaded(catalog.commands)
        }
      } catch {
        await MainActor.run {
          guard let self, self.dataGeneration == requestDataGeneration else { return }
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
    directories = .loading
    let requestGeneration = generation
    Task { [weak self] in
      do {
        let listing = try await client.directories(path: path)
        await MainActor.run {
          guard let self, self.generation == requestGeneration else { return }
          self.reachable = true; self.directories = .loaded(listing)
        }
      } catch {
        await MainActor.run {
          guard let self, self.generation == requestGeneration else { return }
          self.reachable = false; self.directories = .failed(Self.describe(error))
        }
      }
    }
  }

  // Submit a durable intent. Until a receipt arrives the state is explicitly
  // submitting; a transport-unknown result keeps the same intentId available
  // for a user retry, rather than creating a second host run.
  func submit(prompt: String, providerId: String, attachments: [RemoteRunClient.Attachment] = []) {
    let trimmed = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return }
    guard let cwd = chosen?.path else { submitError = "请先选择一个主机已授权的项目"; return }
    #if DEBUG
    if mockMode { applyMockRun(prompt: trimmed, attachments: attachments); return }
    #endif
    guard makeClient() != nil else { submitError = "尚未配对"; return }
    let identity = SessionIdentity.new(providerId: providerId, cwd: cwd)
    resetRun()
    activeSessionIdentity = identity
    self.prompt = trimmed
    sentAttachments = attachments.map { SentAttachment(name: $0.name, kind: $0.kind, size: $0.size) }
    let routing = RemoteRunClient.Routing(cwd: cwd, providerId: providerId, agentProfileId: nil, prompt: trimmed,
                                          modelId: chosenProvider?.modelId, effort: chosenEffort,
                                          permissionMode: permissionMode, attachments: attachments)
    pendingSubmission = PendingSubmission(intentId: UUID().uuidString.lowercased(), routing: routing, identity: identity)
    lifecycle = .submitting
    submitPending()
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
    submitTask?.cancel()
    let requestGeneration = generation
    submitTask = Task { [weak self] in
      do {
        let outcome = try await client.submit(routing: pending.routing, intentId: pending.intentId)
        await MainActor.run {
          guard let self, self.isCurrent(requestGeneration, identity: pending.identity) else { return }
          self.reachable = true
          self.runId = outcome.runId
          self.pendingSubmission = nil
          self.retryAvailable = false
          self.submitError = nil
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
      while !Task.isCancelled {
        do {
          let page = try await client.poll(cursor: ledgerCursor)
          ledgerCursor = page.cursor
          for ev in page.events where ev.runId == runId {
            self.apply(event: ev, generation: generation, identity: identity)
          }
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
          await self.drainOutput(client: client, runId: runId, cursor: outputCursor,
                                 generation: generation, identity: identity)
          await MainActor.run {
            guard self.isCurrent(generation, identity: identity) else { return }
            self.archiveActiveTurnIfNeeded()
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
    submitError = nil
    startPolling(runId: runId, client: client, generation: generation, identity: identity)
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
      resetRun()
      activeSessionIdentity = identity
    }
    self.runId = runId
    if lifecycle == .unknown { lifecycle = .recorded }
    resumeObservation(runId: runId)
  }

  private func drainOutput(client: RemoteRunClient, runId: String, cursor: Int,
                          generation: Int, identity: SessionIdentity) async {
    var cursor = cursor
    while !Task.isCancelled {
      guard let page = try? await client.output(runId: runId, cursor: cursor) else {
        await MainActor.run {
          guard self.isCurrent(generation, identity: identity) else { return }
          self.observationInterrupted = true
          self.submitError = "观察中断：无法读取运行的最后输出，运行结果未知。"
        }
        return
      }
      let next = page.cursor
      for chunk in page.chunks {
        append(chunk: chunk, generation: generation, identity: identity)
      }
      // The host's cursor is authoritative. Stop only when the page is empty or
      // did not advance; this drains arbitrarily many pages, including >400 chunks.
      if !Self.shouldContinueDrain(cursor: cursor, next: next, chunkCount: page.chunks.count) { return }
      cursor = next
    }
  }

  nonisolated private static func responseMatches(currentGeneration: Int, requestGeneration: Int,
                                                   currentIdentity: SessionIdentity?, requestIdentity: SessionIdentity) -> Bool {
    currentGeneration == requestGeneration && currentIdentity == requestIdentity
  }

  nonisolated private static func shouldContinueDrain(cursor: Int, next: Int, chunkCount: Int) -> Bool {
    chunkCount > 0 && next > cursor
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
        // The Provider's own session id for THIS run. Captured so a chained
        // follow-up resumes the latest session (continuous memory), not a stale id.
        if marker["event"] == "session", let ext = marker["externalSessionId"], !ext.isEmpty { liveExternalSessionId = ext }
      }
    case "run_settled": lifecycle = .settled
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

  func resetRun() {
    archiveActiveTurnIfNeeded()
    generation += 1
    pollTask?.cancel(); pollTask = nil
    submitTask?.cancel(); submitTask = nil
    historyTask?.cancel(); historyTask = nil
    pendingSubmission = nil
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
    retryAvailable = false
    archivedActiveTurn = false
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
    historyTask?.cancel(); historyTask = nil
    providersTask?.cancel(); providersTask = nil
    commandsTask?.cancel(); commandsTask = nil
    projectsTask?.cancel(); projectsTask = nil
    pendingSubmission = nil
    projects = .idle; directories = .idle; chosen = nil
    providers = .idle; commands = .idle; chosenProvider = nil; chosenEffort = nil; permissionMode = "default"
    catalog = .idle; history = .idle; reachable = nil
    catalogLoadedAt = nil; providersLoadedAt = nil; projectsLoadedAt = nil; commandCache = [:]; historyCache = [:]
    lifecycle = .unknown; output = []; seenOutputSequences = []; prompt = nil; sentAttachments = []
    runId = nil; submitError = nil; truncated = false; resultSummary = nil
    liveExternalSessionId = nil; activeSessionIdentity = nil
    observationInterrupted = false; retryAvailable = false
    completedLiveTurns = [:]
    archivedActiveTurn = false
    #if DEBUG
    mockMode = false
    #endif
  }

  // Send a follow-up that CONTINUES an opened session (same Provider + cwd +
  // session id) so the conversation keeps its context. Unlike submit(), the
  // target is explicit (from the opened session), not the new-session pickers.
  // Chained follow-ups resume the LATEST reported session id when available.
  func submitFollowUp(prompt: String, providerId: String, cwd: String, resume: String, attachments: [RemoteRunClient.Attachment] = []) {
    let trimmed = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return }
    #if DEBUG
    if mockMode { applyMockRun(prompt: trimmed, attachments: attachments); liveExternalSessionId = resume; return }
    #endif
    guard makeClient() != nil else { submitError = "尚未配对"; return }
    let resumeId = liveExternalSessionId ?? resume
    // The routing resume id may advance after each Provider turn, but the UI
    // identity must remain the originally opened conversation. Otherwise every
    // new native id moves completed turns to a key the current transcript view
    // does not query, making the previous exchange disappear again.
    let identity = Self.followUpIdentity(current: activeSessionIdentity, providerId: providerId,
                                         cwd: cwd, originalResume: resume)
    let modelId = chosenProvider?.id == providerId ? chosenProvider?.modelId : nil
    let effort = chosenProvider?.id == providerId ? chosenEffort : nil
    let permission = chosenProvider?.id == providerId ? permissionMode : "default"
    resetRun()
    activeSessionIdentity = identity
    self.prompt = trimmed
    sentAttachments = attachments.map { SentAttachment(name: $0.name, kind: $0.kind, size: $0.size) }
    liveExternalSessionId = resumeId
    let routing = RemoteRunClient.Routing(cwd: cwd, providerId: providerId, agentProfileId: nil, prompt: trimmed,
                                          modelId: modelId, effort: effort, permissionMode: permission,
                                          resume: resumeId, attachments: attachments)
    pendingSubmission = PendingSubmission(intentId: UUID().uuidString.lowercased(), routing: routing, identity: identity)
    lifecycle = .submitting
    submitPending()
  }

  #if DEBUG
  // Pure checks used by the launch self-test; they exercise the invariants that
  // do not require a relay or Provider.
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

  nonisolated static func selfTestFollowUpIdentity() -> Bool {
    let opened = SessionIdentity.opened(providerId: "codex", cwd: "/repo", externalSessionId: "original")
    let kept = followUpIdentity(current: opened, providerId: "codex", cwd: "/repo", originalResume: "latest")
    let replaced = followUpIdentity(current: opened, providerId: "qoder", cwd: "/repo", originalResume: "qoder")
    return kept == opened && replaced.externalSessionId == "qoder" && replaced != opened
  }

  // Visual-only fixtures for `-uiPreview -uiMockData`. They deliberately never
  // touch Keychain, relay, Provider, ledger, or Release execution paths.
  func applyUIPreviewArguments() {
    guard ProcessInfo.processInfo.arguments.contains("-uiMockData") else { return }
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
      G0Transport.RunProviderRef(id: "codex", label: "Codex", available: true, modelId: "gpt-5.6-sol", efforts: efforts, permissions: permissions),
      G0Transport.RunProviderRef(id: "qoder", label: "Qoder", available: true, modelId: "ultimate", efforts: nil, permissions: permissions),
      G0Transport.RunProviderRef(id: "opencode", label: "OpenCode", available: true, modelId: nil, efforts: nil, permissions: [permissions[0], permissions[2]])
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
    output = [
      OutputLine(id: 1, kind: "reasoning", text: "先对齐信息架构，再调整视觉密度。"),
      OutputLine(id: 2, kind: "tool", text: "编辑 HomeView.swift"),
      OutputLine(id: 3, kind: "tool_result", text: "3 个区块已更新 · 0 个错误"),
      OutputLine(id: 4, kind: "output", text: "## 已完成\n\n首页已按 **置顶 + 项目** 重新组织，并保留 [运行证据](https://example.com/evidence)。\n\n- 会话标题成为主信息\n- `Provider`、更新时间和状态降为轻量元信息\n- 底部仅保留搜索与新建入口\n\n```swift\nLazyVStack(spacing: 12) {\n  sessionRows\n}\n```")
    ]
    resultSummary = "输入 18,420 · 输出 1,286 · $0.084"
    liveExternalSessionId = "codex-mock-session"
    loadMockDirectories(path: chosen?.path)
    if ProcessInfo.processInfo.arguments.contains("-uiMockLoading") { history = .loading }
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
      return code
    }
    return "\(error)"
  }
}
