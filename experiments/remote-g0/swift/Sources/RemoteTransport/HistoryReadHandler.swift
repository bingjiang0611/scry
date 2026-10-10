import Foundation
import NIOCore
import NIOTLS

// State is accessed only on the channel's event loop. The application can queue
// at most two readonly pages; no requests are sent before the mTLS handshake.
final class HistoryReadHandler: ChannelInboundHandler, @unchecked Sendable {
  typealias InboundIn = ByteBuffer
  typealias OutboundOut = ByteBuffer
  private struct Pending {
    let request: Data
    let limit: Int
    let result: EventLoopPromise<Data>
  }
  private var context: ChannelHandlerContext?
  private var ready = false
  private var pending: [Pending] = []
  private var active: Pending?
  private var received = Data()
  private var deadline: Scheduled<Void>?

  func handlerAdded(context: ChannelHandlerContext) {
    self.context = context
    deadline = context.eventLoop.scheduleTask(in: .seconds(10)) { [self, channel = context.channel] in
      fail(RelayTransportError.timedOut(stage: "history-handshake"))
      channel.close(promise: nil)
    }
  }

  func request(_ bytes: Data, limit: Int, on channel: Channel) -> EventLoopFuture<Data> {
    channel.eventLoop.preconditionInEventLoop()
    guard channel.isActive, let context, pending.count + (active == nil ? 0 : 1) < 2 else {
      return channel.eventLoop.makeFailedFuture(ProbeError.disconnected)
    }
    let result = channel.eventLoop.makePromise(of: Data.self)
    pending.append(Pending(request: bytes, limit: limit, result: result))
    sendNext(context: context)
    return result.futureResult
  }

  func userInboundEventTriggered(context: ChannelHandlerContext, event: Any) {
    if let tls = event as? TLSUserEvent, case .handshakeCompleted = tls {
      deadline?.cancel(); deadline = nil
      ready = true
      sendNext(context: context)
    }
    context.fireUserInboundEventTriggered(event)
  }

  private func sendNext(context: ChannelHandlerContext) {
    guard ready, active == nil, !pending.isEmpty else { return }
    active = pending.removeFirst()
    var bytes = active!.request
    bytes.append(10)
    context.writeAndFlush(wrapOutboundOut(ByteBuffer(bytes: bytes)), promise: nil)
    armResponseDeadline(context: context)
  }

  private func armResponseDeadline(context: ChannelHandlerContext) {
    deadline?.cancel()
    deadline = context.eventLoop.scheduleTask(in: .seconds(30)) { [self, channel = context.channel] in
      fail(RelayTransportError.timedOut(stage: "history-response"))
      channel.close(promise: nil)
    }
  }

  func channelRead(context: ChannelHandlerContext, data: NIOAny) {
    let bytes = unwrapInboundIn(data)
    guard let active, received.count + bytes.readableBytes <= active.limit else {
      fail(ProbeError.oversized)
      context.close(promise: nil)
      return
    }
    received.append(contentsOf: bytes.readableBytesView)
    // This is an inactivity deadline, not a 30-second cap on a progressing
    // bounded frame. Cancellation and the byte limit still settle the reader.
    if bytes.readableBytes > 0 { armResponseDeadline(context: context) }
    guard let newline = received.firstIndex(of: 10) else { return }
    guard newline == received.count - 1 else {
      fail(ProbeError.unexpectedReply)
      context.close(promise: nil)
      return
    }
    let reply = Data(received.prefix(upTo: newline))
    received.removeAll(keepingCapacity: true)
    self.active = nil
    deadline?.cancel(); deadline = nil
    active.result.succeed(reply)
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
    deadline?.cancel(); deadline = nil
    let current = active
    let queued = pending
    active = nil; pending.removeAll(); received.removeAll()
    current?.result.fail(error)
    for request in queued { request.result.fail(error) }
  }
}
