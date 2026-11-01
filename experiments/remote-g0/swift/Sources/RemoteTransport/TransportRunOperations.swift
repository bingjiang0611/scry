import Foundation
import NIOCore
import NIOPosix
import NIOHTTP1
import NIOWebSocket
import NIOSSL
import NIOTLS

extension G0Transport {
  static func decodeRun(_ bytes: Data, expectedTarget: ExecutionTargetBinding? = nil, expectedProfile: HistoryProfileValue? = nil, expectedHistoryScope: String? = nil) throws -> RunResponse {
    let response = try JSONDecoder().decode(RunResponse.self, from: bytes)
    if let error = response.error { throw RunError.host(code: error) }
    if let expectedTarget, response.executionTarget != expectedTarget { throw ProbeError.unexpectedReply }
    if let expectedProfile, response.historyProfile == nil || response.historyProfile?.agentProfileId != expectedProfile.value { throw HistoryProfileError.unverified }
    if let expectedHistoryScope, response.historyScope != expectedHistoryScope { throw HistoryProfileError.unverified }
    return response
  }

  static func verifyHistoryResponse(_ bytes: Data, expectedProfile: String?) throws {
    _ = try decodeRun(bytes, expectedProfile: HistoryProfileValue(value: expectedProfile))
  }

  static func verifyRunResponse(_ bytes: Data, expectedTarget: ExecutionTargetBinding?) throws {
    _ = try decodeRun(bytes, expectedTarget: expectedTarget)
  }

  static func wrapExecutionTargetRequest(_ request: Data, target: ExecutionTargetBinding) throws -> Data {
    guard target.isValid, request.first == UInt8(ascii: "{"), request.last == UInt8(ascii: "}") else { throw ProbeError.invalidArguments }
    guard let object = try JSONSerialization.jsonObject(with: request) as? [String: Any],
          let operation = object["op"] as? String, operation != "target", operation != "executionTargets" else {
      throw ProbeError.invalidArguments
    }
    var inner = object
    // keepAlive and deviceLabel belong to the Mac1 lane. They must not become
    // authority metadata for the forwarded Mac2 request.
    inner.removeValue(forKey: "keepAlive")
    inner.removeValue(forKey: "deviceLabel")
    // Preserve Foundation's JSON scalar types: NSNumber(0/1) can bridge to
    // Bool through `as? Bool`, which would corrupt cursors and page limits.
    return try JSONSerialization.data(withJSONObject: [
      "op": "target", "target": ["id": target.id, "binding": target.binding], "request": inner
    ], options: [.sortedKeys])
  }

  public static func relayExecutionTargets(endpoint: RelayEndpoint, identity: G0ProbeIdentity) async throws -> ExecutionTargetCatalog {
    let request = try JSONEncoder().encode(ExecutionTargetsRequest())
    // Discovery is a Mac1 operation. Keep it unwrapped while using the
    // authenticated control lane, so the gateway remains the authority for
    // the returned catalog and the request never becomes a Mac2 operation.
    return try await executionTargetDiscovery(expectedGatewayId: endpoint.hostId, pooled: endpoint.session != nil) { pooled in
      try await exchangeRelay(endpoint: endpoint, mode: "run", identity: identity, request: request,
        responseLimit: 256 * 1024, lane: .control, wrapTarget: false, useSession: pooled)
    }
  }

  static func executionTargetDiscovery(expectedGatewayId: String, pooled: Bool,
                                       exchange: (Bool) async throws -> Data) async throws -> ExecutionTargetCatalog {
    do {
      return try decodeExecutionTargets(try await exchange(pooled), expectedGatewayId: expectedGatewayId)
    } catch RunError.host(code: "invalid_request") where pooled {
      // An already-running older gateway accepts only {op:executionTargets}.
      // Retry this read once without transport metadata during rolling upgrade.
      // TLS/auth/timeout/unknown-op errors and all writes never enter this path.
      return try decodeExecutionTargets(try await exchange(false), expectedGatewayId: expectedGatewayId)
    }
  }

  static func decodeExecutionTargets(_ bytes: Data, expectedGatewayId: String) throws -> ExecutionTargetCatalog {
    let response = try JSONDecoder().decode(ExecutionTargetsResponse.self, from: bytes)
    if let error = response.error { throw RunError.host(code: error) }
    guard let catalog = response.executionTargets, catalog.version == 1,
          catalog.gateway.hostId == expectedGatewayId, catalog.gateway.label.utf16.count <= 256, catalog.targets.count <= 32,
          Set(catalog.targets.map(\.id)).count == catalog.targets.count,
          catalog.targets.allSatisfy({ ExecutionTargetBinding(id: $0.id, binding: $0.binding).isValid &&
            !$0.hostId.isEmpty && $0.hostId.utf16.count <= 128 && $0.label.utf16.count <= 256 && ["connected", "disconnected"].contains($0.state) })
    else { throw ProbeError.unexpectedReply }
    return catalog
  }

  public enum RunError: Error, Equatable { case host(code: String) }

  // Submit a durable run intent (recorded != executed). `detail` is the routing
  // JSON { cwd, providerId, agentProfileId?, prompt }. Returns the host-assigned
  // runId; the device polls the ledger for the real lifecycle.
  public static func relayRunSubmit(endpoint: RelayEndpoint, identity: G0ProbeIdentity, intentId: String, detail: String) async throws -> RunSubmitOutcome {
    let request = try JSONEncoder().encode(RunSubmitRequest(intentId: intentId, detail: detail))
    let response = try decodeRun(await exchangeRelay(endpoint: endpoint, mode: "run", identity: identity, request: request, replayable: false), expectedTarget: endpoint.executionTarget)
    guard let runId = response.runId, let status = response.status else { throw ProbeError.unexpectedReply }
    return RunSubmitOutcome(runId: runId, status: status)
  }

  // Read-only reconciliation of a submit whose receipt was lost. nil means the
  // host has no record of this device's intent id, so a resend cannot duplicate
  // it. Older hosts answer `unknown_op`, surfaced as RunError.host.
  public static func relayRunIntentStatus(endpoint: RelayEndpoint, identity: G0ProbeIdentity, intentId: String) async throws -> RunSubmitOutcome? {
    let request = try JSONEncoder().encode(RunIntentStatusRequest(intentId: intentId))
    let response: RunResponse
    do {
      response = try decodeRun(await exchangeRelay(endpoint: endpoint, mode: "run", identity: identity, request: request), expectedTarget: endpoint.executionTarget)
    } catch RunError.host(code: "unknown_intent") {
      return nil
    }
    guard let intent = response.intent else { throw ProbeError.unexpectedReply }
    return RunSubmitOutcome(runId: intent.runId, status: "duplicate")
  }

  // Poll ledger events strictly after `cursor` (server-authoritative sequence).
  public static func relayRunPoll(endpoint: RelayEndpoint, identity: G0ProbeIdentity, cursor: Int) async throws -> RunPollOutcome {
    let request = try JSONEncoder().encode(RunPollRequest(cursor: cursor))
    let response = try decodeRun(await exchangeRelay(endpoint: endpoint, mode: "run", identity: identity, request: request), expectedTarget: endpoint.executionTarget)
    guard let poll = response.poll else { throw ProbeError.unexpectedReply }
    return RunPollOutcome(events: poll.events, cursor: poll.cursor)
  }

  // Query a single run's current lifecycle; nil means the host has no such run
  // for this device.
  public static func relayRunState(endpoint: RelayEndpoint, identity: G0ProbeIdentity, runId: String) async throws -> String? {
    let request = try JSONEncoder().encode(RunStateRequest(runId: runId))
    let response = try decodeRun(await exchangeRelay(endpoint: endpoint, mode: "run", identity: identity, request: request), expectedTarget: endpoint.executionTarget)
    return response.state
  }

  public static func relayRunQuestions(endpoint: RelayEndpoint, identity: G0ProbeIdentity, runId: String) async throws -> [RunQuestionRequest] {
    let request = try JSONEncoder().encode(RunQuestionsRequest(runId: runId))
    let response = try decodeRun(await exchangeRelay(endpoint: endpoint, mode: "run", identity: identity, request: request), expectedTarget: endpoint.executionTarget)
    guard let questions = response.questions else { throw ProbeError.unexpectedReply }
    return questions
  }

  public static func relayRunAnswerQuestion(endpoint: RelayEndpoint, identity: G0ProbeIdentity, runId: String,
                                            answerId: String, response answer: RunQuestionResponse) async throws -> RunQuestionAnswerOutcome {
    let request = try JSONEncoder().encode(RunAnswerQuestionRequest(runId: runId, answerId: answerId, response: answer))
    let response = try decodeRun(await exchangeRelay(endpoint: endpoint, mode: "run", identity: identity, request: request, replayable: false), expectedTarget: endpoint.executionTarget)
    guard let outcome = response.answer else { throw ProbeError.unexpectedReply }
    return outcome
  }

  // The host-authorized project directories this device may target. Authorized
  // by the granted cert + anchor-pinned inner TLS, exactly like every run op; a
  // revoked device gets RunError.host(code: "device_not_authorized").
  public static func relayRunProjects(endpoint: RelayEndpoint, identity: G0ProbeIdentity) async throws -> [RunProjectRef] {
    let request = try JSONEncoder().encode(RunProjectsRequest())
    let response = try decodeRun(await exchangeRelay(endpoint: endpoint, mode: "run", identity: identity, request: request), expectedTarget: endpoint.executionTarget)
    guard let projects = response.projects else { throw ProbeError.unexpectedReply }
    return projects
  }

  // Browse one hierarchy level. A nil path lists only Mac-authorized roots; a
  // supplied path is re-authorized by the host and cannot escape those roots.
  public static func relayRunDirectories(endpoint: RelayEndpoint, identity: G0ProbeIdentity, path: String?) async throws -> RunDirectoryListing {
    let request = try JSONEncoder().encode(RunDirectoriesRequest(path: path))
    let response = try decodeRun(await exchangeRelay(endpoint: endpoint, mode: "run", identity: identity, request: request), expectedTarget: endpoint.executionTarget)
    guard let directories = response.directories else { throw ProbeError.unexpectedReply }
    return directories
  }

  public static func relayRunDirectoriesPage(endpoint: RelayEndpoint, identity: G0ProbeIdentity, path: String?, cursor: Int, limit: Int = 100, snapshot: String? = nil) async throws -> RunDirectoryPage {
    let request = try JSONEncoder().encode(RunDirectoriesPageRequest(path: path, cursor: cursor, limit: limit, snapshot: snapshot))
    let response = try decodeRun(await exchangeRelay(endpoint: endpoint, mode: "run", identity: identity, request: request), expectedTarget: endpoint.executionTarget)
    guard let page = response.directoriesPage else { throw ProbeError.unexpectedReply }
    return page
  }

  // The Providers this device may target for a new session. Authorized exactly
  // like every run op; a revoked device gets device_not_authorized.
  public struct RunProviderDiscovery: Sendable {
    public let providers: [RunProviderRef]
    public let capability: Int?
  }

  public static func relayRunProvidersWithCapability(endpoint: RelayEndpoint, identity: G0ProbeIdentity,
                                                      detail: String? = nil, providerId: String? = nil,
                                                      cwd: String? = nil, agentProfileId: String? = nil) async throws -> RunProviderDiscovery {
    var negotiatedDetail = detail
    if detail != nil {
      let infoRequest = try JSONEncoder().encode(RunProviderCapabilityRequest())
      let capability = try providerDiscoveryCapability(await exchangeRelay(endpoint: endpoint, mode: "run", identity: identity, request: infoRequest), expectedTarget: endpoint.executionTarget)
      if capability != 2 {
        guard detail == "metadata" else { throw RunError.host(code: "provider_controls_unavailable") }
        // A known legacy host receives only its original full-snapshot request,
        // never new fields that it might silently ignore.
        negotiatedDetail = nil
      }
    }
    let request = try JSONEncoder().encode(RunProvidersRequest(detail: negotiatedDetail, providerId: providerId, cwd: cwd, agentProfileId: agentProfileId))
    return try decodeProviderDiscovery(await exchangeRelay(endpoint: endpoint, mode: "run", identity: identity, request: request), detail: negotiatedDetail, expectedTarget: endpoint.executionTarget)
  }

  static func decodeProviderDiscovery(_ bytes: Data, detail: String?, expectedTarget: ExecutionTargetBinding? = nil) throws -> RunProviderDiscovery {
    let response = try decodeRun(bytes, expectedTarget: expectedTarget)
    guard let providers = response.providers, detail == nil || response.providerDiscovery == 2 else { throw ProbeError.unexpectedReply }
    guard providers.allSatisfy({ provider in
      guard let time = provider.observedAt else { return true }
      return time.isFinite && time >= 0 && time <= 8_640_000_000_000_000 && time.rounded() == time
    }) else { throw ProbeError.unexpectedReply }
    return RunProviderDiscovery(providers: providers, capability: response.providerDiscovery)
  }

  static func providerDiscoveryCapability(_ bytes: Data, expectedTarget: ExecutionTargetBinding? = nil) throws -> Int? {
    let response = try decodeRun(bytes, expectedTarget: expectedTarget)
    guard let info = response.desktop, info.kind == "info", info.protocol == 1, info.execution == "canonical",
          info.providerDiscovery == nil || info.providerDiscovery == 2 else { throw ProbeError.unexpectedReply }
    return info.providerDiscovery
  }

  public static func relayRunProviders(endpoint: RelayEndpoint, identity: G0ProbeIdentity,
                                        detail: String? = nil, providerId: String? = nil,
                                        cwd: String? = nil, agentProfileId: String? = nil) async throws -> [RunProviderRef] {
    try await relayRunProvidersWithCapability(endpoint: endpoint, identity: identity, detail: detail, providerId: providerId, cwd: cwd, agentProfileId: agentProfileId).providers
  }

  // Provider-native slash commands for this exact provider/workspace context.
  public static func relayRunCommands(endpoint: RelayEndpoint, identity: G0ProbeIdentity, providerId: String, cwd: String, agentProfileId: String? = nil) async throws -> RunCommandCatalog {
    let request = try JSONEncoder().encode(RunCommandsRequest(providerId: providerId, cwd: cwd, agentProfileId: agentProfileId))
    let response = try decodeRun(await exchangeRelay(endpoint: endpoint, mode: "run", identity: identity, request: request), expectedTarget: endpoint.executionTarget)
    guard let commands = response.commands else { throw ProbeError.unexpectedReply }
    return commands
  }

  // The host session catalog this device may browse. Authorized exactly like
  // every run op; a revoked device gets device_not_authorized.
  public static func relayRunSessions(endpoint: RelayEndpoint, identity: G0ProbeIdentity) async throws -> [RunSessionRef] {
    let request = try JSONEncoder().encode(RunSessionsRequest())
    let response = try decodeRun(await exchangeRelay(endpoint: endpoint, mode: "run", identity: identity, request: request, lane: .bulk), expectedTarget: endpoint.executionTarget)
    guard let sessions = response.sessions else { throw ProbeError.unexpectedReply }
    return sessions
  }

  public static func relayRunSessionsPage(endpoint: RelayEndpoint, identity: G0ProbeIdentity, cursor: Int, limit: Int = 100, snapshot: String? = nil,
                                          includeArchived: Bool = false) async throws -> RunSessionPage {
    var query = RunSessionsPageRequest(cursor: cursor, limit: limit, snapshot: snapshot)
    if includeArchived { query.includeArchived = true }
    let request = try JSONEncoder().encode(query)
    let response = try decodeRun(await exchangeRelay(endpoint: endpoint, mode: "run", identity: identity, request: request, lane: .bulk), expectedTarget: endpoint.executionTarget)
    guard let page = response.sessionsPage else { throw ProbeError.unexpectedReply }
    return page
  }

  // A transfer owns one fresh mTLS tunnel. It cannot submit, approve or poll a
  // run. It closes and settles its queued reads when the scope ends/cancels.

}
