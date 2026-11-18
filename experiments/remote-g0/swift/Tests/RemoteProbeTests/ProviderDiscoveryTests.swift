import Foundation
import XCTest
@testable import RemoteTransport

final class ProviderDiscoveryTests: XCTestCase {
  func testNegotiationUsesTheExistingInfoOperationBeforeProviderQueries() throws {
    let data = try JSONEncoder().encode(G0Transport.RunProviderCapabilityRequest())
    let request = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    XCTAssertEqual(request["op"] as? String, "desktop")
    XCTAssertEqual((request["query"] as? [String: Any])?["kind"] as? String, "info")
    XCTAssertNil(request["detail"])
  }

  func testMissingCapabilityIsLegacyNotSelectedSupport() throws {
    let legacy = Data(#"{"desktop":{"kind":"info","protocol":2,"execution":"canonical"}}"#.utf8)
    let current = Data(#"{"desktop":{"kind":"info","protocol":2,"execution":"canonical","providerDiscovery":2}}"#.utf8)
    XCTAssertNil(try G0Transport.providerDiscoveryCapability(legacy))
    XCTAssertEqual(try G0Transport.providerDiscoveryCapability(current), 2)
    let unsupported = Data(#"{"desktop":{"kind":"info","protocol":2,"execution":"canonical","providerDiscovery":3}}"#.utf8)
    XCTAssertThrowsError(try G0Transport.providerDiscoveryCapability(unsupported))
  }

  // The host answers `info` with REMOTE_PROTOCOL_VERSION (src/shared/desktop-remote.ts),
  // the same version this client stamps on every relay request. An info reply carrying
  // any other version is not this protocol and must not be read as a capability.
  func testInfoReplyMustCarryTheRelayProtocolVersion() throws {
    XCTAssertEqual(RelaySession.protocolVersion, 2)
    let host = Data(#"{"desktop":{"kind":"info","protocol":2,"hostId":"h","execution":"canonical","traceDelta":1,"providerDiscovery":2}}"#.utf8)
    XCTAssertEqual(try G0Transport.providerDiscoveryCapability(host), 2)
    let stale = Data(#"{"desktop":{"kind":"info","protocol":1,"execution":"canonical","providerDiscovery":2}}"#.utf8)
    XCTAssertThrowsError(try G0Transport.providerDiscoveryCapability(stale))
  }

  func testSelectedReplyRequiresTheNegotiatedMarker() throws {
    let legacy = Data(#"{"providers":[{"id":"pi","label":"Pi","available":true,"agentProfileId":"pi:fixture"}]}"#.utf8)
    let current = Data(#"{"providerDiscovery":2,"providers":[{"id":"pi","label":"Pi","available":true,"agentProfileId":"pi:fixture"}]}"#.utf8)
    XCTAssertThrowsError(try G0Transport.decodeProviderDiscovery(legacy, detail: "selected"))
    XCTAssertEqual(try G0Transport.decodeProviderDiscovery(current, detail: "selected").capability, 2)
    XCTAssertEqual(try G0Transport.decodeProviderDiscovery(legacy, detail: nil).providers.count, 1)
  }

  func testObservationTimeIsPreservedAndInvalidTimesAreRejected() throws {
    let current = Data(#"{"providerDiscovery":2,"providers":[{"id":"pi","label":"Pi","available":true,"observedAt":1700000000000}]}"#.utf8)
    XCTAssertEqual(try G0Transport.decodeProviderDiscovery(current, detail: "selected").providers.first?.observedAt, 1700000000000)
    for invalid in ["-1", "1.5", "1e300"] {
      let data = Data("{\"providerDiscovery\":2,\"providers\":[{\"id\":\"pi\",\"label\":\"Pi\",\"available\":true,\"observedAt\":\(invalid)}]}".utf8)
      XCTAssertThrowsError(try G0Transport.decodeProviderDiscovery(data, detail: "selected"))
    }
  }

  func testAuthorizationErrorsRemainErrorsInsteadOfLegacyFallback() throws {
    let denied = Data(#"{"error":"device_not_authorized"}"#.utf8)
    XCTAssertThrowsError(try G0Transport.providerDiscoveryCapability(denied))
    XCTAssertThrowsError(try G0Transport.decodeProviderDiscovery(denied, detail: "selected"))
  }
}
