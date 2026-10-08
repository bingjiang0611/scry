import Foundation
import CryptoKit
import RemoteTransport

// DEBUG-only, launch-argument driven (`-selfTest`) runtime verification of the
// device-side protocol/crypto/storage that needs NO network: real P-256 CSR
// generation + restore, pairing-code parsing (valid + tampered), and a Keychain
// round-trip. It is NOT a substitute for on-device pairing against a live relay
// and host, and it never claims a paired state. It prints machine-checkable
// lines and exits non-zero on the first failure so a simulator run can assert.
#if DEBUG
enum RemoteSelfTest {
  @MainActor static func runIfRequested() {
    guard ProcessInfo.processInfo.arguments.contains("-selfTest") else { return }
    var failures = 0
    func check(_ name: String, _ ok: Bool) {
      print("SELFTEST \(name) \(ok ? "PASS" : "FAIL")")
      if !ok { failures += 1 }
    }

    // 1. Enrollment: a real CSR + self-signed bootstrap cert, and a byte-exact
    //    restore of the same key material.
    do {
      let material = try G0EnrollmentMaterial.generate()
      let csr = String(decoding: material.csrPEM, as: UTF8.self)
      let bootstrap = String(decoding: material.bootstrapPEM, as: UTF8.self)
      check("enrollment.csr", csr.contains("BEGIN CERTIFICATE REQUEST"))
      check("enrollment.bootstrap", bootstrap.contains("BEGIN CERTIFICATE"))
      check("enrollment.fingerprint", material.publicKeySHA256.count == 64)
      let restored = try G0EnrollmentMaterial.restore(privateKeyPEM: material.privateKeyPEM)
      check("enrollment.restore", restored.publicKeySHA256 == material.publicKeySHA256)
    } catch { check("enrollment", false); print("  error: \(error)") }

    // 2. Pairing code: a well-formed code parses to the exact fields; tampered
    //    variants are rejected field-by-field (fail closed).
    do {
      let anchor = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n"
      let json: [String: Any] = ["relayHost": "relay.example.com", "relayPort": 443,
        "hostId": "c110921f-ba1f-45dd-9774-db10d5f3848f", "pairingId": "5afb2a38-425a-46a3-b004-ef62ce44bb9a",
        "secret": "SLb_kXYTlqzucIe3pQTo6FFtPE0JW4OWR1tP2CqT6eI", "anchorPEM": anchor]
      let data = try JSONSerialization.data(withJSONObject: json)
      let code = "scry1:" + PairingCode.base64urlEncode(data)
      let parsed = try PairingCode.parse(code)
      check("code.parse", parsed.relayHost == "relay.example.com" && parsed.relayPort == 443 && parsed.anchorPEM.contains("BEGIN CERTIFICATE"))
      // Absent relayTLS defaults to the secure public-wss mode (fail-safe).
      check("code.tlsDefaultSystem", parsed.relayTLS == .system)
      check("code.badPrefix", (try? PairingCode.parse("nope:" + PairingCode.base64urlEncode(data))) == nil)
      check("code.badBase64", (try? PairingCode.parse("scry1:!!!not-base64!!!")) == nil)
      var bad = json; bad["secret"] = "too-short"
      let badData = try JSONSerialization.data(withJSONObject: bad)
      check("code.badSecret", (try? PairingCode.parse("scry1:" + PairingCode.base64urlEncode(badData))) == nil)
      // A local dev relay must explicitly opt into plaintext ws.
      var plain = json; plain["relayTLS"] = "plaintext"
      let plainData = try JSONSerialization.data(withJSONObject: plain)
      check("code.tlsPlaintext", (try PairingCode.parse("scry1:" + PairingCode.base64urlEncode(plainData))).relayTLS == .plaintext)
      // An unknown relayTLS value is rejected, never silently downgraded.
      var badTLS = json; badTLS["relayTLS"] = "weird"
      let badTLSData = try JSONSerialization.data(withJSONObject: badTLS)
      check("code.badTLS", (try? PairingCode.parse("scry1:" + PairingCode.base64urlEncode(badTLSData))) == nil)
    } catch { check("code", false); print("  error: \(error)") }

    // 3. Run state: stale generation/session callbacks are rejected, submitting
    //    is distinct from recorded, and output drain is not capped at 600 polls.
    check("run.recoveryCheckpointRoundTrip", RemoteRunStore.selfTestRecoveryCheckpointRoundTrip())
    check("run.generationSessionIsolation", RemoteRunStore.selfTestGenerationIsolation())
    check("run.followUpIdentityStable", RemoteRunStore.selfTestFollowUpIdentity())
    check("run.submittingIsNotRecorded", RemoteRunStore.Lifecycle.submitting != .recorded)
    check("run.stateGates", RemoteRunStore.selfTestStateGates())
    for (name, passed) in RemoteRunStore.selfTestInteractionState() { check("run.\(name)", passed) }
    let model = AppModel()
    let identity = RemoteRunStore.SessionIdentity.new(providerId: "codex", cwd: "/fixture")
    let draft = model.composerDraft(for: .conversation(identity))
    draft.wrappedValue.text = "unsent"
    draft.wrappedValue.attachments = [.init(kind: .text, name: "fixture.txt", mimeType: "text/plain", data: Data("safe".utf8))]
    model.route = .settings; model.route = .chat
    check("draft.navigationKeepsTextAndAttachment", draft.wrappedValue.text == "unsent" && draft.wrappedValue.attachments.count == 1)
    model.bindDraft(externalSessionId: "external", to: identity)
    let reopened = model.composerDraft(for: .conversation(.opened(providerId: "codex", cwd: "/fixture", externalSessionId: "external")))
    check("draft.localToCatalogIdentity", reopened.wrappedValue.text == "unsent" && reopened.wrappedValue.attachments.count == 1)
    check("draft.newTaskIsolated", model.composerDraft(for: .newTask).wrappedValue.text.isEmpty)
    let profileA = G0Transport.RunProviderRef(id: "pi", label: "Pi", available: true, agentProfileId: "pi:a")
    let profileB = G0Transport.RunProviderRef(id: "pi", label: "Pi", available: true, agentProfileId: "pi:b")
    check("provider.profileRowIdentity", profileA.selectionId != profileB.selectionId)
    check("run.drainBeyond400", RemoteRunStore.selfTestDrain(cursor: 400, next: 401, chunkCount: 401))

    // 4. Keychain: insert-only device key + upsertable grant round-trip in an
    //    isolated test service, then cleaned up. An UNSIGNED simulator build has
    //    no keychain-access-group entitlement (errSecMissingEntitlement -34018),
    //    so this is honestly SKIPPED there rather than faked; it is exercised on
    //    a signed device build.
    do {
      let keychain = RemoteKeychain(service: "com.scry.remote.selftest")
      try? keychain.remove(.deviceKey); try? keychain.remove(.grantedCert)
      let key = Data("-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n".utf8)
      do { try keychain.insertDeviceKey(key) }
      catch let f as RemoteKeychain.Failure where f.status == -34018 {
        print("SELFTEST keychain SKIP env=unsigned-simulator-missing-entitlement")
        print("SELFTEST DONE failures=\(failures)")
        exit(failures == 0 ? 0 : 1)
      }
      let loaded = try keychain.load(.deviceKey)
      check("keychain.deviceKey", loaded == key)
      var duplicated = false
      do { try keychain.insertDeviceKey(Data("other".utf8)) } catch let f as RemoteKeychain.Failure where f.isDuplicate { duplicated = true } catch {}
      let afterDup = try keychain.load(.deviceKey)
      check("keychain.insertOnly", duplicated && afterDup == key)
      let cert = Data("cert-v1".utf8)
      try keychain.upsertGrantedCert(cert)
      let grant1 = try keychain.load(.grantedCert)
      check("keychain.grant", grant1 == cert)
      try keychain.upsertGrantedCert(Data("cert-v2".utf8))
      let grant2 = try keychain.load(.grantedCert)
      check("keychain.grantRenew", grant2 == Data("cert-v2".utf8))
      try keychain.clearAll()
      let clearedKey = try keychain.load(.deviceKey)
      let clearedCert = try keychain.load(.grantedCert)
      check("keychain.destructiveClear", clearedKey == nil && clearedCert == nil)
    } catch { check("keychain", false); print("  error: \(error)") }

    print("SELFTEST DONE failures=\(failures)")
    exit(failures == 0 ? 0 : 1)
  }

  // Disk/network-assembly fixture: isolated temporary directory, no relay,
  // no real Keychain/grant and no Provider execution.
  @MainActor static func runHistoryCacheTestIfRequested() {
    guard ProcessInfo.processInfo.arguments.contains("-historyCacheTest") else { return }
    Task {
      var failures = 0
      func check(_ name: String, _ ok: Bool) {
        print("HISTORYTEST \(name) \(ok ? "PASS" : "FAIL")")
        if !ok { failures += 1 }
      }
      let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
      do {
        let turns = [G0Transport.RunHistoryTurn(userText: "fixture", items: [
          .init(kind: "output", text: String(repeating: "a", count: 150_000))])]
        let bytes = try JSONEncoder().encode(turns)
        let fixture = HistoryPages(bytes: bytes)
        let snapshot = try await RemoteRunClient.downloadHistory(cached: nil, fetch: { cursor, hash in
          try await fixture.page(cursor, hash: hash)
        })
        check("completeOrderedDownload", snapshot.turns == turns)
        let order = await fixture.completed
        check("outOfOrderPages", order == [0, 131072, 65536])
        let unchanged = HistoryPages(bytes: bytes)
        let same = try await RemoteRunClient.downloadHistory(cached: snapshot, fetch: { cursor, hash in
          try await unchanged.page(cursor, hash: hash)
        })
        check("unchangedOnlyOneRequest", await unchanged.completed == [0] && same.turns == turns)
        let damaged = HistoryPages(bytes: bytes, badHash: true)
        do {
          _ = try await RemoteRunClient.downloadHistory(cached: nil, fetch: { cursor, hash in
            try await damaged.page(cursor, hash: hash)
          }); check("rejectBadDigest", false)
        } catch { check("rejectBadDigest", true) }
        let wrongCursor = HistoryPages(bytes: Data("[]".utf8), badCursor: true)
        do {
          _ = try await RemoteRunClient.downloadHistory(cached: nil, fetch: { cursor, hash in
            try await wrongCursor.page(cursor, hash: hash)
          }); check("rejectBadCursor", false)
        } catch { check("rejectBadCursor", true) }

        var connection = RemoteConnection(relayHost: "fixture", relayPort: 443, relayTLS: "system",
          hostId: "host-a", anchorPEM: "anchor-a", deviceId: "grant-a")
        let key = RemoteHistoryCache.key(connection: connection, providerId: "pi", cwd: "/fixture", sessionId: "same")
        connection.hostId = "host-b"
        check("hostIsolation", key != RemoteHistoryCache.key(connection: connection, providerId: "pi", cwd: "/fixture", sessionId: "same"))
        connection.hostId = "host-a"; connection.deviceId = "grant-b"
        check("grantIsolation", key != RemoteHistoryCache.key(connection: connection, providerId: "pi", cwd: "/fixture", sessionId: "same"))
        connection.deviceId = "grant-a"; connection.anchorPEM = "anchor-b"
        check("anchorIsolation", key != RemoteHistoryCache.key(connection: connection, providerId: "pi", cwd: "/fixture", sessionId: "same"))
        let cache = RemoteHistoryCache(directory: root, byteLimit: 1_000_000, entryLimit: 2)
        let epoch = await cache.epoch
        check("save", try await cache.write(snapshot, key: key, epoch: epoch))
        let restarted = RemoteHistoryCache(directory: root, byteLimit: 1_000_000, entryLimit: 2)
        let readStarted = Date()
        let saved = try await restarted.read(key)
        print("HISTORYTEST diskRead bytes=\(bytes.count) milliseconds=\(Date().timeIntervalSince(readStarted) * 1000)")
        check("restartLoadsSameHistory", saved?.turns == turns && saved?.fetchedAt == snapshot.fetchedAt)
        let file = await cache.fileURL(key)
        let attrs = try FileManager.default.attributesOfItem(atPath: file.path)
        #if targetEnvironment(simulator)
        // Simulator returned no protection attribute on both initial runs;
        // only the physical device can verify the iOS Data Protection class.
        print("HISTORYTEST completeDataProtection SKIP env=simulator attribute=\(String(describing: attrs[.protectionKey]))")
        #else
        check("completeDataProtection", attrs[.protectionKey] as? String == FileProtectionType.complete.rawValue)
        #endif
        check("excludedFromBackup", try root.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup == true)
        try Data("corrupt".utf8).write(to: file)
        do { _ = try await cache.read(key); check("rejectCorruptCache", false) }
        catch { check("rejectCorruptCache", true) }
        try await cache.clear()
        check("lateWriteRejected", try await !cache.write(snapshot, key: key, epoch: epoch))
        check("clearPersists", try await restarted.read(key) == nil)
        let newEpoch = await cache.epoch
        for key in ["a", "b", "c"] { _ = try await cache.write(snapshot, key: key, epoch: newEpoch) }
        check("boundedEntryCount", try FileManager.default.contentsOfDirectory(atPath: root.path).count == 2)
        let small = RemoteHistoryCache(directory: root.appendingPathComponent("small"), byteLimit: 100)
        check("oversizeNotClaimedSaved", try await !small.write(snapshot, key: "large", epoch: 0))
        for (name, passed) in try await RemoteRunStore.selfTestHistoryStore(directory: root.appendingPathComponent("store"), snapshot: snapshot) {
          check(name, passed)
        }
      } catch { check("unexpected", false); print(error) }
      do { try FileManager.default.removeItem(at: root) }
      catch { check("cleanup", false); print(error) }
      print("HISTORYTEST DONE failures=\(failures)")
      exit(failures == 0 ? 0 : 1)
    }
  }

  private actor HistoryPages {
    let bytes: Data
    let hash: String
    let badCursor: Bool
    var waiting: CheckedContinuation<Void, Never>?
    var completed: [Int] = []
    init(bytes: Data, badHash: Bool = false, badCursor: Bool = false) {
      self.bytes = bytes
      hash = badHash ? String(repeating: "0", count: 64) : SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
      self.badCursor = badCursor
    }
    func page(_ cursor: Int, hash requested: String?) async throws -> G0Transport.RunHistoryPage {
      if cursor == 65536 && !completed.contains(131072) { await withCheckedContinuation { waiting = $0 } }
      if cursor == 131072 { waiting?.resume(); waiting = nil }
      completed.append(cursor)
      let end = min(bytes.count, cursor + 65536)
      let wire: [String: Any] = ["dataBase64": bytes.subdata(in: cursor..<end).base64EncodedString(),
        "cursor": badCursor ? end + 1 : end, "totalBytes": bytes.count, "hasMore": end < bytes.count, "snapshot": hash]
      return try JSONDecoder().decode(G0Transport.RunHistoryPage.self, from: JSONSerialization.data(withJSONObject: wire))
    }
  }

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
  static func runLiveProviderProbeIfRequested() {
    guard ProcessInfo.processInfo.arguments.contains("-liveProviderProbe") else { return }
    Task {
      guard let connection = RemoteConnectionStore().load() else {
        print("LIVEPROBE FAIL reason=no-persisted-connection")
        exit(1)
      }
      let client = RemoteRunClient(connection: connection)
      do {
        let projects = try await client.projects()
        let providers = try await client.providers()
        let preferred = ["codex", "qoder", "opencode"]
        let provider = preferred.compactMap { id in providers.first(where: { $0.id == id && $0.available }) }.first
          ?? providers.first(where: { $0.available })
        guard let project = projects.first, let provider else {
          print("LIVEPROBE FAIL reason=no-authorized-project-or-provider projects=\(projects.count) providers=\(providers.count)")
          exit(1)
        }
        print("LIVEPROBE selected cwd=\(project.path) provider=\(provider.id)")
        let routing = RemoteRunClient.Routing(cwd: project.path, providerId: provider.id, agentProfileId: nil,
          prompt: "只回复 SCRY_REMOTE_OK，不要调用工具，不要修改任何文件。")
        let submit = try await client.submit(routing: routing)
        print("LIVEPROBE submit runId=\(submit.runId) status=\(submit.status)")
        var cursor = 0
        var terminal: String? = nil
        for _ in 0..<120 {
          let page = try await client.poll(cursor: cursor)
          cursor = page.cursor
          for event in page.events where event.runId == submit.runId {
            print("LIVEPROBE event kind=\(event.kind) detail=\(event.detail ?? "")")
            if ["run_settled", "run_failed", "run_cancelled"].contains(event.kind) { terminal = event.kind }
          }
          if terminal != nil { break }
          try await Task.sleep(nanoseconds: 1_000_000_000)
        }
        let ok = terminal == "run_settled"
        print("LIVEPROBE terminal=\(terminal ?? "none") expected=run_settled \(ok ? "PASS" : "FAIL")")
        print("LIVEPROBE DONE failures=\(ok ? 0 : 1)")
        exit(ok ? 0 : 1)
      } catch {
        print("LIVEPROBE FAIL error=\(error)")
        print("LIVEPROBE DONE failures=1")
        exit(1)
      }
    }
    RunLoop.current.run()
  }

  // Opt-in real catalog/history probe. It verifies that the paired device can
  // read host session metadata and one authentic archived conversation.
  static func runSessionReadProbeIfRequested() {
    guard ProcessInfo.processInfo.arguments.contains("-sessionReadProbe") else { return }
    Task {
      guard let connection = RemoteConnectionStore().load() else {
        print("SESSIONPROBE FAIL reason=no-persisted-connection")
        exit(1)
      }
      let client = RemoteRunClient(connection: connection)
      do {
        let sessions = try await client.sessions()
        print("SESSIONPROBE catalog PASS count=\(sessions.count)")
        guard let session = sessions.first(where: { $0.externalSessionId != nil }),
              let externalSessionId = session.externalSessionId else {
          print("SESSIONPROBE DONE failures=0 reason=no-readable-session")
          exit(0)
        }
        let history = try await client.history(providerId: session.providerId, cwd: session.cwd, externalSessionId: externalSessionId)
        let bytes = history.reduce(0) { total, turn in
          total + turn.userText.utf8.count + turn.items.reduce(0) { $0 + $1.text.utf8.count }
        }
        print("SESSIONPROBE history PASS session=\(externalSessionId) provider=\(session.providerId) turns=\(history.count) textBytes=\(bytes)")
        print("SESSIONPROBE DONE failures=0")
        exit(0)
      } catch {
        print("SESSIONPROBE FAIL error=\(error)")
        print("SESSIONPROBE DONE failures=1")
        exit(1)
      }
    }
  }

  // Opt-in REAL DIRECTORY + ATTACHMENT probe (`-directoryAttachmentProbe`):
  // browses host-authorized roots, selects a real canonical descendant, verifies
  // an unauthorized absolute path fails closed, reports the Provider's actual
  // run-control catalog, and sends bounded text + image attachments to a live
  // Provider. This remains DEBUG-only and never selects full_access.
  static func runDirectoryAttachmentProbeIfRequested() {
    let args = ProcessInfo.processInfo.arguments
    let catalogOnly = args.contains("-directoryCatalogProbe")
    guard catalogOnly || args.contains("-directoryAttachmentProbe") else { return }
    Task {
      guard let connection = RemoteConnectionStore().load() else {
        print("DIRATTACH FAIL reason=no-persisted-connection")
        exit(1)
      }
      let client = RemoteRunClient(connection: connection)
      do {
        let roots = try await client.directories(path: nil).directories
        var selectedRoot: G0Transport.RunProjectRef?
        var selectedChild: G0Transport.RunProjectRef?
        for root in roots {
          let listing = try await client.directories(path: root.path)
          if let child = listing.directories.first {
            selectedRoot = root
            selectedChild = child
            break
          }
        }
        guard let root = selectedRoot, let child = selectedChild else {
          print("DIRATTACH FAIL reason=no-descendant roots=\(roots.count)")
          exit(1)
        }
        print("DIRATTACH descendant root=\(root.path) child=\(child.path)")

        if catalogOnly {
          let childListing = try await client.directories(path: child.path)
          guard childListing.current?.path == child.path, childListing.parent?.path == root.path else {
            print("DIRATTACH FAIL reason=hierarchy-mismatch root=\(root.path) child=\(child.path)")
            exit(1)
          }
          print("DIRATTACH hierarchy PASS parent=\(childListing.parent?.path ?? "none")")
          do {
            _ = try await client.directories(path: "/")
            print("DIRATTACH unauthorized FAIL path=/ unexpectedly-listed")
            exit(1)
          } catch G0Transport.RunError.host(let code) where code == "workspace_not_authorized" {
            print("DIRATTACH unauthorized PASS error=\(code)")
          }
        }

        let providers = try await client.providers()
        let provider = providers.first(where: { $0.id == "codex" && $0.available })
          ?? providers.first(where: { $0.available })
        guard let provider else {
          print("DIRATTACH FAIL reason=no-available-provider")
          exit(1)
        }
        let effortCatalog = (provider.efforts ?? []).map { "\($0.id):\($0.isDefault == true ? "default" : "option")" }.joined(separator: ",")
        let permissionCatalog = (provider.permissions ?? []).map { "\($0.id):\($0.isDefault == true ? "default" : "option")" }.joined(separator: ",")
        print("DIRATTACH catalog provider=\(provider.id) model=\(provider.modelId ?? "native-default") efforts=[\(effortCatalog)] permissions=[\(permissionCatalog)]")
        if catalogOnly {
          print("DIRATTACH CATALOG DONE failures=0")
          exit(0)
        }

        let textData = Data("verification marker: SCRY_DESCENDANT_ATTACHMENT_OK\n".utf8)
        guard let imageData = Data(base64Encoded: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=") else {
          print("DIRATTACH FAIL reason=image-fixture")
          exit(1)
        }
        let attachments = [
          RemoteRunClient.Attachment(kind: .text, name: "scry-probe.txt", mimeType: "text/plain", dataBase64: textData.base64EncodedString(), size: textData.count),
          RemoteRunClient.Attachment(kind: .image, name: "scry-probe.png", mimeType: "image/png", dataBase64: imageData.base64EncodedString(), size: imageData.count)
        ]
        let effort = provider.efforts?.first(where: { $0.isDefault == true })?.id
        let permission = provider.permissions?.first(where: { $0.id == "default" })?.id
        let routing = RemoteRunClient.Routing(cwd: child.path, providerId: provider.id, agentProfileId: nil,
          prompt: "读取随附文本，并只回复 SCRY_DESCENDANT_ATTACHMENT_OK；图片无需描述；不要调用工具，不要修改文件。",
          modelId: provider.modelId, effort: effort, permissionMode: permission, attachments: attachments)
        let submit = try await client.submit(routing: routing)
        print("DIRATTACH submit runId=\(submit.runId) status=\(submit.status) cwd=\(child.path) attachments=\(attachments.count) effort=\(effort ?? "native-default") permission=\(permission ?? "native-default")")
        var cursor = 0
        var terminal: String?
        for _ in 0..<180 {
          let page = try await client.poll(cursor: cursor)
          cursor = page.cursor
          for event in page.events where event.runId == submit.runId {
            print("DIRATTACH event kind=\(event.kind) detail=\(event.detail ?? "")")
            if ["run_settled", "run_failed", "run_cancelled"].contains(event.kind) { terminal = event.kind }
          }
          if terminal != nil { break }
          try await Task.sleep(nanoseconds: 1_000_000_000)
        }
        let output = try await client.output(runId: submit.runId, cursor: 0)
        let reply = output.chunks.map(\.text).joined()
        let ok = terminal == "run_settled" && reply.contains("SCRY_DESCENDANT_ATTACHMENT_OK")
        print("DIRATTACH output=\(reply)")
        print("DIRATTACH terminal=\(terminal ?? "none") expected=run_settled replyMarker=\(reply.contains("SCRY_DESCENDANT_ATTACHMENT_OK")) \(ok ? "PASS" : "FAIL")")
        print("DIRATTACH DONE failures=\(ok ? 0 : 1)")
        exit(ok ? 0 : 1)
      } catch {
        print("DIRATTACH FAIL error=\(error)")
        print("DIRATTACH DONE failures=1")
        exit(1)
      }
    }
    // Return from App.init so iOS can finish launching; this probe spans several
    // real relay exchanges plus a Provider turn and must not trip the launch
    // watchdog. The unstructured task exits with a machine-checkable result.
  }

  static func runRunProbeIfRequested() {
    guard ProcessInfo.processInfo.arguments.contains("-runProbe") else { return }
    Task {
      guard let connection = RemoteConnectionStore().load() else {
        print("RUNPROBE SKIP reason=no-persisted-connection (pair on this build first)")
        print("RUNPROBE DONE failures=0")
        exit(0)
      }
      let client = RemoteRunClient(connection: connection)
      do {
        let routing = RemoteRunClient.Routing(cwd: "/scry-run-probe-unauthorized", providerId: "claude", agentProfileId: nil, prompt: "probe")
        let submit = try await client.submit(routing: routing)
        print("RUNPROBE submit runId=\(submit.runId) status=\(submit.status)")
        var cursor = 0
        var terminal: String? = nil
        for _ in 0..<20 {
          let page = try await client.poll(cursor: cursor)
          cursor = page.cursor
          for e in page.events where e.runId == submit.runId {
            print("RUNPROBE event kind=\(e.kind) detail=\(e.detail ?? "")")
            if ["run_settled", "run_failed", "run_cancelled"].contains(e.kind) { terminal = e.kind }
          }
          if terminal != nil { break }
          try await Task.sleep(nanoseconds: 500_000_000)
        }
        let ok = terminal == "run_failed"
        print("RUNPROBE terminal=\(terminal ?? "none") expected=run_failed \(ok ? "PASS" : "FAIL")")
        print("RUNPROBE DONE failures=\(ok ? 0 : 1)")
        exit(ok ? 0 : 1)
      } catch {
        print("RUNPROBE FAIL error=\(error)")
        print("RUNPROBE DONE failures=1")
        exit(1)
      }
    }
    RunLoop.current.run()
  }
}
#endif
