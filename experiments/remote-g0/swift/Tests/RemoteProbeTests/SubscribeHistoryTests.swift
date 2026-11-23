import Foundation
import XCTest
@testable import RemoteTransport

final class SubscribeHistoryTests: XCTestCase {
  func testIdleRepliesKeepTheVerifiedVersionAfterAHistoryInvalidation() throws {
    let session = G0Transport.SubscriptionSession(sessionKey: "session", providerId: "codex", cwd: "/test",
      externalSessionId: "native", agentProfileId: nil)
    let first = G0Transport.SubscriptionCursor(hostId: "mac", logId: "log", seq: 1)
    var detail = G0Transport.SubscriptionDetail(session: session, cursor: first, page: nil)
    let version = G0Transport.RunHistoryVersion(version: "version-after-turn", readMode: "indexed")
    func reply(seq: Int, mode: String, events: String = "[]") throws -> G0Transport.SubscriptionReply {
      try G0Transport.decodeSubscription(Data("""
        {"subscribe":{"hostId":"mac","logId":"log","seq":\(seq),"mode":"\(mode)","events":\(events)}}
        """.utf8), target: nil)
    }
    let turn = try reply(seq: 2, mode: "events",
      events: #"[{"seq":2,"at":10,"type":"turn.delivery","stream":"session:session","payload":{}}]"#)
    let next = try turn.cursor(for: "mac")
    XCTAssertTrue(detail.advance(with: turn, cursor: next))
    XCTAssertNil(detail.version)
    detail.version = version

    let idle = try reply(seq: 3, mode: "idle")
    XCTAssertFalse(detail.advance(with: idle, cursor: try idle.cursor(for: "mac")))
    XCTAssertNil(detail.page, "The user has remained on the older page")
    XCTAssertEqual(detail.version, version, "No fresh version RPC is required on an idle response")
    XCTAssertEqual(detail.changedAt, next, "Unrelated cursor advancement is not a history invalidation")

    let changed = try reply(seq: 4, mode: "events",
      events: #"[{"seq":4,"at":10,"type":"run.settled","stream":"session:session","payload":{}}]"#)
    XCTAssertTrue(detail.advance(with: changed, cursor: try changed.cursor(for: "mac")))
    XCTAssertNil(detail.version, "A new history event must be checked")
  }

  func testOfflineTargetIsRecoverableButAuthorizationAndVersionAreTerminal() {
    for code in ["desktop_not_connected", "execution_target_gateway_offline", "execution_target_timeout", "execution_target_bridge_busy", "mux_busy"] {
      XCTAssertTrue(G0Transport.RunError.host(code: code).isRecoverableReadRefusal, code)
    }
    for code in ["device_not_authorized", "subscribe_unsupported", "protocol_upgrade_host", "execution_target_binding_changed"] {
      XCTAssertFalse(G0Transport.RunError.host(code: code).isRecoverableReadRefusal, code)
    }
  }
}
