import Foundation

extension G0Transport {
  private struct DesktopSubscriptionInfo: Decodable {
    let kind: String
    let protocolVersion: Int
    let execution: String
    let hostId: String
    let subscribe: Int?

    enum CodingKeys: String, CodingKey { case kind, protocolVersion = "protocol", execution, hostId, subscribe }

    init(from decoder: Decoder) throws {
      let values = try decoder.container(keyedBy: CodingKeys.self)
      kind = try values.decode(String.self, forKey: .kind)
      protocolVersion = try values.decode(Int.self, forKey: .protocolVersion)
      execution = try values.decode(String.self, forKey: .execution)
      hostId = try values.decode(String.self, forKey: .hostId)
      subscribe = try? values.decode(Int.self, forKey: .subscribe)
    }
  }

  static func probeSubscription(endpoint: RelayEndpoint, identity: G0ProbeIdentity) async throws -> String? {
    if let binding = endpoint.executionTarget {
      let catalog = try await relayExecutionTargets(endpoint: endpoint, identity: identity)
      // The gateway can return an empty catalog while its App bridge is offline.
      // Neither an absent target nor a different binding may receive a request.
      guard let target = catalog.targets.first(where: { $0.id == binding.id }) else {
        throw RunError.host(code: "execution_target_gateway_offline")
      }
      guard target.binding == binding.binding else { throw RunError.host(code: "execution_target_binding_changed") }
      guard target.state == "connected" else { throw RunError.host(code: "desktop_not_connected") }
      guard target.subscribe == 1 else { throw RunError.host(code: "subscribe_unsupported") }
      return target.hostId
    }
    struct Reply: Decodable { let error: String?; let hostProtocol: Int?; let desktop: DesktopSubscriptionInfo? }
    let data = try await exchangeRelay(endpoint: endpoint, mode: "run", identity: identity,
      request: Data(#"{"op":"desktop","query":{"kind":"info"}}"#.utf8))
    let reply = try JSONDecoder().decode(Reply.self, from: data)
    if let error = reply.error {
      if ["unknown_op", "unsupported_op"].contains(error) { return nil }
      if error == "protocol_mismatch", let version = reply.hostProtocol {
        throw RunError.host(code: version > RelaySession.protocolVersion ? "protocol_upgrade_client" : "protocol_upgrade_host")
      }
      throw RunError.host(code: error)
    }
    guard let info = reply.desktop, info.kind == "info", info.execution == "canonical",
          info.hostId == endpoint.hostId, info.protocolVersion == RelaySession.protocolVersion else {
      throw ProbeError.unexpectedReply
    }
    return info.subscribe == 1 ? info.hostId : nil
  }

  static func subscription(endpoint: RelayEndpoint, identity: G0ProbeIdentity) async throws -> (DeviceSubscriptionState, String) {
    guard let state = endpoint.session?.deviceSubscription, let host = try await state.offer(endpoint: endpoint, identity: identity) else {
      throw RunError.host(code: "subscribe_unsupported")
    }
    return (state, host)
  }

  public static func subscribedSessions(endpoint: RelayEndpoint, identity: G0ProbeIdentity, includeArchived: Bool) async throws -> [RunSessionRef] {
    let (state, host) = try await subscription(endpoint: endpoint, identity: identity)
    let sessions = try await state.verifiedCatalog(endpoint: endpoint, identity: identity, hostId: host)
    return sessions.filter { includeArchived || $0.archivedAt == nil }.sorted {
      $0.ts == $1.ts ? $0.sessionId < $1.sessionId : $0.ts > $1.ts
    }
  }

  static func subscribedLiveRuns(endpoint: RelayEndpoint, identity: G0ProbeIdentity, revision: String?, waitMs: Int,
                                history: (providerId: String, cwd: String, externalSessionId: String, known: String?)?,
                                profile: String?) async throws -> LiveRunsOutcome {
    let (state, host) = try await subscription(endpoint: endpoint, identity: identity)
    let status = try await state.observe(endpoint: endpoint, identity: identity, hostId: host, revision: revision, waitMs: waitMs)
    var version: RunHistoryVersion?
    if let history, let session = status.session(providerId: history.providerId, cwd: history.cwd,
                                                externalSessionId: history.externalSessionId, agentProfileId: profile) {
      version = try await state.historyVersion(endpoint: endpoint, identity: identity, hostId: host,
        session: session, known: history.known)
    }
    let runs = status.runs.values.compactMap(\.live).sorted { $0.runId < $1.runId }
    return LiveRunsOutcome(revision: status.cursor.revision, runs: runs, historyVersion: version)
  }

  static func subscribedHistory(endpoint: RelayEndpoint, identity: G0ProbeIdentity, providerId: String, cwd: String,
                                externalSessionId: String, agentProfileId: String?) async throws -> RunHistoryTurnsPage? {
    let (state, host) = try await subscription(endpoint: endpoint, identity: identity)
    let status = try await state.observe(endpoint: endpoint, identity: identity, hostId: host)
    guard let session = status.session(providerId: providerId, cwd: cwd, externalSessionId: externalSessionId, agentProfileId: agentProfileId) else {
      return nil
    }
    return try await state.detail(endpoint: endpoint, identity: identity, hostId: host, session: session, waitMs: 0, latest: true)
  }

  static func subscribedWatch(endpoint: RelayEndpoint, identity: G0ProbeIdentity, state: DeviceSubscriptionState,
                              host: String, runId: String, cursor: Int, outputCursor: Int, waitMs: Int) async throws -> RunWatchOutcome {
    let global = try await state.observe(endpoint: endpoint, identity: identity, hostId: host)
    var status = await state.mergingWatchedRun(runId, into: global)
    let observed = status.runs[runId]
    let hasOutput: Bool
    if let observed { hasOutput = await state.shouldReadOutput(run: observed, cursor: status.cursor, delivered: outputCursor) }
    else { hasOutput = false }
    if cursor >= status.cursor.seq && !hasOutput {
      if let observed {
        status = try await state.watchRun(endpoint: endpoint, identity: identity, hostId: host, run: observed,
                                          status: status, waitMs: waitMs)
      } else {
        status = try await state.observe(endpoint: endpoint, identity: identity, hostId: host,
                                         revision: status.cursor.revision, waitMs: waitMs)
      }
    }
    guard let run = status.runs[runId] else {
      return RunWatchOutcome(poll: RunPollOutcome(events: [], cursor: status.cursor.seq),
        questions: [], output: RunOutputPage(chunks: [], cursor: outputCursor), state: nil)
    }
    var output = RunOutputPage(chunks: [], cursor: outputCursor)
    if await state.shouldReadOutput(run: run, cursor: status.cursor, delivered: outputCursor) {
      output = try await relayRunOutput(endpoint: endpoint, identity: identity, runId: runId, cursor: outputCursor)
      // A full page may have a second portion even when no more hints arrive.
      if output.chunks.isEmpty { await state.didReadOutput(run: run, cursor: status.cursor, delivered: output.cursor) }
    }
    let events = try bindingEvents(run: run, cursor: status.cursor)
    return RunWatchOutcome(poll: RunPollOutcome(events: events, cursor: status.cursor.seq),
      questions: run.questions ?? [], output: output, state: run.state)
  }

  static func bindingEvents(run: SubscriptionRunRow, cursor: SubscriptionCursor) throws -> [RunLedgerEvent] {
    var markers: [[String: String]] = []
    if let trace = run.traceRunId { markers.append(["event": "bound", "ledgerRunId": run.runId, "scryRunId": trace]) }
    if let session = run.externalSessionId { markers.append(["event": "session", "externalSessionId": session]) }
    return try markers.map { marker in
      let json = try JSONEncoder().encode(marker)
      return RunLedgerEvent(seq: cursor.seq, at: 0, runId: run.runId, kind: "run_progress", intentId: nil,
                            detail: String(decoding: json, as: UTF8.self))
    }
  }
}
