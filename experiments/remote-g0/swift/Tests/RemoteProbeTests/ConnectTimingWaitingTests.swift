import XCTest
@testable import RemoteTransport

// A relay open that stalls before TCP (round 4: ten-second watchdog closes,
// no `tcpMs`) must say whether Network.framework was waiting for a path and
// why; that decides between the phone's network layer and the relay.
final class ConnectTimingWaitingTests: XCTestCase {
  func testWaitingKeepsTheFirstTimeAndTheLatestReason() {
    let recorder = ConnectTimingRecorder(lane: "control", route: "relay")
    recorder.markWaiting("POSIXErrorCode(rawValue: 50): Network is down")
    let firstAt = recorder.finish().waitingMs
    recorder.markWaiting("-65570: PolicyDenied")
    let timing = recorder.finish(error: ProbeError.disconnected)
    XCTAssertNotNil(firstAt)
    XCTAssertEqual(timing.waitingMs, firstAt, "the stall began at the first report")
    XCTAssertEqual(timing.waitingReason, "-65570: PolicyDenied")
    XCTAssertNil(timing.tcpMs, "never reached TCP")
    XCTAssertNotNil(timing.error)
  }

  func testAnOpenThatNeverWaitedCarriesNoWaitingFields() throws {
    let recorder = ConnectTimingRecorder(lane: "bulk", route: "relay")
    recorder.mark(\.tcpMs)
    let timing = recorder.finish()
    XCTAssertNil(timing.waitingMs)
    XCTAssertNil(timing.waitingReason)
    let json = String(decoding: try JSONEncoder().encode(timing), as: UTF8.self)
    XCTAssertFalse(json.contains("waiting"), "absent, not zero: \(json)")
  }
}
