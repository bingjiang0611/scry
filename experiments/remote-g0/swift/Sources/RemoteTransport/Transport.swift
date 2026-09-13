import Foundation
import NIOCore
import NIOPosix
import NIOHTTP1
import NIOWebSocket
import NIOSSL
import NIOTLS

enum ProbeError: Error { case invalidArguments, invalidFrame, oversized, disconnected, unexpectedReply }

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
    case .connectionClose: context.close(promise: nil)
    default:
      context.fireErrorCaught(ProbeError.invalidFrame)
      context.close(promise: nil)
    }
  }

  func write(context: ChannelHandlerContext, data: NIOAny, promise: EventLoopPromise<Void>?) {
    let bytes = unwrapOutboundIn(data)
    guard bytes.readableBytes <= 262_144, context.channel.isWritable else {
      promise?.fail(ProbeError.oversized)
      context.close(promise: nil)
      return
    }
    context.write(wrapOutboundOut(WebSocketFrame(fin: true, opcode: .binary, maskKey: .random(), data: bytes)), promise: promise)
  }
}

final class ProbeHandler: ChannelInboundHandler {
  typealias InboundIn = ByteBuffer
  typealias OutboundOut = ByteBuffer
  private let request: Data
  private let result: EventLoopPromise<Data>
  private var received = Data()
  private var sent = false
  private var settled = false

  init(request: Data, result: EventLoopPromise<Data>) {
    self.request = request
    self.result = result
  }

  func userInboundEventTriggered(context: ChannelHandlerContext, event: Any) {
    if let tlsEvent = event as? TLSUserEvent, case .handshakeCompleted = tlsEvent, !sent {
      // No 0-RTT or writes before the inner host-authenticated handshake.
      sent = true
      var bytes = request
      bytes.append(10)
      context.writeAndFlush(wrapOutboundOut(ByteBuffer(bytes: bytes)), promise: nil)
    }
    context.fireUserInboundEventTriggered(event)
  }

  func channelRead(context: ChannelHandlerContext, data: NIOAny) {
    let bytes = unwrapInboundIn(data)
    guard received.count + bytes.readableBytes <= 65_536 else { fail(ProbeError.oversized, context: context); return }
    received.append(contentsOf: bytes.readableBytesView)
    guard let newline = received.firstIndex(of: 10) else { return }
    do {
      guard newline == received.count - 1 else { throw ProbeError.unexpectedReply }
      let reply = Data(received.prefix(upTo: newline))
      if !settled { settled = true; result.succeed(reply) }
      context.close(promise: nil)
    } catch { fail(error, context: context) }
  }

  func errorCaught(context: ChannelHandlerContext, error: Error) { fail(error, context: context) }
  func channelInactive(context: ChannelHandlerContext) {
    if !settled { settled = true; result.fail(ProbeError.disconnected) }
    context.fireChannelInactive()
  }
  private func fail(_ error: Error, context: ChannelHandlerContext) {
    if !settled { settled = true; result.fail(error) }
    context.close(promise: nil)
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
    public init(host: String, port: Int, hostId: String, relayServerName: String? = nil, outerTLS: OuterTLS = .plaintext) {
      self.host = host
      self.port = port
      self.hostId = hostId
      self.relayServerName = relayServerName
      self.outerTLS = outerTLS
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
  // One host-authorized project directory the device may target. The device can
  // never authorize a new one; it only chooses among these, and the host
  // re-checks the cwd on submit regardless.
  public struct RunProjectRef: Sendable, Equatable, Codable { public let path: String; public let label: String }
  // A Provider the device may target for a new session. `available` mirrors the
  // host's real describe() result; the run path still validates `id` on submit.
  public struct RunProviderRef: Sendable, Equatable, Codable { public let id: String; public let label: String; public let available: Bool }
  // A session in the host catalog the device may browse. `externalSessionId` is
  // the Provider's resumable id (nil => pending/unresumable). Display metadata.
  public struct RunSessionRef: Sendable, Equatable, Codable {
    public let sessionId: String; public let externalSessionId: String?; public let providerId: String; public let cwd: String; public let label: String; public let ts: Double
  }
  // A single chunk of the assistant's REAL streamed output content (masked +
  // bounded host-side). kind ∈ output|reasoning|tool|tool_result|truncated.
  // This is trace-derived CONTENT, not canonical usage; tokens/cost stay on the
  // ledger `result` event, never re-derived from here.
  public struct RunOutputChunk: Sendable, Equatable, Codable {
    public let seq: Int; public let at: Int; public let runId: String; public let kind: String; public let text: String
  }
  public struct RunOutputPage: Sendable, Equatable { public let chunks: [RunOutputChunk]; public let cursor: Int }

  private struct RunSubmitRequest: Encodable { let op = "submit"; let intentId: String; let detail: String }
  private struct RunPollRequest: Encodable { let op = "poll"; let cursor: Int }
  private struct RunStateRequest: Encodable { let op = "runState"; let runId: String }
  private struct RunProjectsRequest: Encodable { let op = "projects" }
  private struct RunProvidersRequest: Encodable { let op = "providers" }
  private struct RunSessionsRequest: Encodable { let op = "sessions" }
  private struct RunOutputRequest: Encodable { let op = "output"; let runId: String; let cursor: Int }
  private struct RunResponse: Decodable {
    let runId: String?
    let status: String?
    let poll: RunPollBody?
    let state: String?
    let projects: [RunProjectRef]?
    let providers: [RunProviderRef]?
    let sessions: [RunSessionRef]?
    let output: RunOutputBody?
    let error: String?
  }
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
    let response = try decodeRun(await exchangeRelay(endpoint: endpoint, mode: "run", identity: identity, request: request))
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

  // The host-authorized project directories this device may target. Authorized
  // by the granted cert + anchor-pinned inner TLS, exactly like every run op; a
  // revoked device gets RunError.host(code: "device_not_authorized").
  public static func relayRunProjects(endpoint: RelayEndpoint, identity: G0ProbeIdentity) async throws -> [RunProjectRef] {
    let request = try JSONEncoder().encode(RunProjectsRequest())
    let response = try decodeRun(await exchangeRelay(endpoint: endpoint, mode: "run", identity: identity, request: request))
    guard let projects = response.projects else { throw ProbeError.unexpectedReply }
    return projects
  }

  // The Providers this device may target for a new session. Authorized exactly
  // like every run op; a revoked device gets device_not_authorized.
  public static func relayRunProviders(endpoint: RelayEndpoint, identity: G0ProbeIdentity) async throws -> [RunProviderRef] {
    let request = try JSONEncoder().encode(RunProvidersRequest())
    let response = try decodeRun(await exchangeRelay(endpoint: endpoint, mode: "run", identity: identity, request: request))
    guard let providers = response.providers else { throw ProbeError.unexpectedReply }
    return providers
  }

  // The host session catalog this device may browse. Authorized exactly like
  // every run op; a revoked device gets device_not_authorized.
  public static func relayRunSessions(endpoint: RelayEndpoint, identity: G0ProbeIdentity) async throws -> [RunSessionRef] {
    let request = try JSONEncoder().encode(RunSessionsRequest())
    let response = try decodeRun(await exchangeRelay(endpoint: endpoint, mode: "run", identity: identity, request: request))
    guard let sessions = response.sessions else { throw ProbeError.unexpectedReply }
    return sessions
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
            let upgrader = NIOTypedWebSocketClientUpgrader<Channel>(maxFrameSize: 262_144, upgradePipelineHandler: { channel, _ in
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
  static func exchangeRelay(endpoint: RelayEndpoint, mode: String, identity: G0ProbeIdentity, request: Data) async throws -> Data {
    guard (1...65535).contains(endpoint.port), request.count < 65_536, ["pair", "run"].contains(mode),
          !endpoint.hostId.isEmpty, endpoint.hostId.count <= 64 else { throw ProbeError.invalidArguments }
    let group = MultiThreadedEventLoopGroup(numberOfThreads: 1)
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
            let upgrader = NIOTypedWebSocketClientUpgrader<Channel>(maxFrameSize: 262_144, upgradePipelineHandler: { channel, _ in
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
            channel.eventLoop.scheduleTask(in: .seconds(10)) { channel.close(promise: nil) }
            return try pipeline.configureUpgradableHTTPClientPipeline(configuration: .init(upgradeConfiguration: configuration))
          }
        }
      let channel = try await upgrade.get()
      // Create the reply promise only after the channel exists so a failed
      // connect/upgrade above can never leave an unfulfilled promise to leak
      // (NIO fatalErrors on a leaked promise in debug builds).
      let result = group.next().makePromise(of: Data.self)
      do {
        try await channel.eventLoop.submit {
          // Inner server hostname is nil: chain-to-anchor is the only check.
          try channel.pipeline.syncOperations.addHandler(NIOSSLClientHandler(context: innerContext, serverHostname: nil))
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
