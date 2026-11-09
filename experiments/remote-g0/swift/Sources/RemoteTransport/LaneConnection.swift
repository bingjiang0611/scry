import Foundation
import NIOCore
import NIOPosix
import NIOSSL
import NIOTLS

// One open tunnel (relay or direct) owned by a lane.
final class LaneConnection: Sendable {
  enum Kind: Sendable {
    case serial(LaneHandler)
    case multiplexed(MuxHandler)
  }

  private let channel: Channel
  private let kind: Kind
  let route: String

  private init(channel: Channel, kind: Kind, route: String) {
    self.channel = channel
    self.kind = kind
    self.route = route
  }

  var multiplexed: Bool {
    if case .multiplexed = kind { return true }
    return false
  }

  // Read off the event loop as a hint; a stale `true` only means the next send
  // fails as notSent and moves to a fresh tunnel.
  var reusable: Bool {
    guard channel.isActive else { return false }
    switch kind {
    case let .serial(handler): return handler.acceptsRequests.value
    case let .multiplexed(handler): return handler.acceptsRequests.value
    }
  }

  var protocolMismatch: Bool {
    if case let .multiplexed(handler) = kind { return handler.protocolMismatch.value }
    return false
  }

  var silentNanos: UInt64 {
    if case let .multiplexed(handler) = kind { return MonotonicClock.nowNanos() &- handler.lastActivity.value }
    return 0
  }

  func close() { channel.close(promise: nil) }

  func send(_ request: Data, limit: Int, timeout: TimeAmount, abortOnCancel: Bool,
            fatalOnTimeout: Bool = false) async throws -> Data {
    switch kind {
    case let .serial(handler):
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
    case let .multiplexed(handler):
      let id = handler.nextId()
      let future = channel.eventLoop.flatSubmit { [handler, channel] in
        handler.request(id: id, request, limit: limit, timeout: timeout, fatalOnTimeout: fatalOnTimeout, on: channel)
      }
      return try await withTaskCancellationHandler {
        try await future.get()
      } onCancel: { [handler, channel] in
        // Forget only this request; the shared tunnel keeps serving others.
        channel.eventLoop.execute { handler.cancel(id: id) }
      }
    }
  }

  // A pushed stream on a multiplexed tunnel: `onItem` receives every
  // intermediate line in order (on the event loop); the final line is
  // returned. Cancelling the task stops the stream on the host too.
  func sendStream(_ request: Data, limit: Int, timeout: TimeAmount,
                  onItem: @escaping @Sendable (Data) -> Void) async throws -> Data {
    guard case let .multiplexed(handler) = kind else { throw LaneFailure.notSent(StreamUnavailable()) }
    let id = handler.nextId()
    let future = channel.eventLoop.flatSubmit { [handler, channel] in
      handler.request(id: id, request, limit: limit, timeout: timeout, onItem: onItem, on: channel)
    }
    return try await withTaskCancellationHandler {
      try await future.get()
    } onCancel: { [handler, channel] in
      channel.eventLoop.execute { handler.cancel(id: id) }
    }
  }

  // An authenticated round trip with a short deadline. Any failure means the
  // tunnel is not usable; it never reports the host as offline by itself.
  func ping(timeout: TimeAmount) async -> Bool {
    guard multiplexed, let request = try? RelaySession.keepAliveRequest(Data(#"{"op":"ping"}"#.utf8)) else { return false }
    do {
      let reply = try await send(request, limit: 64 * 1_024, timeout: timeout, abortOnCancel: false, fatalOnTimeout: true)
      return (try? JSONDecoder().decode(PingReply.self, from: reply))?.pong != nil
    } catch {
      return false
    }
  }

  static func open(endpoint: G0Transport.RelayEndpoint, identity: @Sendable () throws -> G0ProbeIdentity,
                   context: LaneOpenContext) async throws -> LaneConnection {
    let material = try identity()
    // Direct first: when the phone shares a network (or an overlay) with the
    // Mac, this skips the relay round trips entirely. Failures cool the route
    // down and fall through to the relay at once.
    for route in context.transport.candidateRoutes().prefix(2) {
      try Task.checkCancellation()
      do { return try await openDirect(route: route, material: material, context: context) }
      catch { context.transport.coolDown(route) }
    }
    var attempt = 0
    while true {
      do {
        return try await openRelayOnce(endpoint: endpoint, material: material, context: context)
      } catch {
        attempt += 1
        // A rejected certificate/anchor is not transient, and an offline Mac
        // is the relay's answer, not a race. Everything else here happened
        // before any request byte was written and is safe to retry.
        if isNonRetryableOpenError(error) || RelayTransportError.isHostOffline(error) || attempt >= 3 || Task.isCancelled {
          throw error
        }
        try await Task.sleep(nanoseconds: attempt == 1 ? 250_000_000 : 800_000_000)
      }
    }
  }

  static func isNonRetryableOpenError(_ error: Error) -> Bool {
    if error is NIOSSLError { return true }
    if case RelayTransportError.tlsHandshake = error { return true }
    return false
  }

  static func openDirect(route: DirectRoute, material: G0ProbeIdentity, context: LaneOpenContext) async throws -> LaneConnection {
    let recorder = ConnectTimingRecorder(lane: context.lane, route: "direct", target: context.target)
    do {
      let innerContext = try G0Transport.innerTLSContext(identity: material, mode: "run")
      let channel = try await G0Transport.connectDirectChannel(route: route, recorder: recorder)
      let connection = try await establish(channel: channel, innerContext: innerContext, tunnel: nil, recorder: recorder,
                                           context: context, handshakeTimeout: .seconds(2), route: "direct")
      context.transport.confirm(route)
      context.record(recorder.finish())
      return connection
    } catch {
      context.record(recorder.finish(error: error))
      throw error
    }
  }

  private static func openRelayOnce(endpoint: G0Transport.RelayEndpoint, material: G0ProbeIdentity,
                                    context: LaneOpenContext) async throws -> LaneConnection {
    let recorder = ConnectTimingRecorder(lane: context.lane, route: "relay", target: context.target)
    do {
      let (channel, innerContext, tunnel) = try await G0Transport.connectRelayChannel(
        endpoint: endpoint, mode: "run", identity: material, group: MultiThreadedEventLoopGroup.singleton, recorder: recorder)
      let connection = try await establish(channel: channel, innerContext: innerContext, tunnel: tunnel, recorder: recorder,
                                           context: context, handshakeTimeout: .seconds(8), route: "relay")
      context.record(recorder.finish())
      return connection
    } catch {
      context.record(recorder.finish(error: error))
      throw error
    }
  }

  // Runs inner mTLS on an outer channel and picks the wire format. An unknown
  // host gets one ping first: it measures the first authenticated round trip,
  // learns capabilities and direct routes, and on a multiplexing host the same
  // tunnel switches format with no second handshake.
  private static func establish(channel: Channel, innerContext: NIOSSLContext, tunnel: TunnelCodec?,
                                recorder: ConnectTimingRecorder, context: LaneOpenContext,
                                handshakeTimeout: TimeAmount, route: String) async throws -> LaneConnection {
    let capabilities = context.transport.capabilities
    do {
      if case let .supported(set) = capabilities, set.contains("mux") {
        let handler = MuxHandler(ready: channel.eventLoop.makePromise(of: Void.self), handshakeTimeout: handshakeTimeout)
        try await install(handler, innerContext: innerContext, on: channel)
        try await awaitReady(handler.ready, channel: channel)
        recorder.mark(\.innerTLSMs)
        recorder.update { $0.multiplexed = true }
        return LaneConnection(channel: channel, kind: .multiplexed(handler), route: route)
      }
      let handler = LaneHandler(ready: channel.eventLoop.makePromise(of: Void.self), handshakeTimeout: handshakeTimeout)
      try await install(handler, innerContext: innerContext, on: channel)
      try await awaitReady(handler.ready, channel: channel)
      recorder.mark(\.innerTLSMs)
      if capabilities == .legacy {
        recorder.update { $0.multiplexed = false }
        return LaneConnection(channel: channel, kind: .serial(handler), route: route)
      }
      let ping = try RelaySession.keepAliveRequest(Data(#"{"op":"ping"}"#.utf8), deviceLabel: context.deviceLabel)
      let started = MonotonicClock.nowNanos()
      let reply = try await channel.eventLoop.flatSubmit { [handler, channel] in
        handler.request(ping, limit: 64 * 1_024, timeout: .seconds(10), on: channel)
      }.get()
      let roundTrip = MonotonicClock.millis(from: started)
      recorder.update { $0.pingMs = roundTrip }
      let decoded = try? JSONDecoder().decode(PingReply.self, from: reply)
      guard let pong = decoded?.pong else {
        // `unknown_op` (or a one-shot reply): an older host. Remember it so
        // later tunnels do not pay this probe again.
        context.transport.markLegacy()
        recorder.update { $0.multiplexed = false }
        return LaneConnection(channel: channel, kind: .serial(handler), route: route)
      }
      let offered = pong.capabilities ?? []
      context.transport.learn(capabilities: offered, routes: decoded?.routes)
      guard offered.contains("mux"), handler.acceptsRequests.value else {
        recorder.update { $0.multiplexed = false }
        return LaneConnection(channel: channel, kind: .serial(handler), route: route)
      }
      let mux = try await channel.eventLoop.flatSubmit { [handler, channel] in
        channel.pipeline.removeHandler(handler).flatMapThrowing { _ -> MuxHandler in
          let mux = MuxHandler(ready: channel.eventLoop.makePromise(of: Void.self), handshaken: true)
          try channel.pipeline.syncOperations.addHandler(mux)
          return mux
        }
      }.get()
      recorder.update { $0.multiplexed = true }
      return LaneConnection(channel: channel, kind: .multiplexed(mux), route: route)
    } catch {
      let cause = (error as? LaneFailure)?.underlying ?? error
      let failure = try await channel.eventLoop.submit { tunnel?.retainingCloseCause(for: cause) ?? cause }.get()
      channel.close(promise: nil)
      throw RelayTransportError.identifyingHandshake(failure, layer: .host)
    }
  }

  private static func install(_ handler: ChannelHandler & Sendable, innerContext: NIOSSLContext, on channel: Channel) async throws {
    try await channel.eventLoop.submit {
      try channel.pipeline.syncOperations.addHandler(NIOSSLClientHandler(context: innerContext, serverHostname: nil))
      try channel.pipeline.syncOperations.addHandler(handler)
    }.get()
  }

  private static func awaitReady(_ ready: EventLoopPromise<Void>, channel: Channel) async throws {
    do {
      try await withTaskCancellationHandler {
        try await ready.futureResult.get()
      } onCancel: { channel.close(promise: nil) }
    } catch {
      // A lane that failed to become ready never fulfils this promise; leaving
      // it unfulfilled makes NIO report a leaked promise (a fatal error in
      // debug builds) instead of the real handshake failure. A second
      // completion of an already failed promise is ignored by NIO.
      channel.eventLoop.execute { ready.fail(error) }
      throw error
    }
  }
}
