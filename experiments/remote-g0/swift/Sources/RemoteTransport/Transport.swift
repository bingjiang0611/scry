import Foundation
import NIOCore
import NIOPosix
import NIOHTTP1
import NIOWebSocket
import NIOSSL
import NIOTLS

enum ProbeError: Error { case invalidArguments, invalidFrame, oversized, disconnected, unexpectedReply }

// Keep route identity independent of Network.framework so it is testable without
// a live path monitor. Callers provide only interfaces selected by the route.
public enum RelayPathSignature {
  public static func make(status: String, isExpensive: Bool, isConstrained: Bool,
                          supportsDNS: Bool, supportsIPv4: Bool, supportsIPv6: Bool,
                          usedInterfaceTypes: [String]) -> String {
    let interfaces = usedInterfaceTypes.joined(separator: ",")
    return "status=\(status)|expensive=\(isExpensive)|constrained=\(isConstrained)|dns=\(supportsDNS)|ipv4=\(supportsIPv4)|ipv6=\(supportsIPv6)|interfaces=\(interfaces)"
  }
}

public enum RelayTransportError: Error, Sendable {
  public enum TLSLayer: Sendable, Equatable { case relay, host }
  case tlsHandshake(layer: TLSLayer, detail: String)
  case closed(code: UInt16?, reason: String)
  case timedOut(stage: String)
  // The peer sent a WebSocket frame above the 1.5 MiB device limit. Older Mac
  // hosts sent a whole history page as one frame; newer hosts split it.
  case frameTooLarge

  // UI recovery is limited to read operations. Never turn TLS, policy,
  // malformed-frame or decoding failures into periodic retries.
  public static func permitsReadRecovery(_ error: Error) -> Bool {
    switch error {
    case ProbeError.disconnected: return true
    case RelayTransportError.timedOut: return true
    case let RelayTransportError.closed(code, _):
      guard let code else { return true }
      return [1000, 1001, 1006, 1011, 1012, 1013].contains(code)
    default: return false
    }
  }

  // Only handshake failures acquire a layer. Preserve other errors and the
  // original TLS diagnostic; neither an EOF nor this label proves revocation.
  static func identifyingHandshake(_ error: Error, layer: TLSLayer) -> Error {
    guard let tls = error as? NIOSSLError, case .handshakeFailed = tls else { return error }
    return RelayTransportError.tlsHandshake(layer: layer, detail: String(describing: tls))
  }
}

// Converts the outer WebSocket's binary frames into the inner TLS byte stream.
// Text, fragmentation and overflow terminate the stream; never skip bytes and
// continue an allegedly reliable TLS connection after a gap.
// All mutable state is confined to this connection's channel event loop.
final class TunnelCodec: ChannelDuplexHandler, @unchecked Sendable {
  typealias InboundIn = WebSocketFrame
  typealias InboundOut = ByteBuffer
  typealias OutboundIn = ByteBuffer
  typealias OutboundOut = WebSocketFrame
  private var closeCause: RelayTransportError?

  // The upgrade can deliver a close before the inner consumer exists. Retain
  // that bounded diagnostic even after pipeline teardown. Never replace a real
  // TLS failure: doing so could turn a certificate rejection into a retry.
  func retainingCloseCause(for error: Error) -> Error {
    if case ProbeError.disconnected = error, let closeCause { return closeCause }
    return error
  }

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
      let cause = RelayTransportError.closed(code: code, reason: reason)
      if closeCause == nil { closeCause = cause }
      // NIOSSL batches authenticated plaintext until readComplete. A close in
      // the same socket read must not overtake a complete response already
      // received in binary records. Partial responses still fail below.
      context.fireChannelReadComplete()
      context.fireErrorCaught(cause)
      context.close(promise: nil)
    default:
      context.fireErrorCaught(ProbeError.invalidFrame)
      context.close(promise: nil)
    }
  }

  func write(context: ChannelHandlerContext, data: NIOAny, promise: EventLoopPromise<Void>?) {
    // Draining plaintext can settle a response and wake queued work. The peer
    // has already closed: no new ciphertext may leave during that drain.
    if let closeCause { promise?.fail(closeCause); return }
    let bytes = unwrapOutboundIn(data)
    guard bytes.readableBytes <= 1_572_864, context.channel.isWritable else {
      promise?.fail(ProbeError.oversized)
      context.close(promise: nil)
      return
    }
    context.write(wrapOutboundOut(WebSocketFrame(fin: true, opcode: .binary, maskKey: .random(), data: bytes)), promise: promise)
  }

  // The frame decoder before this handler reports oversized frames as an
  // anonymous NIO error; name it so the device can say what the host must fix.
  func errorCaught(context: ChannelHandlerContext, error: Error) {
    if let wsError = error as? NIOWebSocketError, case .invalidFrameLength = wsError {
      context.fireErrorCaught(RelayTransportError.frameTooLarge)
    } else {
      context.fireErrorCaught(error)
    }
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
  public struct ExecutionTargetBinding: Codable, Equatable, Hashable, Sendable {
    public let id: String
    public let binding: String

    public init(id: String, binding: String) {
      self.id = id
      self.binding = binding
    }

    public var isValid: Bool {
      !id.isEmpty && id.utf16.count <= 300 && binding.utf8.count == 64 && binding.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil
    }
  }

  public struct ExecutionTargetRef: Codable, Equatable, Hashable, Sendable {
    public let id: String
    public let binding: String
    public let hostId: String
    public let label: String
    public let state: String

    public init(id: String, binding: String, hostId: String, label: String, state: String) {
      self.id = id; self.binding = binding; self.hostId = hostId; self.label = label; self.state = state
    }
  }

  public struct ExecutionTargetCatalog: Codable, Equatable, Hashable, Sendable {
    public struct Gateway: Codable, Equatable, Hashable, Sendable {
      public let hostId: String
      public let label: String
      public init(hostId: String, label: String) { self.hostId = hostId; self.label = label }
    }
    public let version: Int
    public let gateway: Gateway
    public let targets: [ExecutionTargetRef]
    public init(version: Int, gateway: Gateway, targets: [ExecutionTargetRef]) {
      self.version = version; self.gateway = gateway; self.targets = targets
    }
  }

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
    // When present, run requests are wrapped for this approved desktop target.
    // The gateway hostId and this binding are immutable for the endpoint lifetime.
    public let executionTarget: ExecutionTargetBinding?
    // When present, run-mode exchanges reuse this session's persistent lanes
    // instead of dialing one tunnel per request. Pairing never uses it.
    public let session: RelaySession?
    public init(host: String, port: Int, hostId: String, relayServerName: String? = nil, outerTLS: OuterTLS = .plaintext,
                session: RelaySession? = nil, executionTarget: ExecutionTargetBinding? = nil) {
      self.host = host
      self.port = port
      self.hostId = hostId
      self.relayServerName = relayServerName
      self.outerTLS = outerTLS
      self.executionTarget = executionTarget
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
    // Host-recorded archive time. Only archived catalog reads carry it; nil means
    // "not archived" in the active catalog, never "unknown".
    public let archivedAt: Double?
    public init(sessionId: String, externalSessionId: String? = nil, providerId: String, agentProfileId: String? = nil,
                cwd: String, label: String, ts: Double, pinnedAt: Double? = nil, isActive: Bool? = nil,
                archivedAt: Double? = nil) {
      self.sessionId = sessionId; self.externalSessionId = externalSessionId; self.providerId = providerId
      self.agentProfileId = agentProfileId; self.cwd = cwd; self.label = label; self.ts = ts; self.pinnedAt = pinnedAt
      self.isActive = isActive; self.archivedAt = archivedAt
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

  private struct ExecutionTargetsRequest: Encodable { let op = "executionTargets" }
  private struct ExecutionTargetsResponse: Decodable {
    let executionTargets: ExecutionTargetCatalog?
    let error: String?
  }
  private struct RunSubmitRequest: Encodable { let op = "submit"; let intentId: String; let detail: String }
  private struct RunIntentStatusRequest: Encodable { let op = "intentStatus"; let intentId: String }
  private struct RunIntentBody: Decodable { let runId: String; let state: String }
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
  struct RunSessionsPageRequest: Encodable {
    let op = "sessionsPage"; let cursor: Int; let limit: Int; let snapshot: String?
    var includeArchived: Bool? = nil
    var keepAlive: Bool? = nil
  }
  private struct RunHistoryRequest: Encodable { let op = "history"; let historyScope: String = "session"; let providerId: String; let cwd: String; let externalSessionId: String; var agentProfileId = HistoryProfileValue(value: nil) }
  private struct RunHistoryVersionRequest: Encodable { let op = "historyVersion"; let historyScope: String = "session"; let providerId: String; let cwd: String; let externalSessionId: String; var agentProfileId = HistoryProfileValue(value: nil) }
  private struct RunHistoryPreviewRequest: Encodable {
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
  private struct RunOutputRequest: Encodable { let op = "output"; let runId: String; let cursor: Int }
  private struct RunWatchRequest: Encodable { let op = "watch"; let runId: String; let cursor: Int; let outputCursor: Int; let waitMs: Int }
  private struct RunStopRequest: Encodable { let op = "stop"; let runId: String }
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
  struct RunSessionDeleteRequest: Encodable {
    let op = "sessionDelete"
    let request: Body
    struct Body: Encodable {
      let providerId: String; let cwd: String; let externalSessionId: String
      let agentProfileId: String?; let confirmed: Bool
    }
  }
  private struct LiveRunsHistory: Encodable { let historyScope: String = "session"; let providerId: String; let cwd: String; let externalSessionId: String; let known: String?; var agentProfileId = HistoryProfileValue(value: nil) }
  private struct LiveRunsRequest: Encodable { let op = "liveRuns"; let revision: String?; let waitMs: Int; let history: LiveRunsHistory? }
  struct HistoryProfileValue: Encodable, Equatable, Sendable {
    let value: String?
    func encode(to encoder: Encoder) throws {
      var container = encoder.singleValueContainer()
      if let value { try container.encode(value) } else { try container.encodeNil() }
    }
  }
  private struct HistoryProfileStamp: Decodable {
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
  private struct RunResponse: Decodable {
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
    let liveRuns: LiveRunsOutcome?
    let intent: RunIntentBody?
    let executionTarget: ExecutionTargetBinding?
    let error: String?
  }
  private struct RunWatchBody: Decodable {
    let poll: RunPollBody; let questions: [RunQuestionRequest]; let output: RunOutputBody; let state: String?
  }
  private struct RunStopBody: Decodable { let status: String }
  private struct RunPollBody: Decodable { let events: [RunLedgerEvent]; let cursor: Int }
  private struct RunOutputBody: Decodable { let chunks: [RunOutputChunk]; let cursor: Int }

  private static func decodeRun(_ bytes: Data, expectedTarget: ExecutionTargetBinding? = nil, expectedProfile: HistoryProfileValue? = nil, expectedHistoryScope: String? = nil) throws -> RunResponse {
    let response = try JSONDecoder().decode(RunResponse.self, from: bytes)
    if let error = response.error { throw RunError.host(code: error) }
    if let expectedTarget, response.executionTarget != expectedTarget { throw ProbeError.unexpectedReply }
    if let expectedProfile, response.historyProfile == nil || response.historyProfile?.agentProfileId != expectedProfile.value { throw HistoryProfileError.unverified }
    if let expectedHistoryScope, response.historyScope != expectedHistoryScope { throw HistoryProfileError.unverified }
    return response
  }

  static func verifyHistoryResponse(_ bytes: Data, expectedProfile: String?) throws {
    _ = try decodeRun(bytes, expectedProfile: HistoryProfileValue(value: expectedProfile))
  }

  static func verifyRunResponse(_ bytes: Data, expectedTarget: ExecutionTargetBinding?) throws {
    _ = try decodeRun(bytes, expectedTarget: expectedTarget)
  }

  static func wrapExecutionTargetRequest(_ request: Data, target: ExecutionTargetBinding) throws -> Data {
    guard target.isValid, request.first == UInt8(ascii: "{"), request.last == UInt8(ascii: "}") else { throw ProbeError.invalidArguments }
    guard let object = try JSONSerialization.jsonObject(with: request) as? [String: Any],
          let operation = object["op"] as? String, operation != "target", operation != "executionTargets" else {
      throw ProbeError.invalidArguments
    }
    var inner = object
    // keepAlive and deviceLabel belong to the Mac1 lane. They must not become
    // authority metadata for the forwarded Mac2 request.
    inner.removeValue(forKey: "keepAlive")
    inner.removeValue(forKey: "deviceLabel")
    // Preserve Foundation's JSON scalar types: NSNumber(0/1) can bridge to
    // Bool through `as? Bool`, which would corrupt cursors and page limits.
    return try JSONSerialization.data(withJSONObject: [
      "op": "target", "target": ["id": target.id, "binding": target.binding], "request": inner
    ], options: [.sortedKeys])
  }

  public static func relayExecutionTargets(endpoint: RelayEndpoint, identity: G0ProbeIdentity) async throws -> ExecutionTargetCatalog {
    let request = try JSONEncoder().encode(ExecutionTargetsRequest())
    // Discovery is a Mac1 operation. Keep it unwrapped while using the
    // authenticated control lane, so the gateway remains the authority for
    // the returned catalog and the request never becomes a Mac2 operation.
    return try await executionTargetDiscovery(expectedGatewayId: endpoint.hostId, pooled: endpoint.session != nil) { pooled in
      try await exchangeRelay(endpoint: endpoint, mode: "run", identity: identity, request: request,
        responseLimit: 256 * 1024, lane: .control, wrapTarget: false, useSession: pooled)
    }
  }

  static func executionTargetDiscovery(expectedGatewayId: String, pooled: Bool,
                                       exchange: (Bool) async throws -> Data) async throws -> ExecutionTargetCatalog {
    do {
      return try decodeExecutionTargets(try await exchange(pooled), expectedGatewayId: expectedGatewayId)
    } catch RunError.host(code: "invalid_request") where pooled {
      // An already-running older gateway accepts only {op:executionTargets}.
      // Retry this read once without transport metadata during rolling upgrade.
      // TLS/auth/timeout/unknown-op errors and all writes never enter this path.
      return try decodeExecutionTargets(try await exchange(false), expectedGatewayId: expectedGatewayId)
    }
  }

  static func decodeExecutionTargets(_ bytes: Data, expectedGatewayId: String) throws -> ExecutionTargetCatalog {
    let response = try JSONDecoder().decode(ExecutionTargetsResponse.self, from: bytes)
    if let error = response.error { throw RunError.host(code: error) }
    guard let catalog = response.executionTargets, catalog.version == 1,
          catalog.gateway.hostId == expectedGatewayId, catalog.gateway.label.utf16.count <= 256, catalog.targets.count <= 32,
          Set(catalog.targets.map(\.id)).count == catalog.targets.count,
          catalog.targets.allSatisfy({ ExecutionTargetBinding(id: $0.id, binding: $0.binding).isValid &&
            !$0.hostId.isEmpty && $0.hostId.utf16.count <= 128 && $0.label.utf16.count <= 256 && ["connected", "disconnected"].contains($0.state) })
    else { throw ProbeError.unexpectedReply }
    return catalog
  }

  public enum RunError: Error, Equatable { case host(code: String) }

  // Submit a durable run intent (recorded != executed). `detail` is the routing
  // JSON { cwd, providerId, agentProfileId?, prompt }. Returns the host-assigned
  // runId; the device polls the ledger for the real lifecycle.
  public static func relayRunSubmit(endpoint: RelayEndpoint, identity: G0ProbeIdentity, intentId: String, detail: String) async throws -> RunSubmitOutcome {
    let request = try JSONEncoder().encode(RunSubmitRequest(intentId: intentId, detail: detail))
    let response = try decodeRun(await exchangeRelay(endpoint: endpoint, mode: "run", identity: identity, request: request, replayable: false), expectedTarget: endpoint.executionTarget)
    guard let runId = response.runId, let status = response.status else { throw ProbeError.unexpectedReply }
    return RunSubmitOutcome(runId: runId, status: status)
  }

  // Read-only reconciliation of a submit whose receipt was lost. nil means the
  // host has no record of this device's intent id, so a resend cannot duplicate
  // it. Older hosts answer `unknown_op`, surfaced as RunError.host.
  public static func relayRunIntentStatus(endpoint: RelayEndpoint, identity: G0ProbeIdentity, intentId: String) async throws -> RunSubmitOutcome? {
    let request = try JSONEncoder().encode(RunIntentStatusRequest(intentId: intentId))
    let response: RunResponse
    do {
      response = try decodeRun(await exchangeRelay(endpoint: endpoint, mode: "run", identity: identity, request: request), expectedTarget: endpoint.executionTarget)
    } catch RunError.host(code: "unknown_intent") {
      return nil
    }
    guard let intent = response.intent else { throw ProbeError.unexpectedReply }
    return RunSubmitOutcome(runId: intent.runId, status: "duplicate")
  }

  // Poll ledger events strictly after `cursor` (server-authoritative sequence).
  public static func relayRunPoll(endpoint: RelayEndpoint, identity: G0ProbeIdentity, cursor: Int) async throws -> RunPollOutcome {
    let request = try JSONEncoder().encode(RunPollRequest(cursor: cursor))
    let response = try decodeRun(await exchangeRelay(endpoint: endpoint, mode: "run", identity: identity, request: request), expectedTarget: endpoint.executionTarget)
    guard let poll = response.poll else { throw ProbeError.unexpectedReply }
    return RunPollOutcome(events: poll.events, cursor: poll.cursor)
  }

  // Query a single run's current lifecycle; nil means the host has no such run
  // for this device.
  public static func relayRunState(endpoint: RelayEndpoint, identity: G0ProbeIdentity, runId: String) async throws -> String? {
    let request = try JSONEncoder().encode(RunStateRequest(runId: runId))
    let response = try decodeRun(await exchangeRelay(endpoint: endpoint, mode: "run", identity: identity, request: request), expectedTarget: endpoint.executionTarget)
    return response.state
  }

  public static func relayRunQuestions(endpoint: RelayEndpoint, identity: G0ProbeIdentity, runId: String) async throws -> [RunQuestionRequest] {
    let request = try JSONEncoder().encode(RunQuestionsRequest(runId: runId))
    let response = try decodeRun(await exchangeRelay(endpoint: endpoint, mode: "run", identity: identity, request: request), expectedTarget: endpoint.executionTarget)
    guard let questions = response.questions else { throw ProbeError.unexpectedReply }
    return questions
  }

  public static func relayRunAnswerQuestion(endpoint: RelayEndpoint, identity: G0ProbeIdentity, runId: String,
                                            answerId: String, response answer: RunQuestionResponse) async throws -> RunQuestionAnswerOutcome {
    let request = try JSONEncoder().encode(RunAnswerQuestionRequest(runId: runId, answerId: answerId, response: answer))
    let response = try decodeRun(await exchangeRelay(endpoint: endpoint, mode: "run", identity: identity, request: request, replayable: false), expectedTarget: endpoint.executionTarget)
    guard let outcome = response.answer else { throw ProbeError.unexpectedReply }
    return outcome
  }

  // The host-authorized project directories this device may target. Authorized
  // by the granted cert + anchor-pinned inner TLS, exactly like every run op; a
  // revoked device gets RunError.host(code: "device_not_authorized").
  public static func relayRunProjects(endpoint: RelayEndpoint, identity: G0ProbeIdentity) async throws -> [RunProjectRef] {
    let request = try JSONEncoder().encode(RunProjectsRequest())
    let response = try decodeRun(await exchangeRelay(endpoint: endpoint, mode: "run", identity: identity, request: request), expectedTarget: endpoint.executionTarget)
    guard let projects = response.projects else { throw ProbeError.unexpectedReply }
    return projects
  }

  // Browse one hierarchy level. A nil path lists only Mac-authorized roots; a
  // supplied path is re-authorized by the host and cannot escape those roots.
  public static func relayRunDirectories(endpoint: RelayEndpoint, identity: G0ProbeIdentity, path: String?) async throws -> RunDirectoryListing {
    let request = try JSONEncoder().encode(RunDirectoriesRequest(path: path))
    let response = try decodeRun(await exchangeRelay(endpoint: endpoint, mode: "run", identity: identity, request: request), expectedTarget: endpoint.executionTarget)
    guard let directories = response.directories else { throw ProbeError.unexpectedReply }
    return directories
  }

  public static func relayRunDirectoriesPage(endpoint: RelayEndpoint, identity: G0ProbeIdentity, path: String?, cursor: Int, limit: Int = 100, snapshot: String? = nil) async throws -> RunDirectoryPage {
    let request = try JSONEncoder().encode(RunDirectoriesPageRequest(path: path, cursor: cursor, limit: limit, snapshot: snapshot))
    let response = try decodeRun(await exchangeRelay(endpoint: endpoint, mode: "run", identity: identity, request: request), expectedTarget: endpoint.executionTarget)
    guard let page = response.directoriesPage else { throw ProbeError.unexpectedReply }
    return page
  }

  // The Providers this device may target for a new session. Authorized exactly
  // like every run op; a revoked device gets device_not_authorized.
  public static func relayRunProviders(endpoint: RelayEndpoint, identity: G0ProbeIdentity) async throws -> [RunProviderRef] {
    let request = try JSONEncoder().encode(RunProvidersRequest())
    let response = try decodeRun(await exchangeRelay(endpoint: endpoint, mode: "run", identity: identity, request: request), expectedTarget: endpoint.executionTarget)
    guard let providers = response.providers else { throw ProbeError.unexpectedReply }
    return providers
  }

  // Provider-native slash commands for this exact provider/workspace context.
  public static func relayRunCommands(endpoint: RelayEndpoint, identity: G0ProbeIdentity, providerId: String, cwd: String, agentProfileId: String? = nil) async throws -> RunCommandCatalog {
    let request = try JSONEncoder().encode(RunCommandsRequest(providerId: providerId, cwd: cwd, agentProfileId: agentProfileId))
    let response = try decodeRun(await exchangeRelay(endpoint: endpoint, mode: "run", identity: identity, request: request), expectedTarget: endpoint.executionTarget)
    guard let commands = response.commands else { throw ProbeError.unexpectedReply }
    return commands
  }

  // The host session catalog this device may browse. Authorized exactly like
  // every run op; a revoked device gets device_not_authorized.
  public static func relayRunSessions(endpoint: RelayEndpoint, identity: G0ProbeIdentity) async throws -> [RunSessionRef] {
    let request = try JSONEncoder().encode(RunSessionsRequest())
    let response = try decodeRun(await exchangeRelay(endpoint: endpoint, mode: "run", identity: identity, request: request, lane: .bulk), expectedTarget: endpoint.executionTarget)
    guard let sessions = response.sessions else { throw ProbeError.unexpectedReply }
    return sessions
  }

  public static func relayRunSessionsPage(endpoint: RelayEndpoint, identity: G0ProbeIdentity, cursor: Int, limit: Int = 100, snapshot: String? = nil,
                                          includeArchived: Bool = false) async throws -> RunSessionPage {
    var query = RunSessionsPageRequest(cursor: cursor, limit: limit, snapshot: snapshot)
    if includeArchived { query.includeArchived = true }
    let request = try JSONEncoder().encode(query)
    let response = try decodeRun(await exchangeRelay(endpoint: endpoint, mode: "run", identity: identity, request: request, lane: .bulk), expectedTarget: endpoint.executionTarget)
    guard let page = response.sessionsPage else { throw ProbeError.unexpectedReply }
    return page
  }

  // A transfer owns one fresh mTLS tunnel. It cannot submit, approve or poll a
  // run. It closes and settles its queued reads when the scope ends/cancels.
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
                            lane: RelaySession.Lane = .control, replayable: Bool = true, wrapTarget: Bool = true,
                            useSession: Bool = true) async throws -> Data {
    guard request.count < 1_250_000 else { throw ProbeError.invalidArguments }
    let routedRequest: Data
    if mode == "run", wrapTarget, let target = endpoint.executionTarget {
      routedRequest = try wrapExecutionTargetRequest(request, target: target)
    } else {
      routedRequest = request
    }
    if mode == "run", useSession, let session = endpoint.session {
      return try await session.exchange(routedRequest, lane: lane, limit: responseLimit ?? 8 * 1_024 * 1_024, replayable: replayable)
    }
    return try await withRelayChannel(endpoint: endpoint, mode: mode, identity: identity) { channel, innerContext in
      let result = channel.eventLoop.makePromise(of: Data.self)
      do {
        try await channel.eventLoop.submit {
          try channel.pipeline.syncOperations.addHandler(NIOSSLClientHandler(context: innerContext, serverHostname: nil))
          let limit = responseLimit ?? (mode == "run" ? 8 * 1_024 * 1_024 : 65_536)
          try channel.pipeline.syncOperations.addHandler(ProbeHandler(request: routedRequest, result: result, maxResponseBytes: limit))
        }.get()
      } catch { result.fail(error); throw error }
      return try await result.futureResult.get()
    }
  }

  private static func withRelayChannel<T: Sendable>(endpoint: RelayEndpoint, mode: String, identity: G0ProbeIdentity,
    body: @Sendable (Channel, NIOSSLContext) async throws -> T) async throws -> T {
    let group = MultiThreadedEventLoopGroup(numberOfThreads: 1)
    do {
      let (channel, innerContext, tunnel) = try await connectRelayChannel(endpoint: endpoint, mode: mode, identity: identity, group: group)
      // Cancel an established tunnel immediately. Bootstrap retains its
      // bounded 10-second deadline, rather than leaving a detached connection.
      let reply: T
      do {
        reply = try await withTaskCancellationHandler {
          try Task.checkCancellation()
          return try await body(channel, innerContext)
        } onCancel: { channel.close(promise: nil) }
      } catch {
        let failure = try await channel.eventLoop.submit { tunnel.retainingCloseCause(for: error) }.get()
        try? await channel.close()
        throw RelayTransportError.identifyingHandshake(failure, layer: .host)
      }
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
  // pinned to the host anchor. Retain the codec to recover an early close cause
  // after pipeline teardown. The caller owns the channel and the group.
  static func connectRelayChannel(endpoint: RelayEndpoint, mode: String, identity: G0ProbeIdentity,
                                  group: EventLoopGroup) async throws -> (Channel, NIOSSLContext, TunnelCodec) {
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
      let tunnel = TunnelCodec()
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
                try channel.pipeline.syncOperations.addHandler(tunnel)
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
      return (channel, innerContext, tunnel)
    } catch {
      // An HTTP WebSocket upgrade cannot complete before outer TLS succeeds.
      throw RelayTransportError.identifyingHandshake(error, layer: .relay)
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
