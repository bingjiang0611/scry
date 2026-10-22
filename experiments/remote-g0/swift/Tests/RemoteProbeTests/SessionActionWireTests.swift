import XCTest
import Foundation
@testable import RemoteTransport

// The host validates each action kind by exact key. A null title/pinned/archived
// is rejected, so these tests pin the wire shape the phone actually sends.
final class SessionActionWireTests: XCTestCase {
  private let context = G0Transport.SessionActionContext(
    cwd: "/Users/me/work", providerId: "claude", externalSessionId: "abc", agentProfileId: nil)

  private func encode(_ wire: G0Transport.SessionActionWire) throws -> [String: Any] {
    let data = try JSONEncoder().encode(
      G0Transport.RunSessionActionRequest(context: context, action: wire))
    return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
  }

  func testRenameSendsOnlyTitle() throws {
    let body = try encode(G0Transport.SessionActionWire(kind: "rename", title: "新标题", pinned: nil, archived: nil))
    XCTAssertEqual(body["op"] as? String, "sessionAction")
    let action = try XCTUnwrap(body["action"] as? [String: Any])
    XCTAssertEqual(action["kind"] as? String, "rename")
    XCTAssertEqual(action["title"] as? String, "新标题")
    XCTAssertNil(action["pinned"])
    XCTAssertNil(action["archived"])
    let context = try XCTUnwrap(body["context"] as? [String: Any])
    XCTAssertEqual(context["cwd"] as? String, "/Users/me/work")
    XCTAssertEqual(context["externalSessionId"] as? String, "abc")
    XCTAssertNil(context["agentProfileId"])
  }

  func testPinAndArchiveSendTheirBoolean() throws {
    let pinned = try encode(G0Transport.SessionActionWire(kind: "pin", title: nil, pinned: true, archived: nil))
    let pinAction = try XCTUnwrap(pinned["action"] as? [String: Any])
    XCTAssertEqual(pinAction["pinned"] as? Bool, true)
    XCTAssertNil(pinAction["title"])

    let archived = try encode(G0Transport.SessionActionWire(kind: "archive", title: nil, pinned: nil, archived: false))
    let archiveAction = try XCTUnwrap(archived["action"] as? [String: Any])
    XCTAssertEqual(archiveAction["archived"] as? Bool, false)
    XCTAssertNil(archiveAction["pinned"])
  }

  func testArchiveCarriesAgentProfileWhenKnown() throws {
    let data = try JSONEncoder().encode(G0Transport.RunSessionActionRequest(
      context: G0Transport.SessionActionContext(cwd: "/w", providerId: "codex", externalSessionId: "s", agentProfileId: "profile-a"),
      action: G0Transport.SessionActionWire(kind: "archive", title: nil, pinned: nil, archived: true)))
    let body = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    let context = try XCTUnwrap(body["context"] as? [String: Any])
    XCTAssertEqual(context["agentProfileId"] as? String, "profile-a")
  }

  func testDeleteRequiresConfirmationFlag() throws {
    let data = try JSONEncoder().encode(G0Transport.RunSessionDeleteRequest(request: .init(
      providerId: "claude", cwd: "/w", externalSessionId: "s", agentProfileId: nil, confirmed: true)))
    let body = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    XCTAssertEqual(body["op"] as? String, "sessionDelete")
    let request = try XCTUnwrap(body["request"] as? [String: Any])
    XCTAssertEqual(request["confirmed"] as? Bool, true)
    XCTAssertEqual(request["externalSessionId"] as? String, "s")
    XCTAssertNil(request["agentProfileId"])
  }

  func testArchivedPageRequestOnlyAddsTheFlagWhenAsked() throws {
    var plain = G0Transport.RunSessionsPageRequest(cursor: 0, limit: 100, snapshot: nil)
    plain.keepAlive = true
    var plainBody = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(plain)) as? [String: Any])
    XCTAssertNil(plainBody["includeArchived"])

    var archived = G0Transport.RunSessionsPageRequest(cursor: 0, limit: 100, snapshot: nil)
    archived.includeArchived = true
    let archivedBody = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(archived)) as? [String: Any])
    XCTAssertEqual(archivedBody["includeArchived"] as? Bool, true)
    XCTAssertEqual(archivedBody["op"] as? String, "sessionsPage")
    plainBody = archivedBody
  }
}
