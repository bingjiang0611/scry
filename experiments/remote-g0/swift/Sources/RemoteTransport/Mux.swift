import Foundation
import NIOCore
import NIOTLS

// A multiplexed inner-mTLS lane. Requests carry a numeric `id` right after the
// `keepAlive` marker and are written immediately; the host runs them
// concurrently and each reply echoes its id, so a long-poll no longer holds the
// lane and one tunnel replaces the separate control/watch/status tunnels.
//
// Failure semantics match LaneHandler: a request whose bytes were written is
// `lost` when the tunnel fails (the host may have acted on it); one still
// queued before the inner handshake is `notSent`. Cancelling one request only
// forgets it; the tunnel and the other requests continue.
//
// All mutable state is confined to the channel's event loop, except the id
// counter and the activity clock, which are lock-protected.
final class MuxHandler: ChannelInboundHandler, RemovableChannelHandler, @unchecked Sendable {
  typealias InboundIn = ByteBuffer
  typealias OutboundOut = ByteBuffer

  private struct Pending {
    let limit: Int
    let timeout: TimeAmount
    // A liveness probe: if even this goes unanswered the tunnel is dead.
    let fatalOnTimeout: Bool
    let result: EventLoopPromise<Data>
    // Set for a pushed stream: every `more: true` line goes here and the id
    // stays open; the final line completes `result`.
    let onItem: (@Sendable (Data) -> Void)?
    var written = false
    var deadline: Scheduled<Void>?
  }

  static let maxPending = 32
  static let requestPrefix = Data("{\"keepAlive\":true".utf8)
  static let replyPrefix = Data("{\"keepAlive\":true,\"id\":".utf8)

  let ready: EventLoopPromise<Void>
  let acceptsRequests = LockedFlag(true)
  // The host answered without an id: it no longer speaks this format.
  let protocolMismatch = LockedFlag(false)
  // Monotonic time of the last inbound byte; the keepalive pings only a
  // silent tunnel.
  let lastActivity = LockedValue<UInt64>(MonotonicClock.nowNanos())

  private let handshakeTimeout: TimeAmount
  private var handshaken: Bool
  private var context: ChannelHandlerContext?
  private var pending: [Int: Pending] = [:]
  private var queued: [(id: Int, bytes: Data)] = []
  private var received = Data()
  private var readySettled = false
  private var handshakeDeadline: Scheduled<Void>?
  private let ids = LockedValue(0)

  // `handshaken: true` when installed on a tunnel whose inner TLS is already up
  // (after a capability probe on the same tunnel).
  init(ready: EventLoopPromise<Void>, handshaken: Bool = false, handshakeTimeout: TimeAmount = .seconds(8)) {
    self.ready = ready
    self.handshaken = handshaken
    self.handshakeTimeout = handshakeTimeout
  }

  func nextId() -> Int {
    ids.withValue { value in value += 1; return value }
  }

  static func frame(_ request: Data, id: Int) -> Data? {
    guard request.starts(with: requestPrefix), id >= 0 else { return nil }
    var bytes = Data("{\"keepAlive\":true,\"id\":\(id)".utf8)
    bytes.append(request.dropFirst(requestPrefix.count))
    return bytes
  }

  // `{"keepAlive":true,"id":42,...}` -> 42. Nil when the line is not an
  // id-tagged reply.
  static func replyId(_ line: Data) -> Int? {
    guard line.starts(with: replyPrefix) else { return nil }
    var value = 0
    var digits = 0
    for byte in line.dropFirst(replyPrefix.count) {
      switch byte {
      case UInt8(ascii: "0")...UInt8(ascii: "9"):
        digits += 1
        guard digits <= 15 else { return nil }
        value = value * 10 + Int(byte - UInt8(ascii: "0"))
      case UInt8(ascii: ","), UInt8(ascii: "}"):
        return digits > 0 ? value : nil
      default:
        return nil
      }
    }
    return nil
  }

  func handlerAdded(context: ChannelHandlerContext) {
    self.context = context
    let channel = context.channel
    channel.closeFuture.whenComplete { [self] _ in fail(ProbeError.disconnected) }
    if handshaken {
      readySettled = true
      ready.succeed(())
      return
    }
    // A relay leg that died silently never answers the ClientHello.
    handshakeDeadline = context.eventLoop.scheduleTask(in: handshakeTimeout) { [self] in
      fail(RelayTransportError.timedOut(stage: "lane-handshake"))
      channel.close(promise: nil)
    }
  }

  func handlerRemoved(context: ChannelHandlerContext) {
    self.context = nil
  }

  func userInboundEventTriggered(context: ChannelHandlerContext, event: Any) {
    if let tls = event as? TLSUserEvent, case .handshakeCompleted = tls, !handshaken {
      handshaken = true
      handshakeDeadline?.cancel(); handshakeDeadline = nil
      lastActivity.value = MonotonicClock.nowNanos()
      if !readySettled { readySettled = true; ready.succeed(()) }
      let waiting = queued
      queued.removeAll()
      for entry in waiting where pending[entry.id] != nil { write(id: entry.id, entry.bytes, context: context) }
    }
    context.fireUserInboundEventTriggered(event)
  }

  // `{"keepAlive":true,"id":N,"more":true,...}`: one item of a pushed stream.
  static func isStreamItem(_ line: Data, id: Int) -> Bool {
    line.starts(with: Data("{\"keepAlive\":true,\"id\":\(id),\"more\":true".utf8))
  }

  func request(id: Int, _ bytes: Data, limit: Int, timeout: TimeAmount, fatalOnTimeout: Bool = false,
               onItem: (@Sendable (Data) -> Void)? = nil, on channel: Channel) -> EventLoopFuture<Data> {
    channel.eventLoop.preconditionInEventLoop()
    guard channel.isActive, acceptsRequests.value, let context, pending.count < Self.maxPending,
          pending[id] == nil, let framed = Self.frame(bytes, id: id) else {
      return channel.eventLoop.makeFailedFuture(LaneFailure.notSent(ProbeError.disconnected))
    }
    let result = channel.eventLoop.makePromise(of: Data.self)
    pending[id] = Pending(limit: limit, timeout: timeout, fatalOnTimeout: fatalOnTimeout, result: result, onItem: onItem)
    if handshaken { write(id: id, framed, context: context) } else { queued.append((id, framed)) }
    return result.futureResult
  }

  // The caller stopped waiting. The host may still answer; that reply is
  // dropped by id. Nothing else on the tunnel is affected.
  func cancel(id: Int) {
    guard let entry = pending.removeValue(forKey: id) else { return }
    entry.deadline?.cancel()
    queued.removeAll { $0.id == id }
    entry.result.fail(CancellationError())
    // A pushed stream would keep arriving: ask the host to stop it. The reply
    // has an untracked id and is dropped like any other unknown id.
    if entry.onItem != nil, entry.written, handshaken, let context, acceptsRequests.value {
      let bytes = Data("{\"keepAlive\":true,\"id\":\(nextId()),\"op\":\"cancel\",\"target\":\(id)}\n".utf8)
      context.writeAndFlush(wrapOutboundOut(ByteBuffer(bytes: bytes)), promise: nil)
    }
  }

  private func write(id: Int, _ framed: Data, context: ChannelHandlerContext) {
    var bytes = framed
    bytes.append(10)
    pending[id]?.written = true
    context.writeAndFlush(wrapOutboundOut(ByteBuffer(bytes: bytes)), promise: nil)
    arm(id: id, context: context)
  }

  // Inactivity deadline per request, re-armed whenever the tunnel delivers
  // bytes: a large page in progress keeps every waiter alive.
  private func arm(id: Int, context: ChannelHandlerContext) {
    guard let entry = pending[id], entry.written else { return }
    entry.deadline?.cancel()
    let channel = context.channel
    pending[id]?.deadline = context.eventLoop.scheduleTask(in: entry.timeout) { [self] in
      expire(id: id, channel: channel)
    }
  }

  private func expire(id: Int, channel: Channel) {
    guard let entry = pending.removeValue(forKey: id) else { return }
    let error = RelayTransportError.timedOut(stage: entry.fatalOnTimeout ? "mux-probe" : "mux-response")
    entry.result.fail(LaneFailure.lost(error))
    if entry.fatalOnTimeout {
      // Not even a ping came back: the tunnel is dead, not merely busy.
      fail(error)
      channel.close(promise: nil)
    }
  }

  func channelRead(context: ChannelHandlerContext, data: NIOAny) {
    let bytes = unwrapInboundIn(data)
    guard bytes.readableBytes > 0 else { return }
    lastActivity.value = MonotonicClock.nowNanos()
    received.append(contentsOf: bytes.readableBytesView)
    for id in Array(pending.keys) { arm(id: id, context: context) }
    while let newline = received.firstIndex(of: 10) {
      let line = Data(received[received.startIndex..<newline])
      received = Data(received[received.index(after: newline)...])
      guard let id = Self.replyId(line) else {
        // A reply without an id (e.g. mux_id_required from a host that lost the
        // format) cannot be correlated. End the tunnel; nothing is guessed.
        protocolMismatch.value = true
        fail(ProbeError.unexpectedReply)
        context.close(promise: nil)
        return
      }
      guard let current = pending[id] else { continue }
      if let onItem = current.onItem, Self.isStreamItem(line, id: id), line.count <= current.limit {
        // The id stays open; its deadline was re-armed by this read.
        onItem(line)
        continue
      }
      pending.removeValue(forKey: id)
      current.deadline?.cancel()
      if line.count > current.limit { current.result.fail(LaneFailure.lost(ProbeError.oversized)) }
      else { current.result.succeed(line) }
    }
    let bound = (pending.values.map(\.limit).max() ?? 65_536) + 1_024
    if received.count > bound {
      fail(ProbeError.oversized)
      context.close(promise: nil)
    }
  }

  func errorCaught(context: ChannelHandlerContext, error: Error) {
    fail(error)
    context.close(promise: nil)
  }

  func channelInactive(context: ChannelHandlerContext) {
    fail(ProbeError.disconnected)
    context.fireChannelInactive()
  }

  private func fail(_ error: Error) {
    acceptsRequests.value = false
    handshakeDeadline?.cancel(); handshakeDeadline = nil
    if !readySettled { readySettled = true; ready.fail(error) }
    let entries = pending
    pending.removeAll()
    queued.removeAll()
    received.removeAll()
    for entry in entries.values {
      entry.deadline?.cancel()
      entry.result.fail(entry.written ? LaneFailure.lost(error) : LaneFailure.notSent(error))
    }
  }
}
