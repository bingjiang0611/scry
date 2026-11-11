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
  // Pushed observation of one run on the shared tunnel (current hosts). Throws
  // RunError.host("watch_stream_unavailable") when the host or route cannot
  // push; callers then use `watch` long-polls.
  func watchUpdates(runId: String, cursor: Int, outputCursor: Int) -> AsyncThrowingStream<G0Transport.RunWatchOutcome, Error> {
    G0Transport.relayRunWatchUpdates(endpoint: endpoint(), runId: runId, cursor: cursor, outputCursor: outputCursor)
  }

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
    // The last complete walk of this exact catalog. Offered to the host as
    // `known`: when it still hashes the same, one page confirms it instead of
    // re-sending every page. Only a host confirmation reuses it.
    let memoKey = [connection.relayHost, connection.hostId, connection.deviceId,
                   executionTarget.map { "\($0.id):\($0.binding)" } ?? "local", includeArchived ? "archived" : "active"].joined(separator: "\u{1f}")
    let known = executionTarget == nil ? SessionCatalogMemo.shared.get(memoKey) : nil
    return try await withHistoryConnection { reader in
      var cursor = 0
      var snapshot: String?
      var total: Int?
      var sessions: [G0Transport.RunSessionRef] = []
      repeat {
        let page = try await reader.sessionsPage(cursor: cursor, snapshot: snapshot, includeArchived: includeArchived,
                                                 known: cursor == 0 ? known?.snapshot : nil)
        if cursor == 0, page.unchanged == true, let known, page.snapshot == known.snapshot, page.total == known.sessions.count {
          SessionCatalogMemo.shared.noteConfirmed()
          await progress(known.sessions)
          return known.sessions
        }
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
      if let snapshot { SessionCatalogMemo.shared.set(memoKey, SessionCatalogMemo.Entry(snapshot: snapshot, sessions: sessions)) }
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

  // The assistant's real streamed output content for one run, strictly after
  // `cursor`. This is the trace-derived CONTENT the chat view renders; tokens/
  // cost still come only from the ledger `result` event, never from here.
  func output(runId: String, cursor: Int) async throws -> G0Transport.RunOutputPage {
    try await G0Transport.relayRunOutput(endpoint: endpoint(), identity: try identity(), runId: runId, cursor: cursor)
  }
}
