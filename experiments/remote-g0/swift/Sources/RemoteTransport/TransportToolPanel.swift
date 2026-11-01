import Foundation
import NIOCore
import NIOPosix
import NIOHTTP1
import NIOWebSocket
import NIOSSL
import NIOTLS

extension G0Transport {
  public enum ToolPanelKind: String, Sendable, Equatable {
    case analytics, llmPerformance, mcpTrust
  }

  // Mirrors of the host's bounded projection. Every number that the host could
  // not measure arrives as nil and must stay "unavailable" in the UI.
  public struct ToolPanelPayload: Decodable, Sendable, Equatable {
    public let kind: String
    public let readAt: Double
    public let unavailable: String?
    public let analytics: Analytics?
    public let llm: Llm?
    public let mcp: Mcp?

    public struct Totals: Decodable, Sendable, Equatable {
      public let costUsd: Double?; public let inputTokens: Double?; public let outputTokens: Double?
      public let cacheReadTokens: Double?; public let cacheWriteTokens: Double?; public let reasoningTokens: Double?
      public let turns: Int; public let tokenKnownRows: Int; public let costKnownRows: Int
      public let exactCostRows: Int; public let estimatedCostRows: Int; public let inferredCostRows: Int
    }
    public struct DayRow: Decodable, Sendable, Equatable {
      public let day: String; public let costUsd: Double?; public let inputTokens: Double?; public let outputTokens: Double?
    }
    public struct ProviderRow: Decodable, Sendable, Equatable {
      public let provider: String; public let costUsd: Double?; public let inputTokens: Double?
      public let outputTokens: Double?; public let turns: Int
    }
    public struct ModelRow: Decodable, Sendable, Equatable {
      public let provider: String; public let model: String?; public let costUsd: Double?
      public let turns: Int; public let tokenKnownRows: Int
      // Estimated/inferred cost rows carry the marker; exact rows do not claim one.
      // Optional so a host that predates the marker still decodes.
      public let approximate: Bool?
    }
    public struct Analytics: Decodable, Sendable, Equatable {
      public let rangeDays: Int; public let status: String; public let observedAt: Double
      public let fromDay: String; public let toDay: String
      public let totals: Totals; public let byDay: [DayRow]; public let byProvider: [ProviderRow]
      public let byModel: [ModelRow]; public let byModelTruncated: Bool; public let byProviderTruncated: Bool
    }
    public struct RunningModel: Decodable, Sendable, Equatable {
      public let key: String; public let model: String?; public let sessions: Int
      public let tokensPerSecond: Double?; public let firstTokenMs: Double?; public let states: [String]
    }
    public struct HistoryRow: Decodable, Sendable, Equatable {
      public let ts: String; public let model: String; public let providerId: String
      public let speed: Double?; public let firstTokenMs: Double?; public let failed: Bool
    }
    public struct Llm: Decodable, Sendable, Equatable {
      public let running: Running; public let history: History
      public struct Running: Decodable, Sendable, Equatable {
        public let observedAt: String; public let models: [RunningModel]
      }
      public struct History: Decodable, Sendable, Equatable {
        public let rows: [HistoryRow]; public let truncated: Bool
        public let invalidLines: Int; public let cappedAt: Int
      }
    }
    public struct McpTarget: Decodable, Sendable, Equatable {
      public let name: String; public let scope: String; public let transport: String
      public let enabled: Bool; public let targetId: String?
    }
    public struct McpRuntime: Decodable, Sendable, Equatable {
      public let name: String; public let status: String; public let tools: Int?
    }
    public struct McpFinding: Decodable, Sendable, Equatable {
      public let id: String; public let title: String; public let severity: String
      public let confidence: String; public let decision: String; public let ruleId: String
      public let targets: [String]; public let recommendation: String
    }
    public struct McpScan: Decodable, Sendable, Equatable {
      public let status: String?; public let summary: Summary?
      public let findings: [McpFinding]; public let findingsTruncated: Bool
      public struct Summary: Decodable, Sendable, Equatable {
        public let critical: Int; public let high: Int; public let medium: Int
        public let low: Int; public let info: Int
      }
    }
    public struct Mcp: Decodable, Sendable, Equatable {
      public let providerId: String; public let configured: [McpTarget]
      public let runtime: [McpRuntime]?; public let configuredTruncated: Bool
      public let runtimeTruncated: Bool
      // A read-only static scan. Absent (with a reason) when the Mac could not run one.
      public let scan: McpScan?
      public let scanUnavailable: String?
    }
  }

  // One bounded read of an already-computed panel. The host never scans on this
  // call, so a device cannot widen its own authority through it.
  public static func relayToolPanel(endpoint: RelayEndpoint, identity: G0ProbeIdentity, kind: ToolPanelKind,
                                    rangeDays: Int? = nil, providerId: String? = nil) async throws -> ToolPanelPayload {
    let request = try JSONEncoder().encode(RunToolPanelRequest(kind: kind.rawValue, rangeDays: rangeDays, providerId: providerId))
    let response = try decodeRun(await exchangeRelay(endpoint: endpoint, mode: "run", identity: identity,
                                                    request: request, lane: .bulk), expectedTarget: endpoint.executionTarget)
    guard let panel = response.toolPanel else { throw ProbeError.unexpectedReply }
    return panel
  }

  public enum SessionCleanup: Sendable, Equatable {
    case rename(title: String)
    case pin(Bool)
    case archive(Bool)
  }

  // Host-reported cleanup result for a confirmed archive delete. `deleted` and
  // `retained` are what the host actually removed or kept; the phone never
  // assumes a store was cleared.
  public struct DeleteSessionOutcome: Sendable, Equatable, Codable {
    public let ok: Bool
    public let cancelled: Bool?
    public let reason: String?
    public let deleted: [String]
    public let retained: [String]
    public let failed: [Failure]
    public struct Failure: Sendable, Equatable, Codable { public let store: String; public let error: String }
  }

  // Rename / pin / archive one session on the host. Returns the host verdict;
  // nil-safe callers must re-read the catalog instead of guessing.
  public static func relaySessionAction(endpoint: RelayEndpoint, identity: G0ProbeIdentity,
                                        context: SessionActionContext, action: SessionCleanup) async throws -> Bool {
    let wire: SessionActionWire
    switch action {
    case let .rename(title): wire = SessionActionWire(kind: "rename", title: title, pinned: nil, archived: nil)
    case let .pin(pinned): wire = SessionActionWire(kind: "pin", title: nil, pinned: pinned, archived: nil)
    case let .archive(archived): wire = SessionActionWire(kind: "archive", title: nil, pinned: nil, archived: archived)
    }
    let request = try JSONEncoder().encode(RunSessionActionRequest(context: context, action: wire))
    let response = try decodeRun(await exchangeRelay(endpoint: endpoint, mode: "run", identity: identity, request: request, replayable: false), expectedTarget: endpoint.executionTarget)
    guard let applied = response.sessionAction else { throw ProbeError.unexpectedReply }
    return applied
  }

  // Permanently delete an already-archived session. The host requires an explicit
  // confirmation flag and re-authorizes the workspace before removing anything.
  public static func relaySessionDelete(endpoint: RelayEndpoint, identity: G0ProbeIdentity,
                                        providerId: String, cwd: String, externalSessionId: String,
                                        agentProfileId: String? = nil) async throws -> DeleteSessionOutcome {
    let body = RunSessionDeleteRequest.Body(providerId: providerId, cwd: cwd, externalSessionId: externalSessionId,
                                            agentProfileId: agentProfileId, confirmed: true)
    let request = try JSONEncoder().encode(RunSessionDeleteRequest(request: body))
    let response = try decodeRun(await exchangeRelay(endpoint: endpoint, mode: "run", identity: identity, request: request, replayable: false), expectedTarget: endpoint.executionTarget)
    guard let outcome = response.sessionDelete else { throw ProbeError.unexpectedReply }
    return outcome
  }

  // The assistant's real streamed output content for one run, strictly after
  // `cursor` (server-authoritative per-run sequence). Authorized exactly like
  // every run op; an unknown/evicted run yields an honest empty page.
  public static func relayRunOutput(endpoint: RelayEndpoint, identity: G0ProbeIdentity, runId: String, cursor: Int) async throws -> RunOutputPage {
    let request = try JSONEncoder().encode(RunOutputRequest(runId: runId, cursor: cursor))
    let response = try decodeRun(await exchangeRelay(endpoint: endpoint, mode: "run", identity: identity, request: request), expectedTarget: endpoint.executionTarget)
    guard let output = response.output else { throw ProbeError.unexpectedReply }
    return RunOutputPage(chunks: output.chunks, cursor: output.cursor)
  }
}
