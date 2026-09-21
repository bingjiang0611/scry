import CryptoKit
import Foundation
import RemoteTransport

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

  init(connection: RemoteConnection, keychain: RemoteKeychain = RemoteKeychain()) {
    self.connection = connection
    self.keychain = keychain
  }

  enum ClientError: Error, Equatable { case missingCredentials }

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
    return G0Transport.RelayEndpoint(host: connection.relayHost, port: connection.relayPort, hostId: connection.hostId, outerTLS: outerTLS)
  }

  // Submit a durable run intent. Returns the host-assigned runId + whether it was
  // newly recorded or a duplicate of a prior intentId (idempotent submit).
  // intentId defaults to a fresh lowercase v4 UUID — the host ledger requires the
  // canonical lowercase form (Foundation's uuidString is uppercase).
  func submit(routing: Routing, intentId: String = UUID().uuidString.lowercased()) async throws -> G0Transport.RunSubmitOutcome {
    let detail = String(decoding: try JSONEncoder().encode(routing), as: UTF8.self)
    return try await G0Transport.relayRunSubmit(endpoint: endpoint(), identity: try identity(), intentId: intentId, detail: detail)
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
    try await G0Transport.relayRunProviders(endpoint: endpoint(), identity: try identity())
  }

  // Provider-native slash commands for this exact project context. The host
  // obtains the same capability catalog used by the desktop composer.
  func commands(providerId: String, cwd: String, agentProfileId: String? = nil) async throws -> G0Transport.RunCommandCatalog {
    try await G0Transport.relayRunCommands(endpoint: endpoint(), identity: try identity(), providerId: providerId, cwd: cwd, agentProfileId: agentProfileId)
  }

  // The host session catalog (the SAME conversations the Mac lists) this device
  // may browse. Display metadata only; the host re-authorizes any content read.
  func sessions() async throws -> [G0Transport.RunSessionRef] {
    var cursor = 0
    var snapshot: String?
    var total: Int?
    var sessions: [G0Transport.RunSessionRef] = []
    repeat {
      let page = try await G0Transport.relayRunSessionsPage(
        endpoint: endpoint(), identity: try identity(), cursor: cursor, snapshot: snapshot)
      let previous = cursor
      if snapshot == nil { snapshot = page.snapshot; total = page.total }
      guard snapshot == page.snapshot, total == page.total, page.total <= 100_000,
            page.cursor == previous + page.sessions.count, page.cursor <= page.total,
            page.hasMore ? page.cursor > previous && page.cursor < page.total : page.cursor == page.total else {
        throw NSError(domain: "ScryRemote.Sessions", code: 1,
                      userInfo: [NSLocalizedDescriptionKey: "Session snapshot or cursor changed"])
      }
      sessions.append(contentsOf: page.sessions)
      cursor = page.cursor
      if !page.hasMore { break }
    } while true
    return sessions
  }

  func historyPage(providerId: String, cwd: String, externalSessionId: String, cursor: Int, snapshot: String?) async throws -> G0Transport.RunHistoryPage {
    try await G0Transport.relayRunHistoryPage(
      endpoint: endpoint(), identity: try identity(), providerId: providerId, cwd: cwd,
      externalSessionId: externalSessionId, cursor: cursor, snapshot: snapshot
    )
  }

  // Complete, restart-stable history. No turn/item/text is clipped to a frame.
  // A currently running Mac conversation can change between pages; restart the
  // bounded read from cursor zero instead of surfacing a stale-snapshot error.
  func history(providerId: String, cwd: String, externalSessionId: String) async throws -> [G0Transport.RunHistoryTurn] {
    for attempt in 0..<3 {
      do { return try await historySnapshot(providerId: providerId, cwd: cwd, externalSessionId: externalSessionId) }
      catch G0Transport.RunError.host(let code) where code == "history_snapshot_changed" && attempt < 2 {
        try await Task.sleep(nanoseconds: UInt64(120 + attempt * 180) * 1_000_000)
      }
    }
    throw NSError(domain: "ScryRemote.History", code: 4,
                  userInfo: [NSLocalizedDescriptionKey: "History kept changing while it was read"])
  }

  private func historySnapshot(providerId: String, cwd: String, externalSessionId: String) async throws -> [G0Transport.RunHistoryTurn] {
    var cursor = 0
    var snapshot: String?
    var totalBytes: Int?
    var bytes = Data()
    repeat {
      let page = try await historyPage(providerId: providerId, cwd: cwd, externalSessionId: externalSessionId, cursor: cursor, snapshot: snapshot)
      guard let chunk = Data(base64Encoded: page.dataBase64), page.cursor == cursor + chunk.count else {
        throw NSError(domain: "ScryRemote.History", code: 1, userInfo: [NSLocalizedDescriptionKey: "Invalid history page"])
      }
      if snapshot == nil { snapshot = page.snapshot }
      if totalBytes == nil { totalBytes = page.totalBytes }
      guard snapshot == page.snapshot,
            totalBytes == page.totalBytes,
            page.totalBytes <= 256 * 1024 * 1024,
            page.cursor <= page.totalBytes,
            page.hasMore ? page.cursor > cursor && page.cursor < page.totalBytes : page.cursor == page.totalBytes else {
        throw NSError(domain: "ScryRemote.History", code: 2, userInfo: [NSLocalizedDescriptionKey: "History snapshot or size changed"])
      }
      bytes.append(chunk)
      cursor = page.cursor
      if !page.hasMore { break }
    } while true
    let digest = SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
    guard digest == snapshot else {
      throw NSError(domain: "ScryRemote.History", code: 3, userInfo: [NSLocalizedDescriptionKey: "History snapshot verification failed"])
    }
    return try JSONDecoder().decode([G0Transport.RunHistoryTurn].self, from: bytes)
  }

  // The assistant's real streamed output content for one run, strictly after
  // `cursor`. This is the trace-derived CONTENT the chat view renders; tokens/
  // cost still come only from the ledger `result` event, never from here.
  func output(runId: String, cursor: Int) async throws -> G0Transport.RunOutputPage {
    try await G0Transport.relayRunOutput(endpoint: endpoint(), identity: try identity(), runId: runId, cursor: cursor)
  }
}
