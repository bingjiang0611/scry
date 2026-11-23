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
    for (name, passed) in RemoteRunStore.selfTestInteractionState() + RemoteRunStore.selfTestModelSelection() { check("run.\(name)", passed) }
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
          + RemoteRunStore.selfTestModelSelection()
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
}
#endif
