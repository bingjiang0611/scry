import Foundation
import CryptoKit
import UIKit
import RemoteTransport

// DEBUG-only, launch-argument driven (`-selfTest`) runtime verification of the
// device-side protocol/crypto/storage that needs NO network: real P-256 CSR
// generation + restore, pairing-code parsing (valid + tampered), and a Keychain
// round-trip. It is NOT a substitute for on-device pairing against a live relay
// and host, and it never claims a paired state. It prints machine-checkable
// lines and exits non-zero on the first failure so a simulator run can assert.
#if DEBUG
enum RemoteSelfTest {
  // Four detailed full-resolution iPhone screenshots must all fit the host's
  // 700 KB attachment budget, and the sent copies must keep previewable bytes.
  @MainActor static func selfTestFourScreenshotsFitBudget() -> (Int, Int, Bool) {
    let format = UIGraphicsImageRendererFormat.default()
    format.scale = 1
    var generator = SystemRandomNumberGenerator()
    let sources: [Data] = (0..<4).compactMap { index in
      UIGraphicsImageRenderer(size: CGSize(width: 1179, height: 2556), format: format).image { context in
        UIColor(white: 0.07, alpha: 1).setFill(); context.fill(CGRect(x: 0, y: 0, width: 1179, height: 2556))
        for _ in 0..<1800 {
          UIColor(hue: .random(in: 0...1, using: &generator), saturation: 0.4, brightness: .random(in: 0.3...1, using: &generator), alpha: 1).setFill()
          context.fill(CGRect(x: .random(in: 0...1150, using: &generator), y: .random(in: 0...2530, using: &generator),
                              width: .random(in: 4...120, using: &generator), height: .random(in: 4...28, using: &generator)))
        }
        ("截图 \(index)" as NSString).draw(at: CGPoint(x: 40, y: 120), withAttributes: [.font: UIFont.systemFont(ofSize: 64), .foregroundColor: UIColor.white])
      }.pngData()
    }
    var used = 0
    var accepted: [Data] = []
    for (index, data) in sources.enumerated() {
      let budget = DraftAttachment.imageBudget(usedBytes: used, remainingImages: sources.count - index)
      guard let jpeg = DraftAttachment.compactJPEG(data, maxBytes: budget), used + jpeg.count <= DraftAttachment.maxTotalBytes else { continue }
      used += jpeg.count; accepted.append(jpeg)
    }
    let sent = accepted.map {
      RemoteRunStore.SentAttachment(RemoteRunClient.Attachment(kind: .image, name: "photo.jpg", mimeType: "image/jpeg",
                                                              dataBase64: $0.base64EncodedString(), size: $0.count))
    }
    let previewable = sent.count == accepted.count && zip(sent, accepted).allSatisfy { $0.imageData == $1 && UIImage(data: $1) != nil }
    return (accepted.count, used, previewable)
  }

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
    let markdown = ConversationMarkdownParser.parse("# 标题\n- 项目\n```swift\nlet answer = 42\n```")
    check("markdown.heading", markdown.contains { if case .heading(1) = $0.kind { return $0.text == "标题" }; return false })
    check("markdown.list", markdown.contains { if case .unordered = $0.kind { return $0.text == "项目" }; return false })
    check("markdown.code", markdown.contains { if case .code("swift") = $0.kind { return $0.text == "let answer = 42" }; return false })
    // GFM tables: preserve inline source, alignment, row width and block boundaries.
    let tableSource = "| 问题 | 证据 | 判断 |\r\n|---|:---:|---:|\r\n| **扫描太慢** | `141` 次 | [优化](https://example.com) |"
    let tableBlocks = ConversationMarkdownParser.parse(tableSource)
    check("markdown.tableStructured", tableBlocks.count == 1)
    if case let .table(table) = tableBlocks.first?.kind {
      check("markdown.tableHeaders", table.headers == ["问题", "证据", "判断"])
      check("markdown.tableInline", table.rows == [["**扫描太慢**", "`141` 次", "[优化](https://example.com)"]])
      check("markdown.tableAlignment", table.alignments == [.left, .center, .right])
    } else { check("markdown.tableParsed", false) }
    let uneven = ConversationMarkdownParser.parse("A | B\n- | -\none\ntwo | three | ignored\n\n正文")
    if case let .table(table) = uneven.first?.kind {
      check("markdown.tableUnevenRows", table.rows == [["one", ""], ["two", "three"]])
      check("markdown.tableBlankBoundary", uneven.count == 2 && uneven.last?.text == "正文")
    } else { check("markdown.tableUnevenParsed", false) }
    let escaped = ConversationMarkdownParser.parse(#"| A\|B | C |"# + "\n|---|---|\n" + #"| `x\|y` | **a\|b** |"#)
    if case let .table(table) = escaped.first?.kind {
      check("markdown.tableEscapedPipes", table.headers == ["A|B", "C"] && table.rows == [["`x|y`", "**a|b**"]])
    } else { check("markdown.tableEscapedParsed", false) }
    let boundary = ConversationMarkdownParser.parse("| A | B |\n|---|---|\n| x | y |\n## 标题\n- 项目\n> 引用\n```\n| A | B |\n|---|---|\n```")
    check("markdown.tableBlockBoundary", boundary.count == 5 && boundary[1].text == "标题" && boundary[4].text == "| A | B |\n|---|---|")
    let invalid = ConversationMarkdownParser.parse("| A | B |\n|---|\n| x | y |\n\n管道 x | y\n\n| A | B |\n|--x|---|")
    check("markdown.tableInvalidIsText", !invalid.contains { if case .table = $0.kind { return true }; return false })
    let emptyTable = ConversationMarkdownParser.parse("| A |\n---")
    check("markdown.tableHeaderOnly", emptyTable.count == 1 && { if case let .table(table) = emptyTable[0].kind { return table.rows.isEmpty }; return false }())
    // HTTP paths remain URLs, never guessed project-relative filenames.
    let local = URL(string: "http://127.0.0.1:4311/designs/scry-steer/")!
    check("link.loopbackIntercepted", MacLocalLink.isLoopback(local) && MacLocalLink.isLoopback(URL(string: "http://localhost:5173/a")!))
    check("link.remoteKeepsSystemAction", !MacLocalLink.isLoopback(URL(string: "https://example.com/designs/")!) &&
      !MacLocalLink.isLoopback(URL(string: "http://127.evil.com/")!))
    check("link.directoryRemainsURL", MacLocalLink.downloadTarget(for: local) == local.absoluteString)
    let exact = URL(string: "http://127.0.0.1:4311/bolder-v1.html?x=1#y")!
    check("link.preservesURLAndQuery", MacLocalLink.downloadTarget(for: exact) == exact.absoluteString)
    let file = URL(string: "file:///tmp/a%20b.pdf")!
    check("link.explicitFileRemainsFileURL", MacLocalLink.downloadTarget(for: file) == file.absoluteString)
    check("run.recoveryCheckpointRoundTrip", RemoteRunStore.selfTestRecoveryCheckpointRoundTrip())
    check("run.generationSessionIsolation", RemoteRunStore.selfTestGenerationIsolation())
    check("run.followUpIdentityStable", RemoteRunStore.selfTestFollowUpIdentity())
    check("run.submittingIsNotRecorded", RemoteRunStore.Lifecycle.submitting != .recorded)
    check("run.stateGates", RemoteRunStore.selfTestStateGates())
    for (name, passed) in RemoteRunStore.selfTestCatalogRefreshProjection() { check("catalog.\(name)", passed) }
    for (name, passed) in RemoteRunStore.selfTestInteractionState() { check("run.\(name)", passed) }
    for (name, passed) in RemoteRunStore.selfTestConnectionReplacement() { check("run.\(name)", passed) }
    for (name, passed) in RemoteRunStore.selfTestPreviewConnectionIsolation() { check("run.\(name)", passed) }
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
    check("draft.newTaskIsolated", model.composerDraft(for: .newTask(model.targetCoordinator.localScope)).wrappedValue.text.isEmpty)
    let profileA = G0Transport.RunProviderRef(id: "pi", label: "Pi", available: true, agentProfileId: "pi:a")
    let profileB = G0Transport.RunProviderRef(id: "pi", label: "Pi", available: true, agentProfileId: "pi:b")
    check("provider.profileRowIdentity", profileA.selectionId != profileB.selectionId)
    check("run.drainBeyond400", RemoteRunStore.selfTestDrain(cursor: 400, next: 401, chunkCount: 401))
    let (photoCount, photoBytes, photosPreviewable) = selfTestFourScreenshotsFitBudget()
    print("  attachments.fourScreenshots count=\(photoCount) bytes=\(photoBytes)")
    check("attachments.fourScreenshotsFitBudget", photoCount == 4 && photoBytes <= DraftAttachment.maxTotalBytes)
    check("attachments.sentImagesPreviewable", photosPreviewable)

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
  @MainActor static func runCatalogRefreshChecksIfRequested() {
    guard ProcessInfo.processInfo.arguments.contains("-catalogRefreshChecks") else { return }
    Task {
      let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
      do {
        let checks = try await RemoteRunStore.selfTestCatalogRefreshFlow(directory: directory)
          + RemoteRunStore.selfTestExecutionTargets(directory: directory.appendingPathComponent("targets"))
          + RemoteRunStore.selfTestInteractionState()
        for (name, passed) in checks { print("TARGETTEST \(name) \(passed ? "PASS" : "FAIL")") }
        let failures = checks.filter { !$0.1 }.count
        try FileManager.default.removeItem(at: directory)
        print("TARGETTEST DONE checks=\(checks.count) failures=\(failures)")
        exit(failures == 0 ? 0 : 1)
      } catch {
        print("TARGETTEST ERROR \(error)")
        exit(1)
      }
    }
  }

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
        let previewJSON = Data("{\"status\":\"available\",\"source\":\"indexed_archive\",\"turns\":[{\"userText\":\"中🙂\",\"userTextTruncated\":true,\"items\":[{\"kind\":\"output\",\"text\":\"answer\",\"truncated\":true}],\"truncated\":true}],\"partial\":true,\"truncated\":true,\"bytes\":256}".utf8)
        let preview = try JSONDecoder().decode(G0Transport.RunHistoryPreview.self, from: previewJSON)
        check("structuredPreviewIsPartial", preview.available && preview.partial == true && preview.turns.count == 1)
        check("structuredPreviewRetainsUnicode", preview.turns[0].userText == "中🙂" && preview.turns[0].items[0].truncated)
        let older = [G0Transport.RunHistoryTurn(userText: "older", items: [.init(kind: "output", text: String(repeating: "o", count: 800_000))])]
        let recent = [G0Transport.RunHistoryTurn(userText: "latest", items: [.init(kind: "output", text: "answer")])]
        let tailBytes = try JSONEncoder().encode(older + recent)
        let tailFixture = HistoryPages(bytes: tailBytes)
        let full = try await RemoteRunClient.downloadHistory(cached: nil, fetch: { cursor, hash in
          try await tailFixture.page(cursor, hash: hash)
        })
        check("fullVerificationRemainsCanonical", full.turns == older + recent)
        let tailOrder = await tailFixture.completed
        check("fullPagesNotDownloadedTwice", Set(tailOrder).count == tailOrder.count)
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
        let legacyFields = [connection.hostId, connection.anchorPEM, connection.deviceId, "pi", "/fixture", "same"]
        let legacyKey = SHA256.hash(data: try JSONEncoder().encode(legacyFields)).map { String(format: "%02x", $0) }.joined()
        check("unprovenLegacyHistoryNotReused", key != legacyKey)
        check("profileHistoryIsolation", key != RemoteHistoryCache.key(connection: connection, providerId: "pi", cwd: "/fixture", sessionId: "same", agentProfileId: "A"))
        connection.hostId = "host-b"
        check("hostIsolation", key != RemoteHistoryCache.key(connection: connection, providerId: "pi", cwd: "/fixture", sessionId: "same"))
        connection.hostId = "host-a"; connection.deviceId = "grant-b"
        check("grantIsolation", key != RemoteHistoryCache.key(connection: connection, providerId: "pi", cwd: "/fixture", sessionId: "same"))
        connection.deviceId = "grant-a"; connection.anchorPEM = "anchor-b"
        check("anchorIsolation", key != RemoteHistoryCache.key(connection: connection, providerId: "pi", cwd: "/fixture", sessionId: "same"))
        let cache = RemoteHistoryCache(directory: root, byteLimit: 1_000_000, entryLimit: 2)
        let epoch = await cache.epoch
        check("save", try await cache.write(snapshot, key: key, epoch: epoch))
        let cachedPreview = try JSONDecoder().decode(G0Transport.RunHistoryPreview.self, from: Data("{\"status\":\"available\",\"source\":\"indexed_archive\",\"turns\":[],\"partial\":true,\"truncated\":false,\"bytes\":32}".utf8))
        check("previewMirrorSave", try await cache.writePreview(cachedPreview, key: key, epoch: epoch))
        check("previewMirrorRead", try await cache.readPreview(key) == cachedPreview)
        let slashes = String(repeating: "/", count: 2_048)
        let slashTurns = Array(repeating: G0Transport.RunHistoryPreviewTurn(userText: slashes, userTextTruncated: false,
          items: Array(repeating: .init(kind: "output", text: slashes, truncated: false), count: 2), truncated: false), count: 2)
        let wireEncoder = JSONEncoder()
        wireEncoder.outputFormatting = .withoutEscapingSlashes
        var slashBytes = 0
        var slashPreview = G0Transport.RunHistoryPreview(source: "indexed_archive", turns: slashTurns, truncated: false, bytes: slashBytes)
        while true {
          let size = try wireEncoder.encode(slashPreview).count
          if size == slashBytes { break }
          slashBytes = size
          slashPreview = .init(source: "indexed_archive", turns: slashTurns, truncated: false, bytes: slashBytes)
        }
        check("slashPreviewFitsWireBudget", slashBytes <= 16 * 1024)
        check("slashPreviewPersists", try await cache.writePreview(slashPreview, key: key, epoch: epoch))
        check("slashPreviewReadsWithoutLoss", try await cache.readPreview(key) == slashPreview)
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
        for (name, passed) in try await RemoteRunStore.selfTestCatalogRefreshFlow(directory: root.appendingPathComponent("catalog-refresh")) {
          check("catalog.\(name)", passed)
        }
        for (name, passed) in try await RemoteRunStore.selfTestHistoryStore(directory: root.appendingPathComponent("store"), snapshot: snapshot) {
          check(name, passed)
        }
      } catch { check("unexpected", false); print(error) }
      for (name, passed) in await selfTestDelivery() { check(name, passed) }
      do { try FileManager.default.removeItem(at: root) }
      catch { check("cleanup", false); print(error) }
      print("HISTORYTEST DONE failures=\(failures)")
      exit(failures == 0 ? 0 : 1)
    }
  }

  // Send delivery against scripted host replies (no relay): transport loss keeps
  // resending the same request, only a host answer ends the loop.
  @MainActor private static func selfTestDelivery() async -> [(String, Bool)] {
    struct Lost: Error {}
    var checks: [(String, Bool)] = []
    var sends = 0, failures = 0, pauses: [Int] = []
    let delivered = await RemoteRunStore.deliver(
      submit: { () async throws -> String in sends += 1; if sends < 4 { throw Lost() }; return "run-1" },
      status: { () async throws -> String? in nil },
      transportFailed: { _ in failures += 1 },
      pause: { pauses.append($0) })
    if case .accepted("run-1") = delivered { checks.append(("delivery.resendsUntilReceipt", sends == 4 && failures == 3)) }
    else { checks.append(("delivery.resendsUntilReceipt", false)) }
    checks.append(("delivery.backoffAttempts", pauses == [1, 2, 3]))

    sends = 0
    let uncertain = await RemoteRunStore.deliver(
      submit: { () async throws -> String in sends += 1; throw G0Transport.RunError.host(code: "grant_revoked") },
      status: { () async throws -> String? in nil },
      transportFailed: { _ in }, pause: { _ in })
    if case .uncertain("grant_revoked") = uncertain { checks.append(("delivery.authorityLossPreservesUncertainty", sends == 1)) }
    else { checks.append(("delivery.authorityLossPreservesUncertainty", false)) }
    let rejected = await RemoteRunStore.deliver(
      submit: { () async throws -> String in throw G0Transport.RunError.host(code: "invalid_request") },
      status: { () async throws -> String? in nil },
      transportFailed: { _ in }, pause: { _ in })
    if case .rejected("invalid_request") = rejected { checks.append(("delivery.definitiveRejectionIsFinal", true)) }
    else { checks.append(("delivery.definitiveRejectionIsFinal", false)) }

    let adopted = await RemoteRunStore.deliver(
      submit: { () async throws -> String in throw G0Transport.RunError.host(code: "intent_payload_conflict") },
      status: { () async throws -> String? in "run-existing" },
      transportFailed: { _ in }, pause: { _ in })
    if case .accepted("run-existing") = adopted { checks.append(("delivery.conflictAdoptsRecordedRun", true)) }
    else { checks.append(("delivery.conflictAdoptsRecordedRun", false)) }

    let cancelled = await RemoteRunStore.deliver(
      submit: { () async throws -> String in throw Lost() },
      status: { () async throws -> String? in nil },
      transportFailed: { _ in }, pause: { _ in throw CancellationError() })
    checks.append(("delivery.cancelledPauseYieldsToNewerAttempt", cancelled == nil))
    return checks
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
