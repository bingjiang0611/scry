import Foundation
import RemoteTransport

#if DEBUG
// Opt-in NETWORK benchmark (`-netBench`) for the paired host, read-only. It
// measures what a user waits for, over the real pairing and route:
//   cold-open      DNS+TCP+TLS+relay/direct+inner mTLS for the control and bulk
//                  tunnels (prewarm), after dropping every tunnel
//   warm-request   one small authorized request on an already open tunnel
//   catalog        a full session-catalog walk, then a refresh the host can
//                  confirm as unchanged in one page
//   history        one complete session history download (compressed when the
//                  host supports it) and its verification
//   tunnels        per-tunnel phase timings, Cloudflare colo, relay leg wait,
//                  multiplexing and direct routes as the transport recorded them
// Options: -netBenchRounds=N (1...20, default 5), -netBenchRoute=auto|relay
// (relay disables direct routes for this run), -netBenchSession=<external id>.
// Every line is `NETBENCH <json>`; the last is {"event":"done","failures":n}.
// Durations are client wall-clock milliseconds on this device and network;
// nothing here is written to the host or uploaded.
extension RemoteSelfTest {
  static func runNetBenchIfRequested() {
    let args = ProcessInfo.processInfo.arguments
    guard args.contains("-netBench") else { return }
    func value(_ name: String) -> String? {
      args.first { $0.hasPrefix(name + "=") }.map { String($0.dropFirst(name.count + 1)) }
    }
    let rounds = max(1, min(20, Int(value("-netBenchRounds") ?? "") ?? 5))
    let route = value("-netBenchRoute") ?? "auto"
    let sessionFilter = value("-netBenchSession")
    Task { @MainActor in
      func emit(_ event: String, _ fields: [String: Any] = [:]) {
        var object = fields
        object["event"] = event
        guard JSONSerialization.isValidJSONObject(object),
              let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]),
              let line = String(data: data, encoding: .utf8) else { print("NETBENCH {\"event\":\"\(event)\",\"error\":\"unencodable\"}"); return }
        print("NETBENCH \(line)")
      }
      func elapsed(_ start: Date) -> Double { (Date().timeIntervalSince(start) * 10_000).rounded() / 10 }
      func percentile(_ values: [Double], _ p: Double) -> Any {
        guard !values.isEmpty else { return NSNull() }
        let sorted = values.sorted()
        return sorted[min(sorted.count - 1, Int((Double(sorted.count - 1) * p).rounded()))]
      }
      guard let connection = RemoteConnectionStore().load() else {
        emit("fail", ["reason": "no-persisted-connection"])
        exit(1)
      }
      if route == "relay" { HostTransportState.directRoutesEnabled.value = false }
      let registry = RemoteSessionRegistry.shared
      await registry.setForeground(true)
      // Let the path monitor publish the current route before the first open.
      try? await Task.sleep(nanoseconds: 600_000_000)
      emit("environment", ["route": route, "localNetwork": HostTransportState.localNetworkAvailable.value,
                           "relayHost": connection.relayHost, "rounds": rounds])
      let client = RemoteRunClient(connection: connection)
      var failures = 0
      var cold: [Double] = []
      var warm: [Double] = []
      for round in 1...rounds {
        await registry.resetAll()
        let start = Date()
        do {
          try await client.prewarm()
          cold.append(elapsed(start))
          emit("cold-open", ["round": round, "ms": elapsed(start)])
        } catch {
          failures += 1
          emit("cold-open", ["round": round, "ms": elapsed(start), "error": RemoteRunStore.describe(error)])
          continue
        }
        for _ in 0..<3 {
          let requestStart = Date()
          do {
            _ = try await client.projects()
            warm.append(elapsed(requestStart))
          } catch {
            failures += 1
            emit("warm-request", ["round": round, "ms": elapsed(requestStart), "error": RemoteRunStore.describe(error)])
          }
        }
      }
      var catalog: [G0Transport.RunSessionRef] = []
      for pass in ["full", "refresh"] {
        let start = Date()
        do {
          catalog = try await client.sessions()
          emit("catalog", ["pass": pass, "ms": elapsed(start), "sessions": catalog.count])
        } catch {
          failures += 1
          emit("catalog", ["pass": pass, "ms": elapsed(start), "error": RemoteRunStore.describe(error)])
        }
      }
      let target = catalog.first { ($0.externalSessionId ?? $0.sessionId) == sessionFilter } ??
        (sessionFilter == nil ? catalog.first { $0.externalSessionId != nil } : nil)
      if let target, let external = target.externalSessionId {
        let start = Date()
        do {
          let snapshot = try await client.withHistoryConnection { reader in
            try await client.historySnapshot(providerId: target.providerId, cwd: target.cwd, externalSessionId: external,
                                             connection: reader, agentProfileId: target.agentProfileId)
          }
          emit("history", ["ms": elapsed(start), "turns": snapshot.turns.count, "session": external])
        } catch {
          failures += 1
          emit("history", ["ms": elapsed(start), "session": external, "error": RemoteRunStore.describe(error)])
        }
      } else {
        emit("history", ["skipped": sessionFilter == nil ? "no-session-with-history" : "session-not-in-catalog"])
      }
      let encoder = JSONEncoder()
      encoder.dateEncodingStrategy = .iso8601
      for diagnostics in registry.diagnostics() {
        if let data = try? encoder.encode(diagnostics), let object = try? JSONSerialization.jsonObject(with: data) {
          emit("tunnels", ["diagnostics": object])
        }
      }
      emit("summary", ["coldMedianMs": percentile(cold, 0.5), "coldP90Ms": percentile(cold, 0.9),
                       "warmMedianMs": percentile(warm, 0.5), "warmP90Ms": percentile(warm, 0.9),
                       "coldSamples": cold.count, "warmSamples": warm.count])
      emit("done", ["failures": failures])
      exit(failures == 0 ? 0 : 1)
    }
  }
}
#endif
