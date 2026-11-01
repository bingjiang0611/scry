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
    guard let closeCause else { return error }
    switch error {
    case ProbeError.disconnected, ChannelError.ioOnClosedChannel:
      return closeCause
    default:
      return error
    }
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


public enum G0Transport {}
