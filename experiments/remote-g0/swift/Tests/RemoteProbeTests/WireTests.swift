import Foundation
import XCTest
@testable import RemoteTransport

final class WireTests: XCTestCase {
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
      let decode = {
        if type == "ProbeRequest" { _ = try JSONDecoder().decode(ProbeRequest.self, from: bytes) }
        else { _ = try JSONDecoder().decode(ProbeResponse.self, from: bytes) }
      }
      if valid { XCTAssertNoThrow(try decode(), name) }
      else { XCTAssertThrowsError(try decode(), name) }
    }
  }

  func testScalarBoundsAndConstruction() throws {
    XCTAssertNoThrow(try ProbeRequest(protocolMajor: 1, requestId: "request", operation: "probe.echo", payload: String(repeating: "🧭", count: 4096)))
    XCTAssertThrowsError(try ProbeRequest(protocolMajor: 1, requestId: "request", operation: "probe.echo", payload: String(repeating: "🧭", count: 4097)))
    XCTAssertThrowsError(try ProbeRequest(protocolMajor: 1, requestId: String(repeating: "x", count: 65), operation: "probe.echo", payload: ""))
    let malformed = Data(#"{"protocolMajor":1,"requestId":"request","operation":"probe.echo","payload":"\ud800"}"#.utf8)
    XCTAssertThrowsError(try JSONDecoder().decode(ProbeRequest.self, from: malformed))
  }
}
