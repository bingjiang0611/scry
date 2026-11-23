import Foundation
import RemoteTransport

#if DEBUG
extension RemoteRunStore {
  // Executes loadSessions and the real protected cache in a temporary directory.
  // Only the network reader is replaced; mockMode disables all other transports.
  static func selfTestExecutionTargets(directory: URL) async throws -> [(String, Bool)] {
    let suite = "ScryTargetsFixture.\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: suite)!
    defer { defaults.removePersistentDomain(forName: suite) }
    let connections = RemoteConnectionStore(defaults: defaults)
    let connection = RemoteConnection(relayHost: "fixture.invalid", relayPort: 443, relayTLS: "system",
      hostId: "gateway", anchorPEM: "fixture-anchor", deviceId: "phone-grant")
    connections.save(connection)
    let disk = RemoteHistoryCache(directory: directory.appendingPathComponent("history"))
    let gateway = RemoteHistoryCache.catalogKey(connection: connection)
    let a = ExecutionTargetScope(gatewayHostId: connection.hostId, targetId: "a", binding: String(repeating: "a", count: 64), hostId: "mac2", label: "Mac2", gatewayIdentity: gateway)
    let b = ExecutionTargetScope(gatewayHostId: connection.hostId, targetId: "b", binding: String(repeating: "b", count: 64), hostId: "mac3", label: "Mac3", gatewayIdentity: gateway)
    let renewed = ExecutionTargetScope(gatewayHostId: connection.hostId, targetId: "a", binding: String(repeating: "c", count: 64), hostId: "mac2", label: "Mac2", gatewayIdentity: gateway)
    defaults.set(try JSONEncoder().encode([a, b]), forKey: "com.scry.remote.execution-targets." + gateway)
    let model = AppModel(connections: connections, historyDisk: disk, stateDirectory: directory)
    let coordinator = model.targetCoordinator
    coordinator.select(a)
    coordinator.selectNewTask(b)
    var checks: [(String, Bool)] = [("selection.doesNotMoveConversation", coordinator.selectedScope == a && coordinator.newTaskScope == b)]
    let draftA = model.composerDraft(for: .newTask(a))
    draftA.wrappedValue.text = "private Mac2 draft"
    coordinator.selectNewTask(a)
    coordinator.selectNewTask(b)
    checks.append(("draft.staysOnOriginalTarget", draftA.wrappedValue.text == "private Mac2 draft" && model.composerDraft(for: .newTask(b)).wrappedValue.text.isEmpty))
    checks.append(("draft.renewedGrantIsSeparate", model.composerDraft(for: .newTask(renewed)).wrappedValue.text.isEmpty))
    let store = coordinator.store(for: a)
    let other = coordinator.store(for: b)
    store.catalog = .loaded([.init(sessionId: "same", externalSessionId: "same", providerId: "pi", agentProfileId: "profile-a", cwd: "/repo", label: "Mac2 session", ts: 1)])
    other.catalog = .loaded([.init(sessionId: "same", externalSessionId: "same", providerId: "pi", agentProfileId: "profile-b", cwd: "/repo", label: "Mac3 session", ts: 2)])
    coordinator.rebuildHomeSessions()
    checks.append(("catalog.aggregatesIdenticalSessionIdsWithoutCollision", coordinator.homeSessions.count == 2 && Set(coordinator.homeSessions.map(\.id)).count == 2))
    coordinator.selectFilter(.target(a))
    checks.append(("catalog.filterKeepsOriginalScope", coordinator.homeSessions.count == 1 && coordinator.homeSessions.first?.scope == a))
    coordinator.selectFilter(.all)
    store.chosen = .init(path: "/repo", label: "repo")
    store.chosenProvider = .init(id: "pi", label: "Pi", available: true)
    coordinator.selectNewTask(a)
    checks.append(("selection.requiresFreshProjectAndProvider", store.chosen == nil && store.chosenProvider == nil && other !== store))
    let identity = SessionIdentity.opened(providerId: "pi", agentProfileId: "profile-a", cwd: "/repo", externalSessionId: "same-session", scope: a)
    let profileB = SessionIdentity.opened(providerId: "pi", agentProfileId: "profile-b", cwd: "/repo", externalSessionId: "same-session", scope: a)
    model.composerDraft(for: .conversation(identity)).wrappedValue.text = "private profile A"
    model.bindDraft(externalSessionId: "same-session", to: identity)
    checks.append(("draft.profilesIsolated", model.composerDraft(for: .conversation(profileB)).wrappedValue.text.isEmpty))
    checks.append(("followUp.doesNotReuseAnotherProfile", followUpIdentity(current: identity, providerId: "pi", cwd: "/repo", originalResume: "same-session", scope: a, agentProfileId: "profile-b") == profileB))
    checks.append(("identity.restoresFinalHostNotGateway", identity.scope?.hostId == a.hostId && identity.scope?.gatewayIdentity == gateway))
    let followUp = RemoteRunStore(connections: connections, historyDisk: disk, stateDirectory: directory.appendingPathComponent("follow-up"), targetScope: a)
    followUp.activeSessionIdentity = identity; followUp.liveExternalSessionId = "old-profile-a-session"
    followUp.chosenProvider = .init(id: "pi", label: "Pi B", available: true, agentProfileId: "profile-b")
    followUp.updateTargetAvailability(true)
    let queued = followUp.submitFollowUp(prompt: "offline fixture", providerId: "pi", agentProfileId: "profile-b", cwd: "/repo", resume: "same-session")
    for task in followUp.deliveryTasks.values { task.cancel() }
    followUp.deliveryTasks = [:]
    checks.append(("followUp.routingDoesNotResumeAnotherProfile", queued && followUp.outbox.first?.routing.resume == "same-session" && followUp.activeSessionIdentity == profileB))
    let listing = try JSONDecoder().decode(G0Transport.WorkspaceResult.self,
      from: Data(#"{"action":"list","listing":{"entries":[],"truncated":false}}"#.utf8))
    var workspaceTargets: [G0Transport.ExecutionTargetBinding?] = []
    store.workspaceReaderFixture = { client, _ in workspaceTargets.append(client.executionTarget); return listing }
    _ = try await store.readWorkspace(.init(action: .list, cwd: "/repo", path: ""))
    let readOnly = RemoteRunStore(historyFor: store)
    readOnly.workspaceReaderFixture = { client, _ in workspaceTargets.append(client.executionTarget); return listing }
    _ = try await readOnly.readWorkspace(.init(action: .list, cwd: "/repo", path: ""))
    checks.append(("workspace.browserAndReadonlyRetainTargetBinding", workspaceTargets == [a.targetBinding, a.targetBinding]))
    store.workspaceReaderFixture = { _, _ in
      var replaced = connection; replaced.deviceId = "changed-during-file-read"
      connections.save(replaced)
      return listing
    }
    do { _ = try await store.readWorkspace(.init(action: .list, cwd: "/repo", path: "")); checks.append(("workspace.changedGrantCannotPublishFile", false)) }
    catch is CancellationError { checks.append(("workspace.changedGrantCannotPublishFile", true)) }
    connections.save(connection)
    store.workspaceReaderFixture = nil
    let keyA = RemoteHistoryCache.key(connection: connection, target: a, providerId: "pi", cwd: "/repo", sessionId: "same-session", agentProfileId: "profile-a")
    let keyB = RemoteHistoryCache.key(connection: connection, target: a, providerId: "pi", cwd: "/repo", sessionId: "same-session", agentProfileId: "profile-b")
    checks.append(("cache.profilesIsolated", keyA != keyB))
    checks.append(("cache.localLegacyNamespacePreserved", RemoteHistoryCache.catalogKey(connection: connection) == RemoteHistoryCache.catalogKey(connection: connection, target: coordinator.localScope)))
    store.catalogFixture = CatalogFixture(connection: connection, fetch: { _ in throw G0Transport.RunError.host(code: "grant_revoked") })
    _ = await store.refreshSessions()
    checks.append(("catalog.targetAuthDoesNotRequestPhonePairing", store.catalogRefreshFailure?.requiresPairing == false && store.catalogRefreshFailure?.summary.contains(a.label) == true))
    store.historyTestOffline = true
    store.prepareForSession(providerId: "pi", cwd: "/repo", externalSessionId: "same-session", agentProfileId: "profile-a")
    await store.historyTask?.value
    checks.append(("history.keepsProfile", store.activeSessionIdentity == identity))
    let question = try JSONDecoder().decode(G0Transport.RunQuestionRequest.self,
      from: Data(#"{"runId":"00000000-0000-4000-8000-000000000001","questionId":"same-question","questions":[]}"#.utf8))
    other.activeSessionIdentity = .opened(providerId: "pi", agentProfileId: "profile-a", cwd: "/repo", externalSessionId: "same-session", scope: b)
    let firstQuestion = store.questionIdentity(question)
    checks.append(("question.identicalRunAndQuestionIdsStayOnTheirTarget", firstQuestion != other.questionIdentity(question)))
    store.activeSessionIdentity = profileB
    checks.append(("question.profileChangeDoesNotReuseAnswerState", firstQuestion != store.questionIdentity(question)))
    store.activeSessionIdentity = identity
    let routing = RemoteRunClient.Routing(cwd: "/repo", providerId: "pi", agentProfileId: "profile-a", prompt: "keep this unknown message")
    let pending = PendingSubmission(intentId: "immutable-intent", routing: routing, identity: identity)
    store.outbox = [pending]; store.pendingSubmission = pending
    store.activeSessionIdentity = identity; store.activeRouting = routing; store.lifecycle = .submitting
    guard store.persistOutbox([pending]), store.saveRecoveryCheckpoint(intentId: pending.intentId, routing: routing, identity: identity, runId: nil) else { throw CocoaError(.fileWriteUnknown) }
    let codes = ["target_delivery_unknown", "device_not_authorized", "grant_expired", "grant_revoked", "execution_target_binding_changed", "unknown_connection", "unknown_op"]
    for code in codes {
      var attempts = 0
      let result: DeliveryResult<G0Transport.RunSubmitOutcome>? = await deliver(submit: {
        attempts += 1
        throw G0Transport.RunError.host(code: code)
      }, status: { nil }, transportFailed: { _ in }, pause: { _ in throw CancellationError() }, targeted: true)
      if case let .uncertain(pausedCode) = result { checks.append(("delivery.\(code)PausesWithoutResend", attempts == 1 && pausedCode == code)) }
      else { checks.append(("delivery.\(code)PausesWithoutResend", false)) }
    }
    let localRevocation: DeliveryResult<String>? = await deliver(submit: { throw G0Transport.RunError.host(code: "grant_revoked") }, status: { nil }, transportFailed: { _ in }, pause: { _ in throw CancellationError() })
    checks.append(("delivery.localAuthorityLossDoesNotClaimNonexecution", { if case .uncertain("grant_revoked") = localRevocation { return true }; return false }()))
    let localCredentials: DeliveryResult<String>? = await deliver(submit: { throw RemoteRunClient.ClientError.missingCredentials }, status: { nil }, transportFailed: { _ in }, pause: { _ in throw CancellationError() })
    checks.append(("delivery.localMissingCredentialsKeepsUnconfirmedIntent", { if case .uncertain("missing_credentials") = localCredentials { return true }; return false }()))
    store.deliveryFinished(pending, result: .uncertain("target_delivery_unknown"), client: RemoteRunClient(connection: connection, executionTarget: a.targetBinding))
    checks.append(("delivery.unknownRetainsIntentAndRecovery", store.outbox.first?.identity == identity && store.outbox.first?.intentId == pending.intentId && store.hasUncertainSubmission && FileManager.default.fileExists(atPath: store.recoveryURL!.path) && !(store.submitError ?? "").contains("未执行")))
    let restored = RemoteRunStore(connections: connections, historyDisk: disk, stateDirectory: directory, targetScope: a)
    checks.append(("delivery.restartKeepsPausedOriginalBinding", restored.outbox.first?.uncertainty == "target_delivery_unknown" && restored.pendingSubmission?.identity == identity && restored.deliveryTasks.isEmpty))

    try await checkDeliveryPersistence(directory: directory, connection: connection, connections: connections, disk: disk,
                                       scope: a, routing: routing, identity: identity, checks: &checks)
    let differentGrant = RemoteRunStore(connections: connections, historyDisk: disk, stateDirectory: directory, targetScope: renewed)
    checks.append(("delivery.changedGrantDoesNotAdoptOldIntent", differentGrant.outbox.isEmpty && differentGrant.stateDirectory != restored.stateDirectory))
    do { try coordinator.prepareConnectionReplacement(connection); checks.append(("pairing.pendingOnAnyTargetBlocksReplacement", false)) }
    catch { checks.append(("pairing.pendingOnAnyTargetBlocksReplacement", store.outbox.first?.intentId == pending.intentId)) }
    try await checkTargetStartup(suite: suite, directory: directory, connections: connections, disk: disk,
                                 connection: connection, gateway: gateway, identity: identity, checks: &checks)
    let localIdentity = SessionIdentity.new(providerId: "pi", cwd: "/repo")
    let localDraft = model.composerDraft(for: .conversation(localIdentity))
    localDraft.wrappedValue.text = "private local gateway draft"
    model.bindDraft(externalSessionId: "local-shared-session", to: localIdentity)
    let localOpened = SessionIdentity.opened(providerId: "pi", cwd: "/repo", externalSessionId: "local-shared-session")
    checks.append(("draft.localAliasFindsOriginalGrantDraft", model.composerDraft(for: .conversation(localOpened)).wrappedValue.text == localDraft.wrappedValue.text))
    var replacement = connection; replacement.deviceId = "new-phone-grant"
    connections.save(replacement)
    checks.append(("draft.localGrantChangeDoesNotMoveOrDiscardDraft", model.composerDraft(for: .conversation(localOpened)).wrappedValue.text.isEmpty && localDraft.wrappedValue.text == "private local gateway draft"))
    checks.append(("delivery.phoneGrantChangeCannotReuseStore", store.makeClient() == nil))
    for value in [store, other, restored, differentGrant, coordinator.localStore] {
      value.historyTask?.cancel(); value.catalogTask?.cancel(); value.stopLiveRuns()
    }
    return checks
  }
}
#endif
