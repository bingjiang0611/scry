import Foundation
import Observation
import Combine
import RemoteTransport

// Labels and routes are display metadata. A scope is the gateway grant plus
// the immutable final-host grant binding, not the selected row or a host name.
struct ExecutionTargetScope: Codable, Hashable, Sendable, Identifiable {
  let gatewayHostId: String
  let gatewayIdentity: String?
  let targetId: String?
  let binding: String?
  let hostId: String
  let label: String

  var id: String { [gatewayIdentity ?? gatewayHostId, targetId ?? "local", binding ?? ""].joined(separator: "\u{0}") }
  var isLocal: Bool { targetId == nil }
  var targetBinding: G0Transport.ExecutionTargetBinding? {
    guard let targetId, let binding else { return nil }
    return G0Transport.ExecutionTargetBinding(id: targetId, binding: binding)
  }
  static func == (lhs: Self, rhs: Self) -> Bool { lhs.id == rhs.id }
  func hash(into hasher: inout Hasher) { hasher.combine(id) }

  init(gatewayHostId: String, targetId: String, binding: String, hostId: String, label: String, gatewayIdentity: String? = nil) {
    self.gatewayHostId = gatewayHostId; self.gatewayIdentity = gatewayIdentity
    self.targetId = targetId; self.binding = binding; self.hostId = hostId; self.label = label
  }
  init(gatewayHostId: String, label: String, gatewayIdentity: String? = nil) {
    self.gatewayHostId = gatewayHostId; self.gatewayIdentity = gatewayIdentity
    self.targetId = nil; self.binding = nil; self.hostId = gatewayHostId; self.label = label
  }
  init(gatewayHostId: String, target: G0Transport.ExecutionTargetRef, gatewayIdentity: String? = nil) {
    self.init(gatewayHostId: gatewayHostId, targetId: target.id, binding: target.binding,
              hostId: target.hostId, label: target.label, gatewayIdentity: gatewayIdentity)
  }
}

@MainActor
@Observable
final class ExecutionTargetCoordinator {
  struct HomeSession: Identifiable, Equatable {
    let session: G0Transport.RunSessionRef
    let scope: ExecutionTargetScope
    var id: RemoteRunStore.SessionIdentity {
      .opened(providerId: session.providerId, agentProfileId: session.agentProfileId, cwd: session.cwd,
              externalSessionId: session.sessionId, scope: scope)
    }
  }
  enum HomeFilter: Equatable { case all, target(ExecutionTargetScope) }
  struct RefreshIssue: Identifiable {
    let scope: ExecutionTargetScope
    let discovery: Bool
    let failure: RemoteRunStore.CatalogRefreshFailure
    let verifiedAt: Date?
    var id: String { scope.id + (discovery ? ":discovery" : ":sessions") }
    var summary: String {
      if case .target = failure { return failure.summary }
      return ConnectionCopy.hostRefreshFailure(scope.label, discovery: discovery, summary: failure.summary)
    }
    var diagnostic: String {
      let cache: Bool
      switch failure { case .cacheRead, .cacheWrite, .cacheWriteRejected: cache = true; default: cache = false }
      return ConnectionCopy.refreshDiagnostic(host: scope.label, discovery: discovery, cache: cache,
        verifiedAt: verifiedAt, detail: failure.technicalDetail)
    }
  }

  private(set) var discoveredTargets: [ExecutionTargetScope] = []
  private(set) var homeSessions: [HomeSession] = []
  private(set) var homeLoading = false
  private(set) var homeFailure: RemoteRunStore.CatalogRefreshFailure?
  private(set) var discoveryIssue: RemoteRunStore.CatalogRefreshFailure?
  private(set) var catalogFetchedAt: Date?
  private(set) var forwardingSupported = false
  private(set) var recoveryUnavailable = false
  private(set) var selectedScope: ExecutionTargetScope
  private(set) var newTaskScope: ExecutionTargetScope
  private(set) var homeFilter: HomeFilter = .all

  let localStore: RemoteRunStore
  private let connections: RemoteConnectionStore
  private let historyDisk: RemoteHistoryCache
  private let stateDirectory: URL?
  private let defaults: UserDefaults
  private var gatewayIdentity: String?
  private var gatewayLabel = ConnectionCopy.gatewayHost
  private var stores: [ExecutionTargetScope: RemoteRunStore] = [:]
  private var rebuilding = false
  private var foregroundEligible = false
  private var discoveryTask: Task<Void, Never>?
  private var refreshTask: Task<Bool, Never>?
  private var authorityRevision = 0
  private var homeVisible = false
  private var recoveryTask: Task<Void, Never>?
  private var recoveryAttempt = 0
  private var recoveryGeneration = 0
  private var networkObserver: AnyCancellable?
  // A short recovery burst, not perpetual background polling. Foreground/path
  // events start a new burst; authorization/protocol/cache failures never retry.
  private static let recoveryDelays: [Duration] = [.seconds(1), .seconds(3), .seconds(8)]
  #if DEBUG
  var recoveryWait: ((Duration) async throws -> Void)?
  func finishRecoveryForCheck() async {
    while let task = recoveryTask { await task.value }
    _ = await refreshTask?.value
  }
  #endif
  private static let retainedLimit = 64
  #if DEBUG
  var targetCatalogFixture: (() async throws -> G0Transport.ExecutionTargetCatalog)?
  #endif

  init(connections: RemoteConnectionStore = RemoteConnectionStore(), historyDisk: RemoteHistoryCache = RemoteHistoryCache(), defaults: UserDefaults? = nil,
       stateDirectory: URL? = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first?.appendingPathComponent("ScryRemote", isDirectory: true)) {
    self.connections = connections; self.historyDisk = historyDisk; self.defaults = defaults ?? connections.defaults; self.stateDirectory = stateDirectory
    self.localStore = RemoteRunStore(connections: connections, historyDisk: historyDisk, stateDirectory: stateDirectory)
    let connection = connections.load()
    let identity = connection.map { RemoteHistoryCache.catalogKey(connection: $0) }
    gatewayIdentity = identity
    let scope = ExecutionTargetScope(gatewayHostId: connection?.hostId ?? "local", label: ConnectionCopy.gatewayHost, gatewayIdentity: identity)
    selectedScope = scope; newTaskScope = scope
    stores[scope] = localStore
    observe(localStore, scope: scope)
    restoreDescriptors()
    networkObserver = NotificationCenter.default.publisher(for: RemoteSessionRegistry.pathChangedNotification)
      .receive(on: RunLoop.main).sink { [weak self] _ in
        self?.requestHomeRecovery(resetBudget: true)
      }
  }

  var localScope: ExecutionTargetScope {
    ExecutionTargetScope(gatewayHostId: connections.load()?.hostId ?? "local", label: gatewayLabel, gatewayIdentity: gatewayIdentity)
  }
  var selectedStore: RemoteRunStore { store(for: selectedScope) }
  var newTaskStore: RemoteRunStore { store(for: newTaskScope) }
  var targetScopes: [ExecutionTargetScope] { [localScope] + discoveredTargets }
  var visibleScopes: [ExecutionTargetScope] {
    switch homeFilter { case .all: return targetScopes; case let .target(scope): return [scope] }
  }
  var lastFullRefresh: Date? {
    if recoveryUnavailable && homeFilter == .all { return nil }
    if let catalogFetchedAt { return catalogFetchedAt }
    if homeLoading || homeFailure != nil || (homeFilter == .all && discoveryIssue != nil) { return nil }
    let dates = visibleScopes.compactMap { store(for: $0).catalogVerifiedAt }
    return dates.count == visibleScopes.count ? dates.min() : nil
  }
  var refreshIssues: [RefreshIssue] {
    var issues: [RefreshIssue] = []
    if homeFilter == .all, let discoveryIssue {
      issues.append(RefreshIssue(scope: localScope, discovery: true, failure: discoveryIssue, verifiedAt: nil))
    }
    for scope in visibleScopes {
      let store = store(for: scope)
      if let failure = store.catalogRefreshFailure {
        issues.append(RefreshIssue(scope: scope, discovery: false, failure: failure, verifiedAt: store.catalogVerifiedAt))
      }
    }
    return issues
  }
  var aggregatesHosts: Bool { !discoveredTargets.isEmpty }
  var hasPendingWork: Bool { stores.values.contains { $0.hasUnsentMessages || $0.hasUnresolvedRun } }
  var pendingScopes: [ExecutionTargetScope] { targetScopes.filter { store(for: $0).hasUnresolvedRun || store(for: $0).hasUnsentMessages } }
  var filterLabel: String {
    switch homeFilter { case .all: return ConnectionCopy.allHosts; case let .target(scope): return scope.label }
  }

  func store(for scope: ExecutionTargetScope) -> RemoteRunStore {
    if scope.isLocal { return localStore }
    if let value = stores[scope] { return value }
    // Discovery + retained unresolved bindings have an explicit capacity bound.
    // Never evict a store with unknown delivery to create another route.
    pruneStores()
    precondition(stores.count <= Self.retainedLimit + 2)
    let value = RemoteRunStore(connections: connections, historyDisk: historyDisk, stateDirectory: stateDirectory, targetScope: scope, prefetchEnabled: false)
    value.setLiveRunsForegroundEligible(foregroundEligible)
    stores[scope] = value
    observe(value, scope: scope)
    return value
  }

  func select(_ scope: ExecutionTargetScope) { selectedScope = scope; _ = store(for: scope) }
  func selectNewTask(_ scope: ExecutionTargetScope) {
    guard newTaskScope != scope else { return }
    _ = beginNewTask(scope: scope)
  }
  @discardableResult func beginNewTask(scope explicit: ExecutionTargetScope? = nil) -> Bool {
    let scope: ExecutionTargetScope
    if let explicit { scope = explicit }
    else { switch homeFilter { case let .target(filtered): scope = filtered; case .all: scope = newTaskScope } }
    let next = store(for: scope)
    guard next.detachFocusedRun() else { return false }
    next.resetNewTaskContext()
    newTaskScope = scope
    return true
  }
  func focusNewTask() { select(newTaskScope) }
  func selectFilter(_ filter: HomeFilter) { homeFilter = filter; catalogFetchedAt = nil; homeFailure = nil; rebuildHomeSessions() }

  private func observe(_ store: RemoteRunStore, scope: ExecutionTargetScope) {
    let revision = authorityRevision
    // Only the materialized home-session projection needs an explicit observer.
    // SwiftUI tracks nested questions/outbox/lifecycle reads directly. Forwarding
    // object-wide changes here would reintroduce stream-wide invalidations.
    withObservationTracking { _ = store.catalog } onChange: { [weak self, weak store] in
      // Observation fires before the write and is one-shot. Read/rearm on the
      // next main-actor turn, then rebuild from the latest catalog. An old grant
      // or pruned store must not rearm after connectionChanged().
      Task { @MainActor [weak self, weak store] in
        guard let self, let store, self.authorityRevision == revision,
              self.stores[scope] === store else { return }
        self.observe(store, scope: scope)
        self.scheduleRebuild()
      }
    }
  }
  private func scheduleRebuild() {
    guard !rebuilding else { return }
    rebuilding = true
    Task { @MainActor [weak self] in
      guard let self else { return }
      self.rebuilding = false
      self.rebuildHomeSessions()
    }
  }

  func refreshTargets() async {
    if let discoveryTask { await discoveryTask.value; return }
    let revision = authorityRevision
    let task = Task { @MainActor [weak self] in
      guard let self else { return }
      await self.readTargets()
    }
    // Keep one discovery in flight, including the authorization/metadata phase.
    discoveryTask = task
    await task.value
    if authorityRevision == revision { discoveryTask = nil }
  }

  private func readTargets() async {
    #if DEBUG
    if ProcessInfo.processInfo.arguments.contains("-uiPreview") { return }
    #endif
    guard let connection = connections.load() else { discoveryIssue = .transport(ConnectionCopy.notPaired); return }
    let identity = RemoteHistoryCache.catalogKey(connection: connection)
    guard gatewayIdentity == identity else { discoveryIssue = .transport(ConnectionCopy.targetDiscoveryFailure); return }
    do {
      let catalog: G0Transport.ExecutionTargetCatalog
      #if DEBUG
      if let targetCatalogFixture { catalog = try await targetCatalogFixture() }
      else { catalog = try await RemoteRunClient(connection: connection).executionTargets() }
      #else
      catalog = try await RemoteRunClient(connection: connection).executionTargets()
      #endif
      guard !Task.isCancelled, connections.load() == connection else { return }
      let current = catalog.targets.map { ExecutionTargetScope(gatewayHostId: catalog.gateway.hostId, target: $0, gatewayIdentity: identity) }
      let retained = current + discoveredTargets.filter { old in
        !current.contains(old) && (store(for: old).hasUnsentMessages || store(for: old).hasUnresolvedRun)
      }
      guard retained.count <= Self.retainedLimit else { discoveryIssue = .transport(ConnectionCopy.targetCapacity); return }
      gatewayLabel = catalog.gateway.label
      if selectedScope.isLocal { selectedScope = localScope }
      if newTaskScope.isLocal { newTaskScope = localScope }
      discoveredTargets = retained
      forwardingSupported = true
      for scope in retained {
        let available = catalog.targets.contains { $0.id == scope.targetId && $0.binding == scope.binding && $0.state == "connected" }
        let store = store(for: scope)
        store.updateTargetAvailability(available)
        if available { store.startLiveRuns() } else { store.stopLiveRuns() }
      }
      persistDescriptors(retained)
      discoveryIssue = recoveryUnavailable ? .transport(ConnectionCopy.targetMetadataUnavailable) : nil
    } catch {
      guard !Task.isCancelled, connections.load() == connection else { return }
      let detail: String
      if case G0Transport.RunError.host(code: "unknown_op") = error {
        detail = ConnectionCopy.forwardingUnsupported
      } else {
        detail = RemoteRunStore.describe(error)
      }
      let diagnostic = ConnectionCopy.targetDiscoveryDiagnostic(detail)
      if case let G0Transport.RunError.host(code) = error {
        discoveryIssue = ["device_not_authorized", "grant_expired", "grant_revoked"].contains(code)
          ? .authorization(diagnostic) : .protocolMismatch(diagnostic)
      } else {
        discoveryIssue = .transport(diagnostic, retryable: RelayTransportError.permitsReadRecovery(error))
      }
      // A failed discovery cannot redirect an existing conversation/new draft.
    }
  }

  @discardableResult func refreshHome(automatic: Bool = false) async -> Bool {
    if let refreshTask { return await refreshTask.value }
    if !automatic { cancelHomeRecovery(); recoveryAttempt = 0 }
    // Freeze the last complete visible snapshot before any constituent store
    // advances. A partial/local success cannot attest a full host refresh.
    catalogFetchedAt = lastFullRefresh
    homeLoading = true
    let filter = homeFilter
    let revision = authorityRevision
    let recoveryRevision = recoveryGeneration
    let task = Task { @MainActor [weak self] () -> Bool in
      guard let self else { return false }
      // Local cached content must not wait for optional target discovery. The
      // same single-flight refresh is awaited below, never requested twice.
      guard !automatic || self.recoveryIsCurrent(recoveryRevision) else { return false }
      let recoveringFailure = automatic && !self.refreshIssues.isEmpty
      let wantsLocal = (filter == .all || filter == .target(self.localScope)) &&
        (!recoveringFailure || self.localStore.catalogRefreshFailure?.allowsAutomaticRecovery == true)
      let localRefresh: Task<Bool, Never>? = wantsLocal ? Task { await self.localStore.refreshSessions() } : nil
      defer { localRefresh?.cancel() }
      if filter != .target(self.localScope),
         !recoveringFailure || self.discoveryIssue?.allowsAutomaticRecovery == true { await self.refreshTargets() }
      guard !Task.isCancelled, self.authorityRevision == revision,
            !automatic || self.recoveryIsCurrent(recoveryRevision) else { return false }
      let scopes = self.visibleScopes
      let remoteScopes = scopes.filter { !$0.isLocal &&
        (!recoveringFailure || self.store(for: $0).catalogRefreshFailure?.allowsAutomaticRecovery == true) }
      var succeeded = true
      for index in stride(from: 0, to: remoteScopes.count, by: 2) {
        guard !automatic || self.recoveryIsCurrent(recoveryRevision) else { return false }
        let batch = remoteScopes[index..<min(index + 2, remoteScopes.count)].map { self.store(for: $0) }
        await withTaskGroup(of: Bool.self) { group in
          for store in batch { group.addTask { await store.refreshSessions() } }
          for await result in group { succeeded = succeeded && result }
        }
      }
      let localSucceeded = await localRefresh?.value ?? true
      succeeded = succeeded && localSucceeded
      guard !Task.isCancelled, self.authorityRevision == revision, self.homeFilter == filter,
            !automatic || self.recoveryIsCurrent(recoveryRevision) else { return false }
      self.rebuildHomeSessions()
      let failed = scopes.first { self.store(for: $0).catalogRefreshFailure != nil }
      self.homeFailure = failed.flatMap { self.store(for: $0).catalogRefreshFailure }
      if case .all = self.homeFilter { self.homeFailure = self.homeFailure ?? self.discoveryIssue }
      if !succeeded && self.homeFailure == nil { self.homeFailure = .partial(ConnectionCopy.partialRefreshFailure) }
      if succeeded && self.homeFailure == nil { self.catalogFetchedAt = Date() }
      return succeeded && self.homeFailure == nil
    }
    refreshTask = task
    let result = await task.value
    if authorityRevision == revision {
      refreshTask = nil; homeLoading = false
      if !automatic || recoveryIsCurrent(recoveryRevision) {
        if result { recoveryAttempt = 0 }
        else { scheduleHomeRecovery() }
      }
    }
    return result
  }

  func rebuildHomeSessions() {
    homeSessions = visibleScopes.flatMap { scope -> [HomeSession] in
      guard case let .loaded(list) = store(for: scope).catalog else { return [HomeSession]() }
      return list.map { HomeSession(session: $0, scope: scope) }
    }.sorted { lhs, rhs in
      if (lhs.session.pinnedAt != nil) != (rhs.session.pinnedAt != nil) { return lhs.session.pinnedAt != nil }
      return lhs.session.ts > rhs.session.ts
    }
  }

  func prepareConnectionReplacement(_ connection: RemoteConnection) throws {
    guard !recoveryUnavailable else { throw RemoteRunStore.ConnectionReplacementError.recoveryUnavailable }
    guard !hasPendingWork else { throw RemoteRunStore.ConnectionReplacementError.pendingWork }
    for store in stores.values { try store.prepareConnectionReplacement(connection) }
  }

  func clearAllState() async throws {
    guard !recoveryUnavailable else { throw RemoteRunStore.ConnectionReplacementError.recoveryUnavailable }
    guard !hasPendingWork else { throw RemoteRunStore.ConnectionReplacementError.pendingWork }
    for store in stores.values { try store.clearAllState() }
    try await localStore.clearHistoryCache()
    if let descriptorKey { defaults.removeObject(forKey: descriptorKey) }
  }

  func connectionChanged() {
    let identity = connections.load().map { RemoteHistoryCache.catalogKey(connection: $0) }
    guard identity != gatewayIdentity else { return }
    authorityRevision += 1
    discoveryTask?.cancel(); discoveryTask = nil
    refreshTask?.cancel(); refreshTask = nil
    backgrounded()
    recoveryAttempt = 0
    stores = [:]
    gatewayIdentity = identity; gatewayLabel = ConnectionCopy.gatewayHost
    discoveredTargets = []; homeSessions = []; homeFailure = nil; discoveryIssue = nil
    catalogFetchedAt = nil; forwardingSupported = false; homeLoading = false; recoveryUnavailable = false
    selectedScope = localScope; newTaskScope = localScope; homeFilter = .all
    stores[localScope] = localStore
    observe(localStore, scope: localScope)
    restoreDescriptors()
  }

  func foregrounded() {
    foregroundEligible = true
    for store in stores.values { store.setLiveRunsForegroundEligible(true) }
    for (scope, store) in stores where scope.isLocal || store.executionTargetAvailable || store.hasUnresolvedRun || store.hasUnsentMessages { store.foregrounded() }
    requestHomeRecovery(resetBudget: true)
  }
  func backgrounded() {
    foregroundEligible = false
    cancelHomeRecovery()
    for store in stores.values { store.setLiveRunsForegroundEligible(false) }
  }

  func setHomeVisible(_ visible: Bool) {
    homeVisible = visible
    if !visible { cancelHomeRecovery() }
  }

  private func requestHomeRecovery(resetBudget: Bool) {
    guard foregroundEligible, homeVisible, connections.load() != nil else { return }
    if resetBudget { recoveryAttempt = 0 }
    guard recoveryTask == nil else { return }
    let generation = recoveryGeneration
    recoveryTask = Task { @MainActor [weak self] in
      guard let self else { return }
      _ = await self.refreshHome(automatic: true)
      guard generation == self.recoveryGeneration else { return }
      self.recoveryTask = nil
      if !Task.isCancelled { self.scheduleHomeRecovery() }
    }
  }

  private func scheduleHomeRecovery() {
    let failures = refreshIssues.map(\.failure)
    guard foregroundEligible, homeVisible, recoveryTask == nil,
          failures.contains(where: \.allowsAutomaticRecovery),
          recoveryAttempt < Self.recoveryDelays.count else { return }
    let delay = Self.recoveryDelays[recoveryAttempt]
    recoveryAttempt += 1
    let generation = recoveryGeneration
    recoveryTask = Task { @MainActor [weak self] in
      guard let self else { return }
      do {
        #if DEBUG
        if let recoveryWait = self.recoveryWait { try await recoveryWait(delay) }
        else { try await Task.sleep(for: delay) }
        #else
        try await Task.sleep(for: delay)
        #endif
        try Task.checkCancellation()
      } catch { return }
      _ = await self.refreshHome(automatic: true)
      guard generation == self.recoveryGeneration else { return }
      self.recoveryTask = nil
      if !Task.isCancelled { self.scheduleHomeRecovery() }
    }
  }

  private func recoveryIsCurrent(_ generation: Int) -> Bool {
    generation == recoveryGeneration && foregroundEligible && homeVisible
  }

  private func cancelHomeRecovery() {
    recoveryGeneration += 1
    recoveryTask?.cancel(); recoveryTask = nil
  }

  private var descriptorKey: String? { gatewayIdentity.map { "com.scry.remote.execution-targets." + $0 } }
  private func pruneStores() {
    let kept = Set(targetScopes + [selectedScope, newTaskScope])
    for (scope, store) in stores where !scope.isLocal && !kept.contains(scope) && !store.hasUnsentMessages && !store.hasUnresolvedRun {
      store.stopLiveRuns()
      stores.removeValue(forKey: scope)
    }
  }
  private func persistDescriptors(_ scopes: [ExecutionTargetScope]) {
    guard !recoveryUnavailable, let descriptorKey else { return }
    // Only strings and optional strings are encoded; this cannot encode a
    // nonfinite number or an unsupported value. No credentials are persisted.
    defaults.set(try! JSONEncoder().encode(scopes), forKey: descriptorKey)
  }
  private func restoreDescriptors() {
    #if DEBUG
    if ProcessInfo.processInfo.arguments.contains("-uiPreview") { return }
    #endif
    guard let descriptorKey, let data = defaults.data(forKey: descriptorKey) else { return }
    do {
      guard data.count <= 256 * 1024 else { throw CocoaError(.fileReadCorruptFile) }
      let scopes = try JSONDecoder().decode([ExecutionTargetScope].self, from: data)
      guard scopes.count <= Self.retainedLimit, Set(scopes).count == scopes.count,
            scopes.allSatisfy({ !$0.isLocal && $0.targetBinding?.isValid == true && !$0.hostId.isEmpty && $0.hostId.utf16.count <= 128 && $0.label.utf16.count <= 256 && $0.gatewayIdentity == gatewayIdentity && $0.gatewayHostId == localScope.gatewayHostId }) else { throw CocoaError(.fileReadCorruptFile) }
      discoveredTargets = scopes
      for scope in scopes { store(for: scope).updateTargetAvailability(false) }
    } catch {
      recoveryUnavailable = true
      discoveryIssue = .transport(ConnectionCopy.targetMetadataUnavailable)
    }
  }
}
