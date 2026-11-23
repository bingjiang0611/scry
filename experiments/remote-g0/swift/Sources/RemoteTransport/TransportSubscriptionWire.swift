import Foundation

extension G0Transport {
  struct SubscriptionCursor: Codable, Equatable, Sendable {
    let hostId: String
    let logId: String
    let seq: Int
    var revision: String { "\(logId):\(seq)" }
  }

  struct SubscriptionSession: Encodable, Equatable, Sendable {
    let sessionKey: String
    let providerId: String
    let cwd: String
    let externalSessionId: String
    let agentProfileId: String?
  }

  struct SubscriptionChunkRef: Encodable, Sendable {
    let id: String
    let offset: Int
  }

  struct SubscriptionRequest: Encodable, Sendable {
    let op = "subscribe"
    let views: [String]
    let waitMs: Int
    var known: SubscriptionCursor?
    var sessionsCursor: String?
    var session: SubscriptionSession?
    var historyFormat: String?
    var historyOnly: Bool?
    var chunk: SubscriptionChunkRef?
  }

  struct SubscriptionPacket: Decodable, Sendable {
    let error: String?
    let executionTarget: ExecutionTargetBinding?
    let subscribe: SubscriptionReply?
  }

  struct SubscriptionReply: Decodable, Sendable {
    let hostId: String?
    let logId: String?
    let seq: Int?
    let mode: String?
    let snapshot: SubscriptionSnapshot?
    let events: [SubscriptionEvent]?
    let hints: [SubscriptionHint]?
    let kind: String?
    let id: String?
    let offset: Int?
    let totalBytes: Int?
    let data: String?

    func cursor(for expectedHost: String) throws -> SubscriptionCursor {
      guard hostId == expectedHost, let logId, !logId.isEmpty, logId.utf16.count <= 128,
            let seq, seq >= 0 else { throw ProbeError.unexpectedReply }
      return SubscriptionCursor(hostId: expectedHost, logId: logId, seq: seq)
    }

    func knownEvents(since previous: SubscriptionCursor, next: SubscriptionCursor) -> Bool {
      guard previous.logId == next.logId, previous.seq <= next.seq else { return false }
      if mode == "idle" { return true }
      guard mode == "events", let events, events.count <= 128 else { return false }
      var last = previous.seq
      for event in events {
        guard Self.eventTypes.contains(event.type), event.seq > last, event.seq <= next.seq else { return false }
        last = event.seq
      }
      return true
    }

    private static let eventTypes: Set<String> = [
      "run.intent_recorded", "run.admitted", "run.dispatched", "run.session_bound", "run.stop_requested",
      "run.question_opened", "run.question_answered", "run.question_closed", "run.provider_settled",
      "run.finalized", "run.transcript_referenced", "run.settled", "run.failed", "run.cancelled",
      "run.interrupted", "run.content_gap", "session.created", "session.renamed", "session.pinned",
      "session.unpinned", "session.archived", "session.restored", "session.deleted", "session.forked",
      "session.discovered", "session.withdrawn", "session.imported", "turn.began", "turn.delivery",
      "effect.voided", "host.started"
    ]
  }

  struct SubscriptionSnapshot: Decodable, Sendable {
    struct Sessions: Decodable, Sendable {
      let rows: [SubscriptionSessionRow]
      let nextCursor: String?
    }
    struct ActiveRuns: Decodable, Sendable { let rows: [SubscriptionRunRow] }
    struct Detail: Decodable, Sendable {
      struct Page: Decodable, Sendable {
        let kind: String
        let page: RunHistoryTurnsPage?
      }
      let firstPage: Page?
    }
    let sessions: Sessions?
    let activeRuns: ActiveRuns?
    let detail: Detail?
  }

  struct SubscriptionSessionRow: Decodable, Sendable {
    struct Catalog: Decodable, Sendable { let nativeSessionId: String?; let preview: String? }
    struct Outcome: Decodable, Sendable { let value: String? }
    let sessionKey: String
    let conversationId: String?
    let cwd: String
    let provider: String?
    let profile: String?
    let title: String?
    let ts: Double
    let pinnedAt: Double?
    let archivedAt: Double?
    let activeRunId: String?
    let lastRunOutcome: Outcome?
    let revSeq: Int
    let parentSessionKey: String?
    let lineageKind: String?
    let catalog: Catalog?

    var reference: RunSessionRef {
      RunSessionRef(sessionId: sessionKey,
        externalSessionId: catalog == nil && conversationId == nil ? sessionKey : catalog?.nativeSessionId,
        providerId: provider ?? "legacy_unknown", agentProfileId: profile, cwd: cwd,
        label: title ?? catalog?.preview ?? "", ts: ts, pinnedAt: pinnedAt, isActive: activeRunId != nil,
        archivedAt: archivedAt, lastRunOutcome: lastRunOutcome?.value,
        parentSessionKey: parentSessionKey, lineageKind: lineageKind)
    }
  }

  struct SubscriptionRunRow: Decodable, Sendable {
    let runId: String
    let sessionKey: String?
    let origin: String
    let provider: String?
    let profile: String?
    let cwd: String
    let externalSessionId: String?
    let promptPreview: String?
    let lifecycle: String
    let stopState: String?
    let questions: [RunQuestionRequest]?
    let revSeq: Int
    var outputSeq: Int?
    var traceRunId: String?

    var state: String? {
      switch lifecycle {
      case "recorded": "recorded"
      case "admitted", "dispatched": "dispatched"
      case "settled", "failed", "cancelled": lifecycle
      case "interrupted": "cancelled"
      default: nil
      }
    }

    var live: LiveRun? {
      guard state == "recorded" || state == "dispatched", let provider else { return nil }
      let remote = origin == "remote"
      let requests = questions ?? []
      return LiveRun(origin: remote ? "remote" : "mac", runId: remote ? runId : (traceRunId ?? runId),
        providerId: provider, agentProfileId: profile, cwd: cwd, externalSessionId: externalSessionId,
        prompt: promptPreview ?? "", state: stopState == "requested" ? "stopping" : requests.isEmpty ? "running" : "waiting",
        questions: requests)
    }
  }

  struct SubscriptionEvent: Decodable, Sendable {
    let seq: Int
    let at: Int
    let type: String
    let sessionKey: String?
    let runId: String?
    let sessionRow: SubscriptionSessionRow?
    let runRow: SubscriptionRunRow?
  }

  struct SubscriptionHint: Decodable, Sendable {
    let kind: String
    let runId: String?
    let traceRunId: String?
    let outputSeq: Int?
    let notice: HostAdminNotice?
  }

  public struct SubscriptionCatalogChange: Sendable {
    public let gatewayHostId: String
    public let target: ExecutionTargetBinding?
    public static let received = Notification.Name("ScrySubscriptionCatalogChange")
  }

  public struct HostAdminNotice: Decodable, Sendable, Identifiable {
    public let id: String
    public let kind: String
    public let ts: Int
    public let deviceLabel: String?
    public let fingerprintPrefix: String?

    public static let received = Notification.Name("ScryHostAdminNotice")

    var isDisplayable: Bool {
      let kinds = ["cli_approval_enabled", "device_approved_via_cli", "device_revoked_via_cli",
                   "pairing_cancelled_via_cli", "desktop_disabled_via_cli"]
      return kinds.contains(kind) && !id.isEmpty && id.utf16.count <= 64 && ts >= 0 &&
        (deviceLabel?.utf16.count ?? 0) <= 320 &&
        (fingerprintPrefix == nil || fingerprintPrefix?.range(of: "^[a-fA-F0-9]{8,16}$", options: .regularExpression) != nil)
    }
  }

  static func decodeSubscription(_ data: Data, target: ExecutionTargetBinding?) throws -> SubscriptionReply {
    let packet = try JSONDecoder().decode(SubscriptionPacket.self, from: data)
    if let error = packet.error { throw RunError.host(code: error) }
    guard packet.executionTarget == target, let subscription = packet.subscribe else { throw ProbeError.unexpectedReply }
    return subscription
  }

  static func readSubscription(_ input: SubscriptionRequest, endpoint: RelayEndpoint, identity: G0ProbeIdentity,
                               lane: RelaySession.Lane) async throws -> SubscriptionReply {
    func send(_ request: SubscriptionRequest) async throws -> SubscriptionReply {
      let bytes = try JSONEncoder().encode(request)
      return try decodeSubscription(try await exchangeRelay(endpoint: endpoint, mode: "run",
        identity: identity, request: bytes, lane: lane), target: endpoint.executionTarget)
    }
    var response = try await send(input)
    guard response.kind == "history_chunk" else { return response }
    let chunkSize = 512 * 1_024
    let maximum = 8 * 1_024 * 1_024
    guard let id = response.id, UUID(uuidString: id) != nil, let total = response.totalBytes,
          total > chunkSize, total <= maximum else { throw ProbeError.unexpectedReply }
    var data = Data(capacity: total)
    var request = input
    while data.count < total {
      try Task.checkCancellation()
      guard response.kind == "history_chunk", response.id == id, response.totalBytes == total,
            response.offset == data.count, let raw = response.data, let bytes = Data(base64Encoded: raw),
            bytes.count == min(chunkSize, total - data.count), bytes.base64EncodedString() == raw else {
        throw ProbeError.unexpectedReply
      }
      data.append(bytes)
      if data.count < total {
        request.chunk = SubscriptionChunkRef(id: id, offset: data.count)
        response = try await send(request)
      }
    }
    return try JSONDecoder().decode(SubscriptionReply.self, from: data)
  }
}
