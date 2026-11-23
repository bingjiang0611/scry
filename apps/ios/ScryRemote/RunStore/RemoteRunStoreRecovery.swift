import Foundation
import RemoteTransport

extension RemoteRunStore {
  var recoveryURL: URL? {
    if historyOnly { return nil }
    return stateDirectory?.appendingPathComponent("active-run.json", isDirectory: false)
  }

  func saveRecoveryCheckpoint(intentId: String?, routing: RemoteRunClient.Routing?,
                                      identity: SessionIdentity, runId: String?) -> Bool {
    guard let connection = loadConnection(), let url = recoveryURL else {
      submitError = "无法保存恢复记录：尚未配对或存储目录不可用"
      return false
    }
    let checkpoint = RecoveryCheckpoint(version: 1, hostId: connection.hostId, intentId: intentId,
                                        routing: routing, identity: identity, runId: runId)
    do {
      try Self.writeProtected(JSONEncoder().encode(checkpoint), to: url)
      return true
    } catch {
      submitError = "无法保存恢复记录：\(Self.describe(error))"
      return false
    }
  }

  static func writeProtected(_ data: Data, to url: URL) throws {
    let directory = url.deletingLastPathComponent()
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
      attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
    try data.write(to: url, options: .atomic)
    try FileManager.default.setAttributes(
      [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: url.path)
  }

  struct OutboxFile: Codable {
    let version: Int
    let hostId: String
    let items: [PendingSubmission]
  }

  var outboxURL: URL? {
    recoveryURL?.deletingLastPathComponent().appendingPathComponent("outbox.json", isDirectory: false)
  }

  // Write the outbox before the first send: a message that is not on disk would
  // be forgotten by a killed app even though the host may never have received it.
  func persistOutbox(_ items: [PendingSubmission]) -> Bool {
    #if DEBUG
    if mockMode || ProcessInfo.processInfo.arguments.contains("-historyCacheTest") { return true }
    #endif
    guard let url = outboxURL else {
      submitError = "无法保存待发送消息：存储目录不可用"
      return false
    }
    do {
      if items.isEmpty {
        do { try FileManager.default.removeItem(at: url) }
        catch let error as CocoaError where error.code == .fileNoSuchFile { }
        attemptedDeliveryIntentIds = []
        return true
      }
      guard let connection = loadConnection() else {
        submitError = "无法保存待发送消息：尚未配对"
        return false
      }
      // State writes are synchronous on the MainActor, but an older snapshot
      // can still be supplied by another outbox operation. Never let such a
      // snapshot erase a durable attempt marker for an item it retains.
      var protectedItems = items
      for index in protectedItems.indices where attemptedDeliveryIntentIds.contains(protectedItems[index].intentId) {
        protectedItems[index].attempted = true
      }
      try Self.writeProtected(JSONEncoder().encode(OutboxFile(version: 1, hostId: connection.hostId, items: protectedItems)), to: url)
      attemptedDeliveryIntentIds.formIntersection(Set(items.map(\.intentId)))
      return true
    } catch {
      submitError = "无法保存待发送消息：\(Self.describe(error))"
      return false
    }
  }

  func restoreOutbox() {
    guard let url = outboxURL, FileManager.default.fileExists(atPath: url.path) else { return }
    do {
      let file = try JSONDecoder().decode(OutboxFile.self, from: Data(contentsOf: url))
      guard file.version == 1, let connection = loadConnection(), file.hostId == connection.hostId else {
        submitError = "本地待发送消息不属于当前已配对主机，未发送"
        return
      }
      outbox = file.items.map { item in
        var restored = item
        if restored.attempted != false && restored.uncertainty == nil {
          restored.uncertainty = restored.attempted == true ? "delivery_attempted" : "legacy_delivery_state_unknown"
        }
        return restored
      }
      attemptedDeliveryIntentIds = Set(outbox.compactMap { $0.attempted != false ? $0.intentId : nil })
    } catch {
      submitError = "本地待发送消息损坏，未发送：\(Self.describe(error))"
    }
  }

  func clearRecoveryCheckpoint() {
    #if DEBUG
    if mockMode || ProcessInfo.processInfo.arguments.contains("-historyCacheTest") { return }
    #endif
    guard let url = recoveryURL else { return }
    do { try Self.removeStateFile(at: url) }
    catch { submitError = "无法清除恢复记录：\(Self.describe(error))" }
  }

  static func removeStateFile(at url: URL) throws {
    do { try FileManager.default.removeItem(at: url) }
    catch let error as CocoaError where error.code == .fileNoSuchFile { }
  }

  func restoreRecoveryCheckpoint() {
    guard let url = recoveryURL, FileManager.default.fileExists(atPath: url.path) else { return }
    do {
      let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
      guard let size = attributes[.size] as? NSNumber, size.intValue <= 2 * 1024 * 1024 else {
        throw CocoaError(.fileReadCorruptFile)
      }
      let checkpoint = try JSONDecoder().decode(RecoveryCheckpoint.self, from: Data(contentsOf: url))
      guard checkpoint.version == 1, let connection = loadConnection(), checkpoint.hostId == connection.hostId else {
        submitError = "本地恢复记录不属于当前已配对主机"
        return
      }
      activeSessionIdentity = checkpoint.identity
      modelSelectionSession = checkpoint.identity
      activeRouting = checkpoint.routing
      contextNeedsRestore = true
      prompt = checkpoint.routing?.prompt
      sentAttachments = checkpoint.routing?.attachments.map(SentAttachment.init) ?? []
      if let runId = checkpoint.runId {
        self.runId = runId
        terminalDrainCompleted = false
        lifecycle = .recorded
        if let client = makeClient() {
          startPolling(runId: runId, client: client, generation: generation, identity: checkpoint.identity)
        } else {
          observationInterrupted = true
          submitError = "已恢复运行标识，但当前配对凭据不可用"
        }
      } else if let intentId = checkpoint.intentId, let routing = checkpoint.routing {
        // The outbox owns delivery state; a focus checkpoint alone cannot
        // prove that an earlier request was never submitted.
        let pending = outbox.first { $0.intentId == intentId }
          ?? PendingSubmission(intentId: intentId, routing: routing, identity: checkpoint.identity,
                               uncertainty: "legacy_delivery_state_unknown", attempted: nil)
        if let index = outbox.firstIndex(where: { $0.intentId == intentId }) {
          outbox[index] = pending
        } else {
          outbox.append(pending)
        }
        _ = persistOutbox(outbox)
        pendingSubmission = pending
        terminalDrainCompleted = false
        lifecycle = .submitting
      } else {
        submitError = "本地恢复记录不完整，未自动执行任何操作"
      }
    } catch {
      submitError = "本地恢复记录损坏，未自动执行任何操作：\(Self.describe(error))"
    }
  }
}
