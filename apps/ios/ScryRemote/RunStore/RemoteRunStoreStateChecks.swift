import Foundation
import RemoteTransport

#if DEBUG
extension RemoteRunStore {
  static func selfTestPreviewConnectionIsolation() -> [(String, Bool)] {
    let suite = "ScryPreviewIsolation.\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: suite)!
    defer { defaults.removePersistentDomain(forName: suite) }
    let connections = RemoteConnectionStore(defaults: defaults)
    let connection = RemoteConnection(relayHost: "fixture.invalid", relayPort: 443, relayTLS: "system",
      hostId: "fixture", anchorPEM: "fixture-anchor", deviceId: "fixture-grant")
    connections.save(connection)
    let store = RemoteRunStore(connections: connections)
    var checks = [("preview.normalClientAvailable", store.makeClient()?.connection == connection)]
    store.mockMode = true
    let blocked = store.makeClient() == nil && store.loadConnection() == nil
    checks.append(("preview.pairedTransportBlocked", blocked))
    // A failing control must not send even a fixture request. The positive
    // client check above proves this is not merely an unpaired installation.
    guard blocked else { return checks }

    let identity = SessionIdentity.opened(providerId: "pi", cwd: "/fixture", externalSessionId: "session")
    store.activeSessionIdentity = identity
    store.runId = "mock-run-visual-only"
    store.lifecycle = .running
    store.observationInterrupted = true
    store.foregrounded()
    store.prepareForSession(providerId: "pi", cwd: "/fixture", externalSessionId: "session")
    store.stopRun()
    checks.append(("preview.noObservationOrStop", store.pollTask == nil && store.liveRunsTask == nil &&
      !store.stopRequesting && store.lifecycle == .running))

    store.historyWindow = G0Transport.RunHistoryTurnsPage(turns: [], offset: 1,
      totalTurns: 1, hasOlder: true, snapshot: "fixture", source: "indexed_archive", completeness: "partial")
    store.loadOlderHistory(providerId: "pi", cwd: "/fixture", externalSessionId: "session")
    checks.append(("preview.noPagedHistoryTransport", store.historyTask == nil))

    let liveJSON = #"{"origin":"mac","runId":"fixture-live","providerId":"pi","cwd":"/fixture","externalSessionId":"session","prompt":"fixture","state":"running","questions":[]}"#
    let live = try! JSONDecoder().decode(G0Transport.LiveRun.self, from: Data(liveJSON.utf8))
    store.followDetached(live)
    store.stopLiveRun(live)
    checks.append(("preview.noDetachedTransportOrStop", store.detachedTask == nil && store.liveActionRunId == nil))
    store.mockMode = false
    checks.append(("preview.pairingPreserved", connections.load() == connection && store.makeClient()?.connection == connection))
    return checks
  }

  static func selfTestModelSelection() -> [(String, Bool)] {
    let suite = "scry-model-selection-" + UUID().uuidString
    let defaults = UserDefaults(suiteName: suite)!
    defer { defaults.removePersistentDomain(forName: suite) }
    let connections = RemoteConnectionStore(defaults: defaults)
    let store = RemoteRunStore(connections: connections, stateDirectory: nil)
    let efforts = [G0Transport.RunControlOption(id: "high", label: "High")]
    let models = ["a", "b"].map {
      G0Transport.RunModelOption(id: $0, providerId: "openai", label: $0, efforts: efforts)
    }
    let provider = G0Transport.RunProviderRef(id: "pi", label: "Pi", available: true,
      agentProfileId: "profile-a", models: models, efforts: efforts)
    store.providers = .loaded([provider])
    store.chooseProvider(provider)
    store.chooseModel(models[0].selectionId)
    store.chooseEffort("high")
    let a = SessionIdentity.opened(providerId: "pi", agentProfileId: "profile-a", cwd: "/repo", externalSessionId: "a")
    let b = SessionIdentity.opened(providerId: "pi", agentProfileId: "profile-a", cwd: "/repo", externalSessionId: "b")
    // Drive actual navigation before pairing; no transport or real app state.
    func open(_ identity: SessionIdentity) {
      store.loadHistory(providerId: identity.providerId, cwd: identity.cwd,
        externalSessionId: identity.externalSessionId!, agentProfileId: identity.agentProfileId)
      store.applyPreferredProvider(identity.providerId, agentProfileId: identity.agentProfileId)
    }
    open(a)
    var checks = [("model.newSessionDoesNotInheritDraft", store.chosenModelId == nil && store.chosenEffort == nil)]
    store.chooseModel(models[0].selectionId); store.chooseEffort("high")
    let routing = RemoteRunClient.Routing(cwd: "/repo", providerId: "pi", agentProfileId: "profile-a",
      prompt: "running", modelId: "a", modelProviderId: "openai", effort: "high")
    store.outbox = [.init(intentId: "running-a", routing: routing, identity: a)]
    open(b)
    checks.append(("model.otherSessionStartsIndependently", store.chosenModelId == nil && store.chosenEffort == nil))
    store.chooseModel(models[1].selectionId)
    checks.append(("model.runningRoutingIsFrozen", store.outbox.first?.routing == routing))
    open(a)
    checks.append(("model.sessionRestoresModelAndEffort", store.chosenModelId == models[0].selectionId && store.chosenEffort == "high"))
    store.loadProviders(preferredId: "pi", preferredAgentProfileId: "profile-a")
    checks.append(("model.reloadKeepsSelection", store.chosenModelId == models[0].selectionId && store.chosenEffort == "high"))
    open(b)
    checks.append(("model.secondSessionUnaffected", store.chosenModelId == models[1].selectionId && store.chosenEffort == nil))
    store.chooseModel(nil)
    open(a); open(b)
    checks.append(("model.explicitAutoIsRemembered", store.chosenModelId == nil && store.controlsReady))
    store.resetNewTaskContext(); store.chooseProvider(provider)
    checks.append(("model.newTaskPreferenceIsSeparate", store.chosenModelId == models[0].selectionId && store.chosenEffort == "high"))
    open(b)
    checks.append(("model.returnFromNewTaskRestoresSameSession", store.chosenModelId == nil && store.chosenEffort == nil))
    open(a)
    let missing = G0Transport.RunProviderRef(id: "pi", label: "Pi", available: true,
      agentProfileId: "profile-a", models: [], efforts: [])
    store.applyProviderCatalog([missing])
    checks.append(("model.catalogLossCannotSelectAuto", store.chosenModelId == models[0].selectionId && !store.controlsReady && store.modelSelectionIssue != nil))
    store.applyProviderCatalog([provider])
    checks.append(("model.catalogRecoveryRestoresReadiness", store.controlsReady && store.chosenEffort == "high"))
    let noEffort = G0Transport.RunProviderRef(id: "pi", label: "Pi", available: true,
      agentProfileId: "profile-a", models: models.map { .init(id: $0.id, providerId: $0.providerId, label: $0.label, efforts: []) })
    store.applyProviderCatalog([noEffort])
    checks.append(("model.effortLossCannotSelectDefault", store.chosenEffort == "high" && !store.controlsReady && store.modelSelectionIssue == ConnectionCopy.selectedEffortUnavailable))
    store.applyProviderCatalog([provider])
    store.chooseModel(models[1].selectionId)
    checks.append(("model.modelChangeResetsEffort", store.chosenEffort == nil))
    let otherProfile = G0Transport.RunProviderRef(id: "pi", label: "Pi B", available: true,
      agentProfileId: "profile-b", models: models)
    let profileB = SessionIdentity.opened(providerId: "pi", agentProfileId: "profile-b", cwd: "/repo", externalSessionId: "a")
    store.providers = .loaded([provider, otherProfile])
    open(profileB)
    checks.append(("model.profileIsolation", store.chosenModelId == nil))
    open(a)
    checks.append(("model.originalProfileRetained", store.chosenModelId == models[1].selectionId))
    store.activeRouting = routing; store.contextNeedsRestore = true
    store.modelSelectionSession = a
    store.chooseModel(nil)
    store.restoreActiveContext()
    checks.append(("model.recoveryCannotOverwriteExplicitAuto", store.chosenModelId == nil))
    store.contextNeedsRestore = false
    let local = SessionIdentity.new(providerId: "pi", agentProfileId: "profile-a", cwd: "/repo")
    store.activeSessionIdentity = local; store.modelSelectionSession = local
    store.chooseModel(models[1].selectionId)
    let marker = "{\"event\":\"session\",\"externalSessionId\":\"provider-assigned\"}"
    let eventData = try! JSONSerialization.data(withJSONObject: ["seq": 1, "at": 1, "runId": "running-a", "kind": "run_progress", "detail": marker])
    let event = try! JSONDecoder().decode(G0Transport.RunLedgerEvent.self, from: eventData)
    store.apply(event: event, generation: store.generation, identity: local)
    let external = SessionIdentity.opened(providerId: "pi", agentProfileId: "profile-a", cwd: "/repo", externalSessionId: "provider-assigned")
    open(b); open(external)
    checks.append(("model.providerSessionIDKeepsSelection", store.chosenModelId == models[1].selectionId))
    open(a)
    // Persist with an isolated public pairing descriptor, then recreate the store.
    // No client method is called after installing the descriptor.
    let connection = RemoteConnection(relayHost: "fixture.invalid", relayPort: 443, relayTLS: "system",
      hostId: "host-a", anchorPEM: "fixture", deviceId: "device-a")
    connections.save(connection)
    store.chooseModel(models[0].selectionId); store.chooseEffort("high")
    let reopened = RemoteRunStore(connections: connections, stateDirectory: nil)
    reopened.modelSelectionSession = a; reopened.chooseProvider(provider)
    checks.append(("model.relaunchKeepsSelection", reopened.chosenModelId == models[0].selectionId && reopened.chosenEffort == "high"))
    connections.save(RemoteConnection(relayHost: "fixture.invalid", relayPort: 443, relayTLS: "system",
      hostId: "host-b", anchorPEM: "fixture-b", deviceId: "device-b"))
    reopened.restoreModelSelection()
    checks.append(("model.hostIsolation", reopened.chosenModelId == nil))
    connections.save(connection); reopened.restoreModelSelection()
    checks.append(("model.originalHostRetained", reopened.chosenModelId == models[0].selectionId))
    return checks
  }

  static func selfTestInteractionState() -> [(String, Bool)] {
    // -selfTest skips restoring disk state; mockMode prevents any checkpoint
    // deletion. Exercise the real admission and projection methods in memory.
    let store = RemoteRunStore(stateDirectory: nil)
    store.mockMode = true
    var checks: [(String, Bool)] = []
    let identity = SessionIdentity.new(providerId: "codex", cwd: "/fixture")
    let routing = RemoteRunClient.Routing(cwd: "/fixture", providerId: "codex", agentProfileId: nil, prompt: "same prompt")
    store.activeSessionIdentity = identity
    store.pendingSubmission = PendingSubmission(intentId: "keep-this-intent", routing: routing, identity: identity)
    store.lifecycle = .submitting
    checks.append(("pending.resetRejected", !store.resetRun() && store.pendingSubmission?.intentId == "keep-this-intent"))
    checks.append(("pending.submitRejected", !store.submit(prompt: "next", providerId: "codex") && store.pendingSubmission?.intentId == "keep-this-intent"))
    // Leaving an unsent message must not block a new task; it keeps sending from the outbox.
    store.outbox = [store.pendingSubmission!]
    checks.append(("pending.detachDoesNotBlock", store.detachFocusedRun() && !store.hasUnresolvedRun && store.pendingSubmission == nil))
    checks.append(("pending.detachKeepsOutbox", store.backgroundSends.map(\.intentId) == ["keep-this-intent"] &&
      store.backgroundSend(for: identity)?.routing.prompt == "same prompt"))
    store.discardRejectedSend("keep-this-intent")
    checks.append(("pending.unansweredSendNotDiscardable", store.outbox.count == 1))
    store.outbox[0].failure = "invalid_request"
    store.discardRejectedSend("keep-this-intent")
    checks.append(("pending.rejectedSendDiscardable", store.outbox.isEmpty))
    let file = OutboxFile(version: 1, hostId: "host", items: [PendingSubmission(intentId: "a", routing: routing, identity: identity, failure: "x")])
    let decoded = (try? JSONEncoder().encode(file)).flatMap { try? JSONDecoder().decode(OutboxFile.self, from: $0) }
    checks.append(("outbox.roundTrip", decoded?.items == file.items && decoded?.hostId == "host"))
    let client = RemoteRunClient(connection: RemoteConnection(relayHost: "fixture.invalid", relayPort: 443,
      relayTLS: "system", hostId: "fixture", anchorPEM: "fixture", deviceId: "device"))
    for code in ["grant_revoked", "missing_credentials"] {
      let pending = PendingSubmission(intentId: code, routing: routing, identity: identity)
      store.outbox = [pending]; store.reachable = true; store.connectionObservation = .reachable
      store.deliveryFinished(pending, result: .uncertain(code), client: client)
      checks.append(("connection.uncertainty.\(code)", store.outbox.first?.uncertainty == code && store.outbox.first?.failure == nil && store.reachable == nil &&
        store.connectionObservation == (code == "missing_credentials" ? .unverified : .hostReply(code: code))))
    }
    store.pendingSubmission = nil
    store.runId = "first"; store.prompt = "same prompt"; store.lifecycle = .settled
    checks.append(("drain.blocksReset", !store.resetRun()))
    store.terminalDrainCompleted = true
    store.output = [.init(id: 1, kind: "output", text: "tail")]
    store.archiveActiveTurnIfNeeded()
    checks.append(("completed.noDuplicate", store.completedTurns(for: identity).isEmpty))
    checks.append(("completed.resetAccepted", store.resetRun()))
    checks.append(("completed.tailRetained", store.completedTurns(for: identity).first?.output.last?.text == "tail"))
    store.runId = "second"; store.prompt = "same prompt"; store.lifecycle = .settled
    store.terminalDrainCompleted = true; store.archiveActiveTurnIfNeeded(); _ = store.resetRun()
    checks.append(("completed.repeatedPromptPreserved", store.completedTurns(for: identity).count == 2))
    store.completedLiveTurns[identity] = [.init(id: "ledger-old", runId: "ledger-old", prompt: "continue",
      attachments: [], lifecycle: .settled, output: [.init(id: 1, kind: "output", text: "previous reply")],
      resultSummary: nil, externalSessionId: nil, hostRunId: "host-old")]
    store.history = .loaded([.init(runId: "host-old", userText: "continue", items: [.init(kind: "output", text: "previous reply")])])
    checks.append(("completed.archiveReplacesLocal", store.completedTurns(for: identity).isEmpty))
    checks.append(("completed.chatKeepsReconciledLocal", store.completedTurns(for: identity, historyRendered: false).count == 1))
    store.detachedHostRunId = nil
    checks.append(("detached.promptAloneCannotHideOutput", !store.detachedTurnInHistory))
    store.detachedHostRunId = "host-new"
    checks.append(("detached.differentRunPreserved", !store.detachedTurnInHistory))
    store.detachedHostRunId = "host-old"
    checks.append(("detached.sameRunDeduplicated", store.detachedTurnInHistory))
    store.chosenProvider = .init(id: "codex", label: "Codex", available: true, modelId: nil,
      permissions: [.init(id: "default", label: "Default", description: "Ask")])
    store.restoredControlErrors[.model] = "missing"
    store.choosePermission("default")
    checks.append(("recovery.permissionCannotReplaceModel", !store.controlsReady))
    store.chooseEffort(nil)
    checks.append(("recovery.effortCannotReplaceModel", !store.controlsReady))
    store.chooseModel(nil)
    checks.append(("recovery.explicitModelChoice", store.controlsReady))
    // Exercise the actual shared projection, including the action wiring. No
    // relay calls: the action is the screen's confirmation, not stopRun itself.
    store.runId = "status-fixture"
    var stopConfirmations = 0
    func status() -> SessionStatusLine? {
      SessionStatusLine.focusedRun(store, onAnswer: {}, onStop: { stopConfirmations += 1 })
    }
    for (lifecycle, text) in [(Lifecycle.submitting, "发送中"), (.recorded, "等待开始"),
                              (.dispatched, "等待开始"), (.running, "运行中")] {
      store.lifecycle = lifecycle
      checks.append(("status.\(lifecycle.rawValue)", status()?.text == text))
    }
    store.stopError = "停止请求结果未知，可再次点击停止"
    let failedStop = status()
    failedStop?.action?.perform()
    checks.append(("status.failedStopRetainsConfirmation", failedStop?.text == store.stopError && stopConfirmations == 1))
    store.stopError = nil
    store.observationReconnecting = true
    status()?.action?.perform()
    checks.append(("status.reconnectingRetainsStop", stopConfirmations == 2))
    store.observationReconnecting = false
    store.stopRequested = true
    checks.append(("status.stopping", status()?.text == "正在停止，等待 Agent 实际结束" && status()?.action == nil))
    store.stopRequested = false
    store.lifecycle = .settled
    checks.append(("status.settledIsSilent", status() == nil))
    checks.append(("outcome.normalFinishSilent", TurnOutcomeNote(lifecycle: .settled, hasOutput: true) == nil))
    for lifecycle in [Lifecycle.settled, .failed, .cancelled] {
      checks.append(("outcome.\(lifecycle.rawValue)MissingOutput",
                     TurnOutcomeNote(lifecycle: lifecycle, hasOutput: false)?.text.contains("未读取到输出") == true))
    }
    checks.append(("outcome.truncationVisible", TurnOutcomeNote(lifecycle: .settled, hasOutput: true, truncated: true)?.text.contains("截断") == true))
    return checks
  }
}
#endif
