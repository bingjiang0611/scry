import XCTest
@testable import RemoteTransport

final class HistoryTurnsPageTests: XCTestCase {
  private func page(offset: Int = 0, total: Int = 1, source: String = "indexed_archive",
                    completeness: String = "partial") -> G0Transport.RunHistoryTurnsPage {
    .init(turns: [.init(userText: "real question", items: [.init(kind: "output", text: "real answer")])],
          offset: offset, totalTurns: total, hasOlder: offset > 0,
          snapshot: "source-version", source: source, completeness: completeness)
  }

  func testOlderOnlyRangeIsPartialEvenWhenItReachesZero() throws {
    XCTAssertNoThrow(try page(total: 5).validate())
    XCTAssertThrowsError(try page(total: 5, completeness: "complete").validate())
  }

  func testLiveOnlyMemoryIsNotCompleteHistory() throws {
    XCTAssertNoThrow(try page(source: "active_memory").validate())
    XCTAssertThrowsError(try page(source: "active_memory", completeness: "complete").validate())
    XCTAssertNoThrow(try page(completeness: "complete").validate())
  }

  // The host stamps the page with its signed source-version token:
  // `<archive>:<transcript>:<0|1>:<active>:<native>:<signature>` = 294 chars.
  // A 256-byte bound rejected every real session-scope page, so the device could
  // only ever paint the 2-turn preview and never the recent window.
  func testRealSignedSourceVersionTokenIsAccepted() throws {
    let hex = String(repeating: "a", count: 64)
    let token = [hex, hex, "0", hex, hex, String(repeating: "b", count: 32)].joined(separator: ":")
    XCTAssertEqual(token.count, 294)
    let stamped = G0Transport.RunHistoryTurnsPage(turns: [.init(userText: "real question",
      items: [.init(kind: "output", text: "real answer")])], offset: 0, totalTurns: 1, hasOlder: false,
      snapshot: token, source: "pi_native", completeness: "complete")
    XCTAssertNoThrow(try stamped.validate())
    XCTAssertThrowsError(try G0Transport.RunHistoryTurnsPage(turns: stamped.turns, offset: 0, totalTurns: 1,
      hasOlder: false, snapshot: String(repeating: "a", count: 1_024), source: "pi_native",
      completeness: "complete").validate())
  }

  func testInvalidBoundsAndProvenanceFailClosed() throws {
    XCTAssertThrowsError(try page(offset: -1).validate())
    XCTAssertThrowsError(try page(total: 0).validate())
    XCTAssertThrowsError(try page(offset: Int.max, total: Int.max).validate())
    XCTAssertThrowsError(try page(source: "unavailable").validate())
    XCTAssertThrowsError(try page(completeness: "unknown").validate())
  }
}
