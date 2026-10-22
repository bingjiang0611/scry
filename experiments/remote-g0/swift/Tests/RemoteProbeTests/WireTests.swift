import Foundation
import XCTest
@testable import RemoteTransport

final class WireTests: XCTestCase {
  func testReadRecoveryDoesNotRetrySecurityOrProtocolErrors() {
    XCTAssertTrue(RelayTransportError.permitsReadRecovery(ProbeError.disconnected))
    XCTAssertTrue(RelayTransportError.permitsReadRecovery(RelayTransportError.timedOut(stage: "lane-response")))
    XCTAssertTrue(RelayTransportError.permitsReadRecovery(RelayTransportError.closed(code: 1013, reason: "no_host_leg")))
    XCTAssertFalse(RelayTransportError.permitsReadRecovery(RelayTransportError.tlsHandshake(layer: .host, detail: "verification failed")))
    XCTAssertFalse(RelayTransportError.permitsReadRecovery(RelayTransportError.closed(code: 1008, reason: "host_unauthorized")))
    XCTAssertFalse(RelayTransportError.permitsReadRecovery(RelayTransportError.frameTooLarge))
    XCTAssertFalse(RelayTransportError.permitsReadRecovery(ProbeError.unexpectedReply))
  }

  func testDiscoveryRollingUpgradeOnlyFallsBackOnExplicitSchemaRejection() async throws {
    let valid = Data(#"{"executionTargets":{"version":1,"gateway":{"hostId":"mac1","label":"Mac1"},"targets":[]}}"#.utf8)
    var requests: [Bool] = []
    _ = try await G0Transport.executionTargetDiscovery(expectedGatewayId: "mac1", pooled: true) { pooled in
      requests.append(pooled)
      return pooled ? Data(#"{"error":"invalid_request"}"#.utf8) : valid
    }
    XCTAssertEqual(requests, [true, false])
    for error in [G0Transport.RunError.host(code: "device_not_authorized") as Error,
                  G0Transport.RunError.host(code: "unknown_op"),
                  RelayTransportError.tlsHandshake(layer: .host, detail: "verification failed"),
                  RelayTransportError.timedOut(stage: "lane-response")] {
      requests = []
      do {
        _ = try await G0Transport.executionTargetDiscovery(expectedGatewayId: "mac1", pooled: true) { pooled in
          requests.append(pooled); throw error
        }
        XCTFail("Expected discovery failure")
      } catch { XCTAssertEqual(requests, [true]) }
    }
    requests = []
    do {
      _ = try await G0Transport.executionTargetDiscovery(expectedGatewayId: "mac1", pooled: true) { pooled in
        requests.append(pooled); return Data(#"{"error":"invalid_request"}"#.utf8)
      }
      XCTFail("Expected legacy discovery failure")
    } catch { XCTAssertEqual(requests, [true, false]) }
    requests = []
    _ = try await G0Transport.executionTargetDiscovery(expectedGatewayId: "mac1", pooled: true) { pooled in
      requests.append(pooled); return valid
    }
    XCTAssertEqual(requests, [true])
  }

  func testSharedCorpus() throws {
    let source = URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent().deletingLastPathComponent()
      .deletingLastPathComponent().deletingLastPathComponent()
      .appendingPathComponent("wire-corpus.json")
    let corpus = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: source)) as? [[String: Any]])
    for fixture in corpus {
      let name = try XCTUnwrap(fixture["name"] as? String)
      let type = try XCTUnwrap(fixture["type"] as? String)
      let valid = try XCTUnwrap(fixture["valid"] as? Bool)
      let packet = try XCTUnwrap(fixture["packet"])
      let bytes = try JSONSerialization.data(withJSONObject: packet, options: .fragmentsAllowed)
      let decoders: [String: (Data) throws -> Void] = [
        "ProbeRequest": { _ = try JSONDecoder().decode(ProbeRequest.self, from: $0) },
        "ProbeResponse": { _ = try JSONDecoder().decode(ProbeResponse.self, from: $0) },
        "PairProofRequest": { _ = try JSONDecoder().decode(PairProofRequest.self, from: $0) },
        "PairStatusRequest": { _ = try JSONDecoder().decode(PairStatusRequest.self, from: $0) },
        "PairPendingResponse": { _ = try JSONDecoder().decode(PairPendingResponse.self, from: $0) },
        "PairGrantedResponse": { _ = try JSONDecoder().decode(PairGrantedResponse.self, from: $0) },
        "PairRevokedResponse": { _ = try JSONDecoder().decode(PairRevokedResponse.self, from: $0) },
        "PairDeniedResponse": { _ = try JSONDecoder().decode(PairDeniedResponse.self, from: $0) }
      ]
      let decoder = try XCTUnwrap(decoders[type], type)
      let decode = { try decoder(bytes) }
      if valid { XCTAssertNoThrow(try decode(), name) }
      else { XCTAssertThrowsError(try decode(), name) }
    }
  }

  func testProviderContextPreservesProfileAndFullModelCatalog() throws {
    let effort = G0Transport.RunControlOption(id: "high", label: "高")
    let provider = G0Transport.RunProviderRef(
      id: "pi", label: "Pi · Rotom", available: true, agentProfileId: "pi:rotom",
      modelId: "gpt-6", models: [
        G0Transport.RunModelOption(id: "gpt-6", providerId: "openai", label: "GPT-6", isDefault: true, efforts: [effort])
      ], efforts: [effort], permissions: [G0Transport.RunControlOption(id: "default", label: "默认审批")]
    )
    let decoded = try JSONDecoder().decode(G0Transport.RunProviderRef.self, from: JSONEncoder().encode(provider))
    XCTAssertEqual(decoded, provider)
    XCTAssertEqual(decoded.models?.first?.providerId, "openai")
  }

  func testHistoryProfileResponseRequiresExactSourceProof() throws {
    for raw in ["{}", "{\"historyProfile\":null}", "{\"historyProfile\":{}}", "{\"historyProfile\":{\"agentProfileId\":\"B\"}}"] {
      XCTAssertThrowsError(try G0Transport.verifyHistoryResponse(Data(raw.utf8), expectedProfile: "A"))
    }
    XCTAssertNoThrow(try G0Transport.verifyHistoryResponse(Data("{\"historyProfile\":{\"agentProfileId\":\"A\"}}".utf8), expectedProfile: "A"))
    XCTAssertNoThrow(try G0Transport.verifyHistoryResponse(Data("{\"historyProfile\":{\"agentProfileId\":null}}".utf8), expectedProfile: nil))
    XCTAssertThrowsError(try G0Transport.verifyHistoryResponse(Data("{}".utf8), expectedProfile: nil))
    XCTAssertThrowsError(try G0Transport.verifyHistoryResponse(Data("{\"historyProfile\":{\"agentProfileId\":\"A\"}}".utf8), expectedProfile: nil))
    var request = G0Transport.RunHistoryPageRequest(providerId: "pi", cwd: "/workspace", externalSessionId: "same", cursor: 0, limit: nil, snapshot: nil)
    request.agentProfileId = G0Transport.HistoryProfileValue(value: "A")
    let json = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(request)) as? [String: Any])
    XCTAssertEqual(json["agentProfileId"] as? String, "A")
    XCTAssertEqual(json["historyScope"] as? String, "session")
  }

  func testHistoryPageLimitUsesHostDefaultOrExplicitOverride() throws {
    for limit: Int? in [nil, 1024] {
      let request = G0Transport.RunHistoryPageRequest(
        providerId: "pi", cwd: "/workspace", externalSessionId: "session",
        cursor: 64 * 1024, limit: limit, snapshot: "snapshot"
      )
      let encoded = try JSONEncoder().encode(request)
      let json = try XCTUnwrap(JSONSerialization.jsonObject(with: encoded) as? [String: Any])
      XCTAssertEqual(json["op"] as? String, "historyPage")
      XCTAssertEqual(json["cursor"] as? Int, 64 * 1024)
      XCTAssertTrue(json["agentProfileId"] is NSNull, "Default Profile must be explicit, not omitted")
      XCTAssertEqual(json["snapshot"] as? String, "snapshot")
      if let limit { XCTAssertEqual(json["limit"] as? Int, limit) }
      else { XCTAssertNil(json["limit"]) }
    }
  }

  func testExecutionTargetCatalogAndWrapperWire() throws {
    let target = G0Transport.ExecutionTargetBinding(id: "mac2", binding: String(repeating: "a", count: 64))
    let request = Data(#"{"keepAlive":true,"deviceLabel":"phone","op":"sessionsPage","cursor":0,"limit":100}"#.utf8)
    let wrapped = try G0Transport.wrapExecutionTargetRequest(request, target: target)
    let fields = try XCTUnwrap(JSONSerialization.jsonObject(with: wrapped) as? [String: Any])
    XCTAssertEqual(fields["op"] as? String, "target")
    XCTAssertEqual(fields["target"] as? [String: String], ["id": "mac2", "binding": String(repeating: "a", count: 64)])
    let nested = try XCTUnwrap(fields["request"] as? [String: Any])
    XCTAssertEqual(nested["op"] as? String, "sessionsPage")
    XCTAssertNil(nested["keepAlive"])
    XCTAssertNil(nested["deviceLabel"])
    let outer = try RelaySession.keepAliveRequest(wrapped, deviceLabel: "iPhone")
    let outerFields = try XCTUnwrap(JSONSerialization.jsonObject(with: outer) as? [String: Any])
    XCTAssertEqual(outerFields["keepAlive"] as? Bool, true)
    XCTAssertEqual(outerFields["deviceLabel"] as? String, "iPhone")
    let outerNested = try XCTUnwrap(outerFields["request"] as? [String: Any])
    XCTAssertNil(outerNested["keepAlive"])
    XCTAssertNil(outerNested["deviceLabel"])

    let catalog = G0Transport.ExecutionTargetCatalog(
      version: 1,
      gateway: .init(hostId: "mac1", label: "Mac1"),
      targets: [.init(id: "mac2", binding: String(repeating: "a", count: 64), hostId: "host-2", label: "Mac2", state: "connected")]
    )
    XCTAssertEqual(try JSONDecoder().decode(G0Transport.ExecutionTargetCatalog.self, from: JSONEncoder().encode(catalog)), catalog)
    XCTAssertThrowsError(try G0Transport.wrapExecutionTargetRequest(Data(#"{"op":"target","request":{}}"#.utf8), target: target))
  }

  func testExecutionTargetDiscoveryBindsToPairedGatewayIdentity() throws {
    let reply = Data(#"{"executionTargets":{"version":1,"gateway":{"hostId":"mac1","label":"Mac1"},"targets":[]}}"#.utf8)
    XCTAssertNoThrow(try G0Transport.decodeExecutionTargets(reply, expectedGatewayId: "mac1"))
    XCTAssertThrowsError(try G0Transport.decodeExecutionTargets(reply, expectedGatewayId: "another-gateway"))
  }

  func testRelayPathSignatureContainsOnlyTheSelectedRoute() {
    let selected = RelayPathSignature.make(
      status: "satisfied", isExpensive: true, isConstrained: false,
      supportsDNS: true, supportsIPv4: true, supportsIPv6: false,
      usedInterfaceTypes: ["cellular"]
    )
    XCTAssertEqual(selected, "status=satisfied|expensive=true|constrained=false|dns=true|ipv4=true|ipv6=false|interfaces=cellular")
    XCTAssertFalse(selected.contains("wifi"), "Available Wi-Fi must not masquerade as the selected route")
    let changed = RelayPathSignature.make(
      status: "satisfied", isExpensive: false, isConstrained: false,
      supportsDNS: true, supportsIPv4: true, supportsIPv6: false,
      usedInterfaceTypes: ["wifi"]
    )
    XCTAssertNotEqual(selected, changed)
  }

  func testExecutionTargetDiscoveryRejectsUnsupportedOrMalformedCatalogs() throws {
    let gateway = G0Transport.ExecutionTargetCatalog.Gateway(hostId: "mac1", label: "Mac1")
    let target = G0Transport.ExecutionTargetRef(id: "mac2", binding: String(repeating: "a", count: 64), hostId: "host2", label: "Mac2", state: "connected")
    let tooMany = (0..<33).map { G0Transport.ExecutionTargetRef(id: "target-\($0)", binding: target.binding, hostId: target.hostId, label: target.label, state: target.state) }
    let malformed = [
      G0Transport.ExecutionTargetCatalog(version: 2, gateway: gateway, targets: []),
      .init(version: 1, gateway: gateway, targets: tooMany),
      .init(version: 1, gateway: gateway, targets: [target, target]),
      .init(version: 1, gateway: gateway, targets: [.init(id: "mac2", binding: "bad", hostId: "host2", label: "Mac2", state: "connected")]),
      .init(version: 1, gateway: gateway, targets: [.init(id: "mac2", binding: target.binding + "\n", hostId: "host2", label: "Mac2", state: "connected")]),
      .init(version: 1, gateway: gateway, targets: [.init(id: "mac2", binding: target.binding, hostId: "host2", label: "Mac2", state: "unknown")]),
      .init(version: 1, gateway: gateway, targets: [.init(id: "mac2", binding: target.binding, hostId: "host2", label: String(repeating: "x", count: 257), state: "connected")])
    ]
    for catalog in malformed {
      let reply = try JSONEncoder().encode(["executionTargets": catalog])
      XCTAssertThrowsError(try G0Transport.decodeExecutionTargets(reply, expectedGatewayId: "mac1"))
    }
  }

  func testExecutionTargetWrapperPreservesJSONScalarTypes() throws {
    struct Page: Decodable { let cursor: Int; let limit: Int; let includeArchived: Bool }
    struct Envelope: Decodable { let request: Page }
    let target = G0Transport.ExecutionTargetBinding(id: "mac2", binding: String(repeating: "a", count: 64))
    let request = Data(#"{"op":"sessionsPage","cursor":0,"limit":1,"includeArchived":false}"#.utf8)
    let wrapped = try G0Transport.wrapExecutionTargetRequest(request, target: target)
    let page = try JSONDecoder().decode(Envelope.self, from: wrapped).request
    XCTAssertEqual(page.cursor, 0)
    XCTAssertEqual(page.limit, 1)
    XCTAssertFalse(page.includeArchived)
  }

  func testExecutionTargetResponseStampIsRequiredAndMatched() throws {
    let target = G0Transport.ExecutionTargetBinding(id: "mac2", binding: String(repeating: "b", count: 64))
    let stamp = ["id": "mac2", "binding": String(repeating: "b", count: 64)]
    let matchingObject: [String: Any] = ["status": "ok", "executionTarget": stamp]
    let matching = try JSONSerialization.data(withJSONObject: matchingObject)
    XCTAssertNoThrow(try G0Transport.verifyRunResponse(matching, expectedTarget: target))
    XCTAssertThrowsError(try G0Transport.verifyRunResponse(Data(#"{"status":"ok"}"#.utf8), expectedTarget: target))
    let wrong = Data(#"{"status":"ok","executionTarget":{"id":"mac3","binding":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}}"#.utf8)
    XCTAssertThrowsError(try G0Transport.verifyRunResponse(wrong, expectedTarget: target))
    XCTAssertNoThrow(try G0Transport.verifyRunResponse(Data(#"{"status":"ok"}"#.utf8), expectedTarget: nil))
  }

  func testScalarBoundsAndConstruction() throws {
    XCTAssertNoThrow(try ProbeRequest(protocolMajor: 1, requestId: "request", operation: "probe.echo", payload: String(repeating: "🧭", count: 4096)))
    XCTAssertThrowsError(try ProbeRequest(protocolMajor: 1, requestId: "request", operation: "probe.echo", payload: String(repeating: "🧭", count: 4097)))
    XCTAssertThrowsError(try ProbeRequest(protocolMajor: 1, requestId: String(repeating: "x", count: 65), operation: "probe.echo", payload: ""))
    let malformed = Data(#"{"protocolMajor":1,"requestId":"request","operation":"probe.echo","payload":"\ud800"}"#.utf8)
    XCTAssertThrowsError(try JSONDecoder().decode(ProbeRequest.self, from: malformed))
  }
}
