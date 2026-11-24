import Foundation
import RemoteTransport

extension RemoteRunStore {
  enum ConnectionObservation: Equatable {
    case unverified
    case reachable
    case transportFailure
    case hostReply(code: String)
    case protocolFailure(code: String)
  }
  enum ProjectsState: Equatable {
    case idle
    case loading
    case loaded([G0Transport.RunProjectRef])
    case empty
    case failed(String)
  }

  enum DirectoriesState: Equatable {
    case idle
    case loading
    case loaded(G0Transport.RunDirectoryListing)
    case denied
    case failed(String)
  }

  // Host-advertised Providers for the new-session picker. Mirrors the host's real
  // describe(); we never invent a provider or fake availability.
  enum ProvidersState: Equatable {
    case idle
    case loading
    case loaded([G0Transport.RunProviderRef])
    case empty
    case failed(String)
  }

  enum CommandsState: Equatable {
    case idle
    case loading
    case loaded([G0Transport.RunCommandRef])
    case empty(String?)
    case failed(String)
  }

  // The device-observable lifecycle. `.unknown` = we have not learned a state
  // yet (e.g. before any poll), never shown as success.
  enum Lifecycle: String, Equatable {
    // `queued` means the host accepted this turn and is holding it behind the session's live run.
    // It is not execution, and it is not terminal: the turn still has to run.
    case unknown, submitting, queued, recorded, dispatched, running, settled, failed, cancelled
  }

  struct OutputLine: Identifiable, Equatable {
    let id: Int      // per-run output seq
    let kind: String // output | reasoning | tool | tool_result | truncated
    let text: String
  }
  struct SentAttachment: Identifiable, Equatable {
    let id = UUID()
    let name: String
    let kind: RemoteRunClient.Attachment.Kind
    let size: Int
    // Decoded image bytes kept in memory only, so the sent bubble can show a
    // thumbnail and full-screen preview of exactly what was uploaded.
    let imageData: Data?

    init(name: String, kind: RemoteRunClient.Attachment.Kind, size: Int, imageData: Data? = nil) {
      self.name = name; self.kind = kind; self.size = size; self.imageData = imageData
    }

    init(_ attachment: RemoteRunClient.Attachment) {
      self.init(name: attachment.name, kind: attachment.kind, size: attachment.size,
                imageData: attachment.kind == .image ? Data(base64Encoded: attachment.dataBase64) : nil)
    }
  }

  // A transport response is only allowed to mutate the session that initiated
  // it. The local id keeps consecutive new sessions distinct until the host
  // reports an external Provider session id.
  struct SessionIdentity: Codable, Hashable, Equatable {
    let providerId: String
    let agentProfileId: String?
    let cwd: String
    let externalSessionId: String?
    let localId: String?
    let gatewayHostId: String?
    let gatewayIdentity: String?
    let targetHostId: String?
    let targetId: String?
    let targetBinding: String?

    var scope: ExecutionTargetScope? {
      guard let gatewayHostId, let targetId, let targetBinding else { return nil }
      return ExecutionTargetScope(gatewayHostId: gatewayHostId, targetId: targetId,
                                  binding: targetBinding, hostId: targetHostId ?? targetId, label: targetId, gatewayIdentity: gatewayIdentity)
    }

    static func opened(providerId: String, agentProfileId: String? = nil, cwd: String, externalSessionId: String,
                       scope: ExecutionTargetScope? = nil) -> SessionIdentity {
      SessionIdentity(providerId: providerId, agentProfileId: agentProfileId, cwd: cwd,
        externalSessionId: externalSessionId, localId: nil, gatewayHostId: scope?.gatewayHostId,
        gatewayIdentity: scope?.gatewayIdentity, targetHostId: scope?.isLocal == false ? scope?.hostId : nil,
        targetId: scope?.targetId, targetBinding: scope?.binding)
    }

    static func new(providerId: String, agentProfileId: String? = nil, cwd: String,
                    scope: ExecutionTargetScope? = nil) -> SessionIdentity {
      SessionIdentity(providerId: providerId, agentProfileId: agentProfileId, cwd: cwd,
        externalSessionId: nil, localId: UUID().uuidString.lowercased(), gatewayHostId: scope?.gatewayHostId,
        gatewayIdentity: scope?.gatewayIdentity, targetHostId: scope?.isLocal == false ? scope?.hostId : nil,
        targetId: scope?.targetId, targetBinding: scope?.binding)
    }
  }

  struct QuestionIdentity: Hashable {
    let gatewayIdentity: String?
    let target: G0Transport.ExecutionTargetBinding?
    let session: SessionIdentity?
    let runId: String
    let questionId: String
  }

  func questionIdentity(_ request: G0Transport.RunQuestionRequest) -> QuestionIdentity {
    QuestionIdentity(gatewayIdentity: targetScope?.gatewayIdentity ?? loadConnection().map { RemoteHistoryCache.catalogKey(connection: $0) },
      target: targetScope?.targetBinding, session: activeSessionIdentity, runId: request.runId, questionId: request.questionId)
  }

  var focusedQuestionIdentity: QuestionIdentity? { pendingQuestions.first.map(questionIdentity) }

  struct CompletedLiveTurn: Identifiable, Equatable {
    let id: String
    let runId: String?
    let prompt: String
    let attachments: [SentAttachment]
    let lifecycle: Lifecycle
    let output: [OutputLine]
    let resultSummary: String?
    let externalSessionId: String?
    // Scry run id from the host `bound` marker; matches history page turn ids.
    var hostRunId: String? = nil
  }

  // A message the host has not acknowledged yet. A never-attempted item is
  // delivered automatically; once submit may have crossed the transport
  // boundary, the same intent remains retryable in-process but pauses on relaunch
  // until its result is reconciled. The host ledger still dedupes by intentId.
  // `failure` is set only by a definitive host rejection, never by the network.
  struct PendingSubmission: Codable, Equatable, Identifiable {
    let intentId: String
    let routing: RemoteRunClient.Routing
    let identity: SessionIdentity
    var failure: String? = nil
    var uncertainty: String? = nil
    // false is a new, never-attempted item; nil is an older unknown state.
    // true remains retryable in-process but pauses after relaunch.
    var attempted: Bool? = false
    var id: String { intentId }
  }

  enum DeliveryResult<Outcome> {
    case accepted(Outcome)
    case rejected(String)
    case uncertain(String)
  }

  struct RecoveryCheckpoint: Codable {
    let version: Int
    let hostId: String
    let intentId: String?
    let routing: RemoteRunClient.Routing?
    let identity: SessionIdentity
    let runId: String?
  }

  // parent-facing contract for navigation and composer admission.
  var hasUnresolvedRun: Bool {
    Self.unresolvedState(pending: pendingSubmission != nil, runId: runId,
                         drained: terminalDrainCompleted, interrupted: observationInterrupted)
  }
  var isBusy: Bool { hasUnresolvedRun }
  // A host run exists and has not reported a terminal lifecycle. Stop is a
  // request; it is offered even while reconnecting because the host may still run.
  var canStop: Bool {
    runId != nil && [.recorded, .dispatched, .running].contains(lifecycle)
  }
  var historyPreviewTurns: [G0Transport.RunHistoryTurn] {
    guard case let .available(preview) = historyPreview else { return [] }
    return preview.turns.map { turn in
      G0Transport.RunHistoryTurn(userText: turn.userText,
        items: turn.items.map { G0Transport.RunHistoryChunk(kind: $0.kind, text: $0.text) })
    }
  }
}
