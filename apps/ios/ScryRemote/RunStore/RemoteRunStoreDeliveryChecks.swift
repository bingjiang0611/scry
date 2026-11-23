import Foundation
import RemoteTransport

#if DEBUG
extension RemoteRunStore {
  static func checkDeliveryPersistence(directory: URL, connection: RemoteConnection, connections: RemoteConnectionStore,
                                       disk: RemoteHistoryCache, scope a: ExecutionTargetScope,
                                       routing: RemoteRunClient.Routing, identity: SessionIdentity,
                                       checks: inout [(String, Bool)]) async throws {
    let firstAttemptDirectory = directory.appendingPathComponent("delivery-first-attempt-failure")
    try Data("not-a-directory".utf8).write(to: firstAttemptDirectory)
    let firstAttempt = RemoteRunStore(connections: connections, historyDisk: disk,
      stateDirectory: firstAttemptDirectory, targetScope: a)
    firstAttempt.chosen = .init(path: "/repo", label: "repo")
    firstAttempt.chosenProvider = .init(id: "pi", label: "Pi", available: true)
    let initialSubmit = firstAttempt.submit(prompt: "must not submit", providerId: "pi")
    checks.append(("delivery.firstOutboxPersistenceFailurePreventsSubmission",
      !initialSubmit && firstAttempt.outbox.isEmpty && firstAttempt.deliveryTasks.isEmpty))
    let firstPending = PendingSubmission(intentId: "first-attempt-persistence-failure", routing: routing, identity: identity)
    firstAttempt.outbox = [firstPending]
    firstAttempt.startDelivery(firstPending)
    checks.append(("delivery.attemptMarkerPersistenceFailurePreventsSubmission",
      firstAttempt.deliveryTasks.isEmpty && firstAttempt.outbox.first?.attempted == false && firstAttempt.outbox.first?.uncertainty == nil))
    if let retry = firstAttempt.outbox.first { firstAttempt.startDelivery(retry) }
    checks.append(("delivery.failedAttemptPersistenceCannotBeBypassedOnRetry",
      firstAttempt.deliveryTasks.isEmpty && firstAttempt.outbox.first?.attempted == false && firstAttempt.attemptedDeliveryIntentIds.isEmpty))

    let wakeStore = RemoteRunStore(connections: connections, historyDisk: disk,
      stateDirectory: directory.appendingPathComponent("delivery-wake"), targetScope: a)
    let wakePending = PendingSubmission(intentId: "foreground-wake", routing: routing, identity: identity, attempted: true)
    wakeStore.outbox = [wakePending]
    wakeStore.pausedDeliveries.insert(wakePending.intentId)
    wakeStore.deliveryTasks[wakePending.intentId] = Task { try? await Task.sleep(for: .seconds(60)) }
    wakeStore.wakeDelivery()
    checks.append(("delivery.foregroundWakeRestartsAttemptedBackoff",
      wakeStore.deliveryTasks[wakePending.intentId] != nil && wakeStore.pausedDeliveries.isEmpty))
    for task in wakeStore.deliveryTasks.values { task.cancel() }
    wakeStore.deliveryTasks = [:]

    let multiStore = RemoteRunStore(connections: connections, historyDisk: disk,
      stateDirectory: directory.appendingPathComponent("delivery-multiple"), targetScope: a)
    let focusedPending = PendingSubmission(intentId: "focused-message", routing: routing, identity: identity)
    let backgroundPending = PendingSubmission(intentId: "background-message", routing: routing, identity: identity)
    multiStore.outbox = [focusedPending, backgroundPending]
    multiStore.pendingSubmission = focusedPending
    guard multiStore.persistOutbox(multiStore.outbox),
          multiStore.saveRecoveryCheckpoint(intentId: focusedPending.intentId, routing: routing,
            identity: identity, runId: nil) else { throw CocoaError(.fileWriteUnknown) }
    guard multiStore.markDeliveryAttempted(backgroundPending) else { throw CocoaError(.fileWriteUnknown) }
    let staleSnapshot = [focusedPending, backgroundPending]
    guard multiStore.persistOutbox(staleSnapshot), let multiURL = multiStore.outboxURL,
          let multiData = try? Data(contentsOf: multiURL),
          let multiFile = try? JSONDecoder().decode(OutboxFile.self, from: multiData),
          let multiRecoveryURL = multiStore.recoveryURL,
          let multiRecoveryData = try? Data(contentsOf: multiRecoveryURL),
          let multiRecovery = try? JSONDecoder().decode(RecoveryCheckpoint.self, from: multiRecoveryData) else {
      throw CocoaError(.fileReadUnknown)
    }
    checks.append(("delivery.multipleItemsRetainAttemptMarkerAcrossLaterPersistence",
      multiFile.items.count == 2 && multiFile.items.first?.attempted == false && multiFile.items.last?.attempted == true &&
      multiRecovery.intentId == focusedPending.intentId))

    let finalFailureDirectory = directory.appendingPathComponent("delivery-final-persistence-failure")
    try FileManager.default.createDirectory(at: finalFailureDirectory, withIntermediateDirectories: true)
    let finalFailure = RemoteRunStore(connections: connections, historyDisk: disk,
      stateDirectory: finalFailureDirectory, targetScope: a)
    let finalPending = PendingSubmission(intentId: "final-persistence-failure", routing: routing, identity: identity)
    finalFailure.outbox = [finalPending]; finalFailure.pendingSubmission = finalPending
    finalFailure.activeSessionIdentity = identity; finalFailure.activeRouting = routing; finalFailure.lifecycle = .submitting
    guard finalFailure.persistOutbox([finalPending]),
          finalFailure.saveRecoveryCheckpoint(intentId: finalPending.intentId, routing: routing,
            identity: identity, runId: nil) else { throw CocoaError(.fileWriteUnknown) }
    guard finalFailure.markDeliveryAttempted(finalPending) else { throw CocoaError(.fileWriteUnknown) }
    let blockedOutbox = finalFailure.outboxURL!
    let stateParent = blockedOutbox.deletingLastPathComponent()
    let heldParent = stateParent.appendingPathExtension("held")
    // Make the directory temporarily unavailable without changing the older
    // durable outbox. Restore that same directory before relaunching the store.
    try FileManager.default.moveItem(at: stateParent, to: heldParent)
    try Data("unavailable-directory".utf8).write(to: stateParent)
    finalFailure.deliveryFinished(finalPending, result: .uncertain("target_delivery_unknown"),
      client: RemoteRunClient(connection: connection, executionTarget: a.targetBinding))
    try FileManager.default.removeItem(at: stateParent)
    try FileManager.default.moveItem(at: heldParent, to: stateParent)
    let restoredAfterFinalFailure = RemoteRunStore(connections: connections, historyDisk: disk,
      stateDirectory: finalFailureDirectory, targetScope: a)
    checks.append(("delivery.failedFinalPersistenceRestoresPausedIntent",
      restoredAfterFinalFailure.outbox.first?.attempted == true &&
      restoredAfterFinalFailure.outbox.first?.uncertainty == "delivery_attempted" &&
      restoredAfterFinalFailure.deliveryTasks.isEmpty &&
      FileManager.default.fileExists(atPath: blockedOutbox.path)))

    let legacyDirectory = directory.appendingPathComponent("delivery-legacy")
    let legacyStore = RemoteRunStore(connections: connections, historyDisk: disk, stateDirectory: legacyDirectory, targetScope: a)
    let legacyPending = PendingSubmission(intentId: "legacy-intent", routing: routing, identity: identity, attempted: nil)
    guard legacyStore.persistOutbox([legacyPending]) else { throw CocoaError(.fileWriteUnknown) }
    let restoredLegacy = RemoteRunStore(connections: connections, historyDisk: disk, stateDirectory: legacyDirectory, targetScope: a)
    checks.append(("delivery.legacyUnknownAttemptIsPaused", restoredLegacy.outbox.first?.uncertainty == "legacy_delivery_state_unknown" && restoredLegacy.deliveryTasks.isEmpty))

    let queuedDirectory = directory.appendingPathComponent("delivery-never-attempted")
    let queuedStore = RemoteRunStore(connections: connections, historyDisk: disk, stateDirectory: queuedDirectory, targetScope: a)
    let queuedPending = PendingSubmission(intentId: "never-attempted", routing: routing, identity: identity)
    guard queuedStore.persistOutbox([queuedPending]) else { throw CocoaError(.fileWriteUnknown) }
    let restoredQueued = RemoteRunStore(connections: connections, historyDisk: disk, stateDirectory: queuedDirectory, targetScope: a)
    checks.append(("delivery.neverAttemptedQueueStillStarts", restoredQueued.deliveryTasks[queuedPending.intentId] != nil))
    for task in restoredQueued.deliveryTasks.values { task.cancel() }
    restoredQueued.deliveryTasks = [:]
    guard multiStore.persistOutbox([]) else { throw CocoaError(.fileWriteUnknown) }
    checks.append(("delivery.attemptMarkersReleasedWithOutbox", multiStore.attemptedDeliveryIntentIds.isEmpty))

  }
}
#endif
