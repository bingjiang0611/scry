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

  func testInvalidBoundsAndProvenanceFailClosed() throws {
    XCTAssertThrowsError(try page(offset: -1).validate())
    XCTAssertThrowsError(try page(total: 0).validate())
    XCTAssertThrowsError(try page(offset: Int.max, total: Int.max).validate())
    XCTAssertThrowsError(try page(source: "unavailable").validate())
    XCTAssertThrowsError(try page(completeness: "unknown").validate())
  }
}
