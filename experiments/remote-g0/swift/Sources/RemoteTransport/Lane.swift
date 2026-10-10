import Foundation
import NIOCore
import NIOPosix
import NIOSSL
import NIOTLS

// Persistent inner-mTLS lanes for the post-pairing run channel.
//
// A one-shot exchange pays DNS + TCP + outer TLS + WebSocket upgrade + relay
// rendezvous + inner TLS 1.3 mTLS for every request (measured ~2 s on a phone).
// A lane keeps one authenticated tunnel open and sends further requests on it,
// one outstanding request at a time (the host never pipelines). The host still
// re-authorizes every request against the verified peer certificate.
//
// Separate lanes keep slow work from blocking interactive work:
//   control: submit, answers, stop, catalogs, run state (short)
//   watch:   the live run long-poll (holds the lane up to ~20 s)
//   bulk:    session catalog, history and workspace pages (large)
//
// Retry rules are explicit, not error-string guesses:
//   - Opening a lane may retry: no request byte has been sent yet, so a relay
//     close (e.g. no warm host leg) or a stale leg cannot have run anything.
//   - A request that failed before its bytes were written is re-sent on a new
//     tunnel. A request whose bytes were written is re-sent once only when the
//     caller marks it replayable (reads). Writes surface the error so the UI
//     keeps the outcome "unknown" and reconciles by intent/answer id.
//   - Older hosts close after each reply. Only a reply starting with
//     `{"keepAlive":true,` proves the host keeps the tunnel open.
public final class RelaySession: Sendable {
  public enum Lane: Sendable, CaseIterable { case control, watch, bulk }

  private let lanes: [Lane: RelayLane]

  // `identity` is read when a tunnel opens, so Keychain material is loaded once
  // per tunnel instead of once per request.
  public init(endpoint: G0Transport.RelayEndpoint, identity: @escaping @Sendable () throws -> G0ProbeIdentity) {
    let base = G0Transport.RelayEndpoint(host: endpoint.host, port: endpoint.port, hostId: endpoint.hostId,
                                         relayServerName: endpoint.relayServerName, outerTLS: endpoint.outerTLS)
    var lanes: [Lane: RelayLane] = [:]
    for lane in Lane.allCases {
      lanes[lane] = RelayLane(endpoint: base, identity: identity, abortOnCancel: lane != .control,
                              responseTimeout: lane == .watch ? .seconds(40) : .seconds(30))
    }
    self.lanes = lanes
  }

  func exchange(_ request: Data, lane: Lane, limit: Int, replayable: Bool) async throws -> Data {
    try await lanes[lane]!.exchange(Self.keepAliveRequest(request), limit: limit, replayable: replayable)
  }

  // Opens the control lane ahead of the first user action. Errors are returned
  // to the caller; a failed prewarm is not evidence that the host is offline.
  public func prewarm() async throws {
    try await lanes[.control]!.prewarm()
  }

  // Drops every tunnel (app backgrounded, network path changed). In-flight
  // replayable reads reconnect on their own; writes report an unknown outcome.
  public func reset() async {
    for lane in lanes.values { await lane.reset() }
  }

  // Every run request is a JSONEncoder object starting with `{`. Prefixing keeps
  // its fields intact; history structs that already carry keepAlive:true only
  // repeat the same value (the host's JSON.parse keeps the last duplicate).
  static func keepAliveRequest(_ request: Data) -> Data {
    precondition(request.first == UInt8(ascii: "{") && request.count >= 2)
    if request.count == 2 { return Data("{\"keepAlive\":true}".utf8) }
    return Data("{\"keepAlive\":true,".utf8) + request.dropFirst()
  }
}

enum LaneFailure: Error {
  // Nothing was written for this request; resending cannot duplicate it.
  case notSent(Error)
  // The request bytes were written; the host may have acted on them.
  case lost(Error)
}

actor RelayLane {
  private let endpoint: G0Transport.RelayEndpoint
  private let identity: @Sendable () throws -> G0ProbeIdentity
  private let abortOnCancel: Bool
  private let responseTimeout: TimeAmount
  private var connection: LaneConnection?
  private var opening: Task<LaneConnection, Error>?
  private var inFlight = 0
  private var idleClose: Task<Void, Never>?

  // The host closes an idle tunnel after 30 s; close first so a request is
  // never written into a tunnel the host is about to drop.
  private static let idleSeconds: UInt64 = 20

  init(endpoint: G0Transport.RelayEndpoint, identity: @escaping @Sendable () throws -> G0ProbeIdentity,
       abortOnCancel: Bool, responseTimeout: TimeAmount) {
    self.endpoint = endpoint
    self.identity = identity
    self.abortOnCancel = abortOnCancel
    self.responseTimeout = responseTimeout
  }

  func exchange(_ request: Data, limit: Int, replayable: Bool) async throws -> Data {
    inFlight += 1
    idleClose?.cancel(); idleClose = nil
    defer { inFlight -= 1; scheduleIdleClose() }
    var resends = 0
    var replayed = false
    while true {
      try Task.checkCancellation()
      let current = try await usableConnection()
      do {
        return try await current.send(request, limit: limit, timeout: responseTimeout, abortOnCancel: abortOnCancel)
      } catch LaneFailure.notSent(let error) {
        discard(current)
        resends += 1
        if resends > 2 || Task.isCancelled { throw error }
      } catch LaneFailure.lost(let error) {
        discard(current)
        if !replayable || replayed || Task.isCancelled { throw error }
        replayed = true
      }
    }
  }

  func prewarm() async throws {
    inFlight += 1
    defer { inFlight -= 1; scheduleIdleClose() }
    _ = try await usableConnection()
  }

  func reset() {
    idleClose?.cancel(); idleClose = nil
    opening?.cancel(); opening = nil
    connection?.close()
    connection = nil
  }

  private func usableConnection() async throws -> LaneConnection {
    if let connection, connection.reusable { return connection }
    if let opening { return try await opening.value }
    let task = Task { [endpoint, identity] in try await LaneConnection.open(endpoint: endpoint, identity: identity) }
    opening = task
    do {
      let opened = try await task.value
      if opening == task { opening = nil; connection = opened }
      return opened
    } catch {
      if opening == task { opening = nil }
      throw error
    }
  }

  private func discard(_ failed: LaneConnection) {
    failed.close()
    if connection === failed { connection = nil }
  }

  private func scheduleIdleClose() {
    guard inFlight == 0, connection != nil else { return }
    idleClose?.cancel()
    idleClose = Task { [weak self] in
      try? await Task.sleep(nanoseconds: Self.idleSeconds * 1_000_000_000)
      guard !Task.isCancelled else { return }
      await self?.closeIfIdle()
    }
  }

  private func closeIfIdle() {
    guard inFlight == 0 else { return }
    connection?.close()
    connection = nil
  }
}

// One open tunnel: outer WebSocket + inner mTLS, owned by a lane.
final class LaneConnection: Sendable {
  private let channel: Channel
  private let handler: LaneHandler

  private init(channel: Channel, handler: LaneHandler) {
    self.channel = channel
    self.handler = handler
  }

  // Read off the event loop as a hint; a stale `true` only means the next send
  // fails as notSent and moves to a fresh tunnel.
  var reusable: Bool { channel.isActive && handler.acceptsRequests.value }

  func close() { channel.close(promise: nil) }

  func send(_ request: Data, limit: Int, timeout: TimeAmount, abortOnCancel: Bool) async throws -> Data {
    let future = channel.eventLoop.flatSubmit { [handler, channel] in
      handler.request(request, limit: limit, timeout: timeout, on: channel)
    }
    if !abortOnCancel { return try await future.get() }
    return try await withTaskCancellationHandler {
      try await future.get()
    } onCancel: { [channel] in
      // A superseded long-poll or large page must not keep streaming.
      channel.close(promise: nil)
    }
  }

  static func open(endpoint: G0Transport.RelayEndpoint, identity: @Sendable () throws -> G0ProbeIdentity) async throws -> LaneConnection {
    let material = try identity()
    var attempt = 0
    while true {
      do {
        return try await openOnce(endpoint: endpoint, identity: material)
      } catch {
        attempt += 1
        // A rejected certificate/anchor is not transient; everything else here
        // happened before any request byte was written and is safe to retry.
        if error is NIOSSLError || attempt >= 3 || Task.isCancelled { throw error }
        try await Task.sleep(nanoseconds: attempt == 1 ? 250_000_000 : 800_000_000)
      }
    }
  }

  private static func openOnce(endpoint: G0Transport.RelayEndpoint, identity: G0ProbeIdentity) async throws -> LaneConnection {
    let (channel, innerContext) = try await G0Transport.connectRelayChannel(
      endpoint: endpoint, mode: "run", identity: identity, group: MultiThreadedEventLoopGroup.singleton)
    let handler = LaneHandler(ready: channel.eventLoop.makePromise(of: Void.self))
    do {
      try await channel.eventLoop.submit {
        try channel.pipeline.syncOperations.addHandler(NIOSSLClientHandler(context: innerContext, serverHostname: nil))
        try channel.pipeline.syncOperations.addHandler(handler)
      }.get()
      try await withTaskCancellationHandler {
        try await handler.ready.futureResult.get()
      } onCancel: { channel.close(promise: nil) }
      return LaneConnection(channel: channel, handler: handler)
    } catch {
      channel.close(promise: nil)
      throw error
    }
  }
}

// Event-loop confined. Queues requests until the inner handshake completes and
// sends them strictly one at a time.
final class LaneHandler: ChannelInboundHandler, @unchecked Sendable {
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

  init(ready: EventLoopPromise<Void>) { self.ready = ready }

  func handlerAdded(context: ChannelHandlerContext) {
    self.context = context
    // A relay leg that died silently never answers the ClientHello.
    deadline = context.eventLoop.scheduleTask(in: .seconds(8)) { [self, channel = context.channel] in
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

final class LockedFlag: @unchecked Sendable {
  private let lock = NSLock()
  private var stored: Bool
  init(_ value: Bool) { stored = value }
  var value: Bool {
    get { lock.withLock { stored } }
    set { lock.withLock { stored = newValue } }
  }
}
