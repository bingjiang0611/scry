import XCTest
@testable import RemoteTransport

// The Mac persists one session's latest turn outcome and sends it in the session
// catalog. The device must read the host's own vocabulary, treat an absent or
// unrecognized value as unknown (never as success), and stay decodable for hosts
// that predate the field.
final class SessionCatalogOutcomeTests: XCTestCase {
  private func decode(_ json: String) throws -> G0Transport.RunSessionRef {
    try JSONDecoder().decode(G0Transport.RunSessionRef.self, from: Data(json.utf8))
  }

  func testHostOutcomeDecodesForEveryWireValue() throws {
    let cases: [(String, G0Transport.RunSessionRef.TurnOutcome)] = [("completed", .completed), ("failed", .failed),
                                                                  ("cancelled", .cancelled), ("interrupted", .interrupted)]
    for (wire, expected) in cases {
      let row = try decode(#"{"sessionId":"s","providerId":"codex","cwd":"/repo","label":"t","ts":1,"lastRunOutcome":"\#(wire)"}"#)
      XCTAssertEqual(row.turnOutcome, expected)
    }
  }

  func testOlderHostWithoutOutcomeIsUnknownNotEmpty() throws {
    let row = try decode(#"{"sessionId":"s","providerId":"codex","cwd":"/repo","label":"t","ts":1}"#)
    XCTAssertNil(row.lastRunOutcome)
    XCTAssertNil(row.turnOutcome)
  }

  // A value outside the host's own set proves nothing about the ending.
  func testUnrecognizedOutcomeIsUnknown() throws {
    let row = try decode(#"{"sessionId":"s","providerId":"codex","cwd":"/repo","label":"t","ts":1,"lastRunOutcome":"success"}"#)
    XCTAssertEqual(row.lastRunOutcome, "success")
    XCTAssertNil(row.turnOutcome)
  }
}
