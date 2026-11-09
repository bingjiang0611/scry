import Foundation
import Network
import RemoteTransport

// Last complete session-catalog walk per paired host/target/filter, in memory
// only. It is reused solely after the host confirms its snapshot is current.
final class SessionCatalogMemo: @unchecked Sendable {
  struct Entry: Sendable {
    let snapshot: String
    let sessions: [G0Transport.RunSessionRef]
  }
  static let shared = SessionCatalogMemo()
  private let lock = NSLock()
  private var entries: [String: Entry] = [:]
  private var order: [String] = []
  private static let limit = 8

  func get(_ key: String) -> Entry? { lock.withLock { entries[key] } }

  func set(_ key: String, _ entry: Entry) {
    lock.withLock {
      entries[key] = entry
      order.removeAll { $0 == key }
      order.append(key)
      while order.count > Self.limit { entries[order.removeFirst()] = nil }
    }
  }
}

// One persistent RelaySession per paired connection + credential store, shared
// by every RemoteRunClient value. A different descriptor (re-pair, clear) gets a
// fresh session; the old one's tunnels are closed.
final class RemoteSessionRegistry: @unchecked Sendable {
  static let shared = RemoteSessionRegistry()
  static let pathChangedNotification = Notification.Name("ScryRemoteNetworkPathChanged")
  private let lock = NSLock()
  private var sessions: [String: RelaySession] = [:]
  private var recentKeys: [String] = []
  private static let sessionLimit = 67
  private let pathMonitor = NWPathMonitor()
  private var lastPath: String?
  private var foreground = false

  private init() {
    // Remember each Mac's transport capabilities and advertised direct routes
    // across launches, so the first tunnel after a cold start skips the probe.
    HostTransportState.persistence.value = true
    // Wi-Fi <-> cellular can leave old sockets silently dead. On a real route
    // change, ping the open tunnels: keep the ones that answer (no reconnect,
    // no unknown write outcomes) and replace only the dead ones.
    pathMonitor.pathUpdateHandler = { [weak self] path in
      guard let self else { return }
      let interfaceTypes: [(NWInterface.InterfaceType, String)] = [
        (.wifi, "wifi"), (.cellular, "cellular"), (.wiredEthernet, "wired"),
        (.loopback, "loopback"), (.other, "other")
      ]
      let usedInterfaces = interfaceTypes.compactMap { path.usesInterfaceType($0.0) ? $0.1 : nil }
      // Private LAN addresses are dialed directly only while this phone is on a
      // local network itself; overlay (e.g. Tailscale) addresses always may be.
      HostTransportState.localNetworkAvailable.value = path.status == .satisfied &&
        (path.usesInterfaceType(.wifi) || path.usesInterfaceType(.wiredEthernet))
      let signature = RelayPathSignature.make(
        status: String(describing: path.status), isExpensive: path.isExpensive, isConstrained: path.isConstrained,
        supportsDNS: path.supportsDNS, supportsIPv4: path.supportsIPv4, supportsIPv6: path.supportsIPv6,
        usedInterfaceTypes: usedInterfaces
      )
      let changed = self.lock.withLock {
        defer { self.lastPath = signature }
        return self.lastPath != nil && self.lastPath != signature
      }
      if changed {
        let satisfied = path.status == .satisfied
        Task {
          guard satisfied else { await self.resetAll(); return }
          let intact = await self.probeAll()
          // Recovery reads run only when a tunnel was actually lost.
          if !intact { NotificationCenter.default.post(name: Self.pathChangedNotification, object: nil) }
        }
      }
    }
    pathMonitor.start(queue: DispatchQueue(label: "com.scry.remote.path"))
  }

  func session(for connection: RemoteConnection, keychainService: String,
               executionTarget: G0Transport.ExecutionTargetBinding?,
               identity: @escaping @Sendable () throws -> G0ProbeIdentity,
               endpoint: () -> G0Transport.RelayEndpoint) -> RelaySession {
    let targetKey = executionTarget.map { "\($0.id):\($0.binding)" } ?? "local"
    let wanted = [connection.relayHost, String(connection.relayPort), connection.relayTLS, connection.hostId,
                  connection.deviceId, keychainService, connection.anchorPEM, targetKey].joined(separator: "\u{1f}")
    return lock.withLock {
      recentKeys.removeAll { $0 == wanted }
      recentKeys.append(wanted)
      if let existing = sessions[wanted] { return existing }
      if sessions.count >= Self.sessionLimit {
        let oldest = recentKeys.removeFirst()
        if let evicted = sessions.removeValue(forKey: oldest) {
          // Close cached tunnels only. Host tasks and their durable intents are
          // not cancelled; a later request reopens under the same binding.
          Task { await evicted.reset() }
        }
      }
      let session = RelaySession(endpoint: endpoint(), identity: identity, deviceLabel: RemoteDeviceModel.currentLabel)
      sessions[wanted] = session
      if foreground { Task { await session.setForeground(true) } }
      return session
    }
  }

  // Foreground keeps multiplexed tunnels warm with pings when they go silent;
  // background stops that and the caller resets (iOS suspends sockets).
  func setForeground(_ value: Bool) async {
    let current = lock.withLock { () -> [RelaySession] in
      foreground = value
      return Array(sessions.values)
    }
    for session in current { await session.setForeground(value) }
  }

  func probeAll() async -> Bool {
    let current = lock.withLock { Array(sessions.values) }
    var intact = true
    for session in current {
      let alive = await session.probe()
      if !alive { intact = false }
    }
    return intact
  }

  // Transport evidence for the self-test and diagnostics: capabilities, direct
  // routes and per-tunnel phase timings of every live session.
  func diagnostics() -> [RelaySessionDiagnostics] {
    lock.withLock { Array(sessions.values) }.map { $0.diagnostics() }
  }

  // Background / network path change: drop every lane; the next request reopens.
  // Target switches must not reset another target's live lane.
  func resetAll() async {
    let current = lock.withLock { Array(sessions.values) }
    for session in current { await session.reset() }
  }
}
