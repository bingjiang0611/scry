import Foundation
import RemoteTransport

extension RemoteRunStore {
  // Submit a durable intent. The message goes to the persisted outbox first and
  // is then delivered automatically: transport failures resend the same intentId
  // until the host answers, so a bad network only delays it (the UI spins).
  @discardableResult
  func submit(prompt: String, providerId: String, attachments: [RemoteRunClient.Attachment] = []) -> Bool {
    guard !historyOnly else { return false }
    let trimmed = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return false }
    guard !hasUnresolvedRun else {
      submitError = "当前任务仍在发送或运行中，请先返回该任务"
      return false
    }
    guard let cwd = chosen?.path else { submitError = "请先选择一个主机已授权的项目"; return false }
    guard let provider = chosenProvider, provider.id == providerId, controlsReady else {
      submitError = "当前 Provider 控件不可用，已阻止身份或权限切换"
      return false
    }
    #if DEBUG
    if mockMode { applyMockRun(prompt: trimmed, attachments: attachments); return true }
    #endif
    guard targetScope?.isLocal != false || executionTargetAvailable else {
      submitError = ConnectionCopy.targetSendUnavailable
      return false
    }
    guard makeClient() != nil else { submitError = "尚未配对"; return false }
    let identity = SessionIdentity.new(providerId: providerId, agentProfileId: chosenProvider?.agentProfileId,
                                       cwd: cwd, scope: targetScope)
    let routing = RemoteRunClient.Routing(cwd: cwd, providerId: providerId,
                                          agentProfileId: chosenProvider?.agentProfileId, prompt: trimmed,
                                          modelId: chosenModel?.id, modelProviderId: chosenModel?.providerId,
                                          effort: chosenEffort, permissionMode: permissionMode,
                                          attachments: attachments)
    guard resetRun() else { return false }
    return sendFocused(PendingSubmission(intentId: UUID().uuidString.lowercased(), routing: routing, identity: identity),
                       attachments: attachments)
  }

  // Persist first, then show and deliver. If the outbox cannot be written the
  // send is refused (the composer keeps the draft) instead of spinning on a
  // message a killed app would forget.
  func sendFocused(_ pending: PendingSubmission, attachments: [RemoteRunClient.Attachment]) -> Bool {
    guard persistOutbox(outbox + [pending]) else { return false }
    outbox.append(pending)
    activeSessionIdentity = pending.identity
    modelSelectionSession = pending.identity
    rememberModelSelection()
    prompt = pending.routing.prompt
    sentAttachments = attachments.map(SentAttachment.init)
    activeRouting = pending.routing
    pendingSubmission = pending
    terminalDrainCompleted = false
    lifecycle = .submitting
    // Marks which outbox message is focused after a relaunch.
    _ = saveRecoveryCheckpoint(intentId: pending.intentId, routing: pending.routing,
                               identity: pending.identity, runId: nil)
    startDelivery(pending)
    return true
  }

  func startDelivery(_ pending: PendingSubmission) {
    guard pending.uncertainty == nil, deliveryTasks[pending.intentId] == nil, let client = makeClient() else { return }
    // Reserve the intent durably before its first submit. An already-marked
    // item is a normal in-process retry after foreground wake, not a new send.
    if pending.attempted != true {
      guard markDeliveryAttempted(pending) else { return }
    }
    guard let attempted = outbox.first(where: { $0.intentId == pending.intentId }),
          attempted.uncertainty == nil else { return }
    let requestGeneration = dataGeneration
    let targeted = targetScope?.isLocal == false
    deliveryTasks[pending.intentId] = Task { [weak self] in
      let result = await Self.deliver(
        submit: { try await client.submit(routing: attempted.routing, intentId: attempted.intentId) },
        status: { try await client.intentStatus(intentId: attempted.intentId) },
        transportFailed: { error in
          guard let self, self.dataGeneration == requestGeneration else { return }
          self.recordFailure(error)
        },
        pause: { attempt in
          self?.pausedDeliveries.insert(attempted.intentId)
          defer { self?.pausedDeliveries.remove(attempted.intentId) }
          try await Self.deliveryPause(attempt)
        }, targeted: targeted)
      guard !Task.isCancelled, let self, self.dataGeneration == requestGeneration, let result else { return }
      self.deliveryFinished(attempted, result: result, client: client)
    }
  }

  func markDeliveryAttempted(_ pending: PendingSubmission) -> Bool {
    guard let index = outbox.firstIndex(where: { $0.intentId == pending.intentId }),
          outbox[index].failure == nil, outbox[index].uncertainty == nil else { return false }
    var marked = outbox
    marked[index].attempted = true
    let newlyReserved = attemptedDeliveryIntentIds.insert(pending.intentId).inserted
    // MainActor writes are synchronous: publish only after the marker is
    // durable. Otherwise a later retry could skip a failed first write.
    guard persistOutbox(marked) else {
      if newlyReserved { attemptedDeliveryIntentIds.remove(pending.intentId) }
      return false
    }
    outbox = marked
    return true
  }

  // Retry transport loss under the same intent. A receipt resolves delivery;
  // forwarded errors or lost authority pause without claiming nonexecution.
  // nil means cancellation; a newer attempt owns the intent.
  static func deliver<Outcome>(submit: () async throws -> Outcome,
                               status: () async throws -> Outcome?,
                               transportFailed: (Error) -> Void,
                               pause: (Int) async throws -> Void, targeted: Bool = false) async -> DeliveryResult<Outcome>? {
    var attempt = 0
    while !Task.isCancelled {
      do {
        return .accepted(try await submit())
      } catch G0Transport.RunError.host(code: "intent_payload_conflict") {
        // Recorded earlier under a differently encoded payload (e.g. an app
        // update between attempts): adopt that run instead of failing.
        do {
          if let found = try await status() { return .accepted(found) }
          return .uncertain("intent_payload_conflict")
        } catch let G0Transport.RunError.host(code) {
          return .uncertain(code)
        } catch {
          if Task.isCancelled { return nil }
          transportFailed(error)
        }
      } catch let G0Transport.RunError.host(code) {
        // A gateway rejection cannot prove that an earlier downstream attempt
        // did not execute. Only a receipt can resolve a forwarded intent.
        let authorityLost = ["device_not_authorized", "grant_expired", "grant_revoked", "unknown_op"].contains(code)
        return targeted || authorityLost ? .uncertain(code) : .rejected(code)
      } catch RemoteRunClient.ClientError.missingCredentials {
        return .uncertain("missing_credentials")
      } catch {
        if Task.isCancelled { return nil }
        transportFailed(error)
      }
      attempt += 1
      do { try await pause(attempt) } catch { return nil }
    }
    return nil
  }

  // 1, 2, 4, then every 8 seconds. Foregrounding wakes waiting sends at once.
  static func deliveryPause(_ attempt: Int) async throws {
    let seconds = min(8, 1 << min(attempt - 1, 3))
    try await Task.sleep(nanoseconds: UInt64(seconds) * 1_000_000_000)
  }

  // Restart sends that are waiting out a backoff (foreground). A send whose
  // request is in flight keeps going, so a large payload is not uploaded twice.
  // Resending is still safe: the host dedupes by intentId.
  func wakeDelivery() {
    for intentId in pausedDeliveries {
      deliveryTasks.removeValue(forKey: intentId)?.cancel()
    }
    pausedDeliveries = []
    for pending in outbox where pending.failure == nil && pending.uncertainty == nil { startDelivery(pending) }
  }

  func deliveryFinished(_ pending: PendingSubmission, result: DeliveryResult<G0Transport.RunSubmitOutcome>,
                                client: RemoteRunClient) {
    guard let index = outbox.firstIndex(where: { $0.intentId == pending.intentId }),
          outbox[index].failure == nil else { return }
    deliveryTasks.removeValue(forKey: pending.intentId)?.cancel()
    let focused = pendingSubmission?.intentId == pending.intentId
    var remaining = outbox
    switch result {
    case let .accepted(outcome):
      recordSuccess()
      remaining.remove(at: index)
      if focused { adoptSubmission(outcome, pending: pending, client: client) }
    case let .uncertain(code):
      if code == "missing_credentials" { reachable = nil; connectionObservation = .unverified }
      else { recordFailure(G0Transport.RunError.host(code: code)) }
      remaining[index].uncertainty = code
      if focused {
        observationInterrupted = true
        submitError = ConnectionCopy.targetResultUnknown
      }
    case let .rejected(code):
      // A definitive host reply is connection evidence even when it rejects
      // execution. Missing local credentials are not a reply from the Mac.
      if code == "missing_credentials" {
        reachable = nil
        connectionObservation = .unverified
      } else {
        recordFailure(G0Transport.RunError.host(code: code))
      }
      if focused {
        remaining.remove(at: index)
        pendingSubmission = nil
        lifecycle = .failed
        submitError = "Mac 拒绝了这条消息（\(code)），未执行。"
        clearRecoveryCheckpoint()
      } else {
        // Nobody is looking at this message; keep it visible on the home list.
        remaining[index].failure = code
      }
    }
    // A stale file only causes a deduped resend after relaunch; keep going.
    _ = persistOutbox(remaining)
    outbox = remaining
  }

  // Messages sent from a screen the user has since left. They keep sending in
  // the background and appear as live runs once the host records them.
  var backgroundSends: [PendingSubmission] {
    outbox.filter { $0.intentId != pendingSubmission?.intentId }
  }

  var hasUnsentMessages: Bool { outbox.contains { $0.failure == nil } }

  func backgroundSend(for identity: SessionIdentity?) -> PendingSubmission? {
    guard let identity else { return nil }
    return backgroundSends.last { $0.identity == identity && $0.failure == nil }
  }

  // Only a host-rejected message can be dismissed; an unanswered one keeps sending.
  func discardRejectedSend(_ intentId: String) {
    guard outbox.contains(where: { $0.intentId == intentId && $0.failure != nil }) else { return }
    let remaining = outbox.filter { $0.intentId != intentId }
    _ = persistOutbox(remaining)
    outbox = remaining
  }

  func adoptSubmission(_ outcome: G0Transport.RunSubmitOutcome, pending: PendingSubmission,
                               client: RemoteRunClient) {
    runId = outcome.runId
    terminalDrainCompleted = false
    let saved = saveRecoveryCheckpoint(intentId: pending.intentId, routing: pending.routing,
                                       identity: pending.identity, runId: outcome.runId)
    pendingSubmission = nil
    if saved { submitError = nil }
    lifecycle = .recorded
    startPolling(runId: outcome.runId, client: client, generation: generation, identity: pending.identity)
  }
}
