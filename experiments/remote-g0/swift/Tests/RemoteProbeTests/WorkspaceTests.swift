import XCTest
@testable import RemoteTransport

final class WorkspaceTests: XCTestCase {
  func testWorkspaceEvidenceIsDiscriminated() throws {
    let decoder = JSONDecoder()
    let unknown = Data(#"{"action":"status","state":"not_observed","observedAt":"now"}"#.utf8)
    guard case let .status(status) = try decoder.decode(G0Transport.WorkspaceResult.self, from: unknown) else {
      return XCTFail("wrong result")
    }
    XCTAssertEqual(status.state, .not_observed)
    let unavailable = Data(#"{"action":"diff","diff":{"status":"unavailable","reason":"not_git","patch":"","truncated":false}}"#.utf8)
    guard case let .diff(diff) = try decoder.decode(G0Transport.WorkspaceResult.self, from: unavailable) else {
      return XCTFail("wrong result")
    }
    XCTAssertEqual(diff.status, .unavailable)
    XCTAssertEqual(diff.reason, "not_git")
    for json in [#"{"action":"file"}"#, #"{"action":"status","observedAt":"now"}"#, #"{"action":"write"}"#] {
      XCTAssertThrowsError(try decoder.decode(G0Transport.WorkspaceResult.self, from: Data(json.utf8)))
    }
  }

  func testWorkspaceQueryPreservesScopeAndPagination() throws {
    let query = G0Transport.WorkspaceQuery(action: .file, cwd: "/project with spaces", path: "src/文.swift", offset: 65536, snapshot: "expected")
    let object = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(query)) as? [String: Any])
    XCTAssertEqual(object["cwd"] as? String, "/project with spaces")
    XCTAssertEqual(object["path"] as? String, "src/文.swift")
    XCTAssertEqual(object["snapshot"] as? String, "expected")
    XCTAssertEqual(object["offset"] as? Int, 65536)
    XCTAssertNil(object["providerId"])
  }
}
