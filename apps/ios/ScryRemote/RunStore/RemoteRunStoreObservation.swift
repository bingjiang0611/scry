import Foundation
import RemoteTransport

extension RemoteRunStore {
  func startPolling(runId: String, client: RemoteRunClient, generation: Int,
                            identity: SessionIdentity) {
    pollTask?.cancel()
    pollTask = Task { [weak self] in
      guard let self else { return }
      var ledgerCursor = 0
      var outputCursor = 0
      var failures = 0
      @MainActor func observe(_ page: G0Transport.RunPollOutcome, _ questions: [G0Transport.RunQuestionRequest],
                   _ out: G0Transport.RunOutputPage, _ state: String?) {
        ledgerCursor = page.cursor
        for ev in page.events where ev.runId == runId {
          self.apply(event: ev, generation: generation, identity: identity)
        }
        if let state { self.apply(runState: state, generation: generation, identity: identity) }
        if self.pendingQuestions.first?.questionId != questions.first?.questionId {
          self.pendingQuestionAnswerId = nil
          self.questionAnswering = false
          self.questionError = nil
        }
        self.pendingQuestions = questions
        outputCursor = out.cursor
        for chunk in out.chunks {
          self.append(chunk: chunk, generation: generation, identity: identity)
        }
        self.recordSuccess()
        if failures > 0 || self.observationReconnecting {
          failures = 0
          self.observationReconnecting = false
        }
        self.observationInterrupted = false
      }
      // Compacted ledgers may no longer retain the event that established an
      // older recovered run's current lifecycle. Reconcile the authoritative
      // run projection once, then continue from the server's resettable tail.
      if let snapshot = try? await client.runQueueState(runId: runId) {
        self.apply(runQueue: snapshot, generation: generation, identity: identity)
      }
      while !Task.isCancelled {
        let requestConnectionRevision = self.connectionSuccessRevision
        do {
          let watch = try await client.watch(runId: runId, cursor: ledgerCursor, outputCursor: outputCursor)
          guard self.isCurrent(generation, identity: identity) else { return }
          observe(watch.poll, watch.questions, watch.output, watch.state)
        } catch {
          guard self.isCurrent(generation, identity: identity), !Task.isCancelled else { return }
          self.recordFailure(error, since: requestConnectionRevision)
          failures += 1
          // Host-rejected reads (revoked device, unknown run) cannot heal by
          // retrying. Transport loss and a full tunnel (`mux_busy`) can: keep
          // observing with capped backoff for as long as it takes; the status
          // row says it is reconnecting and the Provider may still be running,
          // so nothing is assumed.
          if let refusal = error as? G0Transport.RunError, !refusal.isRecoverableReadRefusal {
            self.observationReconnecting = false
            self.observationInterrupted = true
            self.submitError = Self.observationFailure(error, lifecycle: self.lifecycle, operation: "实时观察")
            self.pollTask = nil
            return
          }
          self.observationReconnecting = true
          let delay = min(8.0, 0.5 * pow(2.0, Double(failures - 1)))
          try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
          continue
        }
        if self.isTerminal(generation: generation, identity: identity) {
          let drained = await self.drainOutput(client: client, runId: runId, cursor: outputCursor,
                                               generation: generation, identity: identity)
          guard self.isCurrent(generation, identity: identity) else { return }
          if drained {
            self.archiveActiveTurnIfNeeded()
            self.clearRecoveryCheckpoint()
            self.terminalDrainCompleted = true
            // The host archives the run before its settled marker. Read the
            // host record now so the local copy can give way to it.
            if let externalSessionId = identity.externalSessionId {
              self.loadHistory(providerId: identity.providerId, cwd: identity.cwd, externalSessionId: externalSessionId, force: true, agentProfileId: identity.agentProfileId)
            }
          }
          self.pollTask = nil
          return
        }
      }
    }
  }

  // Interrupt the current run's Provider on the Mac. The receipt only says the
  // request was accepted; the lifecycle still comes from the real result.
  func stopRun() {
    guard let runId, !stopRequesting, let client = makeClient(),
          let identity = activeSessionIdentity else { return }
    stopRequesting = true
    stopError = nil
    let requestGeneration = generation
    Task { [weak self] in
      do {
        let status = try await client.stop(runId: runId)
        await MainActor.run {
          guard let self, self.isCurrent(requestGeneration, identity: identity) else { return }
          self.stopRequesting = false
          self.stopRequested = status != "not_running"
        }
      } catch {
        await MainActor.run {
          guard let self, self.isCurrent(requestGeneration, identity: identity) else { return }
          self.stopRequesting = false
          self.stopError = "停止请求结果未知：\(Self.describe(error))。可再次点击停止。"
        }
      }
    }
  }

  func resumeObservation(runId: String) {
    guard !historyOnly else { return }
    guard let identity = activeSessionIdentity, let client = makeClient() else { return }
    observationInterrupted = false
    terminalDrainCompleted = false
    submitError = nil
    startPolling(runId: runId, client: client, generation: generation, identity: identity)
  }

  func answerPendingQuestion(answers: [String: String], cancel: Bool = false) {
    #if DEBUG
    if mockMode {
      pendingQuestions = []
      return
    }
    #endif
    guard !questionAnswering, let request = pendingQuestions.first, let runId,
          let identity = activeSessionIdentity, let client = makeClient() else { return }
    let answerId = pendingQuestionAnswerId ?? UUID().uuidString.lowercased()
    pendingQuestionAnswerId = answerId
    questionAnswering = true
    questionError = nil
    let requestGeneration = generation
    Task { [weak self] in
      do {
        let response = G0Transport.RunQuestionResponse(
          runId: runId, questionId: request.questionId,
          behavior: cancel ? "cancelled" : "answered",
          answers: cancel ? nil : answers
        )
        _ = try await client.answerQuestion(runId: runId, answerId: answerId, response: response)
        await MainActor.run {
          guard let self, self.isCurrent(requestGeneration, identity: identity),
                self.pendingQuestions.first?.questionId == request.questionId else { return }
          self.pendingQuestions.removeFirst()
          self.pendingQuestionAnswerId = nil
          self.questionAnswering = false
          self.questionError = nil
        }
      } catch {
        await MainActor.run {
          guard let self, self.isCurrent(requestGeneration, identity: identity),
                self.pendingQuestions.first?.questionId == request.questionId else { return }
          self.questionAnswering = false
          self.questionError = "回答结果未知：\(Self.describe(error))。再次提交会复用同一回答标识。"
        }
      }
    }
  }

  var hasUncertainSubmission: Bool {
    guard let id = pendingSubmission?.intentId else { return false }
    return outbox.contains { $0.intentId == id && $0.uncertainty != nil }
  }

  func reconcileUncertain(intentId: String? = nil) {
    guard let id = intentId ?? pendingSubmission?.intentId,
          let pending = outbox.first(where: { $0.intentId == id && $0.uncertainty != nil }),
          deliveryTasks[id] == nil, let client = makeClient() else { return }
    let requestGeneration = dataGeneration
    deliveryTasks[id] = Task { [weak self] in
      guard let self else { return }
      defer { self.deliveryTasks.removeValue(forKey: id) }
      do {
        let receipt = try await client.intentStatus(intentId: id)
        guard !Task.isCancelled, self.dataGeneration == requestGeneration else { return }
        if let receipt { self.deliveryFinished(pending, result: .accepted(receipt), client: client) }
        else { self.submitError = ConnectionCopy.targetResultUnknown }
      } catch {
        guard !Task.isCancelled, self.dataGeneration == requestGeneration else { return }
        self.submitError = ConnectionCopy.targetResultUnknown
      }
    }
  }

  func retryObservation() {
    if hasUncertainSubmission { reconcileUncertain(); return }
    guard observationInterrupted, let runId else { return }
    resumeObservation(runId: runId)
  }

  // App returned to the foreground: open the interactive tunnel early and, if a
  // transport loss had stopped observation of an unfinished run, resume it.
  // Resuming is a read; it never re-sends a prompt or answer.
  func foregrounded() {
    liveRunsForegroundEligible = true
    guard !historyOnly, let client = makeClient() else { return }
    Task { try? await client.prewarm() }
    startLiveRuns()
    wakeDelivery()
    if observationInterrupted, pollTask == nil, !terminalDrainCompleted, runId != nil { retryObservation() }
  }

  // Resume a known host run after a view rebuild. The caller supplies the
  // session identity obtained from the host catalog, so a run id from another
  // session cannot attach to the current transcript.
  func resumeObservation(runId: String, providerId: String, cwd: String, externalSessionId: String, agentProfileId: String? = nil) {
    guard !historyOnly else { return }
    let identity = SessionIdentity.opened(providerId: providerId, agentProfileId: agentProfileId, cwd: cwd, externalSessionId: externalSessionId, scope: targetScope)
    if activeSessionIdentity != identity {
      guard resetRun() else { return }
      activeSessionIdentity = identity
    }
    self.runId = runId
    terminalDrainCompleted = false
    if lifecycle == .unknown { lifecycle = .recorded }
    _ = saveRecoveryCheckpoint(intentId: nil, routing: activeRouting, identity: identity, runId: runId)
    resumeObservation(runId: runId)
  }

  // Cancels only this phone's observation task; it cannot stop the Mac Provider.
  func stopObservation() { pollTask?.cancel(); pollTask = nil }
}
