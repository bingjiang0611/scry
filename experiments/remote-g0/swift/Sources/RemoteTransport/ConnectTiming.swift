import Foundation
import NIOCore
import NIOTLS
#if canImport(Network)
import NIOTransportServices
#endif

// Phase timing for one tunnel open. These are client-observed durations from
// the start of the open, not server-side facts: `tcpMs` includes DNS, and a
// missing phase stays nil (never 0) when it did not happen or was not seen.
public struct RelayConnectTiming: Codable, Equatable, Sendable {
  public var lane: String
  // "relay" through the public relay, "direct" to a host-advertised address.
  public var route: String
  public var target: String?
  public var at: Date
  public var tcpMs: Double?
  public var outerTLSMs: Double?
  public var upgradeMs: Double?
  public var innerTLSMs: Double?
  // First authenticated round trip on the new tunnel (capability probe).
  public var pingMs: Double?
  public var totalMs: Double?
  // Cloudflare colo from `cf-ray`, when the relay is behind Cloudflare.
  public var colo: String?
  // Time the relay held the phone waiting for a free host leg.
  public var relayWaitMs: Int?
  public var multiplexed: Bool?
  // "open": on a request's path (the caller waited for it); "upgrade": a
  // background attempt to move an open relay tunnel onto a direct route.
  public var phase: String?
  public var error: String?
  // Network.framework held the connect back because it had no usable path
  // (interface down, no route, local network not permitted, ...): when it
  // first said so, and its latest reason. A failed open with no `tcpMs` and no
  // `waitingReason` never got a path verdict at all; with a reason, the stall
  // was on the phone's side before any byte reached the relay or the host.
  public var waitingMs: Double?
  public var waitingReason: String?

  public init(lane: String, route: String, target: String? = nil, at: Date = Date()) {
    self.lane = lane
    self.route = route
    self.target = target
    self.at = at
  }
}

enum MonotonicClock {
  static func nowNanos() -> UInt64 { DispatchTime.now().uptimeNanoseconds }
  static func millis(from start: UInt64, to end: UInt64 = nowNanos()) -> Double {
    Double(end &- start) / 1_000_000
  }
}

final class LockedValue<Value: Sendable>: @unchecked Sendable {
  private let lock = NSLock()
  private var stored: Value
  init(_ value: Value) { stored = value }
  var value: Value {
    get { lock.withLock { stored } }
    set { lock.withLock { stored = newValue } }
  }
  func withValue<T>(_ body: (inout Value) -> T) -> T {
    lock.lock()
    defer { lock.unlock() }
    return body(&stored)
  }
}

final class ConnectTimingRecorder: @unchecked Sendable {
  private let lock = NSLock()
  private let start = MonotonicClock.nowNanos()
  private var value: RelayConnectTiming

  init(lane: String, route: String, target: String? = nil, phase: String = "open") {
    value = RelayConnectTiming(lane: lane, route: route, target: target)
    value.phase = phase
  }

  // First observation wins; a phase is not re-timed by a later event.
  func mark(_ phase: WritableKeyPath<RelayConnectTiming, Double?>) {
    let elapsed = MonotonicClock.millis(from: start)
    lock.lock()
    defer { lock.unlock() }
    if value[keyPath: phase] == nil { value[keyPath: phase] = elapsed }
  }

  func update(_ body: (inout RelayConnectTiming) -> Void) {
    lock.lock()
    defer { lock.unlock() }
    body(&value)
  }

  // First waiting time wins (when the stall began); the reason is the latest,
  // since Network.framework re-evaluates the path while it waits.
  func markWaiting(_ reason: String) {
    let elapsed = MonotonicClock.millis(from: start)
    lock.lock()
    defer { lock.unlock() }
    if value.waitingMs == nil { value.waitingMs = elapsed }
    value.waitingReason = String(reason.prefix(200))
  }

  func finish(error: Error? = nil) -> RelayConnectTiming {
    let elapsed = MonotonicClock.millis(from: start)
    lock.lock()
    defer { lock.unlock() }
    value.totalMs = elapsed
    if let error { value.error = String(String(describing: error).prefix(200)) }
    return value
  }

  // `cf-ray: 8c1f2e3d4a5b6c7d-NRT` -> "NRT".
  static func colo(fromRay ray: String?) -> String? {
    guard let ray, let dash = ray.lastIndex(of: "-") else { return nil }
    let colo = ray[ray.index(after: dash)...]
    guard (2...5).contains(colo.count), colo.allSatisfy({ $0.isLetter }) else { return nil }
    return String(colo).uppercased()
  }
}

// Pass-through observer placed directly after the outer TLS handler (or first,
// for a plaintext/direct leg). It sees TCP activation and only the OUTER TLS
// completion: the inner TLS handler sits later in the pipeline and fires its
// events toward the tail, never back through this handler.
final class ConnectTimingHandler: ChannelInboundHandler, RemovableChannelHandler, @unchecked Sendable {
  typealias InboundIn = Any
  private let recorder: ConnectTimingRecorder
  private let observesOuterTLS: Bool

  init(recorder: ConnectTimingRecorder, observesOuterTLS: Bool) {
    self.recorder = recorder
    self.observesOuterTLS = observesOuterTLS
  }

  func handlerAdded(context: ChannelHandlerContext) {
    if context.channel.isActive { recorder.mark(\.tcpMs) }
  }

  func channelActive(context: ChannelHandlerContext) {
    recorder.mark(\.tcpMs)
    context.fireChannelActive()
  }

  func userInboundEventTriggered(context: ChannelHandlerContext, event: Any) {
    if observesOuterTLS, let tls = event as? TLSUserEvent, case .handshakeCompleted = tls {
      recorder.mark(\.outerTLSMs)
    }
    #if canImport(Network)
    if let waiting = event as? NIOTSNetworkEvents.WaitingForConnectivity {
      recorder.markWaiting(String(describing: waiting.transientError))
    }
    #endif
    context.fireUserInboundEventTriggered(event)
  }
}
