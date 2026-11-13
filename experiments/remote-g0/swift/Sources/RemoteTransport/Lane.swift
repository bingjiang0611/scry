import Foundation
import NIOCore
import NIOTLS

// Event-loop confined. Queues requests until the inner handshake completes and
// sends them strictly one at a time.
final class LaneHandler: ChannelInboundHandler, RemovableChannelHandler, @unchecked Sendable {
  typealias InboundIn = ByteBuffer
  typealias OutboundOut = ByteBuffer
  private struct Pending {
    let request: Data
    let limit: Int
    let timeout: TimeAmount
    let result: EventLoopPromise<Data>
  }
  private static let keepAlivePrefix = Data("{\"keepAlive\":true,".utf8)
  private static let maxQueued = 16

  let ready: EventLoopPromise<Void>
  private var context: ChannelHandlerContext?
  private var handshaken = false
  private var pending: [Pending] = []
  private var active: Pending?
  private var received = Data()
  private var deadline: Scheduled<Void>?
  private var readySettled = false
  // Written on the event loop, read by the lane actor (see LaneConnection.reusable).
  // Cleared on failure or when the host shows it closes after each reply.
  let acceptsRequests = LockedFlag(true)

  private let handshakeTimeout: TimeAmount

  init(ready: EventLoopPromise<Void>, handshakeTimeout: TimeAmount = .seconds(8)) {
    self.ready = ready
    self.handshakeTimeout = handshakeTimeout
  }

  func handlerAdded(context: ChannelHandlerContext) {
    self.context = context
    // A relay leg that died silently never answers the ClientHello.
    deadline = context.eventLoop.scheduleTask(in: handshakeTimeout) { [self, channel = context.channel] in
      fail(RelayTransportError.timedOut(stage: "lane-handshake"))
      channel.close(promise: nil)
    }
    let channel = context.channel
    channel.closeFuture.whenComplete { [self] _ in fail(ProbeError.disconnected) }
  }

  func request(_ bytes: Data, limit: Int, timeout: TimeAmount, on channel: Channel) -> EventLoopFuture<Data> {
    channel.eventLoop.preconditionInEventLoop()
    guard channel.isActive, acceptsRequests.value, let context, pending.count < Self.maxQueued else {
      return channel.eventLoop.makeFailedFuture(LaneFailure.notSent(ProbeError.disconnected))
    }
    let result = channel.eventLoop.makePromise(of: Data.self)
    pending.append(Pending(request: bytes, limit: limit, timeout: timeout, result: result))
    sendNext(context: context)
    return result.futureResult
  }

  func userInboundEventTriggered(context: ChannelHandlerContext, event: Any) {
    if let tls = event as? TLSUserEvent, case .handshakeCompleted = tls, !handshaken {
      handshaken = true
      deadline?.cancel(); deadline = nil
      readySettled = true
      ready.succeed(())
      sendNext(context: context)
    }
    context.fireUserInboundEventTriggered(event)
  }

  private func sendNext(context: ChannelHandlerContext) {
    guard handshaken, active == nil, acceptsRequests.value, !pending.isEmpty else { return }
    let next = pending.removeFirst()
    active = next
    var bytes = next.request
    bytes.append(10)
    context.writeAndFlush(wrapOutboundOut(ByteBuffer(bytes: bytes)), promise: nil)
    armResponseDeadline(context: context, timeout: next.timeout)
  }

  // Inactivity deadline: progressing large pages keep it re-armed.
  private func armResponseDeadline(context: ChannelHandlerContext, timeout: TimeAmount) {
    deadline?.cancel()
    deadline = context.eventLoop.scheduleTask(in: timeout) { [self, channel = context.channel] in
      fail(RelayTransportError.timedOut(stage: "lane-response"))
      channel.close(promise: nil)
    }
  }

  func channelRead(context: ChannelHandlerContext, data: NIOAny) {
    let bytes = unwrapInboundIn(data)
    guard let current = active, received.count + bytes.readableBytes <= current.limit else {
      fail(ProbeError.oversized)
      context.close(promise: nil)
      return
    }
    received.append(contentsOf: bytes.readableBytesView)
    if bytes.readableBytes > 0 { armResponseDeadline(context: context, timeout: current.timeout) }
    guard let newline = received.firstIndex(of: 10) else { return }
    guard newline == received.count - 1 else {
      fail(ProbeError.unexpectedReply)
      context.close(promise: nil)
      return
    }
    let reply = Data(received.prefix(upTo: newline))
    received.removeAll(keepingCapacity: true)
    active = nil
    deadline?.cancel(); deadline = nil
    if !reply.starts(with: Self.keepAlivePrefix) {
      // One-shot host: it ends the tunnel after this reply. Queued requests
      // were never written and move to a fresh tunnel.
      acceptsRequests.value = false
      let queued = pending
      pending.removeAll()
      for request in queued { request.result.fail(LaneFailure.notSent(ProbeError.disconnected)) }
    }
    current.result.succeed(reply)
    sendNext(context: context)
  }

  func errorCaught(context: ChannelHandlerContext, error: Error) {
    fail(error)
    context.close(promise: nil)
  }

  func channelInactive(context: ChannelHandlerContext) {
    fail(ProbeError.disconnected)
    self.context = nil
    context.fireChannelInactive()
  }

  private func fail(_ error: Error) {
    acceptsRequests.value = false
    deadline?.cancel(); deadline = nil
    if !readySettled { readySettled = true; ready.fail(error) }
    let current = active
    let queued = pending
    active = nil; pending.removeAll(); received.removeAll()
    current?.result.fail(LaneFailure.lost(error))
    for request in queued { request.result.fail(LaneFailure.notSent(error)) }
  }
}

public final class LockedFlag: @unchecked Sendable {
  private let lock = NSLock()
  private var stored: Bool
  public init(_ value: Bool) { stored = value }
  public var value: Bool {
    get { lock.withLock { stored } }
    set { lock.withLock { stored = newValue } }
  }
}
