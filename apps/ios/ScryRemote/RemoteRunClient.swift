import CryptoKit
import Foundation
import Network
import RemoteTransport
import UniformTypeIdentifiers

// Device-side RUN client over the POST-PAIRING channel: strict inner TLS 1.3
// mTLS to the host, presenting the CA-GRANTED device certificate (issued at
// pairing confirmation) and pinning the host anchor. It performs NO trust
// decision of its own — the granted cert + anchor-pinned inner TLS ARE the
// authorization, verified on the host by InnerMtlsHost -> HostController against
// the device's fingerprint (never anything in the request body).
//
// A submitted intent is a DURABLE INTENT (recorded != executed): the host
// records it, the dispatcher drives exactly-once execution through the gated
// executor, and the device learns the real lifecycle only by polling the ledger.
// This client never fabricates a lifecycle; it surfaces host/transport errors.
// Disk IO stays off the UI actor. Each view owns a private directory containing
// only its downloaded file; WebKit never receives access to shared app storage.
actor RemoteFileDownloadSink {
  private var directory: URL?
  private var url: URL?
  private var handle: FileHandle?

  func start(name: String, mimeType: String? = nil) throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent("scry-download-" + UUID().uuidString, isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
    self.directory = directory
    var url = directory.appendingPathComponent(name, isDirectory: false)
    if url.pathExtension.isEmpty, let mimeType, let ext = UTType(mimeType: mimeType)?.preferredFilenameExtension {
      url.appendPathExtension(ext)
    }
    guard FileManager.default.createFile(atPath: url.path, contents: nil) else { throw CocoaError(.fileWriteUnknown) }
    self.url = url
    handle = try FileHandle(forWritingTo: url)
  }
  func write(_ data: Data) throws {
    guard let handle else { throw RemoteRunClient.ClientError.invalidFileDownload }
    try handle.write(contentsOf: data)
  }
  func finish() throws -> URL {
    guard let url, let handle else { throw RemoteRunClient.ClientError.invalidFileDownload }
    try handle.close()
    self.handle = nil
    return url
  }
  func remove() {
    try? handle?.close()
    handle = nil
    if let directory { try? FileManager.default.removeItem(at: directory) }
    directory = nil; url = nil
  }
}

struct RemoteRunClient {
  let keychain: RemoteKeychain
  let connection: RemoteConnection
  let executionTarget: G0Transport.ExecutionTargetBinding?

  init(connection: RemoteConnection, keychain: RemoteKeychain = RemoteKeychain(),
       executionTarget: G0Transport.ExecutionTargetBinding? = nil) {
    self.connection = connection
    self.keychain = keychain
    self.executionTarget = executionTarget
  }

  enum ClientError: Error, Equatable { case missingCredentials, invalidFileDownload }

  func fileDownload(_ query: G0Transport.FileDownloadQuery) async throws -> G0Transport.FileDownloadResult {
    try await G0Transport.relayFileDownload(endpoint: endpoint(), identity: try identity(), query: query)
  }

  func workspace(_ query: G0Transport.WorkspaceQuery) async throws -> G0Transport.WorkspaceResult {
    try await G0Transport.relayWorkspace(endpoint: endpoint(), identity: try identity(), query: query)
  }

  // A bounded attachment carried inside the existing inner-mTLS request. Images
  // become native Provider image inputs on the Mac; UTF-8 text/code files are
  // appended to Provider context with their real filename. Unsupported binary
  // files never masquerade as uploaded content.
  struct Attachment: Codable, Equatable {
    enum Kind: String, Codable, Equatable { case image, text }
    let kind: Kind
    let name: String
    let mimeType: String
    let dataBase64: String
    let size: Int
  }

  // The routing an intent resolves to on the host. `cwd` must already be an
  // authorized Scry project directory; the host fails closed otherwise.
  struct Routing: Codable, Equatable {
    let cwd: String
    let providerId: String
    let agentProfileId: String?
    let prompt: String
    var modelId: String? = nil
    var modelProviderId: String? = nil
    var effort: String? = nil
    var permissionMode: String? = nil
    // The Provider session id to CONTINUE (resume) instead of starting fresh.
    // nil for a new session; set when sending a follow-up into an opened session.
    var resume: String? = nil
    var attachments: [Attachment] = []
  }

  private func identity() throws -> G0ProbeIdentity {
    guard let key = try keychain.load(.deviceKey), let cert = try keychain.load(.grantedCert) else {
      throw ClientError.missingCredentials
    }
    // outerCA empty: the outer TLS mode is the endpoint's (system for public wss,
    // plaintext for a local dev relay). innerCA = the pinned host anchor.
    return G0ProbeIdentity(outerCA: Data(), innerCA: Data(connection.anchorPEM.utf8), certificate: cert, privateKey: key)
  }

  private func endpoint() -> G0Transport.RelayEndpoint {
    let outerTLS: G0Transport.RelayEndpoint.OuterTLS = connection.relayTLS == "system" ? .system : .plaintext
    let base = G0Transport.RelayEndpoint(host: connection.relayHost, port: connection.relayPort,
                                         hostId: connection.hostId, outerTLS: outerTLS,
                                         executionTarget: executionTarget)
    let session = RemoteSessionRegistry.shared.session(for: connection, keychainService: keychain.service,
                                                       executionTarget: executionTarget) { [self] in
      try identity()
    } endpoint: { base }
    return G0Transport.RelayEndpoint(host: base.host, port: base.port, hostId: base.hostId,
                                     outerTLS: outerTLS, session: session, executionTarget: executionTarget)
  }

  func executionTargets() async throws -> G0Transport.ExecutionTargetCatalog {
    try await G0Transport.relayExecutionTargets(endpoint: endpoint(), identity: try identity())
  }

  // Opens the interactive lane before the user acts (app foreground). Failure
  // is returned, not shown as offline: only a real exchange proves reachability.
  func prewarm() async throws {
    try await endpoint().session?.prewarm()
  }

  // Long-poll one run: returns as soon as the host has new ledger events,
  // output or a terminal lifecycle after the cursors, or after `waitMs`.
  func watch(runId: String, cursor: Int, outputCursor: Int, waitMs: Int = 15_000) async throws -> G0Transport.RunWatchOutcome {
    try await G0Transport.relayRunWatch(endpoint: endpoint(), identity: try identity(), runId: runId,
                                        cursor: cursor, outputCursor: outputCursor, waitMs: waitMs)
  }

  // Long-poll the host's live runs, optionally joined with one session's
  // history version. A read on its own lane; never blocks a run's watch.
  func liveRuns(revision: String?, waitMs: Int = 15_000,
                history: (providerId: String, cwd: String, externalSessionId: String, known: String?)?, historyAgentProfileId: String? = nil) async throws -> G0Transport.LiveRunsOutcome {
    try await G0Transport.relayLiveRuns(endpoint: endpoint(), identity: try identity(), revision: revision,
                                        waitMs: waitMs, history: history, historyAgentProfileId: historyAgentProfileId)
  }

  // Ask the host to interrupt this run's Provider. A receipt, not a lifecycle.
  func stop(runId: String) async throws -> String {
    try await G0Transport.relayRunStop(endpoint: endpoint(), identity: try identity(), runId: runId)
  }

  // Submit a durable run intent. Returns the host-assigned runId + whether it was
  // newly recorded or a duplicate of a prior intentId (idempotent submit).
  // intentId defaults to a fresh lowercase v4 UUID — the host ledger requires the
  // canonical lowercase form (Foundation's uuidString is uppercase).
  func submit(routing: Routing, intentId: String = UUID().uuidString.lowercased()) async throws -> G0Transport.RunSubmitOutcome {
    let encoder = JSONEncoder()
    encoder.outputFormatting = .sortedKeys
    let detail = String(decoding: try encoder.encode(routing), as: UTF8.self)
    return try await G0Transport.relayRunSubmit(endpoint: endpoint(), identity: try identity(), intentId: intentId, detail: detail)
  }

  // nil: the host never recorded this intent (safe to resend). Non-nil: it did,
  // and this is its runId. Never resends the intent body.
  func intentStatus(intentId: String) async throws -> G0Transport.RunSubmitOutcome? {
    try await G0Transport.relayRunIntentStatus(endpoint: endpoint(), identity: try identity(), intentId: intentId)
  }

  // Poll ledger events strictly after `cursor`; returns events + the next cursor.
  func poll(cursor: Int) async throws -> G0Transport.RunPollOutcome {
    try await G0Transport.relayRunPoll(endpoint: endpoint(), identity: try identity(), cursor: cursor)
  }

  // Current lifecycle of one run; nil means the host has no such run for us.
  func runState(runId: String) async throws -> String? {
    try await G0Transport.relayRunState(endpoint: endpoint(), identity: try identity(), runId: runId)
  }

  func questions(runId: String) async throws -> [G0Transport.RunQuestionRequest] {
    try await G0Transport.relayRunQuestions(endpoint: endpoint(), identity: try identity(), runId: runId)
  }

  func answerQuestion(runId: String, answerId: String, response: G0Transport.RunQuestionResponse) async throws -> G0Transport.RunQuestionAnswerOutcome {
    try await G0Transport.relayRunAnswerQuestion(endpoint: endpoint(), identity: try identity(), runId: runId,
                                                  answerId: answerId, response: response)
  }

  // The host-authorized project directories this device may target, for the
  // new-session picker. The phone cannot authorize a new directory; it only
  // chooses among these, and the host re-checks the cwd on submit.
  func projects() async throws -> [G0Transport.RunProjectRef] {
    try await G0Transport.relayRunProjects(endpoint: endpoint(), identity: try identity())
  }

  // Browse one folder level inside a Mac-authorized project. nil lists the
  // authorized roots; every non-nil path is canonicalized and re-authorized by
  // the host before any directory names are returned.
  func directories(path: String?) async throws -> G0Transport.RunDirectoryListing {
    var cursor = 0
    var snapshot: String?
    var total: Int?
    var current: G0Transport.RunProjectRef?
    var parent: G0Transport.RunProjectRef?
    var directories: [G0Transport.RunProjectRef] = []
    repeat {
      let page = try await G0Transport.relayRunDirectoriesPage(
        endpoint: endpoint(), identity: try identity(), path: path, cursor: cursor, snapshot: snapshot)
      let previous = cursor
      if snapshot == nil { snapshot = page.snapshot; total = page.total; current = page.current; parent = page.parent }
      guard snapshot == page.snapshot, total == page.total, current == page.current, parent == page.parent,
            page.total <= 100_000, page.cursor == previous + page.directories.count,
            page.cursor <= page.total,
            page.hasMore ? page.cursor > previous && page.cursor < page.total : page.cursor == page.total else {
        throw NSError(domain: "ScryRemote.Directories", code: 1,
                      userInfo: [NSLocalizedDescriptionKey: "Directory snapshot or cursor changed"])
      }
      directories.append(contentsOf: page.directories)
      cursor = page.cursor
      if !page.hasMore { break }
    } while true
    return G0Transport.RunDirectoryListing(current: current, parent: parent, directories: directories)
  }

  // The Providers the host currently offers for a new session (id/label/available).
  // The phone picks among these; the host re-validates the chosen providerId on
  // submit. It can never invent a provider the host does not have.
  func providers() async throws -> [G0Transport.RunProviderRef] {
    try await providersWithCapability().providers
  }

  func providersWithCapability() async throws -> (providers: [G0Transport.RunProviderRef], capability: Int?) {
    let result = try await G0Transport.relayRunProvidersWithCapability(endpoint: endpoint(), identity: try identity(), detail: "metadata")
    return (result.providers, result.capability)
  }

  // Resolve controls only after this exact Provider/profile and authorized cwd
  // have been selected. Older hosts are reported unavailable rather than
  // treating their legacy full list as proof for this context.
  func providerControls(providerId: String, cwd: String, agentProfileId: String? = nil) async throws -> G0Transport.RunProviderRef {
    let result = try await G0Transport.relayRunProvidersWithCapability(endpoint: endpoint(), identity: try identity(), detail: "selected", providerId: providerId, cwd: cwd, agentProfileId: agentProfileId)
    guard result.capability == 2 else {
      throw NSError(domain: "ScryRemote.ProviderControls", code: 2,
                    userInfo: [NSLocalizedDescriptionKey: "Provider controls unavailable on this host"])
    }
    let refs = result.providers
    guard let ref = refs.first(where: { $0.id == providerId && $0.agentProfileId == agentProfileId }) else {
      throw NSError(domain: "ScryRemote.ProviderControls", code: 1,
                    userInfo: [NSLocalizedDescriptionKey: "Provider controls unavailable"])
    }
    return ref
  }

  // Provider-native slash commands for this exact project context. The host
  // obtains the same capability catalog used by the desktop composer.
  func commands(providerId: String, cwd: String, agentProfileId: String? = nil) async throws -> G0Transport.RunCommandCatalog {
    try await G0Transport.relayRunCommands(endpoint: endpoint(), identity: try identity(), providerId: providerId, cwd: cwd, agentProfileId: agentProfileId)
  }

  // The host session catalog (the SAME conversations the Mac lists) this device
  // may browse. Display metadata only; the host re-authorizes any content read.
  func sessions(includeArchived: Bool = false,
                progress: @escaping @Sendable ([G0Transport.RunSessionRef]) async -> Void = { _ in }) async throws -> [G0Transport.RunSessionRef] {
    try await withHistoryConnection { reader in
      var cursor = 0
      var snapshot: String?
      var total: Int?
      var sessions: [G0Transport.RunSessionRef] = []
      repeat {
        let page = try await reader.sessionsPage(cursor: cursor, snapshot: snapshot, includeArchived: includeArchived)
        let previous = cursor
        if snapshot == nil { snapshot = page.snapshot; total = page.total }
        guard snapshot == page.snapshot, total == page.total, page.total <= 100_000,
              page.cursor == previous + page.sessions.count, page.cursor <= page.total,
              page.hasMore ? page.cursor > previous && page.cursor < page.total : page.cursor == page.total else {
          throw NSError(domain: "ScryRemote.Sessions", code: 1,
                        userInfo: [NSLocalizedDescriptionKey: "Session snapshot or cursor changed"])
        }
        sessions.append(contentsOf: page.sessions)
        await progress(sessions)
        cursor = page.cursor
        if !page.hasMore { break }
      } while true
      return sessions
    }
  }

  // Rename / pin / archive on the host. `true` means the host applied it; the
  // caller still re-reads the catalog because the catalog is the display truth.
  func sessionAction(context: G0Transport.SessionActionContext, action: G0Transport.SessionCleanup) async throws -> Bool {
    try await G0Transport.relaySessionAction(endpoint: endpoint(), identity: try identity(), context: context, action: action)
  }

  // One bounded read of an already-computed host panel (analytics, LLM
  // performance, MCP snapshot). The host never scans on this call.
  func toolPanel(kind: G0Transport.ToolPanelKind, rangeDays: Int? = nil,
                 providerId: String? = nil) async throws -> G0Transport.ToolPanelPayload {
    try await G0Transport.relayToolPanel(endpoint: endpoint(), identity: try identity(), kind: kind,
                                         rangeDays: rangeDays, providerId: providerId)
  }

  // Permanent delete of an archived session; the host re-authorizes and reports
  // what it actually removed.
  func deleteSession(providerId: String, cwd: String, externalSessionId: String,
                     agentProfileId: String? = nil) async throws -> G0Transport.DeleteSessionOutcome {
    try await G0Transport.relaySessionDelete(endpoint: endpoint(), identity: try identity(), providerId: providerId,
                                             cwd: cwd, externalSessionId: externalSessionId, agentProfileId: agentProfileId)
  }

  @MainActor
  func withHistoryConnection<T: Sendable>(_ body: @escaping @MainActor @Sendable (G0Transport.HistoryConnection) async throws -> T) async throws -> T {
    try await G0Transport.withHistoryConnection(endpoint: endpoint(), identity: identity()) { reader in
      try await body(reader)
    }
  }

  func historyVersion(providerId: String, cwd: String, externalSessionId: String, agentProfileId: String? = nil) async throws -> G0Transport.RunHistoryVersion {
    try await G0Transport.relayRunHistoryVersion(endpoint: endpoint(), identity: try identity(), providerId: providerId, cwd: cwd, externalSessionId: externalSessionId, agentProfileId: agentProfileId)
  }

  func historyPreview(providerId: String, cwd: String, externalSessionId: String, agentProfileId: String? = nil) async throws -> G0Transport.RunHistoryPreview {
    try await G0Transport.relayRunHistoryPreview(endpoint: endpoint(), identity: try identity(), providerId: providerId, cwd: cwd, externalSessionId: externalSessionId, agentProfileId: agentProfileId)
  }

  func historyTurnsPage(providerId: String, cwd: String, externalSessionId: String, before: Int?, limit: Int = 3, snapshot: String?, agentProfileId: String? = nil) async throws -> G0Transport.RunHistoryTurnsPage {
    try await G0Transport.relayRunHistoryTurnsPage(endpoint: endpoint(), identity: try identity(), providerId: providerId, cwd: cwd, externalSessionId: externalSessionId, before: before, limit: limit, snapshot: snapshot, agentProfileId: agentProfileId)
  }

  func historyPage(providerId: String, cwd: String, externalSessionId: String, cursor: Int, snapshot: String?, agentProfileId: String? = nil) async throws -> G0Transport.RunHistoryPage {
    try await G0Transport.relayRunHistoryPage(
      endpoint: endpoint(), identity: try identity(), providerId: providerId, cwd: cwd,
      externalSessionId: externalSessionId, cursor: cursor, snapshot: snapshot, agentProfileId: agentProfileId
    )
  }

  // Complete, restart-stable history. No turn/item/text is clipped to a frame.
  // A currently running Mac conversation can change between pages; restart the
  // bounded read from cursor zero instead of surfacing a stale-snapshot error.
  func history(providerId: String, cwd: String, externalSessionId: String, agentProfileId: String? = nil) async throws -> [G0Transport.RunHistoryTurn] {
    try await historySnapshot(providerId: providerId, cwd: cwd, externalSessionId: externalSessionId, agentProfileId: agentProfileId).turns
  }

  func historySnapshot(providerId: String, cwd: String, externalSessionId: String,
                       cached: RemoteHistorySnapshot? = nil,
                       connection: G0Transport.HistoryConnection? = nil,
                       agentProfileId: String? = nil,
                       progress: @escaping @Sendable (Int, Int) async -> Void = { _, _ in }) async throws -> RemoteHistorySnapshot {
    for attempt in 0..<3 {
      do {
        return try await Self.downloadHistory(cached: cached, pageSize: connection == nil ? 64 * 1024 : 256 * 1024, fetch: { cursor, snapshot in
          if let connection {
            return try await connection.page(providerId: providerId, cwd: cwd, externalSessionId: externalSessionId, cursor: cursor, snapshot: snapshot, agentProfileId: agentProfileId)
          }
          return try await historyPage(providerId: providerId, cwd: cwd, externalSessionId: externalSessionId,
                                      cursor: cursor, snapshot: snapshot, agentProfileId: agentProfileId)
        }, progress: progress)
      }
      catch G0Transport.RunError.host(let code) where code == "history_snapshot_changed" && attempt < 2 {
        try await Task.sleep(nanoseconds: UInt64(120 + attempt * 180) * 1_000_000)
      }
    }
    throw NSError(domain: "ScryRemote.History", code: 4,
                  userInfo: [NSLocalizedDescriptionKey: "History kept changing while it was read"])
  }

  // Larger pages share the transfer's tunnel; keep assembly/digest/JSON work
  // off the UI actor. Legacy isolated fixtures retain their 64 KiB page contract.
  @concurrent static func downloadHistory(cached: RemoteHistorySnapshot?, pageSize: Int = 64 * 1024,
    fetch: @escaping @Sendable (Int, String?) async throws -> G0Transport.RunHistoryPage,
    progress: @escaping @Sendable (Int, Int) async -> Void = { _, _ in }) async throws -> RemoteHistorySnapshot {
    try Task.checkCancellation()
    let first = try await fetch(0, nil)
    try Task.checkCancellation()
    let total = first.totalBytes
    let fingerprint = first.snapshot
    func chunk(_ page: G0Transport.RunHistoryPage, at cursor: Int) throws -> Data {
      guard total >= 0, total <= 256 * 1024 * 1024,
            page.snapshot == fingerprint, page.totalBytes == total,
            let data = Data(base64Encoded: page.dataBase64),
            data.count == min(pageSize, total - cursor),
            page.cursor == cursor + data.count, page.hasMore == (page.cursor < total) else {
        throw NSError(domain: "ScryRemote.History", code: 2,
          userInfo: [NSLocalizedDescriptionKey: "History snapshot, cursor or size changed"])
      }
      return data
    }
    var bytes = try chunk(first, at: 0)
    if let cached, cached.fingerprint == fingerprint {
      await progress(total, total)
      return RemoteHistorySnapshot(turns: cached.turns, fingerprint: fingerprint, fetchedAt: Date())
    }
    bytes.reserveCapacity(total)
    await progress(bytes.count, total)
    while bytes.count < total {
      try Task.checkCancellation()
      let start = bytes.count
      let pages = try await withThrowingTaskGroup(of: (Int, G0Transport.RunHistoryPage).self) { group in
        for cursor in stride(from: start, to: min(total, start + 2 * pageSize), by: pageSize) {
          group.addTask { (cursor, try await fetch(cursor, fingerprint)) }
        }
        var result: [(Int, G0Transport.RunHistoryPage)] = []
        for try await page in group { result.append(page) }
        return result.sorted { $0.0 < $1.0 }
      }
      for (cursor, page) in pages { bytes.append(try chunk(page, at: cursor)) }
      await progress(bytes.count, total)
    }
    try Task.checkCancellation()
    await progress(total, total)
    let digest = SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
    guard digest == fingerprint else {
      throw NSError(domain: "ScryRemote.History", code: 3,
        userInfo: [NSLocalizedDescriptionKey: "History snapshot verification failed"])
    }
    return RemoteHistorySnapshot(turns: try JSONDecoder().decode([G0Transport.RunHistoryTurn].self, from: bytes),
                                 fingerprint: fingerprint, fetchedAt: Date())
  }

  // The assistant's real streamed output content for one run, strictly after
  // `cursor`. This is the trace-derived CONTENT the chat view renders; tokens/
  // cost still come only from the ledger `result` event, never from here.
  func output(runId: String, cursor: Int) async throws -> G0Transport.RunOutputPage {
    try await G0Transport.relayRunOutput(endpoint: endpoint(), identity: try identity(), runId: runId, cursor: cursor)
  }
}

// One persistent RelaySession per paired connection + credential store, shared
// by every RemoteRunClient value. A different descriptor (re-pair, clear) gets a
// fresh session; the old one's tunnels are closed.
final class RemoteSessionRegistry: @unchecked Sendable {
  static let shared = RemoteSessionRegistry()
  static let pathChangedNotification = Notification.Name("ScryRemoteNetworkPathChanged")
  private let lock = NSLock()
  private var sessions: [String: RelaySession] = [:]
  private var recentKeys: [String] = []
  private static let sessionLimit = 67
  private let pathMonitor = NWPathMonitor()
  private var lastPath: String?

  private init() {
    // Wi-Fi <-> cellular leaves old sockets silently dead; a lane would wait for
    // its response deadline. Reset on a real interface change instead.
    pathMonitor.pathUpdateHandler = { [weak self] path in
      guard let self else { return }
      let interfaceTypes: [(NWInterface.InterfaceType, String)] = [
        (.wifi, "wifi"), (.cellular, "cellular"), (.wiredEthernet, "wired"),
        (.loopback, "loopback"), (.other, "other")
      ]
      let usedInterfaces = interfaceTypes.compactMap { path.usesInterfaceType($0.0) ? $0.1 : nil }
      let signature = RelayPathSignature.make(
        status: String(describing: path.status), isExpensive: path.isExpensive, isConstrained: path.isConstrained,
        supportsDNS: path.supportsDNS, supportsIPv4: path.supportsIPv4, supportsIPv6: path.supportsIPv6,
        usedInterfaceTypes: usedInterfaces
      )
      let changed = self.lock.withLock {
        defer { self.lastPath = signature }
        return self.lastPath != nil && self.lastPath != signature
      }
      if changed {
        let satisfied = path.status == .satisfied
        Task {
          await self.resetAll()
          if satisfied { NotificationCenter.default.post(name: Self.pathChangedNotification, object: nil) }
        }
      }
    }
    pathMonitor.start(queue: DispatchQueue(label: "com.scry.remote.path"))
  }

  func session(for connection: RemoteConnection, keychainService: String,
               executionTarget: G0Transport.ExecutionTargetBinding?,
               identity: @escaping @Sendable () throws -> G0ProbeIdentity,
               endpoint: () -> G0Transport.RelayEndpoint) -> RelaySession {
    let targetKey = executionTarget.map { "\($0.id):\($0.binding)" } ?? "local"
    let wanted = [connection.relayHost, String(connection.relayPort), connection.relayTLS, connection.hostId,
                  connection.deviceId, keychainService, connection.anchorPEM, targetKey].joined(separator: "\u{1f}")
    return lock.withLock {
      recentKeys.removeAll { $0 == wanted }
      recentKeys.append(wanted)
      if let existing = sessions[wanted] { return existing }
      if sessions.count >= Self.sessionLimit {
        let oldest = recentKeys.removeFirst()
        if let evicted = sessions.removeValue(forKey: oldest) {
          // Close cached tunnels only. Host tasks and their durable intents are
          // not cancelled; a later request reopens under the same binding.
          Task { await evicted.reset() }
        }
      }
      let session = RelaySession(endpoint: endpoint(), identity: identity, deviceLabel: RemoteDeviceModel.currentLabel)
      sessions[wanted] = session
      return session
    }
  }

  // Background / network path change: drop every lane; the next request reopens.
  // Target switches must not reset another target's live lane.
  func resetAll() async {
    let current = lock.withLock { Array(sessions.values) }
    for session in current { await session.reset() }
  }
}
