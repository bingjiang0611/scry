import Foundation
import NIOCore
import NIOPosix
import NIOHTTP1
import NIOWebSocket
import NIOSSL
import NIOTLS

extension G0Transport {
  // --- Post-pairing RUN channel (relay mode "run", strict inner TLS 1.3 mTLS
  // presenting the CA-GRANTED device certificate). The host side is InnerMtlsHost
  // -> HostController; its op-based JSON wire is: request { op, intentId?, detail?,
  // cursor?, runId? }; response { runId, status } | { poll: { events, cursor } } |
  // { state } | { error }. These methods carry no trust of their own: the granted
  // cert on `identity` + the anchor-pinned inner TLS are the authorization.
  public struct RunSubmitOutcome: Sendable, Equatable { public let runId: String; public let status: String }
  public struct RunLedgerEvent: Sendable, Equatable, Codable {
    public let seq: Int
    public let at: Int
    public let runId: String
    public let kind: String
    public let intentId: String?
    public let detail: String?
  }
  public struct RunPollOutcome: Sendable, Equatable { public let events: [RunLedgerEvent]; public let cursor: Int }
  public struct RunQuestionOption: Sendable, Equatable, Codable {
    public let label: String; public let description: String; public let preview: String?
  }
  public struct RunQuestionPrompt: Sendable, Equatable, Codable {
    public let question: String; public let header: String; public let options: [RunQuestionOption]
    public let multiSelect: Bool; public let inputMode: String?
  }
  public struct RunQuestionRequest: Sendable, Equatable, Codable, Identifiable {
    public var id: String { questionId }
    public let runId: String; public let questionId: String; public let providerId: String?; public let agentId: String?
    public let questionKind: String?; public let source: String?; public let questions: [RunQuestionPrompt]
  }
  public struct RunQuestionResponse: Sendable, Equatable, Codable {
    public let runId: String; public let questionId: String; public let behavior: String; public let answers: [String: String]?
    public init(runId: String, questionId: String, behavior: String, answers: [String: String]? = nil) {
      self.runId = runId; self.questionId = questionId; self.behavior = behavior; self.answers = answers
    }
  }
  public struct RunQuestionAnswerOutcome: Sendable, Equatable, Codable { public let status: String }
  // One run the host proves is live right now. `remote` runs were submitted by a
  // paired device; `mac` runs belong to the Mac UI. Both carry open questions.
  // Absence from the list is "not observed", never "completed".
  public struct LiveRun: Sendable, Equatable, Codable, Identifiable {
    public var id: String { runId }
    public let origin: String
    public let runId: String
    public let providerId: String
    public let agentProfileId: String?
    public let cwd: String
    public let externalSessionId: String?
    public let prompt: String
    public let state: String
    public let questions: [RunQuestionRequest]
  }
  public struct LiveRunsOutcome: Sendable, Equatable, Codable {
    public let revision: String
    public let runs: [LiveRun]
    public let historyVersion: RunHistoryVersion?
  }
  // One host-authorized project directory the device may target. The device can
  // never authorize a new one; it only chooses among these, and the host
  // re-checks the cwd on submit regardless.
  public struct RunProjectRef: Sendable, Equatable, Codable {
    public let path: String; public let label: String
    public init(path: String, label: String) { self.path = path; self.label = label }
  }
  public struct RunDirectoryListing: Sendable, Equatable, Codable {
    public let current: RunProjectRef?; public let parent: RunProjectRef?; public let directories: [RunProjectRef]
    public init(current: RunProjectRef? = nil, parent: RunProjectRef? = nil, directories: [RunProjectRef]) {
      self.current = current; self.parent = parent; self.directories = directories
    }
  }
  public struct RunDirectoryPage: Sendable, Equatable, Codable {
    public let current: RunProjectRef?; public let parent: RunProjectRef?; public let directories: [RunProjectRef]
    public let cursor: Int; public let total: Int; public let hasMore: Bool; public let snapshot: String
  }
  public struct RunControlOption: Sendable, Equatable, Codable {
    public let id: String; public let label: String; public let description: String?; public let isDefault: Bool?
    public init(id: String, label: String, description: String? = nil, isDefault: Bool? = nil) {
      self.id = id; self.label = label; self.description = description; self.isDefault = isDefault
    }
  }
  public struct RunModelOption: Sendable, Equatable, Codable {
    public let id: String; public let providerId: String?; public let label: String
    public let description: String?; public let isDefault: Bool?; public let efforts: [RunControlOption]?
    public init(id: String, providerId: String? = nil, label: String, description: String? = nil,
                isDefault: Bool? = nil, efforts: [RunControlOption]? = nil) {
      self.id = id; self.providerId = providerId; self.label = label
      self.description = description; self.isDefault = isDefault; self.efforts = efforts
    }
    public var selectionId: String { (providerId ?? "") + "\u{1f}" + id }
  }
  // A selectable Provider context. Pi profiles share the canonical Provider id
  // while agentProfileId keeps their runtime/model catalogs distinct.
  public struct RunProviderRef: Sendable, Equatable, Codable {
    public let id: String; public let label: String; public let available: Bool; public let agentProfileId: String?
    public let modelId: String?; public let models: [RunModelOption]?
    public let efforts: [RunControlOption]?; public let permissions: [RunControlOption]?
    public let observedAt: Double?
    public init(id: String, label: String, available: Bool, agentProfileId: String? = nil, modelId: String? = nil,
                models: [RunModelOption]? = nil, efforts: [RunControlOption]? = nil,
                permissions: [RunControlOption]? = nil, observedAt: Double? = nil) {
      self.id = id; self.label = label; self.available = available; self.agentProfileId = agentProfileId
      self.modelId = modelId; self.models = models; self.efforts = efforts; self.permissions = permissions
      self.observedAt = observedAt
    }
  }
  public struct RunCommandRef: Sendable, Equatable, Codable, Identifiable {
    public let name: String; public let description: String; public let argumentHint: String?; public let source: String?
    public var id: String { name }
    public init(name: String, description: String, argumentHint: String? = nil, source: String? = nil) {
      self.name = name; self.description = description; self.argumentHint = argumentHint; self.source = source
    }
  }
  public struct RunCommandCatalog: Sendable, Equatable, Codable {
    public let commands: [RunCommandRef]; public let reason: String?
    public init(commands: [RunCommandRef], reason: String? = nil) { self.commands = commands; self.reason = reason }
  }
  // A session in the host catalog the device may browse. `externalSessionId` is
  // the Provider's resumable id (nil => pending/unresumable). Display metadata.
  public struct RunSessionRef: Sendable, Equatable, Codable {
    public let sessionId: String; public let externalSessionId: String?; public let providerId: String; public let agentProfileId: String?
    public let cwd: String; public let label: String; public let ts: Double; public let pinnedAt: Double?; public let isActive: Bool?
    // Host-recorded archive time. Only archived catalog reads carry it; nil means
    // "not archived" in the active catalog, never "unknown".
    public let archivedAt: Double?
    // The host's PERSISTED outcome of this session's latest turn (see
    // `TurnOutcome`). Only the Mac's turn record can prove an ending, so a host
    // that has none — never ran a turn, older host, unfinished run — sends
    // nothing. Absence is unknown, never success, and it outlives app restarts.
    public let lastRunOutcome: String?
    // Wire vocabulary of `lastRunOutcome`, the same four values the Mac accepts
    // (`isRemoteSessionOutcome` in src/shared/desktop-remote.ts).
    public enum TurnOutcome: String, Sendable, Equatable {
      case completed, failed, cancelled, interrupted
    }
    public var turnOutcome: TurnOutcome? { lastRunOutcome.flatMap(TurnOutcome.init(rawValue:)) }
    public init(sessionId: String, externalSessionId: String? = nil, providerId: String, agentProfileId: String? = nil,
                cwd: String, label: String, ts: Double, pinnedAt: Double? = nil, isActive: Bool? = nil,
                archivedAt: Double? = nil, lastRunOutcome: String? = nil) {
      self.sessionId = sessionId; self.externalSessionId = externalSessionId; self.providerId = providerId
      self.agentProfileId = agentProfileId; self.cwd = cwd; self.label = label; self.ts = ts; self.pinnedAt = pinnedAt
      self.isActive = isActive; self.archivedAt = archivedAt
      self.lastRunOutcome = lastRunOutcome
    }
  }
  public struct RunSessionPage: Sendable, Equatable, Codable {
    public let sessions: [RunSessionRef]
    public let cursor: Int; public let total: Int; public let hasMore: Bool; public let snapshot: String
  }
  // One content chunk of a replayed session turn (same kinds a live run streams).
  public struct RunHistoryChunk: Sendable, Equatable, Codable {
    public let kind: String; public let text: String
    public init(kind: String, text: String) { self.kind = kind; self.text = text }
  }
  // One turn of a session's real conversation: the prompt + assistant content.
  // `runId` is the Scry run id on structured turn pages (nil for transcript-only
  // turns, legacy snapshots and older hosts). It lets a device recognize its own
  // archived run; it is never derived from prompt text.
  public struct RunHistoryTurn: Sendable, Equatable, Codable {
    public let runId: String?; public let userText: String; public let items: [RunHistoryChunk]
    public init(runId: String? = nil, userText: String, items: [RunHistoryChunk]) {
      self.runId = runId; self.userText = userText; self.items = items
    }
  }
  // A single chunk of the assistant's REAL streamed output content (masked +
  // bounded host-side). kind ∈ output|reasoning|tool|tool_result|truncated.
  // This is trace-derived CONTENT, not canonical usage; tokens/cost stay on the
  // ledger `result` event, never re-derived from here.
  public struct RunOutputChunk: Sendable, Equatable, Codable {
    public let seq: Int; public let at: Int; public let runId: String; public let kind: String; public let text: String
  }
  public struct RunOutputPage: Sendable, Equatable { public let chunks: [RunOutputChunk]; public let cursor: Int }
  public struct RunHistoryPage: Sendable, Equatable, Codable {
    public let dataBase64: String; public let cursor: Int; public let totalBytes: Int
    public let hasMore: Bool; public let snapshot: String
  }
  public struct RunHistoryTurnsPage: Sendable, Equatable, Codable {
    // The host's snapshot is a signed source-version token, not a display id:
    // `<archive>:<transcript>:<active 0|1>:<active revision>:<native revision>:<signature>`
    // = 4*64 + 1 + 32 hex chars + 5 ':' = 294. A 256-byte bound rejected every
    // real session-scope page, so the device could only ever paint the 2-turn
    // preview. The bound is a framing guard; integrity stays in the signature.
    public static let maxHistorySnapshotBytes = 512
    public let turns: [RunHistoryTurn]; public let offset: Int; public let totalTurns: Int
    public let hasOlder: Bool; public let snapshot: String; public let source: String; public let completeness: String
    public let sourceWarning: String?
    public init(turns: [RunHistoryTurn], offset: Int, totalTurns: Int, hasOlder: Bool,
                snapshot: String, source: String, completeness: String, sourceWarning: String? = nil) {
      self.turns = turns; self.offset = offset; self.totalTurns = totalTurns; self.hasOlder = hasOlder
      self.snapshot = snapshot; self.source = source; self.completeness = completeness; self.sourceWarning = sourceWarning
    }
    public func validate() throws {
      guard offset >= 0, totalTurns >= offset, turns.count <= totalTurns - offset,
            hasOlder == (offset > 0), !snapshot.isEmpty, snapshot.utf8.count <= Self.maxHistorySnapshotBytes,
            ["active_memory", "indexed_archive", "index_rebuild", "monolithic", "claude_transcript", "pi_native"].contains(source),
            sourceWarning == nil || sourceWarning == "native_unavailable",
            ["partial", "complete"].contains(completeness),
            completeness != "complete" || (offset == 0 && turns.count == totalTurns && source != "active_memory") else {
        throw ProbeError.unexpectedReply
      }
    }
    func validated(before: Int?, limit: Int, expectedSnapshot: String?) throws -> Self {
      try validate()
      guard turns.count <= limit, offset + turns.count == (before ?? totalTurns),
            expectedSnapshot == nil || expectedSnapshot == snapshot else { throw ProbeError.unexpectedReply }
      return self
    }
  }
  public struct RunHistoryPreviewItem: Sendable, Equatable, Codable {
    public let kind: String; public let text: String; public let truncated: Bool
    public init(kind: String, text: String, truncated: Bool) { self.kind = kind; self.text = text; self.truncated = truncated }
  }
  public struct RunHistoryPreviewTurn: Sendable, Equatable, Codable {
    public let userText: String; public let userTextTruncated: Bool
    public let items: [RunHistoryPreviewItem]; public let truncated: Bool
    public init(userText: String, userTextTruncated: Bool, items: [RunHistoryPreviewItem], truncated: Bool) {
      self.userText = userText; self.userTextTruncated = userTextTruncated; self.items = items; self.truncated = truncated
    }
  }
  public struct RunHistoryVersion: Sendable, Equatable, Codable {
    public let version: String
    public let readMode: String
  }
  public struct RunHistoryPreview: Sendable, Equatable, Codable {
    public let status: String; public let reason: String?; public let source: String?
    public let turns: [RunHistoryPreviewTurn]; public let partial: Bool?; public let truncated: Bool?; public let bytes: Int?
    public var available: Bool { status == "available" }
    public init(source: String, turns: [RunHistoryPreviewTurn], truncated: Bool, bytes: Int) {
      status = "available"; reason = nil; self.source = source; self.turns = turns
      partial = true; self.truncated = truncated; self.bytes = bytes
    }
    private enum CodingKeys: String, CodingKey { case status, reason, source, turns, partial, truncated, bytes }
    public init(from decoder: Decoder) throws {
      let container = try decoder.container(keyedBy: CodingKeys.self)
      status = try container.decode(String.self, forKey: .status)
      reason = try container.decodeIfPresent(String.self, forKey: .reason)
      source = try container.decodeIfPresent(String.self, forKey: .source)
      partial = try container.decodeIfPresent(Bool.self, forKey: .partial)
      truncated = try container.decodeIfPresent(Bool.self, forKey: .truncated)
      bytes = try container.decodeIfPresent(Int.self, forKey: .bytes)
      switch status {
      case "available":
        turns = try container.decode([RunHistoryPreviewTurn].self, forKey: .turns)
        guard partial == true, source != nil, bytes != nil, truncated != nil else {
          throw DecodingError.dataCorruptedError(forKey: .status, in: container, debugDescription: "Incomplete available preview")
        }
      case "unavailable":
        guard reason != nil else {
          throw DecodingError.dataCorruptedError(forKey: .reason, in: container, debugDescription: "Unavailable preview requires reason")
        }
        turns = []
      default:
        throw DecodingError.dataCorruptedError(forKey: .status, in: container, debugDescription: "Unknown preview status")
      }
    }
  }


}
