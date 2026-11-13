import Foundation
import NIOCore

// One logical lane's tunnel: opening (direct first, then relay), reuse,
// foreground keepalive, background direct upgrade and idle close.
actor RelayLane {
  private let endpoint: G0Transport.RelayEndpoint
  private let identity: @Sendable () throws -> G0ProbeIdentity
  private let context: LaneOpenContext
  private var connection: LaneConnection?
  private var opening: Task<LaneConnection, Error>?
  private var upgrading: Task<Void, Never>?
  private var keepAlive: Task<Void, Never>?
  private var foreground = false
  private var inFlight = 0
  private var idleClose: Task<Void, Never>?
  private var refreshing = false

  // The host closes an idle serial tunnel after 30 s (75 s for current hosts);
  // close first so a request is never written into a tunnel about to drop.
  private static let idleSeconds: UInt64 = 20
  // Foreground keepalive: look every 5 s, ping a tunnel silent for 15 s.
  static let keepAliveCheckNanos: UInt64 = 5_000_000_000
  static let keepAliveSilenceNanos: UInt64 = 15_000_000_000
  // A relay tunnel replaced by a direct one keeps serving the requests already
  // on it (a long-poll waits up to ~20 s) before it is closed.
  static let retireNanos: UInt64 = 45_000_000_000

  init(endpoint: G0Transport.RelayEndpoint, identity: @escaping @Sendable () throws -> G0ProbeIdentity,
       context: LaneOpenContext) {
    self.endpoint = endpoint
    self.identity = identity
    self.context = context
  }

  func exchange(_ request: Data, limit: Int, replayable: Bool, timeout: TimeAmount, abortOnCancel: Bool) async throws -> Data {
    inFlight += 1
    idleClose?.cancel(); idleClose = nil
    defer { inFlight -= 1; scheduleIdleClose() }
    var resends = 0
    var replayed = false
    while true {
      try Task.checkCancellation()
      let current = try await usableConnection()
      do {
        return try await current.send(request, limit: limit, timeout: timeout, abortOnCancel: abortOnCancel)
      } catch LaneFailure.notSent(let error) {
        // A serial tunnel that refused a request is replaced. A multiplexed one
        // that is merely full or timed one request out keeps serving others;
        // a dead one is discarded either way.
        discard(current, force: !current.multiplexed)
        resends += 1
        if resends > 2 || Task.isCancelled { throw error }
      } catch LaneFailure.lost(let error) {
        discard(current, force: !current.multiplexed)
        if !replayable || replayed || Task.isCancelled { throw error }
        replayed = true
      }
    }
  }

  // Streams are read-only but not replayed here: the caller resubscribes
  // with the cursors it has already applied.
  func exchangeStream(_ request: Data, limit: Int, timeout: TimeAmount,
                      onItem: @escaping @Sendable (Data) -> Void) async throws -> Data {
    inFlight += 1
    idleClose?.cancel(); idleClose = nil
    defer { inFlight -= 1; scheduleIdleClose() }
    let current = try await usableConnection()
    guard current.multiplexed else { throw StreamUnavailable() }
    do {
      return try await current.sendStream(request, limit: limit, timeout: timeout, onItem: onItem)
    } catch let failure as LaneFailure {
      discard(current)
      throw failure.underlying
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
    upgrading?.cancel(); upgrading = nil
    connection?.close()
    connection = nil
  }

  func setForeground(_ value: Bool) {
    foreground = value
    if value {
      startKeepAlive()
    } else {
      keepAlive?.cancel(); keepAlive = nil
      scheduleIdleClose()
    }
  }

  func probe() async -> Bool {
    guard let current = connection else { return true }
    guard current.reusable, current.multiplexed else { discard(current, force: true); return false }
    if await current.ping(timeout: .seconds(3)) { return true }
    discard(current, force: true)
    return false
  }

  private func usableConnection() async throws -> LaneConnection {
    if let connection, connection.reusable { return connection }
    if let opening { return try await opening.value }
    let task = Task { [endpoint, identity, context] in
      try await LaneConnection.open(endpoint: endpoint, identity: identity, context: context)
    }
    opening = task
    do {
      let opened = try await task.value
      if opening == task { opening = nil; adopt(opened) }
      return opened
    } catch {
      if opening == task { opening = nil }
      throw error
    }
  }

  private func adopt(_ opened: LaneConnection) {
    connection = opened
    if foreground { startKeepAlive() }
    if opened.route == "relay" { scheduleDirectUpgrade() }
    scheduleAdvertisementRefresh(opened)
  }

  // Remembered capabilities skip the ping that carries the host's current LAN
  // advertisement, so a Mac that joins Wi-Fi (or moves) stays unreachable
  // directly for as long as the cache lives. The evidence is on the phone:
  // `scry.remote.transport.<hostId>` held `routes: []` with a full capability
  // list while the host advertised 192.168.0.100:47820 and the phone went
  // through the relay every time. Re-read it once per adopted tunnel, in the
  // background: the open path never waits for this, and a failed refresh keeps
  // the old routes instead of failing the lane.
  private func scheduleAdvertisementRefresh(_ opened: LaneConnection) {
    guard !refreshing, opened.multiplexed else { return }
    refreshing = true
    Task { [weak self, context] in
      if let reply = try? await Self.advertisement(opened, deviceLabel: context.deviceLabel) {
        Self.applyAdvertisement(reply, transport: context.transport)
      }
      await self?.finishAdvertisementRefresh()
    }
  }

  static func advertisement(_ opened: LaneConnection, deviceLabel: String?) async throws -> Data {
    let request = try RelaySession.keepAliveRequest(Data(#"{"op":"ping"}"#.utf8), deviceLabel: deviceLabel)
    return try await opened.send(request, limit: 64 * 1_024, timeout: .seconds(10), abortOnCancel: false)
  }

  // The host's answer is diagnostic only (routes it is willing to serve), and
  // it never outranks the pinned inner TLS or the device authorization.
  @discardableResult
  static func applyAdvertisement(_ reply: Data, transport: HostTransportState) -> [DirectRoute]? {
    guard let decoded = try? JSONDecoder().decode(PingReply.self, from: reply),
          let pong = decoded.pong, let capabilities = pong.capabilities else { return nil }
    transport.learn(capabilities: capabilities, routes: decoded.routes)
    return transport.routes
  }

  private func finishAdvertisementRefresh() {
    refreshing = false
    // New routes are only useful if the tunnel that found them can move over.
    if connection?.route == "relay" { scheduleDirectUpgrade() }
  }

  // A tunnel through the relay that could go direct: try once in the
  // background and move new requests over if it works.
  private func scheduleDirectUpgrade() {
    guard upgrading == nil, let route = context.transport.candidateRoutes().first else { return }
    upgrading = Task { [weak self, identity, context] in
      var direct: LaneConnection?
      do {
        direct = try await LaneConnection.openDirect(route: route, material: try identity(), context: context, phase: "upgrade")
      } catch {
        context.transport.coolDown(route)
      }
      await self?.finishUpgrade(direct)
    }
  }

  private func finishUpgrade(_ direct: LaneConnection?) {
    upgrading = nil
    guard let direct else { return }
    guard !Task.isCancelled else { direct.close(); return }
    guard let old = connection, old.reusable else {
      connection = direct
      if foreground { startKeepAlive() }
      return
    }
    guard old.route == "relay" else { direct.close(); return }
    connection = direct
    Task { try? await Task.sleep(nanoseconds: RelayLane.retireNanos); old.close() }
  }

  private func discard(_ failed: LaneConnection, force: Bool = false) {
    // A multiplexed tunnel that only timed one request out still serves others.
    if !force && failed.reusable { return }
    if failed.protocolMismatch { context.transport.forgetCapabilities() }
    failed.close()
    if connection === failed { connection = nil }
  }

  private func startKeepAlive() {
    guard keepAlive == nil else { return }
    keepAlive = Task { [weak self] in
      while !Task.isCancelled {
        try? await Task.sleep(nanoseconds: RelayLane.keepAliveCheckNanos)
        guard !Task.isCancelled, let self else { return }
        await self.keepAliveTick()
      }
    }
  }

  private func keepAliveTick() async {
    guard foreground, let current = connection, current.reusable, current.multiplexed,
          current.silentNanos >= Self.keepAliveSilenceNanos else { return }
    if await current.ping(timeout: .seconds(8)) { return }
    discard(current, force: true)
    // Reopen while the user is looking, so the next tap is warm again. A single
    // attempt per tick; an offline Mac is retried at the next tick, not in a loop.
    if foreground { _ = try? await usableConnection() }
  }

  private func scheduleIdleClose() {
    guard inFlight == 0, let current = connection else { return }
    // A foreground multiplexed tunnel stays open; the keepalive owns liveness.
    if foreground && current.multiplexed { return }
    idleClose?.cancel()
    idleClose = Task { [weak self] in
      try? await Task.sleep(nanoseconds: RelayLane.idleSeconds * 1_000_000_000)
      guard !Task.isCancelled else { return }
      await self?.closeIfIdle()
    }
  }

  private func closeIfIdle() {
    guard inFlight == 0 else { return }
    if foreground, let connection, connection.multiplexed { return }
    connection?.close()
    connection = nil
  }
}
