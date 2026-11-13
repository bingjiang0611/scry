import Foundation
import NIOCore
import NIOPosix
import NIOSSL

// What the phone has learned about one Mac host's transport, shared by every
// RelaySession that reaches that host (the host itself and each execution
// target routed through it). Nothing here is authority: capabilities only pick
// a wire format the host already re-authorizes per request, and a direct route
// is only an address. Every tunnel, relay or direct, still pins the host anchor
// and presents the granted device certificate in inner TLS 1.3 mTLS.
public struct DirectRoute: Codable, Hashable, Sendable {
  public let host: String
  public let port: Int
  public init(host: String, port: Int) { self.host = host; self.port = port }

  public enum Kind: Sendable { case localNetwork, overlay, other }

  // Only IPv4 literals are accepted from the host. 100.64/10 is the CGNAT range
  // overlay networks such as Tailscale use; it is reachable from any phone
  // network while that overlay runs, unlike a private LAN address.
  public var kind: Kind {
    let parts = host.split(separator: ".").compactMap { Int($0) }
    guard parts.count == 4, parts.allSatisfy({ (0...255).contains($0) }) else { return .other }
    switch (parts[0], parts[1]) {
    case (10, _), (192, 168): return .localNetwork
    case (172, let second) where (16...31).contains(second): return .localNetwork
    case (100, let second) where (64...127).contains(second): return .overlay
    default: return .other
    }
  }

  var isUsable: Bool { kind != .other && (1...65535).contains(port) }
}

public final class HostTransportState: @unchecked Sendable {
  public enum Capabilities: Equatable, Sendable {
    case unknown
    // The host answered without the ping op, or as a one-shot host.
    case legacy
    case supported(Set<String>)
  }

  private struct Persisted: Codable {
    var capabilities: [String]?
    var routes: [DirectRoute]
  }

  private let lock = NSLock()
  private let hostId: String
  private var capabilitiesValue: Capabilities = .unknown
  private var routesValue: [DirectRoute] = []
  private var cooldownUntil: [DirectRoute: UInt64] = [:]
  // Routes that completed inner mTLS on the current network. Only these are
  // dialed before the relay; an unproven route is tried in the background
  // after the relay tunnel is up, so an unreachable advertised address can
  // never delay an open (measured: 2 x 900 ms per lane without this).
  private var confirmedAt: [DirectRoute: UInt64] = [:]

  // A failed direct route is not retried for this long; the relay serves.
  static let routeCooldownNanos: UInt64 = 60_000_000_000
  // A confirmation older than this is re-proven in the background first.
  static let routeConfirmationNanos: UInt64 = 600_000_000_000

  private static let registryLock = NSLock()
  nonisolated(unsafe) private static var registry: [String: HostTransportState] = [:]
  // The app opts in to remembering capabilities and routes across launches.
  // Off by default so isolated tests never share or write state.
  public static let persistence = LockedFlag(false)
  // Set by the app from its path monitor: private LAN addresses are only worth
  // dialing while the phone itself is on Wi-Fi or Ethernet.
  public static let localNetworkAvailable = LockedFlag(false)
  // Kill switch for direct routes (diagnostics, or a policy that forbids them).
  public static let directRoutesEnabled = LockedFlag(true)

  public static func shared(hostId: String) -> HostTransportState {
    registryLock.lock()
    defer { registryLock.unlock() }
    if let existing = registry[hostId] { return existing }
    let state = HostTransportState(hostId: hostId)
    registry[hostId] = state
    return state
  }

  init(hostId: String) {
    self.hostId = hostId
    guard Self.persistence.value, let data = UserDefaults.standard.data(forKey: defaultsKey),
          let saved = try? JSONDecoder().decode(Persisted.self, from: data) else { return }
    // Only learned capabilities are remembered, and only because a host that
    // advertised them keeps speaking them. "Legacy" is deliberately not
    // remembered: it also comes from one unanswered or unparsable ping, so a
    // host upgrade (or a transient failure) would keep the phone on the serial
    // fallback forever, without mux, streaming or compressed history. A legacy
    // host costs one ping per launch to rediscover.
    if let capabilities = saved.capabilities { capabilitiesValue = .supported(Set(capabilities)) }
    routesValue = saved.routes.filter(\.isUsable)
  }

  private var defaultsKey: String { "scry.remote.transport.\(hostId)" }

  public var capabilities: Capabilities {
    lock.lock(); defer { lock.unlock() }
    return capabilitiesValue
  }

  public var multiplexed: Bool {
    if case let .supported(set) = capabilities { return set.contains("mux") }
    return false
  }

  public var routes: [DirectRoute] {
    lock.lock(); defer { lock.unlock() }
    return routesValue
  }

  func learn(capabilities: [String], routes: [DirectRoute]?) {
    lock.lock()
    capabilitiesValue = .supported(Set(capabilities))
    if let routes { routesValue = Array(routes.filter(\.isUsable).prefix(4)) }
    lock.unlock()
    save()
  }

  func markLegacy() {
    lock.lock()
    capabilitiesValue = .legacy
    routesValue = []
    lock.unlock()
    save()
  }

  // The host stopped speaking a learned format (downgraded or replaced):
  // probe again on the next tunnel instead of failing every request.
  func forgetCapabilities() {
    lock.lock()
    capabilitiesValue = .unknown
    lock.unlock()
    save()
  }

  // Routes worth dialing now, best first: private LAN only on a local network,
  // overlay addresses always, neither while cooling down after a failure.
  // `confirmedOnly` limits the list to routes proven on this network recently:
  // the only ones allowed on the blocking open path.
  func candidateRoutes(confirmedOnly: Bool = false, now: UInt64 = MonotonicClock.nowNanos()) -> [DirectRoute] {
    guard Self.directRoutesEnabled.value else { return [] }
    let local = Self.localNetworkAvailable.value
    lock.lock(); defer { lock.unlock() }
    return routesValue.filter { route in
      if let until = cooldownUntil[route], until > now { return false }
      if confirmedOnly {
        guard let at = confirmedAt[route], now &- at <= Self.routeConfirmationNanos else { return false }
      }
      switch route.kind {
      case .localNetwork: return local
      case .overlay: return true
      case .other: return false
      }
    }.sorted { lhs, rhs in lhs.kind == .localNetwork && rhs.kind != .localNetwork }
  }

  func coolDown(_ route: DirectRoute, now: UInt64 = MonotonicClock.nowNanos()) {
    lock.lock(); defer { lock.unlock() }
    cooldownUntil[route] = now &+ Self.routeCooldownNanos
    confirmedAt[route] = nil
  }

  func confirm(_ route: DirectRoute, now: UInt64 = MonotonicClock.nowNanos()) {
    lock.lock(); defer { lock.unlock() }
    cooldownUntil[route] = nil
    confirmedAt[route] = now
  }

  // The phone changed networks: what was reachable (or not) before proves
  // nothing now.
  func forgetRouteEvidence() {
    lock.lock(); defer { lock.unlock() }
    cooldownUntil.removeAll()
    confirmedAt.removeAll()
  }

  public static func networkChanged() {
    registryLock.lock()
    let states = Array(registry.values)
    registryLock.unlock()
    for state in states { state.forgetRouteEvidence() }
  }

  private func save() {
    guard Self.persistence.value else { return }
    lock.lock()
    let saved: Persisted
    switch capabilitiesValue {
    case .unknown, .legacy: saved = Persisted(capabilities: nil, routes: routesValue)
    case let .supported(set): saved = Persisted(capabilities: set.sorted(), routes: routesValue)
    }
    lock.unlock()
    if let data = try? JSONEncoder().encode(saved) { UserDefaults.standard.set(data, forKey: defaultsKey) }
  }
}

// `{"keepAlive":true,"pong":{...}}` from a current host; older hosts answer the
// unknown op with an error instead.
struct PingReply: Decodable {
  struct Lan: Decodable {
    let port: Int
    let addresses: [String]
  }
  struct Pong: Decodable {
    let serverTime: Double?
    let idleTimeoutMs: Int?
    let capabilities: [String]?
    let lan: Lan?
  }
  let pong: Pong?
  let error: String?

  var routes: [DirectRoute]? {
    guard let lan = pong?.lan else { return nil }
    return lan.addresses.map { DirectRoute(host: $0, port: lan.port) }
  }
}

extension G0Transport {
  // Inner TLS 1.3 mTLS context pinned to the host anchor. Shared by the relay
  // and direct paths so both make the identical trust decision.
  static func innerTLSContext(identity: G0ProbeIdentity, mode: String) throws -> NIOSSLContext {
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
    return try NIOSSLContext(configuration: inner)
  }

  // A direct TCP leg to a host-advertised address. No outer TLS or WebSocket:
  // the bytes are the inner mTLS stream itself, exactly what the relay carries.
  // Bounded tightly so an unreachable LAN address falls back to the relay fast.
  static func connectDirectChannel(route: DirectRoute, recorder: ConnectTimingRecorder?) async throws -> Channel {
    guard route.isUsable else { throw ProbeError.invalidArguments }
    return try await RemoteBootstrap.connectChannel(host: route.host, port: route.port, timeout: .milliseconds(900)) { channel in
      if let recorder {
        try channel.pipeline.syncOperations.addHandler(ConnectTimingHandler(recorder: recorder, observesOuterTLS: false))
      }
    }
  }
}
