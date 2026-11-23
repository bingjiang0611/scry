import Foundation
import CryptoKit
import UIKit
import RemoteTransport

#if DEBUG
extension RemoteSelfTest {
  // Opt-in NETWORK probe (`-relayTLSProbe <host>`): verifies that this device's
  // system trust store validates the relay's PUBLIC certificate via the `.system`
  // outer-TLS mode. Kept separate from the offline self-test because it needs
  // real internet and only exercises the outer hop (no host leg, no pairing).
  static func runRelayTLSProbeIfRequested() {
    let args = ProcessInfo.processInfo.arguments
    guard let i = args.firstIndex(of: "-relayTLSProbe"), i + 1 < args.count else { return }
    let host = args[i + 1]
    Task {
      do {
        let negotiated = try await G0Transport.probeSystemTLS(host: host)
        print("SELFTEST relayTLS.systemTrust PASS host=\(host) negotiated=\(negotiated)")
        print("SELFTEST DONE failures=0")
        exit(0)
      } catch {
        print("SELFTEST relayTLS.systemTrust FAIL host=\(host) error=\(error)")
        print("SELFTEST DONE failures=1")
        exit(1)
      }
    }
    // Dedicated probe launch: keep the process alive until the Task exits.
    RunLoop.current.run()
  }

  // Opt-in RUN-CHANNEL probe (`-runProbe`): using the persisted connection +
  // Keychain grant, submit an intent whose cwd is deliberately UNAUTHORIZED. The
  // host policy denies it BEFORE any Provider is spawned, so this exercises the
  // full device -> relay -> InnerMtlsHost -> HostController -> ledger loop with
  // the CA-granted device cert and NO Provider token cost. A run that fails
  // closed (run_failed) is the PASS condition; a settled run would be wrong.
  // Opt-in LIVE PROVIDER probe (`-liveProviderProbe`): selects a real
  // host-authorized project and available Provider, asks for a fixed response
  // without file changes, then requires a host-reported settled lifecycle.
  // failure can be attributed to the host build instead of to the network. It
  // reads one real session and never writes anything.
  static func runHistoryContractProbeIfRequested() {
    guard ProcessInfo.processInfo.arguments.contains("-historyContractProbe") else { return }
    func argumentValue(_ name: String) -> String? {
      guard let argument = ProcessInfo.processInfo.arguments.first(where: { $0.hasPrefix(name + "=") }) else { return nil }
      return String(argument.dropFirst(name.count + 1))
    }
    Task {
      guard let connection = RemoteConnectionStore().load() else {
        print("CONTRACTPROBE FAIL reason=no-persisted-connection")
        exit(1)
      }
      guard let provider = argumentValue("-provider"), let cwd = argumentValue("-cwd"),
            let external = argumentValue("-session") else {
        print("CONTRACTPROBE FAIL reason=missing-target")
        exit(1)
      }
      let client = RemoteRunClient(connection: connection)
      do {
        let catalog = try await client.sessions()
        let ref = catalog.first { $0.providerId == provider && $0.cwd == cwd && ($0.externalSessionId ?? $0.sessionId) == external }
        print("CONTRACTPROBE catalog sessions=\(catalog.count) profile=\(ref?.agentProfileId ?? "absent")")
        func attempt(_ name: String, _ body: () async throws -> String) async {
          let started = Date()
          do {
            let detail = try await body()
            print("CONTRACTPROBE \(name) OK ms=\(Int(Date().timeIntervalSince(started) * 1000)) \(detail)")
          } catch {
            print("CONTRACTPROBE \(name) FAIL ms=\(Int(Date().timeIntervalSince(started) * 1000)) error=\(error)")
          }
        }
        await attempt("scoped-preview-nil-profile") {
          let preview = try await client.historyPreview(providerId: provider, cwd: cwd, externalSessionId: external, agentProfileId: nil)
          return "status=\(preview.status) turns=\(preview.turns.count)"
        }
        if let profile = ref?.agentProfileId {
          await attempt("scoped-preview-catalog-profile") {
            let preview = try await client.historyPreview(providerId: provider, cwd: cwd, externalSessionId: external, agentProfileId: profile)
            return "status=\(preview.status) turns=\(preview.turns.count)"
          }
        }
        await attempt("scoped-turns-page") {
          let page = try await client.historyTurnsPage(providerId: provider, cwd: cwd, externalSessionId: external, before: nil, limit: 3, snapshot: nil, agentProfileId: ref?.agentProfileId)
          return "turns=\(page.turns.count) total=\(page.totalTurns) source=\(page.source)"
        }
        print("CONTRACTPROBE DONE")
        exit(0)
      } catch {
        print("CONTRACTPROBE FAIL error=\(error)")
        exit(1)
      }
    }
    RunLoop.current.run()
  }

  // Opt-in real catalog/history probe. It verifies that the paired device can
  // read host session metadata and one authentic archived conversation.
  static func runSessionReadProbeIfRequested() {
    guard ProcessInfo.processInfo.arguments.contains("-sessionReadProbe") else { return }
    func argumentValue(_ name: String) -> String? {
      guard let argument = ProcessInfo.processInfo.arguments.first(where: { $0.hasPrefix(name + "=") }) else { return nil }
      return String(argument.dropFirst(name.count + 1))
    }
    Task {
      guard let connection = RemoteConnectionStore().load() else {
        print("SESSIONPROBE FAIL reason=no-persisted-connection")
        exit(1)
      }
      let client = RemoteRunClient(connection: connection)
      do {
        print("SESSIONPROBE stage=catalog")
        let sessions = try await client.sessions()
        guard let provider = argumentValue("-sessionReadProbeProvider"), let cwd = argumentValue("-sessionReadProbeCwd"),
              let external = argumentValue("-sessionReadProbeSession"),
              let session = sessions.first(where: { $0.providerId == provider && $0.cwd == cwd && $0.externalSessionId == external }) else {
          print("SESSIONPROBE DONE failures=0 reason=explicit-target-not-in-authenticated-catalog")
          exit(0)
        }
        let previewStarted = Date()
        print("SESSIONPROBE stage=history-connection")
        let (preview, previewMs, snapshot, firstPageMs, fullBytes, verifyMs) = try await client.withHistoryConnection { reader in
          print("SESSIONPROBE stage=preview")
          let preview = try await reader.preview(providerId: session.providerId, cwd: session.cwd, externalSessionId: external)
          let previewMs = Date().timeIntervalSince(previewStarted) * 1000
          let fullStarted = Date()
          let timing = SessionPageTiming(started: fullStarted)
          print("SESSIONPROBE stage=full-history previewMs=\(previewMs) status=\(preview.status)")
          let snapshot = try await client.historySnapshot(providerId: session.providerId, cwd: session.cwd,
            externalSessionId: external, connection: reader, progress: { received, total in await timing.received(received: received, total: total) })
          return (preview, previewMs, snapshot, await timing.firstPageMs, await timing.totalBytes, Date().timeIntervalSince(fullStarted) * 1000)
        }
        print("SESSIONPROBE target provider=\(provider) cwd=\(cwd) session=\(external) previewMs=\(String(format: "%.1f", previewMs)) previewBytes=\(preview.bytes ?? 0) firstFullPageMs=\(String(format: "%.1f", firstPageMs ?? verifyMs)) fullVerificationMs=\(String(format: "%.1f", verifyMs)) fullBytes=\(fullBytes.map(String.init) ?? "unavailable") turns=\(snapshot.turns.count) status=\(preview.status)")
        print("SESSIONPROBE DONE failures=0")
        exit(0)
      } catch {
        print("SESSIONPROBE FAIL error=\(error)")
        print("SESSIONPROBE DONE failures=1")
        exit(1)
      }
    }
  }

  private actor SessionPageTiming {
    let started: Date
    var firstPageMs: Double?
    var totalBytes: Int?
    var reportedBytes = 0
    init(started: Date) { self.started = started }
    func received(received: Int, total: Int) {
      let elapsed = Date().timeIntervalSince(started) * 1000
      totalBytes = total
      if firstPageMs == nil { firstPageMs = elapsed }
      if reportedBytes == 0 || received - reportedBytes >= 1_048_576 || received == total {
        print("SESSIONPROBE stage=full-progress bytes=\(received) total=\(total) elapsedMs=\(elapsed)")
        reportedBytes = received
      }
    }
  }

  // Opt-in REAL DIRECTORY + ATTACHMENT probe (`-directoryAttachmentProbe`):
  // browses host-authorized roots, selects a real canonical descendant, verifies
  // an unauthorized absolute path fails closed, reports the Provider's actual
  // run-control catalog, and sends bounded text + image attachments to a live
}
#endif
