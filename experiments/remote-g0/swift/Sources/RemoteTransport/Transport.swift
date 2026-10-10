import Foundation
import NIOCore
import NIOPosix
import NIOHTTP1
import NIOWebSocket
import NIOSSL
import NIOTLS

enum ProbeError: Error { case invalidArguments, invalidFrame, oversized, disconnected, unexpectedReply }

public enum RelayTransportError: Error, Sendable {
  case closed(code: UInt16?, reason: String)
  case timedOut(stage: String)
}

// Converts the outer WebSocket's binary frames into the inner TLS byte stream.
// Text, fragmentation and overflow terminate the stream; never skip bytes and
// continue an allegedly reliable TLS connection after a gap.
final class TunnelCodec: ChannelDuplexHandler {
  typealias InboundIn = WebSocketFrame
  typealias InboundOut = ByteBuffer
  typealias OutboundIn = ByteBuffer
  typealias OutboundOut = WebSocketFrame

  func channelRead(context: ChannelHandlerContext, data: NIOAny) {
    let frame = unwrapInboundIn(data)
    switch frame.opcode {
    case .binary:
      guard frame.fin, frame.maskKey == nil else {
        context.fireErrorCaught(ProbeError.invalidFrame)
        context.close(promise: nil)
        return
      }
      context.fireChannelRead(wrapInboundOut(frame.unmaskedData))
    case .ping:
      context.writeAndFlush(wrapOutboundOut(WebSocketFrame(fin: true, opcode: .pong, maskKey: .random(), data: frame.unmaskedData)), promise: nil)
    case .pong: break
    case .connectionClose:
      var payload = frame.unmaskedData
      let code = payload.readInteger(as: UInt16.self)
      let reason = payload.readString(length: min(payload.readableBytes, 123)) ?? ""
      // Preserve the relay's close cause before TLS sees an anonymous EOF.
      // This is untrusted diagnostic text, never authentication evidence.
      context.fireErrorCaught(RelayTransportError.closed(code: code, reason: reason))
      context.close(promise: nil)
    default:
      context.fireErrorCaught(ProbeError.invalidFrame)
      context.close(promise: nil)
    }
  }

  func write(context: ChannelHandlerContext, data: NIOAny, promise: EventLoopPromise<Void>?) {
    let bytes = unwrapOutboundIn(data)
    guard bytes.readableBytes <= 1_572_864, context.channel.isWritable else {
      promise?.fail(ProbeError.oversized)
      context.close(promise: nil)
      return
    }
    context.write(wrapOutboundOut(WebSocketFrame(fin: true, opcode: .binary, maskKey: .random(), data: bytes)), promise: promise)
  }
}

// Mutable state belongs exclusively to the channel event loop.
final class ProbeHandler: ChannelInboundHandler, @unchecked Sendable {
  typealias InboundIn = ByteBuffer
  typealias OutboundOut = ByteBuffer
  private let request: Data
  private let result: EventLoopPromise<Data>
  private let maxResponseBytes: Int
  private var received = Data()
  private var sent = false
  private var settled = false
  private var deadline: Scheduled<Void>?

  init(request: Data, result: EventLoopPromise<Data>, maxResponseBytes: Int = 65_536) {
    self.request = request
    self.result = result
    self.maxResponseBytes = maxResponseBytes
  }

  func handlerAdded(context: ChannelHandlerContext) {
    let channel = context.channel
    // The relay can close between HTTP upgrade and this handler's installation.
    // closeFuture also covers that already-closed case; channelInactive cannot.
    channel.closeFuture.whenComplete { [self] _ in fail(ProbeError.disconnected, channel: channel) }
    guard !settled else { return }
    deadline = context.eventLoop.scheduleTask(in: .seconds(10)) { [self] in
      fail(RelayTransportError.timedOut(stage: "inner-handshake"), channel: channel)
    }
  }

  func userInboundEventTriggered(context: ChannelHandlerContext, event: Any) {
    if let tlsEvent = event as? TLSUserEvent, case .handshakeCompleted = tlsEvent, !sent {
      // No 0-RTT or writes before the inner host-authenticated handshake.
      sent = true
      deadline?.cancel()
      let channel = context.channel
      deadline = context.eventLoop.scheduleTask(in: .seconds(30)) { [self] in
        fail(RelayTransportError.timedOut(stage: "response"), channel: channel)
      }
      var bytes = request
      bytes.append(10)
      context.writeAndFlush(wrapOutboundOut(ByteBuffer(bytes: bytes)), promise: nil)
    }
    context.fireUserInboundEventTriggered(event)
  }

  func channelRead(context: ChannelHandlerContext, data: NIOAny) {
    let bytes = unwrapInboundIn(data)
    guard received.count + bytes.readableBytes <= maxResponseBytes else { fail(ProbeError.oversized, channel: context.channel); return }
    received.append(contentsOf: bytes.readableBytesView)
    guard let newline = received.firstIndex(of: 10) else { return }
    do {
      guard newline == received.count - 1 else { throw ProbeError.unexpectedReply }
      let reply = Data(received.prefix(upTo: newline))
      if !settled { settled = true; deadline?.cancel(); deadline = nil; result.succeed(reply) }
      context.close(promise: nil)
    } catch { fail(error, channel: context.channel) }
  }

  func errorCaught(context: ChannelHandlerContext, error: Error) { fail(error, channel: context.channel) }
  func channelInactive(context: ChannelHandlerContext) {
    fail(ProbeError.disconnected, channel: context.channel)
    context.fireChannelInactive()
  }
  private func fail(_ error: Error, channel: Channel) {
    guard !settled else { return }
    settled = true
    deadline?.cancel(); deadline = nil
    result.fail(error)
    channel.close(promise: nil)
  }
}

public struct G0ProbeIdentity: Sendable {
  let outerCA: Data
  let innerCA: Data
  let certificate: Data?
  let privateKey: Data?

  // Full mTLS identity for post-pairing business channels.
  public init(outerCA: Data, innerCA: Data, certificate: Data, privateKey: Data) {
    self.outerCA = outerCA
    self.innerCA = innerCA
    self.certificate = certificate
    self.privateKey = privateKey
  }

  // Pairing bootstrap: the device only verifies the host anchor from the QR
  // code and proves key possession via the in-channel CSR signature. It must
  // NOT present an owner-device client certificate it does not yet have.
  public init(outerCA: Data, hostAnchor: Data) {
    self.outerCA = outerCA
    self.innerCA = hostAnchor
    self.certificate = nil
    self.privateKey = nil
  }
}

public enum G0Transport {
  // Intentionally loopback-only until a separate public test endpoint is
  // authorized and authenticated routing exists. This is not a business API.
  public static func echo(port: Int, identity: G0ProbeIdentity, payload: String) async throws -> Data {
    let request = try ProbeRequest(protocolMajor: 1, requestId: UUID().uuidString, operation: "probe.echo", payload: payload)
    let bytes = try await exchange(port: port, identity: identity, request: JSONEncoder().encode(request))
    let reply = try JSONDecoder().decode(ProbeResponse.self, from: bytes)
    guard reply.requestId == request.requestId, reply.payload == request.payload else { throw ProbeError.unexpectedReply }
    return try JSONEncoder().encode(reply)
  }

  // Pairing bootstrap over a host-authenticated channel. Returns the raw JSON
  // response line; the caller decides local UI meaning. This does not itself
  // establish trust: the device must have verified the host anchor from the QR
  // code, and a granted certificate still needs the host user's confirmation.
  public enum PairOutcome: Sendable, Equatable {
    case pending(publicKeySHA256: String)
    case granted(certificatePEM: String, deviceId: String, expiresAt: Int)
    case revoked(deviceId: String)
    case denied(code: String)
  }

  public static func pairProve(port: Int, identity: G0ProbeIdentity, pairingId: String, secret: String, csrPEM: String, deviceLabel: String) async throws -> PairOutcome {
    let requestId = UUID().uuidString
    let request = try PairProofRequest(protocolMajor: 1, requestId: requestId, operation: "pair.prove", pairingId: pairingId, secret: secret, csrPEM: csrPEM, deviceLabel: deviceLabel)
    return try decodePair(await exchange(port: port, identity: identity, request: JSONEncoder().encode(request), route: "/pair"), requestId: requestId)
  }

  public static func pairStatus(port: Int, identity: G0ProbeIdentity, pairingId: String, secret: String) async throws -> PairOutcome {
    let requestId = UUID().uuidString
    let request = try PairStatusRequest(protocolMajor: 1, requestId: requestId, operation: "pair.status", pairingId: pairingId, secret: secret)
    return try decodePair(await exchange(port: port, identity: identity, request: JSONEncoder().encode(request), route: "/pair"), requestId: requestId)
  }

  // Relay endpoint: outer WS(S) hop to a public relay that byte-shuttles to the
  // NAT-bound host's reverse tunnel. Routing is `/?host=<hostId>&mode=pair`; the
  // relay never sees inner keys. The device pins the host anchor (from the QR
  // code) for the inner TLS 1.3 mTLS and skips leaf hostname verification
  // because the per-launch host server cert carries no SAN (chain-to-anchor is
  // the only trust decision). Outer TLS is used only when a relay CA is given.
  public struct RelayEndpoint: Sendable {
    // Outer transport TLS to the relay. This is NOT the security root: the inner
    // TLS 1.3 mTLS to the host (pinned to the anchor) is. Outer TLS only stops a
    // passive network from reading the already-encrypted relay hop.
    public enum OuterTLS: Sendable {
      case plaintext   // ws:// — a local dev relay
      case system      // wss:// with a publicly-trusted cert (e.g. Cloudflare): default trust roots + hostname verification
      case pinned      // wss:// pinned to identity.outerCA (a private relay CA)
    }
    public let host: String
    public let port: Int
    public let hostId: String
    public let relayServerName: String?
    public let outerTLS: OuterTLS
    // When present, run-mode exchanges reuse this session's persistent lanes
    // instead of dialing one tunnel per request. Pairing never uses it.
    public let session: RelaySession?
    public init(host: String, port: Int, hostId: String, relayServerName: String? = nil, outerTLS: OuterTLS = .plaintext,
                session: RelaySession? = nil) {
      self.host = host
      self.port = port
      self.hostId = hostId
      self.relayServerName = relayServerName
      self.outerTLS = outerTLS
      self.session = session
    }
  }

  public static func relayPairProve(endpoint: RelayEndpoint, identity: G0ProbeIdentity, pairingId: String, secret: String, csrPEM: String, deviceLabel: String) async throws -> PairOutcome {
    let requestId = UUID().uuidString
    let request = try PairProofRequest(protocolMajor: 1, requestId: requestId, operation: "pair.prove", pairingId: pairingId, secret: secret, csrPEM: csrPEM, deviceLabel: deviceLabel)
    return try decodePair(await exchangeRelay(endpoint: endpoint, mode: "pair", identity: identity, request: JSONEncoder().encode(request)), requestId: requestId)
  }

  public static func relayPairStatus(endpoint: RelayEndpoint, identity: G0ProbeIdentity, pairingId: String, secret: String) async throws -> PairOutcome {
    let requestId = UUID().uuidString
    let request = try PairStatusRequest(protocolMajor: 1, requestId: requestId, operation: "pair.status", pairingId: pairingId, secret: secret)
    return try decodePair(await exchangeRelay(endpoint: endpoint, mode: "pair", identity: identity, request: JSONEncoder().encode(request)), requestId: requestId)
  }

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
    public init(id: String, label: String, available: Bool, agentProfileId: String? = nil, modelId: String? = nil,
                models: [RunModelOption]? = nil, efforts: [RunControlOption]? = nil,
                permissions: [RunControlOption]? = nil) {
      self.id = id; self.label = label; self.available = available; self.agentProfileId = agentProfileId
      self.modelId = modelId; self.models = models; self.efforts = efforts; self.permissions = permissions
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
    public init(sessionId: String, externalSessionId: String? = nil, providerId: String, agentProfileId: String? = nil,
                cwd: String, label: String, ts: Double, pinnedAt: Double? = nil, isActive: Bool? = nil) {
      self.sessionId = sessionId; self.externalSessionId = externalSessionId; self.providerId = providerId
      self.agentProfileId = agentProfileId; self.cwd = cwd; self.label = label; self.ts = ts; self.pinnedAt = pinnedAt
      self.isActive = isActive
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
  public struct RunHistoryTurn: Sendable, Equatable, Codable {
    public let userText: String; public let items: [RunHistoryChunk]
    public init(userText: String, items: [RunHistoryChunk]) { self.userText = userText; self.items = items }
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
    public let turns: [RunHistoryTurn]; public let offset: Int; public let totalTurns: Int
    public let hasOlder: Bool; public let snapshot: String; public let source: String; public let completeness: String
    public init(turns: [RunHistoryTurn], offset: Int, totalTurns: Int, hasOlder: Bool,
                snapshot: String, source: String, completeness: String) {
      self.turns = turns; self.offset = offset; self.totalTurns = totalTurns; self.hasOlder = hasOlder
      self.snapshot = snapshot; self.source = source; self.completeness = completeness
    }
    public func validate() throws {
      guard offset >= 0, totalTurns >= offset, turns.count <= totalTurns - offset,
            hasOlder == (offset > 0), !snapshot.isEmpty, snapshot.utf8.count <= 256,
            ["active_memory", "indexed_archive", "index_rebuild", "monolithic", "claude_transcript"].contains(source),
            ["partial", "complete"].contains(completeness),
            completeness != "complete" || (offset == 0 && turns.count == totalTurns && source != "active_memory") else {
        throw ProbeError.unexpectedReply
      }
    }
    fileprivate func validated(before: Int?, limit: Int, expectedSnapshot: String?) throws -> Self {
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

  private struct RunSubmitRequest: Encodable { let op = "submit"; let intentId: String; let detail: String }
  private struct RunPollRequest: Encodable { let op = "poll"; let cursor: Int }
  private struct RunStateRequest: Encodable { let op = "runState"; let runId: String }
  private struct RunQuestionsRequest: Encodable { let op = "questions"; let runId: String }
  private struct RunAnswerQuestionRequest: Encodable {
    let op = "answerQuestion"; let runId: String; let answerId: String; let response: RunQuestionResponse
  }
  private struct RunProjectsRequest: Encodable { let op = "projects" }
  private struct RunDirectoriesRequest: Encodable { let op = "directories"; let path: String? }
  private struct RunDirectoriesPageRequest: Encodable {
    let op = "directoriesPage"; let path: String?; let cursor: Int; let limit: Int; let snapshot: String?
  }
  private struct RunProvidersRequest: Encodable { let op = "providers" }
  private struct RunCommandsRequest: Encodable { let op = "commands"; let providerId: String; let cwd: String; let agentProfileId: String? }
  private struct RunSessionsRequest: Encodable { let op = "sessions" }
  private struct RunSessionsPageRequest: Encodable {
    let op = "sessionsPage"; let cursor: Int; let limit: Int; let snapshot: String?
    var keepAlive: Bool? = nil
  }
  private struct RunHistoryRequest: Encodable { let op = "history"; let providerId: String; let cwd: String; let externalSessionId: String }
  private struct RunHistoryVersionRequest: Encodable { let op = "historyVersion"; let providerId: String; let cwd: String; let externalSessionId: String }
  private struct RunHistoryPreviewRequest: Encodable {
    let op = "historyPreview"; let providerId: String; let cwd: String; let externalSessionId: String
    var keepAlive: Bool? = nil
  }
  struct RunHistoryTurnsPageRequest: Encodable {
    let op = "historyTurnsPage"; let providerId: String; let cwd: String; let externalSessionId: String
    let before: Int?; let limit: Int?; let snapshot: String?
    var keepAlive: Bool? = nil
  }
  struct RunHistoryPageRequest: Encodable {
    let op = "historyPage"; let providerId: String; let cwd: String; let externalSessionId: String
    let cursor: Int; let limit: Int?; let snapshot: String?
    var keepAlive: Bool? = nil
  }
  private struct RunOutputRequest: Encodable { let op = "output"; let runId: String; let cursor: Int }
  private struct RunWatchRequest: Encodable { let op = "watch"; let runId: String; let cursor: Int; let outputCursor: Int; let waitMs: Int }
  private struct RunStopRequest: Encodable { let op = "stop"; let runId: String }
  private struct LiveRunsHistory: Encodable { let providerId: String; let cwd: String; let externalSessionId: String; let known: String? }
  private struct LiveRunsRequest: Encodable { let op = "liveRuns"; let revision: String?; let waitMs: Int; let history: LiveRunsHistory? }
  private struct RunResponse: Decodable {
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
    let liveRuns: LiveRunsOutcome?
    let error: String?
  }
  private struct RunWatchBody: Decodable {
    let poll: RunPollBody; let questions: [RunQuestionRequest]; let output: RunOutputBody; let state: String?
  }
  private struct RunStopBody: Decodable { let status: String }
  private struct RunPollBody: Decodable { let events: [RunLedgerEvent]; let cursor: Int }
  private struct RunOutputBody: Decodable { let chunks: [RunOutputChunk]; let cursor: Int }

  private static func decodeRun(_ bytes: Data) throws -> RunResponse {
    let response = try JSONDecoder().decode(RunResponse.self, from: bytes)
    if let error = response.error { throw RunError.host(code: error) }
    return response
  }

  public enum RunError: Error, Equatable { case host(code: String) }

  // Submit a durable run intent (recorded != executed). `detail` is the routing
  // JSON { cwd, providerId, agentProfileId?, prompt }. Returns the host-assigned
  // runId; the device polls the ledger for the real lifecycle.
  public static func relayRunSubmit(endpoint: RelayEndpoint, identity: G0ProbeIdentity, intentId: String, detail: String) async throws -> RunSubmitOutcome {
    let request = try JSONEncoder().encode(RunSubmitRequest(intentId: intentId, detail: detail))
    let response = try decodeRun(await exchangeRelay(endpoint: endpoint, mode: "run", identity: identity, request: request, replayable: false))
    guard let runId = response.runId, let status = response.status else { throw ProbeError.unexpectedReply }
    return RunSubmitOutcome(runId: runId, status: status)
  }

  // Poll ledger events strictly after `cursor` (server-authoritative sequence).
  public static func relayRunPoll(endpoint: RelayEndpoint, identity: G0ProbeIdentity, cursor: Int) async throws -> RunPollOutcome {
    let request = try JSONEncoder().encode(RunPollRequest(cursor: cursor))
    let response = try decodeRun(await exchangeRelay(endpoint: endpoint, mode: "run", identity: identity, request: request))
    guard let poll = response.poll else { throw ProbeError.unexpectedReply }
    return RunPollOutcome(events: poll.events, cursor: poll.cursor)
  }

  // Query a single run's current lifecycle; nil means the host has no such run
  // for this device.
  public static func relayRunState(endpoint: RelayEndpoint, identity: G0ProbeIdentity, runId: String) async throws -> String? {
    let request = try JSONEncoder().encode(RunStateRequest(runId: runId))
    let response = try decodeRun(await exchangeRelay(endpoint: endpoint, mode: "run", identity: identity, request: request))
    return response.state
  }

  public static func relayRunQuestions(endpoint: RelayEndpoint, identity: G0ProbeIdentity, runId: String) async throws -> [RunQuestionRequest] {
    let request = try JSONEncoder().encode(RunQuestionsRequest(runId: runId))
    let response = try decodeRun(await exchangeRelay(endpoint: endpoint, mode: "run", identity: identity, request: request))
    guard let questions = response.questions else { throw ProbeError.unexpectedReply }
    return questions
  }

  public static func relayRunAnswerQuestion(endpoint: RelayEndpoint, identity: G0ProbeIdentity, runId: String,
                                            answerId: String, response answer: RunQuestionResponse) async throws -> RunQuestionAnswerOutcome {
    let request = try JSONEncoder().encode(RunAnswerQuestionRequest(runId: runId, answerId: answerId, response: answer))
    let response = try decodeRun(await exchangeRelay(endpoint: endpoint, mode: "run", identity: identity, request: request, replayable: false))
    guard let outcome = response.answer else { throw ProbeError.unexpectedReply }
    return outcome
  }

  // The host-authorized project directories this device may target. Authorized
  // by the granted cert + anchor-pinned inner TLS, exactly like every run op; a
  // revoked device gets RunError.host(code: "device_not_authorized").
  public static func relayRunProjects(endpoint: RelayEndpoint, identity: G0ProbeIdentity) async throws -> [RunProjectRef] {
    let request = try JSONEncoder().encode(RunProjectsRequest())
    let response = try decodeRun(await exchangeRelay(endpoint: endpoint, mode: "run", identity: identity, request: request))
    guard let projects = response.projects else { throw ProbeError.unexpectedReply }
    return projects
  }

  // Browse one hierarchy level. A nil path lists only Mac-authorized roots; a
  // supplied path is re-authorized by the host and cannot escape those roots.
  public static func relayRunDirectories(endpoint: RelayEndpoint, identity: G0ProbeIdentity, path: String?) async throws -> RunDirectoryListing {
    let request = try JSONEncoder().encode(RunDirectoriesRequest(path: path))
    let response = try decodeRun(await exchangeRelay(endpoint: endpoint, mode: "run", identity: identity, request: request))
    guard let directories = response.directories else { throw ProbeError.unexpectedReply }
    return directories
  }

  public static func relayRunDirectoriesPage(endpoint: RelayEndpoint, identity: G0ProbeIdentity, path: String?, cursor: Int, limit: Int = 100, snapshot: String? = nil) async throws -> RunDirectoryPage {
    let request = try JSONEncoder().encode(RunDirectoriesPageRequest(path: path, cursor: cursor, limit: limit, snapshot: snapshot))
    let response = try decodeRun(await exchangeRelay(endpoint: endpoint, mode: "run", identity: identity, request: request))
    guard let page = response.directoriesPage else { throw ProbeError.unexpectedReply }
    return page
  }

  // The Providers this device may target for a new session. Authorized exactly
  // like every run op; a revoked device gets device_not_authorized.
  public static func relayRunProviders(endpoint: RelayEndpoint, identity: G0ProbeIdentity) async throws -> [RunProviderRef] {
    let request = try JSONEncoder().encode(RunProvidersRequest())
    let response = try decodeRun(await exchangeRelay(endpoint: endpoint, mode: "run", identity: identity, request: request))
    guard let providers = response.providers else { throw ProbeError.unexpectedReply }
    return providers
  }

  // Provider-native slash commands for this exact provider/workspace context.
  public static func relayRunCommands(endpoint: RelayEndpoint, identity: G0ProbeIdentity, providerId: String, cwd: String, agentProfileId: String? = nil) async throws -> RunCommandCatalog {
    let request = try JSONEncoder().encode(RunCommandsRequest(providerId: providerId, cwd: cwd, agentProfileId: agentProfileId))
    let response = try decodeRun(await exchangeRelay(endpoint: endpoint, mode: "run", identity: identity, request: request))
    guard let commands = response.commands else { throw ProbeError.unexpectedReply }
    return commands
  }

  // The host session catalog this device may browse. Authorized exactly like
  // every run op; a revoked device gets device_not_authorized.
  public static func relayRunSessions(endpoint: RelayEndpoint, identity: G0ProbeIdentity) async throws -> [RunSessionRef] {
    let request = try JSONEncoder().encode(RunSessionsRequest())
    let response = try decodeRun(await exchangeRelay(endpoint: endpoint, mode: "run", identity: identity, request: request, lane: .bulk))
    guard let sessions = response.sessions else { throw ProbeError.unexpectedReply }
    return sessions
  }

  public static func relayRunSessionsPage(endpoint: RelayEndpoint, identity: G0ProbeIdentity, cursor: Int, limit: Int = 100, snapshot: String? = nil) async throws -> RunSessionPage {
    let request = try JSONEncoder().encode(RunSessionsPageRequest(cursor: cursor, limit: limit, snapshot: snapshot))
    let response = try decodeRun(await exchangeRelay(endpoint: endpoint, mode: "run", identity: identity, request: request, lane: .bulk))
    guard let page = response.sessionsPage else { throw ProbeError.unexpectedReply }
    return page
  }

  // A transfer owns one fresh mTLS tunnel. It cannot submit, approve or poll a
  // run. It closes and settles its queued reads when the scope ends/cancels.
  public final class HistoryConnection: Sendable {
    private let send: @Sendable (Data, Int) async throws -> Data
    fileprivate init(send: @escaping @Sendable (Data, Int) async throws -> Data) { self.send = send }
    private func response(_ request: Data, limit: Int) async throws -> RunResponse {
      try decodeRun(await send(request, limit))
    }
    public func preview(providerId: String, cwd: String, externalSessionId: String) async throws -> RunHistoryPreview {
      let request = try JSONEncoder().encode(RunHistoryPreviewRequest(providerId: providerId, cwd: cwd, externalSessionId: externalSessionId, keepAlive: true))
      let reply = try await response(request, limit: 17 * 1_024)
      guard let preview = reply.historyPreview else { throw ProbeError.unexpectedReply }
      return preview
    }
    public func turnsPage(providerId: String, cwd: String, externalSessionId: String, before: Int?, limit: Int, snapshot: String?) async throws -> RunHistoryTurnsPage {
      let request = try JSONEncoder().encode(RunHistoryTurnsPageRequest(providerId: providerId, cwd: cwd, externalSessionId: externalSessionId, before: before, limit: limit, snapshot: snapshot, keepAlive: true))
      let reply = try await response(request, limit: 8 * 1024 * 1024)
      guard let page = reply.historyTurnsPage else { throw ProbeError.unexpectedReply }
      return try page.validated(before: before, limit: limit, expectedSnapshot: snapshot)
    }
    public func page(providerId: String, cwd: String, externalSessionId: String, cursor: Int, snapshot: String?) async throws -> RunHistoryPage {
      let request = try JSONEncoder().encode(RunHistoryPageRequest(providerId: providerId, cwd: cwd, externalSessionId: externalSessionId, cursor: cursor, limit: 256 * 1_024, snapshot: snapshot, keepAlive: true))
      let reply = try await response(request, limit: 512 * 1_024)
      guard let page = reply.historyPage else { throw ProbeError.unexpectedReply }
      return page
    }
    public func sessionsPage(cursor: Int, snapshot: String?) async throws -> RunSessionPage {
      let request = try JSONEncoder().encode(RunSessionsPageRequest(cursor: cursor, limit: 100, snapshot: snapshot, keepAlive: true))
      let reply = try await response(request, limit: 2 * 1_024 * 1_024)
      guard let page = reply.sessionsPage else { throw ProbeError.unexpectedReply }
      return page
    }
  }

  public static func withHistoryConnection<T: Sendable>(endpoint: RelayEndpoint, identity: G0ProbeIdentity,
    body: @Sendable (HistoryConnection) async throws -> T) async throws -> T {
    if let session = endpoint.session {
      return try await body(HistoryConnection { request, limit in
        try await session.exchange(request, lane: .bulk, limit: limit, replayable: true)
      })
    }
    return try await withRelayChannel(endpoint: endpoint, mode: "run", identity: identity) { channel, innerContext in
      let handler = HistoryReadHandler()
      try await channel.eventLoop.submit {
        try channel.pipeline.syncOperations.addHandler(NIOSSLClientHandler(context: innerContext, serverHostname: nil))
        try channel.pipeline.syncOperations.addHandler(handler)
      }.get()
      return try await body(HistoryConnection { request, limit in
        try await channel.eventLoop.flatSubmit { handler.request(request, limit: limit, on: channel) }.get()
      })
    }
  }

  // Small first-screen evidence. Unavailable is explicit and is not decoded as an empty transcript.
  public static func relayRunHistoryVersion(endpoint: RelayEndpoint, identity: G0ProbeIdentity, providerId: String, cwd: String, externalSessionId: String) async throws -> RunHistoryVersion {
    let request = try JSONEncoder().encode(RunHistoryVersionRequest(providerId: providerId, cwd: cwd, externalSessionId: externalSessionId))
    let response = try decodeRun(await exchangeRelay(endpoint: endpoint, mode: "run", identity: identity, request: request, lane: .bulk))
    guard let version = response.historyVersion else { throw ProbeError.unexpectedReply }
    return version
  }

  public static func relayRunHistoryPreview(endpoint: RelayEndpoint, identity: G0ProbeIdentity, providerId: String, cwd: String, externalSessionId: String) async throws -> RunHistoryPreview {
    let request = try JSONEncoder().encode(RunHistoryPreviewRequest(providerId: providerId, cwd: cwd, externalSessionId: externalSessionId))
    let response = try decodeRun(await exchangeRelay(endpoint: endpoint, mode: "run", identity: identity, request: request, responseLimit: 17 * 1_024, lane: .bulk))
    guard let preview = response.historyPreview else { throw ProbeError.unexpectedReply }
    return preview
  }

  // The REAL conversation content of one session so the device can OPEN it.
  // Same owner-device authorization; an unknown/unauthorized session returns [].
  public static func relayRunHistory(endpoint: RelayEndpoint, identity: G0ProbeIdentity, providerId: String, cwd: String, externalSessionId: String) async throws -> [RunHistoryTurn] {
    let request = try JSONEncoder().encode(RunHistoryRequest(providerId: providerId, cwd: cwd, externalSessionId: externalSessionId))
    let response = try decodeRun(await exchangeRelay(endpoint: endpoint, mode: "run", identity: identity, request: request, lane: .bulk))
    guard let history = response.history else { throw ProbeError.unexpectedReply }
    return history
  }

  // Complete history as stable byte pages. The caller may persist cursor,
  // snapshot and accumulated bytes across disconnects; a changed source fails
  // explicitly instead of combining two transcript versions.
  // Omit the limit by default: the host owns the frame budget and page size.
  public static func relayRunHistoryTurnsPage(endpoint: RelayEndpoint, identity: G0ProbeIdentity, providerId: String, cwd: String, externalSessionId: String, before: Int? = nil, limit: Int = 3, snapshot: String? = nil) async throws -> RunHistoryTurnsPage {
    let request = try JSONEncoder().encode(RunHistoryTurnsPageRequest(providerId: providerId, cwd: cwd, externalSessionId: externalSessionId, before: before, limit: limit, snapshot: snapshot))
    let response = try decodeRun(await exchangeRelay(endpoint: endpoint, mode: "run", identity: identity, request: request, lane: .bulk))
    guard let page = response.historyTurnsPage else { throw ProbeError.unexpectedReply }
    return try page.validated(before: before, limit: limit, expectedSnapshot: snapshot)
  }

  public static func relayRunHistoryPage(endpoint: RelayEndpoint, identity: G0ProbeIdentity, providerId: String, cwd: String, externalSessionId: String, cursor: Int, limit: Int? = nil, snapshot: String? = nil) async throws -> RunHistoryPage {
    let request = try JSONEncoder().encode(RunHistoryPageRequest(providerId: providerId, cwd: cwd, externalSessionId: externalSessionId, cursor: cursor, limit: limit, snapshot: snapshot))
    let response = try decodeRun(await exchangeRelay(endpoint: endpoint, mode: "run", identity: identity, request: request, lane: .bulk))
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
    let response = try decodeRun(await exchangeRelay(endpoint: endpoint, mode: "run", identity: identity, request: request, lane: .watch))
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
                                   history: (providerId: String, cwd: String, externalSessionId: String, known: String?)? = nil) async throws -> LiveRunsOutcome {
    let request = try JSONEncoder().encode(LiveRunsRequest(revision: revision, waitMs: waitMs, history: history.map {
      LiveRunsHistory(providerId: $0.providerId, cwd: $0.cwd, externalSessionId: $0.externalSessionId, known: $0.known)
    }))
    let response = try decodeRun(await exchangeRelay(endpoint: endpoint, mode: "run", identity: identity, request: request, lane: .status))
    guard let live = response.liveRuns else { throw ProbeError.unexpectedReply }
    return live
  }

  // Asks the host to interrupt the Provider for this run. "requested" is only a
  // request receipt; the lifecycle still settles from the real Provider result.
  public static func relayRunStop(endpoint: RelayEndpoint, identity: G0ProbeIdentity, runId: String) async throws -> String {
    let request = try JSONEncoder().encode(RunStopRequest(runId: runId))
    let response = try decodeRun(await exchangeRelay(endpoint: endpoint, mode: "run", identity: identity, request: request, replayable: false))
    guard let stop = response.stop else { throw ProbeError.unexpectedReply }
    return stop.status
  }

  // The assistant's real streamed output content for one run, strictly after
  // `cursor` (server-authoritative per-run sequence). Authorized exactly like
  // every run op; an unknown/evicted run yields an honest empty page.
  public static func relayRunOutput(endpoint: RelayEndpoint, identity: G0ProbeIdentity, runId: String, cursor: Int) async throws -> RunOutputPage {
    let request = try JSONEncoder().encode(RunOutputRequest(runId: runId, cursor: cursor))
    let response = try decodeRun(await exchangeRelay(endpoint: endpoint, mode: "run", identity: identity, request: request))
    guard let output = response.output else { throw ProbeError.unexpectedReply }
    return RunOutputPage(chunks: output.chunks, cursor: output.cursor)
  }

  private static func decodePair(_ bytes: Data, requestId: String) throws -> PairOutcome {
    // Correlate the response to our own request id before trusting any field.
    if let granted = try? JSONDecoder().decode(PairGrantedResponse.self, from: bytes), granted.requestId == requestId {
      return .granted(certificatePEM: granted.certificatePEM, deviceId: granted.deviceId, expiresAt: granted.expiresAt)
    }
    if let pending = try? JSONDecoder().decode(PairPendingResponse.self, from: bytes), pending.requestId == requestId {
      return .pending(publicKeySHA256: pending.publicKeySHA256)
    }
    if let revoked = try? JSONDecoder().decode(PairRevokedResponse.self, from: bytes), revoked.requestId == requestId {
      return .revoked(deviceId: revoked.deviceId)
    }
    if let denied = try? JSONDecoder().decode(PairDeniedResponse.self, from: bytes), denied.requestId == requestId {
      return .denied(code: denied.code)
    }
    throw ProbeError.unexpectedReply
  }

  // Internal framed transport; public entry points must construct generated
  // request DTOs and validate/correlate the generated response before returning.
  static func exchange(port: Int, identity: G0ProbeIdentity, request: Data, route: String = "/device") async throws -> Data {
    guard (1...65535).contains(port), request.count < 65_536, ["/device", "/pair"].contains(route) else { throw ProbeError.invalidArguments }
    let group = MultiThreadedEventLoopGroup(numberOfThreads: 1)
    do {
      var outer = TLSConfiguration.makeClientConfiguration()
      outer.minimumTLSVersion = .tlsv13
      outer.maximumTLSVersion = .tlsv13
      outer.trustRoots = .certificates(try NIOSSLCertificate.fromPEMBytes(Array(identity.outerCA)))
      outer.certificateVerification = .fullVerification
      let outerContext = try NIOSSLContext(configuration: outer)
      var inner = TLSConfiguration.makeClientConfiguration()
      inner.minimumTLSVersion = .tlsv13
      inner.maximumTLSVersion = .tlsv13
      inner.trustRoots = .certificates(try NIOSSLCertificate.fromPEMBytes(Array(identity.innerCA)))
      inner.certificateVerification = .fullVerification
      if let certificate = identity.certificate, let privateKey = identity.privateKey {
        inner.certificateChain = try NIOSSLCertificate.fromPEMBytes(Array(certificate)).map { .certificate($0) }
        inner.privateKey = .privateKey(try NIOSSLPrivateKey(bytes: Array(privateKey), format: .pem))
      } else if route != "/pair" {
        // Only the pairing bootstrap route may omit the client certificate.
        throw ProbeError.invalidArguments
      }
      let innerContext = try NIOSSLContext(configuration: inner)
      let upgrade: EventLoopFuture<Channel> = try await ClientBootstrap(group: group)
        .connectTimeout(.seconds(10))
        .channelOption(ChannelOptions.writeBufferWaterMark, value: ChannelOptions.Types.WriteBufferWaterMark(low: 262_144, high: 524_288))
        .connect(host: "127.0.0.1", port: port) { channel in
          channel.eventLoop.makeCompletedFuture {
            let pipeline = channel.pipeline.syncOperations
            try pipeline.addHandler(NIOSSLClientHandler(context: outerContext, serverHostname: "localhost"))
            let upgrader = NIOTypedWebSocketClientUpgrader<Channel>(maxFrameSize: 1_572_864, upgradePipelineHandler: { channel, _ in
              channel.eventLoop.makeCompletedFuture {
                try channel.pipeline.syncOperations.addHandler(TunnelCodec())
                return channel
              }
            })
            let headers = HTTPHeaders([("Host", "localhost:\(port)"), ("Content-Length", "0")])
            let head = HTTPRequestHead(version: .http1_1, method: .GET, uri: route, headers: headers)
            let configuration = NIOTypedHTTPClientUpgradeConfiguration(upgradeRequestHead: head, upgraders: [upgrader], notUpgradingCompletionHandler: { channel in
              channel.eventLoop.makeFailedFuture(ProbeError.invalidFrame)
            })
            // Bound even a silent malicious relay; there is no reconnect/replay.
            channel.eventLoop.scheduleTask(in: .seconds(10)) { channel.close(promise: nil) }
            return try pipeline.configureUpgradableHTTPClientPipeline(configuration: .init(upgradeConfiguration: configuration))
          }
        }
      let channel = try await upgrade.get()
      // Create the reply promise only after the channel exists so a failed
      // connect/upgrade above can never leave an unfulfilled promise to leak
      // (NIO fatalErrors on a leaked promise in debug builds).
      let result = group.next().makePromise(of: Data.self)
      // The HTTP upgrader rejects outbound writes while its callback is active.
      // Install inner TLS only after upgrade completion, on the event loop, so
      // its immediate ClientHello cannot be silently rejected by HTTP state.
      do {
        try await channel.eventLoop.submit {
          try channel.pipeline.syncOperations.addHandler(NIOSSLClientHandler(context: innerContext, serverHostname: "scry-host.test"))
          try channel.pipeline.syncOperations.addHandler(ProbeHandler(request: request, result: result))
        }.get()
      } catch {
        // Handler install failed before ProbeHandler could complete the promise.
        result.fail(error)
        throw error
      }
      let reply = try await result.futureResult.get()
      try await group.shutdownGracefully()
      return reply
    } catch {
      try? await group.shutdownGracefully()
      throw error
    }
  }

  // Relay variant of `exchange`. Mirrors the loopback security decisions but
  // dials a public relay and routes by hostId+mode instead of a fixed port, and
  // pins the inner server to the host anchor without leaf-hostname verification.
  // Do not replay exchanges by matching error strings. A lost response is not
  // evidence that a request did not run; explicit UI reconciliation owns retry.
  static func exchangeRelay(endpoint: RelayEndpoint, mode: String, identity: G0ProbeIdentity, request: Data, responseLimit: Int? = nil,
                            lane: RelaySession.Lane = .control, replayable: Bool = true) async throws -> Data {
    guard request.count < 1_250_000 else { throw ProbeError.invalidArguments }
    if mode == "run", let session = endpoint.session {
      return try await session.exchange(request, lane: lane, limit: responseLimit ?? 8 * 1_024 * 1_024, replayable: replayable)
    }
    return try await withRelayChannel(endpoint: endpoint, mode: mode, identity: identity) { channel, innerContext in
      let result = channel.eventLoop.makePromise(of: Data.self)
      do {
        try await channel.eventLoop.submit {
          try channel.pipeline.syncOperations.addHandler(NIOSSLClientHandler(context: innerContext, serverHostname: nil))
          let limit = responseLimit ?? (mode == "run" ? 8 * 1_024 * 1_024 : 65_536)
          try channel.pipeline.syncOperations.addHandler(ProbeHandler(request: request, result: result, maxResponseBytes: limit))
        }.get()
      } catch { result.fail(error); throw error }
      return try await result.futureResult.get()
    }
  }

  private static func withRelayChannel<T: Sendable>(endpoint: RelayEndpoint, mode: String, identity: G0ProbeIdentity,
    body: @Sendable (Channel, NIOSSLContext) async throws -> T) async throws -> T {
    let group = MultiThreadedEventLoopGroup(numberOfThreads: 1)
    do {
      let (channel, innerContext) = try await connectRelayChannel(endpoint: endpoint, mode: mode, identity: identity, group: group)
      // Cancel an established tunnel immediately. Bootstrap retains its
      // bounded 10-second deadline, rather than leaving a detached connection.
      let reply: T
      do {
        reply = try await withTaskCancellationHandler {
          try Task.checkCancellation()
          return try await body(channel, innerContext)
        } onCancel: { channel.close(promise: nil) }
      } catch { try? await channel.close(); throw error }
      try? await channel.close()
      try await group.shutdownGracefully()
      return reply
    } catch {
      try? await group.shutdownGracefully()
      throw error
    }
  }

  // Dials the relay and completes the outer WebSocket upgrade. Returns the
  // channel (TunnelCodec installed, no inner TLS yet) and the inner mTLS context
  // pinned to the host anchor. The caller owns the channel and the group.
  static func connectRelayChannel(endpoint: RelayEndpoint, mode: String, identity: G0ProbeIdentity,
                                  group: EventLoopGroup) async throws -> (Channel, NIOSSLContext) {
    guard (1...65535).contains(endpoint.port), ["pair", "run"].contains(mode),
          !endpoint.hostId.isEmpty, endpoint.hostId.count <= 64 else { throw ProbeError.invalidArguments }
    do {
      // Outer TLS mode is decided by the endpoint (from the pairing code), not by
      // whether a CA happens to be present. `.system` trusts the platform's
      // public roots for a wss relay like Cloudflare; `.pinned` trusts only the
      // supplied private relay CA; `.plaintext` is ws:// for the local dev relay.
      let outerContext: NIOSSLContext?
      switch endpoint.outerTLS {
      case .plaintext:
        outerContext = nil
      case .system:
        var outer = TLSConfiguration.makeClientConfiguration()
        outer.minimumTLSVersion = .tlsv12
        outer.maximumTLSVersion = .tlsv13
        outer.trustRoots = .default
        outer.certificateVerification = .fullVerification
        outerContext = try NIOSSLContext(configuration: outer)
      case .pinned:
        guard !identity.outerCA.isEmpty else { throw ProbeError.invalidArguments }
        var outer = TLSConfiguration.makeClientConfiguration()
        outer.minimumTLSVersion = .tlsv13
        outer.maximumTLSVersion = .tlsv13
        outer.trustRoots = .certificates(try NIOSSLCertificate.fromPEMBytes(Array(identity.outerCA)))
        outer.certificateVerification = .fullVerification
        outerContext = try NIOSSLContext(configuration: outer)
      }
      var inner = TLSConfiguration.makeClientConfiguration()
      inner.minimumTLSVersion = .tlsv13
      inner.maximumTLSVersion = .tlsv13
      inner.trustRoots = .certificates(try NIOSSLCertificate.fromPEMBytes(Array(identity.innerCA)))
      // Chain-to-anchor is the trust decision; the per-launch host leaf has no SAN.
      inner.certificateVerification = .noHostnameVerification
      if let certificate = identity.certificate, let privateKey = identity.privateKey {
        inner.certificateChain = try NIOSSLCertificate.fromPEMBytes(Array(certificate)).map { .certificate($0) }
        inner.privateKey = .privateKey(try NIOSSLPrivateKey(bytes: Array(privateKey), format: .pem))
      } else if mode != "pair" {
        // Only the pairing bootstrap may omit the client certificate.
        throw ProbeError.invalidArguments
      }
      let innerContext = try NIOSSLContext(configuration: inner)
      let uri = "/?host=\(endpoint.hostId)&mode=\(mode)"
      let hostHeader = endpoint.relayServerName ?? endpoint.host
      let upgrade: EventLoopFuture<Channel> = try await ClientBootstrap(group: group)
        .connectTimeout(.seconds(10))
        .channelOption(ChannelOptions.writeBufferWaterMark, value: ChannelOptions.Types.WriteBufferWaterMark(low: 262_144, high: 524_288))
        .connect(host: endpoint.host, port: endpoint.port) { channel in
          channel.eventLoop.makeCompletedFuture {
            let pipeline = channel.pipeline.syncOperations
            if let outerContext {
              try pipeline.addHandler(NIOSSLClientHandler(context: outerContext, serverHostname: endpoint.relayServerName ?? endpoint.host))
            }
            let upgrader = NIOTypedWebSocketClientUpgrader<Channel>(maxFrameSize: 1_572_864, upgradePipelineHandler: { channel, _ in
              channel.eventLoop.makeCompletedFuture {
                try channel.pipeline.syncOperations.addHandler(TunnelCodec())
                return channel
              }
            })
            let headers = HTTPHeaders([("Host", hostHeader), ("Content-Length", "0")])
            let head = HTTPRequestHead(version: .http1_1, method: .GET, uri: uri, headers: headers)
            let configuration = NIOTypedHTTPClientUpgradeConfiguration(upgradeRequestHead: head, upgraders: [upgrader], notUpgradingCompletionHandler: { channel in
              channel.eventLoop.makeFailedFuture(ProbeError.invalidFrame)
            })
            let timeout = channel.eventLoop.scheduleTask(in: .seconds(10)) { channel.close(promise: nil) }
            let upgraded = try pipeline.configureUpgradableHTTPClientPipeline(configuration: .init(upgradeConfiguration: configuration))
            upgraded.whenComplete { _ in timeout.cancel() }
            return upgraded
          }
        }
      let channel = try await upgrade.get()
      return (channel, innerContext)
    }
  }

  // Verify ONLY the outer/system TLS trust used by `.system`: open a NIOSSL
  // client with the platform's public trust roots (.default) + full verification
  // to host:port and wait for the TLS handshake to complete. Success proves THIS
  // device trusts the relay's PUBLICLY-signed certificate (e.g. Cloudflare) via
  // the system store. No inner TLS, no WebSocket, no token; throws on any
  // trust/handshake failure. Used by the on-device self-test's -relayTLSProbe.
  public static func probeSystemTLS(host: String, port: Int = 443) async throws -> String {
    guard (1...65535).contains(port), !host.isEmpty else { throw ProbeError.invalidArguments }
    let group = MultiThreadedEventLoopGroup(numberOfThreads: 1)
    do {
      var outer = TLSConfiguration.makeClientConfiguration()
      outer.minimumTLSVersion = .tlsv12
      outer.maximumTLSVersion = .tlsv13
      outer.trustRoots = .default
      outer.certificateVerification = .fullVerification
      let context = try NIOSSLContext(configuration: outer)
      let done = group.next().makePromise(of: String.self)
      let bootstrap = ClientBootstrap(group: group)
        .connectTimeout(.seconds(10))
        .channelInitializer { channel in
          do {
            try channel.pipeline.syncOperations.addHandler(NIOSSLClientHandler(context: context, serverHostname: host))
            try channel.pipeline.syncOperations.addHandler(TLSHandshakeReporter(promise: done))
            return channel.eventLoop.makeSucceededFuture(())
          } catch {
            return channel.eventLoop.makeFailedFuture(error)
          }
        }
      let channel: Channel
      do {
        channel = try await bootstrap.connect(host: host, port: port).get()
      } catch {
        // Resolve the promise so it never leaks, and surface the real connect
        // error (DNS/TCP/timeout) instead of NIO's leaked-promise fatalError.
        done.fail(error)
        try? await group.shutdownGracefully()
        throw error
      }
      // The reporter resolves `done` on handshake completion (trust OK) or on the
      // first error / early close (trust or transport failure). connectTimeout
      // bounds the TCP connect; the caller bounds the overall run.
      let negotiated: String
      do {
        negotiated = try await done.futureResult.get()
      } catch {
        try? await channel.close()
        try? await group.shutdownGracefully()
        throw error
      }
      try? await channel.close()
      try await group.shutdownGracefully()
      return negotiated
    } catch {
      try? await group.shutdownGracefully()
      throw error
    }
  }
}

// Fulfils on TLS handshake completion (trust validated) or fails on the first
// error / early close. This isolates the outer-TLS trust decision from any HTTP,
// WebSocket or inner-TLS behaviour.
private final class TLSHandshakeReporter: ChannelInboundHandler {
  typealias InboundIn = ByteBuffer
  private let promise: EventLoopPromise<String>
  private var settled = false
  init(promise: EventLoopPromise<String>) { self.promise = promise }
  func userInboundEventTriggered(context: ChannelHandlerContext, event: Any) {
    if let tls = event as? TLSUserEvent, case .handshakeCompleted(let negotiated) = tls, !settled {
      settled = true
      promise.succeed(negotiated ?? "tls")
    }
    context.fireUserInboundEventTriggered(event)
  }
  func errorCaught(context: ChannelHandlerContext, error: Error) {
    if !settled { settled = true; promise.fail(error) }
    context.close(promise: nil)
  }
  func channelInactive(context: ChannelHandlerContext) {
    if !settled { settled = true; promise.fail(ProbeError.disconnected) }
    context.fireChannelInactive()
  }
}
