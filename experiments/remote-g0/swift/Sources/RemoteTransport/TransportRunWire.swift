import Foundation
import NIOCore
import NIOPosix
import NIOHTTP1
import NIOWebSocket
import NIOSSL
import NIOTLS

extension G0Transport {
  struct ExecutionTargetsRequest: Encodable { let op = "executionTargets" }
  struct ExecutionTargetsResponse: Decodable {
    let executionTargets: ExecutionTargetCatalog?
    let error: String?
  }
  struct RunSubmitRequest: Encodable { let op = "submit"; let intentId: String; let detail: String }
  struct RunIntentStatusRequest: Encodable { let op = "intentStatus"; let intentId: String }
  struct RunIntentBody: Decodable { let runId: String; let state: String }
  struct RunPollRequest: Encodable { let op = "poll"; let cursor: Int }
  struct RunStateRequest: Encodable { let op = "runState"; let runId: String }
  struct RunQuestionsRequest: Encodable { let op = "questions"; let runId: String }
  struct RunAnswerQuestionRequest: Encodable {
    let op = "answerQuestion"; let runId: String; let answerId: String; let response: RunQuestionResponse
  }
  struct RunProjectsRequest: Encodable { let op = "projects" }
  struct RunDirectoriesRequest: Encodable { let op = "directories"; let path: String? }
  struct RunDirectoriesPageRequest: Encodable {
    let op = "directoriesPage"; let path: String?; let cursor: Int; let limit: Int; let snapshot: String?
  }
  struct RunProviderCapabilityRequest: Encodable {
    struct Query: Encodable { let kind = "info" }
    let op = "desktop"
    let query = Query()
  }
  struct RunProvidersRequest: Encodable {
    let op = "providers"
    let detail: String?
    let providerId: String?
    let cwd: String?
    let agentProfileId: String?
  }
  struct RunCommandsRequest: Encodable { let op = "commands"; let providerId: String; let cwd: String; let agentProfileId: String? }
  struct RunSessionsRequest: Encodable { let op = "sessions" }
  struct RunSessionsPageRequest: Encodable {
    let op = "sessionsPage"; let cursor: Int; let limit: Int; let snapshot: String?
    var includeArchived: Bool? = nil
    var keepAlive: Bool? = nil
  }
  struct RunHistoryRequest: Encodable { let op = "history"; let historyScope: String = "session"; let providerId: String; let cwd: String; let externalSessionId: String; var agentProfileId = HistoryProfileValue(value: nil) }
  struct RunHistoryVersionRequest: Encodable { let op = "historyVersion"; let historyScope: String = "session"; let providerId: String; let cwd: String; let externalSessionId: String; var agentProfileId = HistoryProfileValue(value: nil) }
  struct RunHistoryPreviewRequest: Encodable {
    var agentProfileId = HistoryProfileValue(value: nil)
    let op = "historyPreview"; let historyScope: String = "session"; let providerId: String; let cwd: String; let externalSessionId: String
    var keepAlive: Bool? = nil
  }
  struct RunHistoryTurnsPageRequest: Encodable {
    var agentProfileId = HistoryProfileValue(value: nil)
    let op = "historyTurnsPage"; let historyScope: String = "session"; let providerId: String; let cwd: String; let externalSessionId: String
    let before: Int?; let limit: Int?; let snapshot: String?
    var keepAlive: Bool? = nil
  }
  struct RunHistoryPageRequest: Encodable {
    var agentProfileId = HistoryProfileValue(value: nil)
    let op = "historyPage"; let historyScope: String = "session"; let providerId: String; let cwd: String; let externalSessionId: String
    let cursor: Int; let limit: Int?; let snapshot: String?
    var keepAlive: Bool? = nil
  }
  struct RunOutputRequest: Encodable { let op = "output"; let runId: String; let cursor: Int }
  struct RunWatchRequest: Encodable { let op = "watch"; let runId: String; let cursor: Int; let outputCursor: Int; let waitMs: Int }
  struct RunStopRequest: Encodable { let op = "stop"; let runId: String }
  public struct SessionActionContext: Encodable, Sendable {
    public let cwd: String; public let providerId: String; public let externalSessionId: String; public let agentProfileId: String?
    public init(cwd: String, providerId: String, externalSessionId: String, agentProfileId: String? = nil) {
      self.cwd = cwd; self.providerId = providerId; self.externalSessionId = externalSessionId
      self.agentProfileId = agentProfileId
    }
  }
  // Only the fields belonging to one action kind are encoded: the host rejects a
  // null title/pinned/archived instead of treating it as a value.
  struct SessionActionWire: Encodable {
    let kind: String; let title: String?; let pinned: Bool?; let archived: Bool?
    func encode(to encoder: Encoder) throws {
      var box = encoder.container(keyedBy: CodingKeys.self)
      try box.encode(kind, forKey: .kind)
      try box.encodeIfPresent(title, forKey: .title)
      try box.encodeIfPresent(pinned, forKey: .pinned)
      try box.encodeIfPresent(archived, forKey: .archived)
    }
    enum CodingKeys: String, CodingKey { case kind, title, pinned, archived }
  }
  struct RunSessionActionRequest: Encodable {
    let op = "sessionAction"; let context: SessionActionContext; let action: SessionActionWire
  }
  struct RunToolPanelRequest: Encodable {
    let op = "toolPanel"
    let kind: String
    let rangeDays: Int?
    let providerId: String?
  }
  struct RunSessionDeleteRequest: Encodable {
    let op = "sessionDelete"
    let request: Body
    struct Body: Encodable {
      let providerId: String; let cwd: String; let externalSessionId: String
      let agentProfileId: String?; let confirmed: Bool
    }
  }
  struct LiveRunsHistory: Encodable { let historyScope: String = "session"; let providerId: String; let cwd: String; let externalSessionId: String; let known: String?; var agentProfileId = HistoryProfileValue(value: nil) }
  struct LiveRunsRequest: Encodable { let op = "liveRuns"; let revision: String?; let waitMs: Int; let history: LiveRunsHistory? }
  struct HistoryProfileValue: Encodable, Equatable, Sendable {
    let value: String?
    func encode(to encoder: Encoder) throws {
      var container = encoder.singleValueContainer()
      if let value { try container.encode(value) } else { try container.encodeNil() }
    }
  }
  struct HistoryProfileStamp: Decodable {
    let historyScope: String?
    let agentProfileId: String?
    enum CodingKeys: CodingKey { case agentProfileId, historyScope }
    init(from decoder: Decoder) throws {
      let container = try decoder.container(keyedBy: CodingKeys.self)
      guard container.contains(.agentProfileId) else { throw HistoryProfileError.unverified }
      agentProfileId = try container.decodeIfPresent(String.self, forKey: .agentProfileId)
      historyScope = try container.decodeIfPresent(String.self, forKey: .historyScope)
    }
  }
  public enum HistoryProfileError: Error { case unverified }
  struct ProviderDiscoveryInfo: Decodable {
    let kind: String
    let `protocol`: Int
    let execution: String
    let providerDiscovery: Int?
  }
  struct RunResponse: Decodable {
    let desktop: ProviderDiscoveryInfo?
    let historyProfile: HistoryProfileStamp?
    let historyScope: String?
    let runId: String?
    let status: String?
    let poll: RunPollBody?
    let state: String?
    let questions: [RunQuestionRequest]?
    let answer: RunQuestionAnswerOutcome?
    let projects: [RunProjectRef]?
    let directories: RunDirectoryListing?
    let directoriesPage: RunDirectoryPage?
    let providers: [RunProviderRef]?
    let providerDiscovery: Int?
    let commands: RunCommandCatalog?
    let sessions: [RunSessionRef]?
    let sessionsPage: RunSessionPage?
    let history: [RunHistoryTurn]?
    let historyVersion: RunHistoryVersion?
    let historyPreview: RunHistoryPreview?
    let historyPage: RunHistoryPage?
    let historyTurnsPage: RunHistoryTurnsPage?
    let output: RunOutputBody?
    let watch: RunWatchBody?
    let stop: RunStopBody?
    let sessionAction: Bool?
    let sessionDelete: DeleteSessionOutcome?
    let toolPanel: ToolPanelPayload?
    let liveRuns: LiveRunsOutcome?
    let intent: RunIntentBody?
    let executionTarget: ExecutionTargetBinding?
    let error: String?
  }
  struct RunWatchBody: Decodable {
    let poll: RunPollBody; let questions: [RunQuestionRequest]; let output: RunOutputBody; let state: String?
  }
  struct RunStopBody: Decodable { let status: String }
  struct RunPollBody: Decodable { let events: [RunLedgerEvent]; let cursor: Int }
  struct RunOutputBody: Decodable { let chunks: [RunOutputChunk]; let cursor: Int }


}
