import CryptoKit
import Foundation
import RemoteTransport
import UniformTypeIdentifiers

struct RemoteHistorySnapshot: Codable, Sendable {
  let turns: [G0Transport.RunHistoryTurn]
  let fingerprint: String
  let fetchedAt: Date
}

// Disposable verified snapshots and separate partial mirrors. iOS Data Protection encrypts these
// files while locked; they are excluded from backups. We store history, not
// pairing keys or unsent drafts. A different grant/anchor cannot address old data.
actor RemoteHistoryCache {
  static let previewByteLimit = 17 * 1024 // 16 KiB payload plus local wrapper
  private(set) var epoch = 0
  let directory: URL
  let byteLimit: Int
  let entryLimit: Int

  init(directory: URL = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
    .appendingPathComponent("ScryHistory", isDirectory: true),
       byteLimit: Int = 64 * 1024 * 1024, entryLimit: Int = 20) {
    self.directory = directory
    self.byteLimit = byteLimit
    self.entryLimit = entryLimit
  }

  static func key(connection: RemoteConnection, target: ExecutionTargetScope? = nil,
                  providerId: String, cwd: String, sessionId: String, agentProfileId: String? = nil) -> String {
    // Length-safe identity includes the gateway grant, immutable target and Profile.
    var fields = [connection.hostId, connection.anchorPEM, connection.deviceId]
    if let target, !target.isLocal { fields += [target.gatewayHostId, target.targetId ?? "", target.binding ?? "", target.hostId] }
    // Old cache entries lack Profile source proof and must not render under
    // the strict protocol, including the default Profile. Outbox/catalog keys stay unchanged.
    fields += ["session-history-v2", providerId, cwd, sessionId]
    if let agentProfileId { fields += [agentProfileId] }
    let bytes = try! JSONEncoder().encode(fields)
    return SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
  }

  private struct Entry: Codable {
    let version: Int
    let key: String
    let snapshot: RemoteHistorySnapshot
  }
  private struct PreviewEntry: Codable {
    let version: Int
    let key: String
    let preview: G0Transport.RunHistoryPreview
  }
  private struct CatalogEntry: Codable {
    let version: Int
    let key: String
    let sessions: [G0Transport.RunSessionRef]
    // Synthesized Codable reads older entries without this optional field as
    // nil; file mtime is never substituted for a verified refresh timestamp.
    let fetchedAt: Date?
  }
  struct CatalogValue: Sendable {
    let sessions: [G0Transport.RunSessionRef]
    let fetchedAt: Date?
  }
  struct StructuredWindow: Codable, Sendable {
    let page: G0Transport.RunHistoryTurnsPage
    let fetchedAt: Date
  }
  private struct WindowEntry: Codable {
    let version: Int
    let key: String
    let window: StructuredWindow
  }

  static func catalogKey(connection: RemoteConnection, target: ExecutionTargetScope? = nil) -> String {
    var fields = [connection.hostId, connection.anchorPEM, connection.deviceId]
    if let target, !target.isLocal { fields += [target.gatewayHostId, target.targetId ?? "", target.binding ?? "", target.hostId] }
    let bytes = try! JSONEncoder().encode(fields)
    return SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
  }

  func fileURL(_ key: String) -> URL { directory.appendingPathComponent(key + ".json") }
  private func previewFileURL(_ key: String) -> URL { directory.appendingPathComponent("preview-" + key + ".json") }
  private func catalogFileURL(_ key: String) -> URL { directory.appendingPathComponent("catalog-" + key + ".json") }
  private func windowFileURL(_ key: String) -> URL { directory.appendingPathComponent("window-" + key + ".json") }

  func readWindow(_ key: String) throws -> StructuredWindow? {
    let url = windowFileURL(key)
    guard FileManager.default.fileExists(atPath: url.path) else { return nil }
    let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
    guard size <= byteLimit else { throw CocoaError(.fileReadTooLarge) }
    let entry = try JSONDecoder().decode(WindowEntry.self, from: Data(contentsOf: url))
    guard entry.version == 1, entry.key == key else { throw CocoaError(.fileReadCorruptFile) }
    try entry.window.page.validate()
    guard entry.window.page.offset + entry.window.page.turns.count == entry.window.page.totalTurns else {
      throw CocoaError(.fileReadCorruptFile)
    }
    return entry.window
  }

  @discardableResult
  func writeWindow(_ page: G0Transport.RunHistoryTurnsPage, key: String, epoch expectedEpoch: Int) throws -> Bool {
    guard expectedEpoch == epoch else { return false }
    try page.validate()
    guard page.offset + page.turns.count == page.totalTurns else { throw CocoaError(.fileWriteUnknown) }
    let data = try JSONEncoder().encode(WindowEntry(version: 1, key: key, window: StructuredWindow(page: page, fetchedAt: Date())))
    guard data.count <= byteLimit else { return false }
    try persist(data, to: windowFileURL(key))
    return FileManager.default.fileExists(atPath: windowFileURL(key).path)
  }

  func readCatalogValue(_ key: String) throws -> CatalogValue? {
    let url = catalogFileURL(key)
    guard FileManager.default.fileExists(atPath: url.path) else { return nil }
    let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
    guard size <= byteLimit else { throw CocoaError(.fileReadTooLarge) }
    let entry = try JSONDecoder().decode(CatalogEntry.self, from: Data(contentsOf: url))
    guard entry.version == 1, entry.key == key else { throw CocoaError(.fileReadCorruptFile) }
    return CatalogValue(sessions: entry.sessions, fetchedAt: entry.fetchedAt)
  }

  func readCatalog(_ key: String) throws -> [G0Transport.RunSessionRef]? {
    try readCatalogValue(key)?.sessions
  }

  @discardableResult
  func writeCatalog(_ sessions: [G0Transport.RunSessionRef], key: String, epoch expectedEpoch: Int,
                    fetchedAt: Date = Date()) throws -> Bool {
    guard expectedEpoch == epoch else { return false }
    let data = try JSONEncoder().encode(CatalogEntry(version: 1, key: key, sessions: sessions, fetchedAt: fetchedAt))
    guard data.count <= byteLimit else { return false }
    try persist(data, to: catalogFileURL(key))
    return FileManager.default.fileExists(atPath: catalogFileURL(key).path)
  }

  func read(_ key: String) throws -> RemoteHistorySnapshot? {
    let url = fileURL(key)
    guard FileManager.default.fileExists(atPath: url.path) else { return nil }
    let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
    guard size <= byteLimit else { throw CocoaError(.fileReadTooLarge) }
    let entry = try JSONDecoder().decode(Entry.self, from: Data(contentsOf: url))
    guard entry.version == 1, entry.key == key else { throw CocoaError(.fileReadCorruptFile) }
    return entry.snapshot
  }

  func readPreview(_ key: String) throws -> G0Transport.RunHistoryPreview? {
    let url = previewFileURL(key)
    guard FileManager.default.fileExists(atPath: url.path) else { return nil }
    let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
    guard size <= Self.previewByteLimit else { throw CocoaError(.fileReadTooLarge) }
    let entry = try JSONDecoder().decode(PreviewEntry.self, from: Data(contentsOf: url))
    guard entry.version == 1, entry.key == key else { throw CocoaError(.fileReadCorruptFile) }
    return entry.preview.available ? entry.preview : nil
  }

  // Actor-isolated IO never blocks SwiftUI. Clearing advances the epoch so
  // even a queued write from an earlier download cannot resurrect removed data.
  @discardableResult
  func write(_ snapshot: RemoteHistorySnapshot, key: String, epoch expectedEpoch: Int) throws -> Bool {
    guard expectedEpoch == epoch else { return false }
    let data = try JSONEncoder().encode(Entry(version: 1, key: key, snapshot: snapshot))
    let saved = data.count <= byteLimit
    if saved { try persist(data, to: fileURL(key)) }
    // A tiny recent mirror remains useful even when the complete snapshot is
    // too large. Write it last so eviction prioritizes first-readable content.
    _ = try writePreview(Self.mirror(snapshot), key: key, epoch: expectedEpoch)
    return saved && FileManager.default.fileExists(atPath: fileURL(key).path)
  }

  private static func mirror(_ snapshot: RemoteHistorySnapshot) throws -> G0Transport.RunHistoryPreview {
    let encoder = JSONEncoder()
    encoder.outputFormatting = .withoutEscapingSlashes
    func clip(_ value: String) throws -> (text: String, truncated: Bool) {
      var text = ""
      var bytes = 0
      for scalar in value.unicodeScalars {
        let character = String(scalar)
        let count = try encoder.encode(character).count - 2
        if bytes + count > 1_024 { return (text, true) }
        bytes += count; text += character
      }
      return (text, false)
    }
    let turns = try snapshot.turns.suffix(2).map { turn in
      let prompt = try clip(turn.userText)
      let items = try turn.items.suffix(2).map { item in
        let text = try clip(item.text)
        return G0Transport.RunHistoryPreviewItem(kind: item.kind, text: text.text, truncated: text.truncated)
      }
      return G0Transport.RunHistoryPreviewTurn(userText: prompt.text, userTextTruncated: prompt.truncated,
        items: items, truncated: prompt.truncated || turn.items.count > 2 || items.contains { $0.truncated })
    }
    let truncated = snapshot.turns.count > 2 || turns.contains { $0.truncated }
    var bytes = 0
    while true {
      let preview = G0Transport.RunHistoryPreview(source: "snapshot_cache", turns: turns, truncated: truncated, bytes: bytes)
      let encoded = try encoder.encode(preview).count
      if encoded == bytes { return preview }
      bytes = encoded
    }
  }

  private func persist(_ data: Data, to url: URL) throws {
    let fm = FileManager.default
    try fm.createDirectory(at: directory, withIntermediateDirectories: true,
      attributes: [.protectionKey: FileProtectionType.complete])
    var folder = directory
    var values = URLResourceValues(); values.isExcludedFromBackup = true
    try folder.setResourceValues(values)
    try data.write(to: url, options: [.atomic, .completeFileProtection])
    let files = try fm.contentsOfDirectory(at: directory, includingPropertiesForKeys: [.fileSizeKey, .contentModificationDateKey])
      .filter { $0.pathExtension == "json" }
      .map { url -> (URL, Int, Date) in
        let info = try url.resourceValues(forKeys: [.fileSizeKey, .contentModificationDateKey])
        return (url, info.fileSize ?? 0, info.contentModificationDate ?? .distantPast)
      }.sorted { $0.2 > $1.2 }
    var bytes = 0
    for (index, file) in files.enumerated() {
      bytes += file.1
      if index >= entryLimit || bytes > byteLimit { try fm.removeItem(at: file.0) }
    }
  }

  @discardableResult
  func writePreview(_ preview: G0Transport.RunHistoryPreview, key: String, epoch expectedEpoch: Int) throws -> Bool {
    guard expectedEpoch == epoch, preview.available else { return false }
    // Match the host JSON budget: slash escaping can otherwise double a valid
    // preview beyond the protected mirror's 17 KiB wrapper limit.
    let encoder = JSONEncoder()
    encoder.outputFormatting = .withoutEscapingSlashes
    let data = try encoder.encode(PreviewEntry(version: 1, key: key, preview: preview))
    guard data.count <= min(byteLimit, Self.previewByteLimit) else { return false }
    try persist(data, to: previewFileURL(key))
    return true
  }

  func clear() throws {
    epoch += 1
    guard FileManager.default.fileExists(atPath: directory.path) else { return }
    try FileManager.default.removeItem(at: directory)
  }
}

// Disk IO stays off the UI actor. Each view owns a private directory containing
// only its downloaded file; WebKit never receives access to shared app storage.
actor RemoteFileDownloadSink {
  private var directory: URL?
  private var url: URL?
  private var handle: FileHandle?

  func start(name: String, mimeType: String? = nil) throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent("scry-download-" + UUID().uuidString, isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
    self.directory = directory
    var url = directory.appendingPathComponent(name, isDirectory: false)
    if url.pathExtension.isEmpty, let mimeType, let ext = UTType(mimeType: mimeType)?.preferredFilenameExtension {
      url.appendPathExtension(ext)
    }
    guard FileManager.default.createFile(atPath: url.path, contents: nil) else { throw CocoaError(.fileWriteUnknown) }
    self.url = url
    handle = try FileHandle(forWritingTo: url)
  }
  func write(_ data: Data) throws {
    guard let handle else { throw RemoteRunClient.ClientError.invalidFileDownload }
    try handle.write(contentsOf: data)
  }
  func finish() throws -> URL {
    guard let url, let handle else { throw RemoteRunClient.ClientError.invalidFileDownload }
    try handle.close()
    self.handle = nil
    return url
  }
  func remove() {
    try? handle?.close()
    handle = nil
    if let directory { try? FileManager.default.removeItem(at: directory) }
    directory = nil; url = nil
  }
}

// Complete history download: paging, optional DEFLATE, snapshot verification.
extension RemoteRunClient {
  // Complete, restart-stable history. No turn/item/text is clipped to a frame.
  // A currently running Mac conversation can change between pages; restart the
  // bounded read from cursor zero instead of surfacing a stale-snapshot error.
  func history(providerId: String, cwd: String, externalSessionId: String, agentProfileId: String? = nil) async throws -> [G0Transport.RunHistoryTurn] {
    try await historySnapshot(providerId: providerId, cwd: cwd, externalSessionId: externalSessionId, agentProfileId: agentProfileId).turns
  }

  func historySnapshot(providerId: String, cwd: String, externalSessionId: String,
                       cached: RemoteHistorySnapshot? = nil,
                       connection: G0Transport.HistoryConnection? = nil,
                       agentProfileId: String? = nil,
                       progress: @escaping @Sendable (Int, Int) async -> Void = { _, _ in }) async throws -> RemoteHistorySnapshot {
    for attempt in 0..<3 {
      do {
        return try await Self.downloadHistory(cached: cached, pageSize: connection == nil ? 64 * 1024 : 256 * 1024, fetch: { cursor, snapshot in
          if let connection {
            return try await connection.page(providerId: providerId, cwd: cwd, externalSessionId: externalSessionId, cursor: cursor, snapshot: snapshot,
                                             agentProfileId: agentProfileId, compressed: true)
          }
          return try await historyPage(providerId: providerId, cwd: cwd, externalSessionId: externalSessionId,
                                      cursor: cursor, snapshot: snapshot, agentProfileId: agentProfileId)
        }, progress: progress)
      }
      catch G0Transport.RunError.host(let code) where code == "history_snapshot_changed" && attempt < 2 {
        try await Task.sleep(nanoseconds: UInt64(120 + attempt * 180) * 1_000_000)
      }
    }
    throw NSError(domain: "ScryRemote.History", code: 4,
                  userInfo: [NSLocalizedDescriptionKey: "History kept changing while it was read"])
  }

  // Larger pages share the transfer's tunnel; keep assembly/digest/JSON work
  // off the UI actor. Legacy isolated fixtures retain their 64 KiB page contract.
  @concurrent static func downloadHistory(cached: RemoteHistorySnapshot?, pageSize: Int = 64 * 1024,
    fetch: @escaping @Sendable (Int, String?) async throws -> G0Transport.RunHistoryPage,
    progress: @escaping @Sendable (Int, Int) async -> Void = { _, _ in }) async throws -> RemoteHistorySnapshot {
    try Task.checkCancellation()
    let first = try await fetch(0, nil)
    try Task.checkCancellation()
    let total = first.totalBytes
    let fingerprint = first.snapshot
    func chunk(_ page: G0Transport.RunHistoryPage, at cursor: Int) throws -> Data {
      guard total >= 0, total <= 256 * 1024 * 1024,
            page.snapshot == fingerprint, page.totalBytes == total,
            let data = Data(base64Encoded: page.dataBase64),
            data.count == min(pageSize, total - cursor),
            page.encoding == first.encoding, page.rawBytes == first.rawBytes,
            page.cursor == cursor + data.count, page.hasMore == (page.cursor < total) else {
        throw NSError(domain: "ScryRemote.History", code: 2,
          userInfo: [NSLocalizedDescriptionKey: "History snapshot, cursor or size changed"])
      }
      return data
    }
    var bytes = try chunk(first, at: 0)
    if let cached, cached.fingerprint == fingerprint {
      await progress(total, total)
      return RemoteHistorySnapshot(turns: cached.turns, fingerprint: fingerprint, fetchedAt: Date())
    }
    bytes.reserveCapacity(total)
    await progress(bytes.count, total)
    while bytes.count < total {
      try Task.checkCancellation()
      let start = bytes.count
      let pages = try await withThrowingTaskGroup(of: (Int, G0Transport.RunHistoryPage).self) { group in
        for cursor in stride(from: start, to: min(total, start + 2 * pageSize), by: pageSize) {
          group.addTask { (cursor, try await fetch(cursor, fingerprint)) }
        }
        var result: [(Int, G0Transport.RunHistoryPage)] = []
        for try await page in group { result.append(page) }
        return result.sorted { $0.0 < $1.0 }
      }
      for (cursor, page) in pages { bytes.append(try chunk(page, at: cursor)) }
      await progress(bytes.count, total)
    }
    try Task.checkCancellation()
    await progress(total, total)
    // Compressed pages inflate to exactly the bytes the snapshot hash covers;
    // anything else fails verification rather than rendering a partial copy.
    var raw = bytes
    switch first.encoding {
    case nil: break
    case "deflate"?:
      guard let expected = first.rawBytes, (0...(256 * 1024 * 1024)).contains(expected),
            let inflated = try? (bytes as NSData).decompressed(using: .zlib) as Data, inflated.count == expected else {
        throw NSError(domain: "ScryRemote.History", code: 5,
          userInfo: [NSLocalizedDescriptionKey: "History decompression failed"])
      }
      raw = inflated
    default:
      throw NSError(domain: "ScryRemote.History", code: 6,
        userInfo: [NSLocalizedDescriptionKey: "History page encoding is not supported"])
    }
    let digest = SHA256.hash(data: raw).map { String(format: "%02x", $0) }.joined()
    guard digest == fingerprint else {
      throw NSError(domain: "ScryRemote.History", code: 3,
        userInfo: [NSLocalizedDescriptionKey: "History snapshot verification failed"])
    }
    return RemoteHistorySnapshot(turns: try JSONDecoder().decode([G0Transport.RunHistoryTurn].self, from: raw),
                                 fingerprint: fingerprint, fetchedAt: Date())
  }
}
