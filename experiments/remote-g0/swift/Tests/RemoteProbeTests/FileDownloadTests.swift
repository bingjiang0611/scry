import Foundation
import XCTest
@testable import RemoteTransport

final class FileDownloadTests: XCTestCase {
  private func page(_ changes: [String: Any] = [:]) throws -> G0Transport.FileDownloadPage {
    var value: [String: Any] = ["id": "opaque", "name": "a.unknown", "totalBytes": 4,
      "offset": 0, "nextOffset": 4, "data": Data([0, 1, 128, 255]).base64EncodedString(), "hasMore": false]
    changes.forEach { value[$0.key] = $0.value }
    return try JSONDecoder().decode(G0Transport.FileDownloadPage.self, from: JSONSerialization.data(withJSONObject: value))
  }
  func testPreservesArbitraryFileBytesAndRejectsMixedTransfers() throws {
    XCTAssertEqual(try page().bytes(expectedOffset: 0, expectedID: nil), Data([0, 1, 128, 255]))
    XCTAssertThrowsError(try page().bytes(expectedOffset: 1, expectedID: nil))
    XCTAssertThrowsError(try page().bytes(expectedOffset: 0, expectedID: "another"))
    for changed: [String: Any] in [["nextOffset": 3], ["totalBytes": 5], ["data": "not base64"], ["name": "../outside"], ["name": ".."], ["offset": -1]] {
      XCTAssertThrowsError(try page(changed).bytes(expectedOffset: 0, expectedID: nil))
    }
  }
  func testEnforcesChunkBoundAndProgressWithoutRejectingEmptyFiles() throws {
    XCTAssertEqual(try page(["data": "", "nextOffset": 0, "totalBytes": 0]).bytes(expectedOffset: 0, expectedID: nil), Data())
    XCTAssertThrowsError(try page(["data": "", "nextOffset": 0, "hasMore": true]).bytes(expectedOffset: 0, expectedID: nil))
    let large = Data(repeating: 42, count: 256 * 1024 + 1)
    XCTAssertThrowsError(try page(["data": large.base64EncodedString(), "nextOffset": large.count, "totalBytes": large.count])
      .bytes(expectedOffset: 0, expectedID: nil))
  }
  func testQueryKeepsRealURLAndOnlyExplicitlySelectedFile() throws {
    let target = "http://127.0.0.1:49732/bolder-v1.html?x=1"
    let value = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(
      G0Transport.FileDownloadQuery.open(cwd: "/repo", target: target))) as? [String: Any])
    XCTAssertEqual(value["target"] as? String, target)
    XCTAssertEqual(Set(value.keys), ["action", "cwd", "target"])
    let read = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(
      G0Transport.FileDownloadQuery.read(cwd: "/repo", id: "opaque", offset: 262144))) as? [String: Any])
    XCTAssertNil(read["target"])
    XCTAssertEqual(read["offset"] as? Int, 262144)
  }
  func testNativeHistorySourceAndArchiveWarningAreRecognized() throws {
    let native = G0Transport.RunHistoryTurnsPage(turns: [], offset: 0, totalTurns: 0, hasOlder: false,
      snapshot: "version", source: "pi_native", completeness: "complete")
    XCTAssertNoThrow(try native.validate())
    let warning = G0Transport.RunHistoryTurnsPage(turns: [], offset: 0, totalTurns: 0, hasOlder: false,
      snapshot: "version", source: "monolithic", completeness: "complete", sourceWarning: "native_unavailable")
    XCTAssertNoThrow(try warning.validate())
    XCTAssertEqual(try JSONDecoder().decode(G0Transport.RunHistoryTurnsPage.self, from: JSONEncoder().encode(warning)).sourceWarning, "native_unavailable")
  }
}
