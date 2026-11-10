import XCTest
import Foundation
@testable import RemoteTransport

// RelaySession.prewarm opens control and bulk together. The relay's 4001 is the
// same answer for both (they reach the same room), so it must not wait for the
// slower lane; every other outcome still waits for both lanes.
final class PrewarmSettleTests: XCTestCase {
  private static let decisive: @Sendable (Error) -> Bool = { RelayTransportError.isHostOffline($0) }

  func testHostOfflineFromOneLaneAnswersWithoutWaitingForTheOther() async throws {
    let slowFinished = LockedFlag(false)
    let started = ContinuousClock.now
    do {
      try await RelaySession.settle([
        { try await Task.sleep(nanoseconds: 1_500_000_000); slowFinished.value = true },
        { try await Task.sleep(nanoseconds: 20_000_000); throw RelayTransportError.closed(code: 4001, reason: "host_offline") }
      ], decisive: Self.decisive)
      XCTFail("expected host_offline")
    } catch {
      XCTAssertTrue(RelayTransportError.isHostOffline(error), "got \(error)")
    }
    let elapsed = started.duration(to: .now)
    XCTAssertLessThan(elapsed, .milliseconds(1_000), "waited for the slower lane: \(elapsed)")
    XCTAssertFalse(slowFinished.value)
  }

  func testOrdinaryFailureStillWaitsForEveryLane() async throws {
    let slowFinished = LockedFlag(false)
    do {
      try await RelaySession.settle([
        { throw RelayTransportError.closed(code: 1013, reason: "no_host_leg") },
        { try await Task.sleep(nanoseconds: 300_000_000); slowFinished.value = true }
      ], decisive: Self.decisive)
      XCTFail("expected the lane failure")
    } catch let RelayTransportError.closed(code, _) {
      XCTAssertEqual(code, 1013)
    }
    XCTAssertTrue(slowFinished.value, "a non-decisive failure must not cut the other lane's open short")
  }

  func testEveryLaneSucceeding() async throws {
    let finished = LockedFlag(false)
    try await RelaySession.settle([
      { try await Task.sleep(nanoseconds: 10_000_000) },
      { try await Task.sleep(nanoseconds: 50_000_000); finished.value = true }
    ], decisive: Self.decisive)
    XCTAssertTrue(finished.value)
  }

  func testCancellingTheCallerCancelsTheLanes() async throws {
    let started = ContinuousClock.now
    // Built outside the Task: Swift 6.3's region checker cannot analyze a
    // closure array literal written inside the Task body.
    let jobs: [@Sendable () async throws -> Void] = [
      { try await Task.sleep(nanoseconds: 5_000_000_000) },
      { try await Task.sleep(nanoseconds: 5_000_000_000) }
    ]
    let decisive = Self.decisive
    let caller = Task { try await RelaySession.settle(jobs, decisive: decisive) }
    try await Task.sleep(nanoseconds: 50_000_000)
    caller.cancel()
    do {
      try await caller.value
      XCTFail("expected cancellation")
    } catch is CancellationError {
    }
    XCTAssertLessThan(started.duration(to: .now), .milliseconds(2_000))
  }
}
