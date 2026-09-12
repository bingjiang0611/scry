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
  private let request: ProbeRequest
  private let result: EventLoopPromise<ProbeResponse>
  private var received = Data()
  private var sent = false
  private var settled = false

  init(request: ProbeRequest, result: EventLoopPromise<ProbeResponse>) {
    self.request = request
    self.result = result
  }

  func userInboundEventTriggered(context: ChannelHandlerContext, event: Any) {
    if let tlsEvent = event as? TLSUserEvent, case .handshakeCompleted = tlsEvent, !sent {
      // No 0-RTT or writes before the inner host-authenticated handshake.
      sent = true
      do {
        var bytes = try JSONEncoder().encode(request)
        bytes.append(10)
        context.writeAndFlush(wrapOutboundOut(ByteBuffer(bytes: bytes)), promise: nil)
      } catch { fail(error, context: context) }
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
      let reply = try JSONDecoder().decode(ProbeResponse.self, from: received.prefix(upTo: newline))
      guard reply.requestId == request.requestId, reply.payload == request.payload else { throw ProbeError.unexpectedReply }
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
  let certificate: Data
  let privateKey: Data

  public init(outerCA: Data, innerCA: Data, certificate: Data, privateKey: Data) {
    self.outerCA = outerCA
    self.innerCA = innerCA
    self.certificate = certificate
    self.privateKey = privateKey
  }
}

public enum G0Transport {
  // Intentionally loopback-only until a separate public test endpoint is
  // authorized and authenticated routing exists. This is not a business API.
  public static func echo(port: Int, identity: G0ProbeIdentity, payload: String) async throws -> Data {
    guard (1...65535).contains(port) else { throw ProbeError.invalidArguments }
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
      inner.certificateChain = try NIOSSLCertificate.fromPEMBytes(Array(identity.certificate)).map { .certificate($0) }
      inner.privateKey = .privateKey(try NIOSSLPrivateKey(bytes: Array(identity.privateKey), format: .pem))
      let innerContext = try NIOSSLContext(configuration: inner)
      let request = try ProbeRequest(protocolMajor: 1, requestId: UUID().uuidString, operation: "probe.echo", payload: payload)
      let result = group.next().makePromise(of: ProbeResponse.self)
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
            let head = HTTPRequestHead(version: .http1_1, method: .GET, uri: "/device", headers: headers)
            let configuration = NIOTypedHTTPClientUpgradeConfiguration(upgradeRequestHead: head, upgraders: [upgrader], notUpgradingCompletionHandler: { channel in
              channel.eventLoop.makeFailedFuture(ProbeError.invalidFrame)
            })
            // Bound even a silent malicious relay; there is no reconnect/replay.
            channel.eventLoop.scheduleTask(in: .seconds(10)) { channel.close(promise: nil) }
            return try pipeline.configureUpgradableHTTPClientPipeline(configuration: .init(upgradeConfiguration: configuration))
          }
        }
      let channel = try await upgrade.get()
      // The HTTP upgrader rejects outbound writes while its callback is active.
      // Install inner TLS only after upgrade completion, on the event loop, so
      // its immediate ClientHello cannot be silently rejected by HTTP state.
      try await channel.eventLoop.submit {
        try channel.pipeline.syncOperations.addHandler(NIOSSLClientHandler(context: innerContext, serverHostname: "scry-host.test"))
        try channel.pipeline.syncOperations.addHandler(ProbeHandler(request: request, result: result))
      }.get()
      let reply = try await result.futureResult.get()
      let encoded = try JSONEncoder().encode(reply)
      try await group.shutdownGracefully()
      return encoded
    } catch {
      try? await group.shutdownGracefully()
      throw error
    }
  }
}
