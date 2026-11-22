import Foundation
import CryptoKit
import UIKit
import RemoteTransport

#if DEBUG
extension RemoteSelfTest {
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
}
#endif
