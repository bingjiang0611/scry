import Foundation
import RemoteTransport

extension RemoteRunStore {
  @discardableResult
  func resetRun() -> Bool {
    guard !hasUnresolvedRun else {
      submitError = "当前任务仍未完成观察或提交核对，已保留原运行"
      return false
    }
    archiveActiveTurnIfNeeded()
    clearRunState()
    return true
  }

  // Leave the focused run running on the Mac and stop watching it here, so the
  // user can open another session or start a new task. An unacknowledged
  // message stays in the outbox and keeps sending in the background.
  // Its partial live turn is not archived as "completed"; the host live-run
  // list keeps showing the run, its questions and stop, and history shows its
  // content once the Provider writes it.
  func detachFocusedRun() -> Bool {
    guard !historyOnly else { return false }
    if !hasUnresolvedRun { return resetRun() }
    clearRunState()
    return true
  }

  func clearRunState() {
    prefetchTask?.cancel()
    generation += 1
    pollTask?.cancel(); pollTask = nil
    historyTask?.cancel(); historyTask = nil
    // Unfocus only; its outbox delivery task keeps running.
    pendingSubmission = nil
    activeRouting = nil
    clearRecoveryCheckpoint()
    lifecycle = .unknown
    output = []
    seenOutputSequences = []
    prompt = nil
    sentAttachments = []
    runId = nil
    truncated = false
    resultSummary = nil
    submitError = nil
    liveExternalSessionId = nil
    liveHostRunId = nil
    observationInterrupted = false
    observationReconnecting = false
    stopRequesting = false
    stopRequested = false
    stopError = nil
    terminalDrainCompleted = false
    pendingQuestions = []
    pendingQuestionAnswerId = nil
    questionAnswering = false
    questionError = nil
    archivedActiveTurn = false
    restoredControlErrors = [:]
    contextNeedsRestore = false
  }

  func archiveActiveTurnIfNeeded() {
    guard !archivedActiveTurn, let identity = activeSessionIdentity,
          let prompt, !prompt.isEmpty, isTerminal(generation: generation, identity: identity) else { return }
    let turn = CompletedLiveTurn(id: runId ?? UUID().uuidString.lowercased(), runId: runId,
      prompt: prompt, attachments: sentAttachments, lifecycle: lifecycle, output: output,
      resultSummary: resultSummary, externalSessionId: liveExternalSessionId, hostRunId: liveHostRunId)
    completedLiveTurns[identity, default: []].append(turn)
    archivedActiveTurn = true
  }

  // Send a follow-up that CONTINUES an opened session (same Provider + cwd +
  // session id) so the conversation keeps its context. Unlike submit(), the
  // target is explicit (from the opened session), not the new-session pickers.
  // Chained follow-ups resume the LATEST reported session id when available.
  @discardableResult
  func submitFollowUp(prompt: String, providerId: String, agentProfileId: String? = nil, cwd: String, resume: String, attachments: [RemoteRunClient.Attachment] = []) -> Bool {
    guard !historyOnly else { return false }
    let trimmed = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return false }
    guard !hasUnresolvedRun else {
      submitError = "当前任务仍在发送或运行中，请先返回该任务"
      return false
    }
    guard !resume.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
      submitError = "缺少原会话标识，已阻止切换会话继续"
      return false
    }
    #if DEBUG
    if mockMode { applyMockRun(prompt: trimmed, attachments: attachments); liveExternalSessionId = resume; return true }
    #endif
    guard targetScope?.isLocal != false || executionTargetAvailable else {
      submitError = ConnectionCopy.targetSendUnavailable
      return false
    }
    guard makeClient() != nil else { submitError = "尚未配对"; return false }
    // The routing resume id may advance after each Provider turn, but the UI
    // identity must remain the originally opened conversation. Otherwise every
    // new native id moves completed turns to a key the current transcript view
    // does not query, making the previous exchange disappear again.
    let identity = Self.followUpIdentity(current: activeSessionIdentity, providerId: providerId,
                                         cwd: cwd, originalResume: resume, scope: targetScope,
                                         agentProfileId: agentProfileId)
    let resumeId = activeSessionIdentity == identity ? liveExternalSessionId ?? resume : resume
    let matchingProvider = chosenProvider?.id == providerId && chosenProvider?.agentProfileId == agentProfileId ? chosenProvider : nil
    guard let matchingProvider, controlsMatch(providerId: providerId, agentProfileId: agentProfileId, cwd: cwd) else {
      submitError = agentProfileId == nil ? "当前 Provider 控件不可用" : "原 Agent Profile 当前不可用，已阻止切换身份继续会话"
      return false
    }
    if let active = activeSessionIdentity, (active.providerId != providerId || active.cwd != cwd) {
      submitError = "当前会话身份不匹配，已阻止切换会话继续"
      return false
    }
    // One turn per conversation: a follow-up must not race its own earlier message.
    guard backgroundSend(for: identity) == nil else { return false }
    let modelId = chosenModel?.id
    let modelProviderId = chosenModel?.providerId
    let effort = chosenEffort
    let permission = permissionMode
    guard resetRun() else { return false }
    liveExternalSessionId = resumeId
    let routing = RemoteRunClient.Routing(cwd: cwd, providerId: providerId,
                                          agentProfileId: matchingProvider.agentProfileId, prompt: trimmed,
                                          modelId: modelId, modelProviderId: modelProviderId,
                                          effort: effort, permissionMode: permission,
                                          resume: resumeId, attachments: attachments)
    return sendFocused(PendingSubmission(intentId: UUID().uuidString.lowercased(), routing: routing, identity: identity),
                       attachments: attachments)
  }
}
