import Foundation
import NIOCore
import NIOPosix
import NIOSSL
import NIOTLS

// Persistent inner-mTLS tunnels for the post-pairing run channel.
//
// A one-shot exchange pays DNS + TCP + outer TLS + WebSocket upgrade + relay
// rendezvous + inner TLS 1.3 mTLS for every request (measured ~2 s on a phone).
// A tunnel keeps that cost to one open. The host still re-authorizes every
// request against the verified peer certificate.
//
// Current hosts multiplex: requests carry an id, run concurrently and reply out
// of order. Then control, the live-run watch and the live-run status share ONE
// tunnel (a long-poll no longer holds it), and bulk reads (catalog, history,
// workspace pages) keep a second so a large page never delays a command. The
// foreground keeps both warm with a ping when they go silent instead of closing
// them after 20 s, so a tap after a pause does not pay a cold open. Older hosts
// keep the original four serial lanes, one outstanding request each.
//
// Retry rules are explicit, not error-string guesses:
//   - Opening a tunnel may retry: no request byte has been sent yet, so a relay
//     close (e.g. no free host leg) or a stale leg cannot have run anything. A
//     relay that reports the Mac offline (4001) is not retried: it is the answer.
//   - A request that failed before its bytes were written is re-sent on a new
//     tunnel. A request whose bytes were written is re-sent once only when the
//     caller marks it replayable (reads). Writes surface the error so the UI
//     keeps the outcome "unknown" and reconciles by intent/answer id.
//   - Older hosts close after each reply. Only a reply starting with
//     `{"keepAlive":true,` proves the host keeps the tunnel open.
//
// Before the relay, a tunnel first tries a direct route the host advertised
// (its LAN or overlay address), which skips the relay entirely. The trust
// decision is identical: inner TLS pins the host anchor either way.
public final class RelaySession: Sendable {
  // `status` carries the live-run/history long-poll so it never queues behind
  // the focused run's watch or a large history page.
  public enum Lane: Sendable, CaseIterable { case control, watch, status, bulk }

  private let lanes: [Lane: RelayLane]
  private let deviceLabel: String?
  private let hostId: String
  let transport: HostTransportState
  private let timings: LockedValue<[RelayConnectTiming]>
  public static let timingHistoryLimit = 64

  // `identity` is read when a tunnel opens, so Keychain material is loaded once
  // per tunnel instead of once per request.
  public init(endpoint: G0Transport.RelayEndpoint, identity: @escaping @Sendable () throws -> G0ProbeIdentity,
              deviceLabel: String? = nil) {
    self.deviceLabel = deviceLabel
    self.hostId = endpoint.hostId
    let transport = HostTransportState.shared(hostId: endpoint.hostId)
    self.transport = transport
    let timings = LockedValue<[RelayConnectTiming]>([])
    self.timings = timings
    let base = G0Transport.RelayEndpoint(host: endpoint.host, port: endpoint.port, hostId: endpoint.hostId,
                                         relayServerName: endpoint.relayServerName, outerTLS: endpoint.outerTLS,
                                         executionTarget: endpoint.executionTarget)
    let record: @Sendable (RelayConnectTiming) -> Void = { timing in
      timings.withValue { list in
        list.append(timing)
        if list.count > RelaySession.timingHistoryLimit { list.removeFirst(list.count - RelaySession.timingHistoryLimit) }
      }
    }
    var lanes: [Lane: RelayLane] = [:]
    for lane in Lane.allCases {
      let context = LaneOpenContext(lane: String(describing: lane), target: endpoint.executionTarget?.id,
                                    transport: transport, deviceLabel: deviceLabel, record: record)
      lanes[lane] = RelayLane(endpoint: base, identity: identity, context: context)
    }
    self.lanes = lanes
  }

  static func timeout(for lane: Lane) -> TimeAmount {
    lane == .watch || lane == .status ? .seconds(40) : .seconds(30)
  }

  // The tunnel a logical lane uses right now. Decided per request: the first
  // tunnel to a new host learns whether it multiplexes.
  private func physical(_ lane: Lane) -> Lane {
    guard transport.multiplexed else { return lane }
    return lane == .bulk ? .bulk : .control
  }

  func exchange(_ request: Data, lane: Lane, limit: Int, replayable: Bool) async throws -> Data {
    let body = try Self.keepAliveRequest(request, deviceLabel: deviceLabel)
    return try await lanes[physical(lane)]!.exchange(body, limit: limit, replayable: replayable,
                                                     timeout: Self.timeout(for: lane), abortOnCancel: lane != .control)
  }

  // True when the host pushes run observation on a multiplexed tunnel.
  public var supportsWatchStream: Bool {
    if case let .supported(set) = transport.capabilities { return set.contains("mux") && set.contains("watchStream") }
    return false
  }

  func stream(_ request: Data, lane: Lane, limit: Int, onItem: @escaping @Sendable (Data) -> Void) async throws -> Data {
    guard transport.multiplexed else { throw StreamUnavailable() }
    let body = try Self.keepAliveRequest(request, deviceLabel: deviceLabel)
    return try await lanes[physical(lane)]!.exchangeStream(body, limit: limit, timeout: Self.timeout(for: lane), onItem: onItem)
  }

  // Opens the tunnels a first user action needs before it is taken: control for
  // commands, and bulk because opening a session reads history there. Both
  // open concurrently. Errors are returned to the caller; a failed prewarm is
  // not evidence that the host is offline (unless the relay said so), and one
  // tunnel's failure must not cancel the other.
  //
  // The relay's 4001 is the exception: both tunnels reach the same room, so the
  // first one to hear "Mac offline" is the answer and the caller gets it at
  // once instead of waiting for the slower tunnel to repeat it (measured: the
  // slower lane added 0.5-1.2 s to the offline answer on a long relay path).
  public func prewarm() async throws {
    let jobs: [@Sendable () async throws -> Void] = [Lane.control, Lane.bulk].map { name -> @Sendable () async throws -> Void in
      let lane = lanes[name]!
      return { try await lane.prewarm() }
    }
    try await Self.settle(jobs, decisive: { RelayTransportError.isHostOffline($0) })
  }

  // Runs every job concurrently and returns once all have finished, throwing
  // the first error. A decisive error is returned as soon as it happens; the
  // other jobs are not abandoned mid-open but finish in the background (a lane
  // open is shared by later requests, and cancelling it would not stop it).
  // Cancelling the caller cancels the jobs, as a task group would.
  static func settle(_ jobs: [@Sendable () async throws -> Void],
                     decisive: @escaping @Sendable (Error) -> Bool) async throws {
    guard !jobs.isEmpty else { return }
    let gate = SettleGate(remaining: jobs.count)
    try await withTaskCancellationHandler {
      try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
        gate.install(continuation)
        for job in jobs {
          gate.add(Task {
            do { try await job(); gate.finish(nil, decisive: false) }
            catch { gate.finish(error, decisive: decisive(error)) }
          })
        }
      }
    } onCancel: {
      gate.cancel()
    }
  }

  // Drops every tunnel (app backgrounded, network path changed). In-flight
  // replayable reads reconnect on their own; writes report an unknown outcome.
  public func reset() async {
    for lane in lanes.values { await lane.reset() }
  }

  // Foreground keeps multiplexed tunnels warm with pings; background stops it
  // (the app also resets, since iOS suspends sockets).
  public func setForeground(_ foreground: Bool) async {
    for lane in lanes.values { await lane.setForeground(foreground) }
  }

  // After a network path change: ping the open tunnels instead of tearing them
  // down blindly. A tunnel that answers is kept (no reconnect, no unknown
  // write outcomes); one that does not is closed. Serial tunnels cannot be
  // pinged alongside a request and are replaced. True when nothing was lost.
  public func probe() async -> Bool {
    var healthy = true
    for lane in Lane.allCases {
      let alive = await lanes[lane]!.probe()
      if !alive { healthy = false }
    }
    return healthy
  }

  public func diagnostics() -> RelaySessionDiagnostics {
    let capabilities = transport.capabilities
    var names: [String]?
    var legacy = false
    switch capabilities {
    case .unknown: break
    case .legacy: legacy = true
    case let .supported(set): names = set.sorted()
    }
    return RelaySessionDiagnostics(hostId: hostId, capabilities: names, legacyHost: legacy,
                                   multiplexed: transport.multiplexed, directRoutes: transport.routes,
                                   localNetworkAvailable: HostTransportState.localNetworkAvailable.value,
                                   timings: timings.value)
  }

  // Every run request is a JSONEncoder object starting with `{`. Prefixing keeps
  // its fields intact; history structs that already carry keepAlive:true only
  // repeat the same value (the host's JSON.parse keeps the last duplicate).
  static func keepAliveRequest(_ request: Data, deviceLabel: String? = nil) throws -> Data {
    precondition(request.first == UInt8(ascii: "{") && request.count >= 2)
    var prefix = Data("{\"keepAlive\":true".utf8)
    if let deviceLabel {
      prefix += Data(",\"deviceLabel\":".utf8)
      prefix += try JSONEncoder().encode(deviceLabel)
    }
    if request.count == 2 { return prefix + Data("}".utf8) }
    return prefix + Data(",".utf8) + request.dropFirst()
  }
}

public struct RelaySessionDiagnostics: Codable, Equatable, Sendable {
  public let hostId: String
  // nil until a tunnel has asked the host; legacyHost when it cannot answer.
  public let capabilities: [String]?
  public let legacyHost: Bool
  public let multiplexed: Bool
  public let directRoutes: [DirectRoute]
  public let localNetworkAvailable: Bool
  public let timings: [RelayConnectTiming]
}

enum LaneFailure: Error {
  // Nothing was written for this request; resending cannot duplicate it.
  case notSent(Error)
  // The request bytes were written; the host may have acted on them.
  case lost(Error)

  var underlying: Error {
    switch self {
    case let .notSent(error), let .lost(error): return error
    }
  }
}

// The tunnel cannot carry a pushed stream (serial host or tunnel); the caller
// falls back to long-polling.
struct StreamUnavailable: Error {}

struct LaneOpenContext: Sendable {
  let lane: String
  let target: String?
  let transport: HostTransportState
  let deviceLabel: String?
  let record: @Sendable (RelayConnectTiming) -> Void
}

// Completion state for RelaySession.settle. The continuation is installed
// before any job starts, so every finish sees it; it is resumed exactly once.
private final class SettleGate: @unchecked Sendable {
  private let lock = NSLock()
  private var remaining: Int
  private var firstError: Error?
  private var continuation: CheckedContinuation<Void, Error>?
  private var tasks: [Task<Void, Never>] = []
  private var cancelled = false

  init(remaining: Int) { self.remaining = remaining }

  func install(_ continuation: CheckedContinuation<Void, Error>) {
    lock.lock(); defer { lock.unlock() }
    self.continuation = continuation
  }

  func add(_ task: Task<Void, Never>) {
    lock.lock()
    let cancelNow = cancelled
    if !cancelNow { tasks.append(task) }
    lock.unlock()
    if cancelNow { task.cancel() }
  }

  func cancel() {
    lock.lock()
    cancelled = true
    let running = tasks
    lock.unlock()
    for task in running { task.cancel() }
  }

  func finish(_ error: Error?, decisive: Bool) {
    lock.lock()
    remaining -= 1
    if let error, firstError == nil { firstError = error }
    var resume: CheckedContinuation<Void, Error>?
    var outcome: Error?
    if let pending = continuation, decisive || remaining == 0 {
      continuation = nil
      resume = pending
      outcome = decisive ? error : firstError
    }
    lock.unlock()
    guard let resume else { return }
    if let outcome { resume.resume(throwing: outcome) } else { resume.resume() }
  }
}
