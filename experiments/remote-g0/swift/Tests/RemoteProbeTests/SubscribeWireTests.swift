import Foundation
import XCTest
@testable import RemoteTransport

final class SubscribeWireTests: XCTestCase {
  func testTargetRoundTripsTheAdvertisedVersion() throws {
    let wire = Data("""
      {"executionTargets":{"version":1,"gateway":{"hostId":"mac1","label":"Mac 1"},"targets":[
        {"id":"target","binding":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
         "hostId":"mac2","label":"Mac 2","state":"connected","subscribe":1,"future":{"field":true}}]}}
      """.utf8)
    let targets = try G0Transport.decodeExecutionTargets(wire, expectedGatewayId: "mac1")
    let encoded = try JSONEncoder().encode(XCTUnwrap(targets.targets.first))
    let target = try XCTUnwrap(try JSONSerialization.jsonObject(with: encoded) as? [String: Any])
    XCTAssertEqual(target["subscribe"] as? Int, 1)
    XCTAssertNil(target["future"])
  }

  func testUnknownFieldsStayOptionalAndUnknownEventTypesReset() throws {
    let base = G0Transport.SubscriptionCursor(hostId: "mac2", logId: "log-a", seq: 4)
    func decode(type: String, seq: Int) throws -> G0Transport.SubscriptionReply {
      try G0Transport.decodeSubscription(Data("""
        {"subscribe":{"hostId":"mac2","logId":"log-a","seq":8,"mode":"events","events":[
          {"seq":\(seq),"at":10,"type":"\(type)","stream":"session:test","payload":{"author":"future","optionalField":false}}],
          "future":{"field":true}}}
        """.utf8), target: nil)
    }
    let known = try decode(type: "session.discovered", seq: 6)
    XCTAssertTrue(known.knownEvents(since: base, next: try known.cursor(for: "mac2")))
    XCTAssertThrowsError(try known.cursor(for: "mac1"))
    let reordered = try decode(type: "session.discovered", seq: 4)
    XCTAssertFalse(reordered.knownEvents(since: base, next: try reordered.cursor(for: "mac2")))
    let future = try decode(type: "session.future", seq: 6)
    XCTAssertFalse(future.knownEvents(since: base, next: try future.cursor(for: "mac2")))
  }

  func testLegacyReceiptLossAllowsLookupButDoesNotResubmitAfterUpgrade() async throws {
    let endpoint = G0Transport.RelayEndpoint(host: "127.0.0.1", port: 12345, hostId: "legacy-host")
    let fences = G0Transport.SubmissionFence()
    let first = try await fences.submitLog("intent", endpoint: endpoint) { nil }
    XCTAssertNil(first.logId)
    do {
      _ = try await fences.submitLog("intent", endpoint: endpoint) { "upgraded-log" }
      XCTFail("An upgrade cannot prove that a previous submit reached no host")
    } catch let error as G0Transport.RunError {
      XCTAssertEqual(error, .host(code: "intent_payload_conflict"))
    }
    let lookup = try await fences.statusLog("intent", endpoint: endpoint)
    XCTAssertNil(lookup)
  }

  func testReplacingTheRelaySessionKeepsTheInFlightIntentLog() async throws {
    let hostId = UUID().uuidString
    let identity = G0ProbeIdentity(outerCA: Data(), hostAnchor: Data())
    let binding = G0Transport.ExecutionTargetBinding(id: "target", binding: String(repeating: "a", count: 64))
    let base = G0Transport.RelayEndpoint(host: "127.0.0.1", port: 12345, hostId: hostId, executionTarget: binding)
    func endpoint() -> G0Transport.RelayEndpoint {
      let session = RelaySession(endpoint: base) { identity }
      return G0Transport.RelayEndpoint(host: base.host, port: base.port, hostId: hostId, session: session, executionTarget: binding)
    }
    let first = endpoint(), replacement = endpoint()
    let fences = G0Transport.SubmissionFence()
    let original = try await fences.submitLog("intent", endpoint: first) { "first-log" }
    let retried = try await fences.submitLog("intent", endpoint: replacement) { "replacement-log" }
    let lookup = try await fences.statusLog("intent", endpoint: replacement)
    XCTAssertTrue(original.first)
    XCTAssertFalse(retried.first)
    XCTAssertEqual(original.logId, "first-log")
    XCTAssertEqual(retried.logId, original.logId)
    XCTAssertEqual(lookup, original.logId)
    do {
      _ = try await fences.submitLog("intent", endpoint: G0Transport.RelayEndpoint(host: base.host, port: base.port, hostId: hostId)) { "gateway-log" }
      XCTFail("A forwarded intent cannot silently move back to the gateway")
    } catch let error as G0Transport.RunError {
      XCTAssertEqual(error, .host(code: "orchestration_log_changed"))
    }
    try await fences.acknowledge("intent", endpoint: replacement)
    let acknowledged = try await fences.statusLog("intent", endpoint: replacement)
    XCTAssertNil(acknowledged)
  }

  func testDefinitiveFirstRejectionsReleaseCapacityWithoutDroppingUnknownAttempts() async throws {
    let endpoint = G0Transport.RelayEndpoint(host: "127.0.0.1", port: 12345, hostId: "host")
    let fences = G0Transport.SubmissionFence()
    let unknown = try await fences.submitLog("unknown", endpoint: endpoint) { "original-log" }
    try await fences.rejected("unknown", endpoint: endpoint, reservation: unknown, code: "orchestration_write_indeterminate")
    let retry = try await fences.submitLog("unknown", endpoint: endpoint) { "replacement-log" }
    try await fences.rejected("unknown", endpoint: endpoint, reservation: retry, code: "orchestration_log_changed")
    for index in 0..<513 {
      let intentId = "rejected-\(index)"
      let first = try await fences.submitLog(intentId, endpoint: endpoint) { "original-log" }
      try await fences.rejected(intentId, endpoint: endpoint, reservation: first, code: "invalid_request")
      let retained = try await fences.statusLog(intentId, endpoint: endpoint)
      XCTAssertNil(retained)
    }
    let retained = try await fences.statusLog("unknown", endpoint: endpoint)
    XCTAssertEqual(retained, "original-log")
  }

  func testLogFencedWriteUsesAnOperationAnOldHostCannotExecute() throws {
    let id = "32694a8e-d638-4752-8e9c-a883df723597"
    let encoder = JSONEncoder()
    let fenced = G0Transport.RunSubmitRequest(intentId: id, detail: "{}", knownLogId: "old-log")
    let normal = G0Transport.RunSubmitRequest(intentId: id, detail: "{}")
    let guardedWire = try XCTUnwrap(try JSONSerialization.jsonObject(with: encoder.encode(fenced)) as? [String: Any])
    let legacyWire = try XCTUnwrap(try JSONSerialization.jsonObject(with: encoder.encode(normal)) as? [String: Any])
    XCTAssertEqual(guardedWire["op"] as? String, "submitAtLog")
    XCTAssertEqual(guardedWire["knownLogId"] as? String, "old-log")
    XCTAssertEqual(guardedWire["intentId"] as? String, id)
    XCTAssertEqual(legacyWire["op"] as? String, "submit")
    XCTAssertNil(legacyWire["knownLogId"])
  }

  func testDecodesSanitizedHostNoticeWithoutRequiringFutureFields() throws {
    let data = Data("""
      {"subscribe":{"hostId":"mac2","logId":"log-a","seq":1,"mode":"idle","hints":[
        {"kind":"hostNotice","notice":{"id":"notice","kind":"device_approved_via_cli","ts":42,
         "deviceLabel":"测试 iPhone","fingerprintPrefix":"0123456789abcdef","future":true}}]}}
      """.utf8)
    let reply = try G0Transport.decodeSubscription(data, target: nil)
    let notice = try XCTUnwrap(reply.hints?.first?.notice)
    XCTAssertTrue(notice.isDisplayable)
    XCTAssertEqual(notice.deviceLabel, "测试 iPhone")
  }
}
