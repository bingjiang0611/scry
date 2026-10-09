import CryptoKit
import Foundation
import RemoteTransport

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

  static func key(connection: RemoteConnection, providerId: String, cwd: String, sessionId: String) -> String {
    // Length-safe JSON encoding; paths/session ids never become filesystem paths.
    let fields = [connection.hostId, connection.anchorPEM, connection.deviceId, providerId, cwd, sessionId]
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

  func fileURL(_ key: String) -> URL { directory.appendingPathComponent(key + ".json") }
  private func previewFileURL(_ key: String) -> URL { directory.appendingPathComponent("preview-" + key + ".json") }

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
