import Foundation
import XCTest
@testable import ScryRemoteG0

final class G0Tests: XCTestCase {
  private func material(port: Int = 12345) throws -> Data {
    try JSONEncoder().encode(G0Fixture(version: 1, port: port, outerCA: Data("ca".utf8), innerCA: Data("host-ca".utf8), certificate: Data("device".utf8), privateKey: Data("test-only-key".utf8)))
  }

  func testFixtureBoundsAndUnexpectedFields() throws {
    XCTAssertEqual(try G0Fixture.decode(material()).port, 12345)
    XCTAssertThrowsError(try G0Fixture.decode(material(port: 0)))
    XCTAssertThrowsError(try G0Fixture.decode(material(port: 65536)))
    XCTAssertThrowsError(try G0Fixture.decode(Data(repeating: 32, count: 65_537)))
    var object = try XCTUnwrap(JSONSerialization.jsonObject(with: material()) as? [String: Any])
    object["command"] = "run.start"
    XCTAssertThrowsError(try G0Fixture.decode(JSONSerialization.data(withJSONObject: object)))
  }

  func testKeychainRoundTripAndFailedImportPreservesIdentity() throws {
    // A unique test service: never touch the actual G0 app's saved identity or
    // the user's developer-signing key. Cleanup only this exact service/item.
    let vault = G0Keychain(service: "com.scry.remote.g0.test." + UUID().uuidString)
    defer { try? vault.remove() }
    XCTAssertNil(try vault.load())
    let original = try material()
    try vault.save(original)
    XCTAssertEqual(try vault.load(), original)
    XCTAssertThrowsError(try vault.save(Data("not-json".utf8)))
    XCTAssertEqual(try vault.load(), original)
    try vault.remove()
    XCTAssertNil(try vault.load())
  }

  @MainActor
  func testSimulatorTLSFromKeychain() async throws {
    let documents = try XCTUnwrap(FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first)
    let file = documents.appendingPathComponent("g0-loopback-test-fixture.json")
    guard FileManager.default.fileExists(atPath: file.path) else {
      throw XCTSkip("Run experiments/remote-g0/ios-smoke.mjs to supply temporary certificates and a live relay")
    }
    let vault = G0Keychain(service: "com.scry.remote.g0.test." + UUID().uuidString)
    defer { try? vault.remove(); try? FileManager.default.removeItem(at: file) }
    let model = G0Model(service: G0Service(keychain: vault))
    XCTAssertEqual(model.phase, .noIdentity)
    await model.reload()
    XCTAssertEqual(model.phase, .noIdentity)
    await model.importFile(file)
    XCTAssertEqual(model.phase, .ready)
    try FileManager.default.removeItem(at: file)
    // The only remaining private material is in Keychain. Concurrent UI intent
    // must not create two probe operations while the first is awaiting TLS.
    let first = Task { await model.run() }
    let second = Task { await model.run() }
    await first.value
    await second.value
    XCTAssertEqual(model.phase, .verified, model.explanation)
    await model.remove()
    XCTAssertEqual(model.phase, .noIdentity)
  }
}
