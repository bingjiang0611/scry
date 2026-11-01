import Foundation
import NIOCore
import NIOPosix
import NIOHTTP1
import NIOWebSocket
import NIOSSL
import NIOTLS

extension G0Transport {
  public final class HistoryConnection: Sendable {
    private let send: @Sendable (Data, Int) async throws -> Data
    private let expectedTarget: ExecutionTargetBinding?
    fileprivate init(send: @escaping @Sendable (Data, Int) async throws -> Data, expectedTarget: ExecutionTargetBinding? = nil) {
      self.send = send
      self.expectedTarget = expectedTarget
    }
    private func response(_ request: Data, limit: Int, expectedProfile: HistoryProfileValue? = nil, expectedHistoryScope: String? = nil) async throws -> RunResponse {
      try decodeRun(await send(request, limit), expectedTarget: expectedTarget, expectedProfile: expectedProfile, expectedHistoryScope: expectedHistoryScope)
    }
    public func preview(providerId: String, cwd: String, externalSessionId: String, agentProfileId: String? = nil) async throws -> RunHistoryPreview {
      var query = RunHistoryPreviewRequest(providerId: providerId, cwd: cwd, externalSessionId: externalSessionId, keepAlive: true)
      query.agentProfileId = HistoryProfileValue(value: agentProfileId)
      let request = try JSONEncoder().encode(query)
      let reply = try await response(request, limit: 17 * 1_024, expectedHistoryScope: "session")
      guard let preview = reply.historyPreview else { throw ProbeError.unexpectedReply }
      return preview
    }
    public func turnsPage(providerId: String, cwd: String, externalSessionId: String, before: Int?, limit: Int, snapshot: String?, agentProfileId: String? = nil) async throws -> RunHistoryTurnsPage {
      var query = RunHistoryTurnsPageRequest(providerId: providerId, cwd: cwd, externalSessionId: externalSessionId, before: before, limit: limit, snapshot: snapshot, keepAlive: true)
      query.agentProfileId = HistoryProfileValue(value: agentProfileId)
      let request = try JSONEncoder().encode(query)
      let reply = try await response(request, limit: 8 * 1024 * 1024, expectedHistoryScope: "session")
      guard let page = reply.historyTurnsPage else { throw ProbeError.unexpectedReply }
      return try page.validated(before: before, limit: limit, expectedSnapshot: snapshot)
    }
    public func page(providerId: String, cwd: String, externalSessionId: String, cursor: Int, snapshot: String?, agentProfileId: String? = nil) async throws -> RunHistoryPage {
      var query = RunHistoryPageRequest(providerId: providerId, cwd: cwd, externalSessionId: externalSessionId, cursor: cursor, limit: 256 * 1_024, snapshot: snapshot, keepAlive: true)
      query.agentProfileId = HistoryProfileValue(value: agentProfileId)
      let request = try JSONEncoder().encode(query)
      let reply = try await response(request, limit: 512 * 1_024, expectedHistoryScope: "session")
      guard let page = reply.historyPage else { throw ProbeError.unexpectedReply }
      return page
    }
    public func sessionsPage(cursor: Int, snapshot: String?, includeArchived: Bool = false) async throws -> RunSessionPage {
      var query = RunSessionsPageRequest(cursor: cursor, limit: 100, snapshot: snapshot, keepAlive: true)
      if includeArchived { query.includeArchived = true }
      let request = try JSONEncoder().encode(query)
      let reply = try await response(request, limit: 2 * 1_024 * 1_024)
      guard let page = reply.sessionsPage else { throw ProbeError.unexpectedReply }
      return page
    }
  }

  public static func withHistoryConnection<T: Sendable>(endpoint: RelayEndpoint, identity: G0ProbeIdentity,
    body: @Sendable (HistoryConnection) async throws -> T) async throws -> T {
    if let session = endpoint.session {
      return try await body(HistoryConnection(send: { request, limit in
        let routed = try endpoint.executionTarget.map { try wrapExecutionTargetRequest(request, target: $0) } ?? request
        return try await session.exchange(routed, lane: .bulk, limit: limit, replayable: true)
      }, expectedTarget: endpoint.executionTarget))
    }
    return try await withRelayChannel(endpoint: endpoint, mode: "run", identity: identity) { channel, innerContext in
      let handler = HistoryReadHandler()
      try await channel.eventLoop.submit {
        try channel.pipeline.syncOperations.addHandler(NIOSSLClientHandler(context: innerContext, serverHostname: nil))
        try channel.pipeline.syncOperations.addHandler(handler)
      }.get()
      return try await body(HistoryConnection(send: { request, limit in
        let routed = try endpoint.executionTarget.map { try wrapExecutionTargetRequest(request, target: $0) } ?? request
        return try await channel.eventLoop.flatSubmit { handler.request(routed, limit: limit, on: channel) }.get()
      }, expectedTarget: endpoint.executionTarget))
    }
  }

  // Small first-screen evidence. Unavailable is explicit and is not decoded as an empty transcript.
  public static func relayRunHistoryVersion(endpoint: RelayEndpoint, identity: G0ProbeIdentity, providerId: String, cwd: String, externalSessionId: String, agentProfileId: String? = nil) async throws -> RunHistoryVersion {
    var query = RunHistoryVersionRequest(providerId: providerId, cwd: cwd, externalSessionId: externalSessionId)
    query.agentProfileId = HistoryProfileValue(value: agentProfileId)
    let request = try JSONEncoder().encode(query)
    let response = try decodeRun(await exchangeRelay(endpoint: endpoint, mode: "run", identity: identity, request: request, lane: .bulk), expectedTarget: endpoint.executionTarget, expectedHistoryScope: "session")
    guard let version = response.historyVersion else { throw ProbeError.unexpectedReply }
    return version
  }

  public static func relayRunHistoryPreview(endpoint: RelayEndpoint, identity: G0ProbeIdentity, providerId: String, cwd: String, externalSessionId: String, agentProfileId: String? = nil) async throws -> RunHistoryPreview {
    var query = RunHistoryPreviewRequest(providerId: providerId, cwd: cwd, externalSessionId: externalSessionId)
    query.agentProfileId = HistoryProfileValue(value: agentProfileId)
    let request = try JSONEncoder().encode(query)
    let response = try decodeRun(await exchangeRelay(endpoint: endpoint, mode: "run", identity: identity, request: request, responseLimit: 17 * 1_024, lane: .bulk), expectedTarget: endpoint.executionTarget, expectedHistoryScope: "session")
    guard let preview = response.historyPreview else { throw ProbeError.unexpectedReply }
    return preview
  }

  // The REAL conversation content of one session so the device can OPEN it.
  // Same owner-device authorization; an unknown/unauthorized session returns [].
  public static func relayRunHistory(endpoint: RelayEndpoint, identity: G0ProbeIdentity, providerId: String, cwd: String, externalSessionId: String, agentProfileId: String? = nil) async throws -> [RunHistoryTurn] {
    var query = RunHistoryRequest(providerId: providerId, cwd: cwd, externalSessionId: externalSessionId)
    query.agentProfileId = HistoryProfileValue(value: agentProfileId)
    let request = try JSONEncoder().encode(query)
    let response = try decodeRun(await exchangeRelay(endpoint: endpoint, mode: "run", identity: identity, request: request, lane: .bulk), expectedTarget: endpoint.executionTarget, expectedHistoryScope: "session")
    guard let history = response.history else { throw ProbeError.unexpectedReply }
    return history
  }

  // Complete history as stable byte pages. The caller may persist cursor,
  // snapshot and accumulated bytes across disconnects; a changed source fails
  // explicitly instead of combining two transcript versions.
  // Omit the limit by default: the host owns the frame budget and page size.
  public static func relayRunHistoryTurnsPage(endpoint: RelayEndpoint, identity: G0ProbeIdentity, providerId: String, cwd: String, externalSessionId: String, before: Int? = nil, limit: Int = 3, snapshot: String? = nil, agentProfileId: String? = nil) async throws -> RunHistoryTurnsPage {
    var query = RunHistoryTurnsPageRequest(providerId: providerId, cwd: cwd, externalSessionId: externalSessionId, before: before, limit: limit, snapshot: snapshot)
    query.agentProfileId = HistoryProfileValue(value: agentProfileId)
    let request = try JSONEncoder().encode(query)
    let response = try decodeRun(await exchangeRelay(endpoint: endpoint, mode: "run", identity: identity, request: request, lane: .bulk), expectedTarget: endpoint.executionTarget, expectedHistoryScope: "session")
    guard let page = response.historyTurnsPage else { throw ProbeError.unexpectedReply }
    do { return try page.validated(before: before, limit: limit, expectedSnapshot: snapshot) }
    catch {
      #if DEBUG
      // A rejected page is a contract mismatch, not a transport failure; keep
      // the host's own fields visible instead of only the enum error.
      print("[historyTurnsPage] rejected before=\(String(describing: before)) limit=\(limit) offset=\(page.offset) total=\(page.totalTurns) turns=\(page.turns.count) source=\(page.source) completeness=\(page.completeness) hasOlder=\(page.hasOlder) warning=\(String(describing: page.sourceWarning)) snapshot=\(page.snapshot.prefix(12))")
      #endif
      throw error
    }
  }

  public static func relayRunHistoryPage(endpoint: RelayEndpoint, identity: G0ProbeIdentity, providerId: String, cwd: String, externalSessionId: String, cursor: Int, limit: Int? = nil, snapshot: String? = nil, agentProfileId: String? = nil) async throws -> RunHistoryPage {
    var query = RunHistoryPageRequest(providerId: providerId, cwd: cwd, externalSessionId: externalSessionId, cursor: cursor, limit: limit, snapshot: snapshot)
    query.agentProfileId = HistoryProfileValue(value: agentProfileId)
    let request = try JSONEncoder().encode(query)
    let response = try decodeRun(await exchangeRelay(endpoint: endpoint, mode: "run", identity: identity, request: request, lane: .bulk), expectedTarget: endpoint.executionTarget, expectedHistoryScope: "session")
    guard let page = response.historyPage else { throw ProbeError.unexpectedReply }
    return page
  }

  // Long-poll: the host answers as soon as ledger events, output or a terminal
  // lifecycle exist after the cursors, or after `waitMs` (host-capped at 20 s).
  // It is a read; `state` nil means the host has no such run for this device.
  public struct RunWatchOutcome: Sendable, Equatable {
    public let poll: RunPollOutcome
    public let questions: [RunQuestionRequest]
    public let output: RunOutputPage
    public let state: String?
  }
  public static func relayRunWatch(endpoint: RelayEndpoint, identity: G0ProbeIdentity, runId: String,
                                   cursor: Int, outputCursor: Int, waitMs: Int) async throws -> RunWatchOutcome {
    let request = try JSONEncoder().encode(RunWatchRequest(runId: runId, cursor: cursor, outputCursor: outputCursor, waitMs: waitMs))
    let response = try decodeRun(await exchangeRelay(endpoint: endpoint, mode: "run", identity: identity, request: request, lane: .watch), expectedTarget: endpoint.executionTarget)
    guard let watch = response.watch else { throw ProbeError.unexpectedReply }
    return RunWatchOutcome(poll: RunPollOutcome(events: watch.poll.events, cursor: watch.poll.cursor),
                           questions: watch.questions,
                           output: RunOutputPage(chunks: watch.output.chunks, cursor: watch.output.cursor),
                           state: watch.state)
  }

  // Long-poll for the live-run list (and optionally one session's history
  // version). Returns when either differs from what the caller holds, or after
  // `waitMs` (host-capped at 20 s). A read on its own lane.
  public static func relayLiveRuns(endpoint: RelayEndpoint, identity: G0ProbeIdentity, revision: String?, waitMs: Int,
                                   history: (providerId: String, cwd: String, externalSessionId: String, known: String?)? = nil, historyAgentProfileId: String? = nil) async throws -> LiveRunsOutcome {
    let request = try JSONEncoder().encode(LiveRunsRequest(revision: revision, waitMs: waitMs, history: history.map {
      LiveRunsHistory(providerId: $0.providerId, cwd: $0.cwd, externalSessionId: $0.externalSessionId, known: $0.known, agentProfileId: HistoryProfileValue(value: historyAgentProfileId))
    }))
    let response = try decodeRun(await exchangeRelay(endpoint: endpoint, mode: "run", identity: identity, request: request, lane: .status), expectedTarget: endpoint.executionTarget, expectedHistoryScope: history == nil ? nil : "session")
    guard let live = response.liveRuns else { throw ProbeError.unexpectedReply }
    return live
  }

  // Asks the host to interrupt the Provider for this run. "requested" is only a
  // request receipt; the lifecycle still settles from the real Provider result.
  public static func relayRunStop(endpoint: RelayEndpoint, identity: G0ProbeIdentity, runId: String) async throws -> String {
    let request = try JSONEncoder().encode(RunStopRequest(runId: runId))
    let response = try decodeRun(await exchangeRelay(endpoint: endpoint, mode: "run", identity: identity, request: request, replayable: false), expectedTarget: endpoint.executionTarget)
    guard let stop = response.stop else { throw ProbeError.unexpectedReply }
    return stop.status
  }
}
