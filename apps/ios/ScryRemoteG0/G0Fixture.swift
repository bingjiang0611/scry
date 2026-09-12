import Foundation
import CryptoKit
import RemoteTransport

// Local installation material for the isolated G0 app, NOT the pairing protocol.
// No endpoint URLs, commands, credentials for real Providers or project paths.
struct G0Fixture: Codable, Equatable {
  let version: Int
  let port: Int
  let outerCA: Data
  let innerCA: Data
  let certificate: Data
  let privateKey: Data

  enum Failure: Error { case invalidMaterial }
  static func decode(_ bytes: Data) throws -> G0Fixture {
    guard bytes.count <= 65_536,
          let object = try JSONSerialization.jsonObject(with: bytes) as? [String: Any],
          Set(object.keys) == Set(["version", "port", "outerCA", "innerCA", "certificate", "privateKey"]) else { throw Failure.invalidMaterial }
    let fixture = try JSONDecoder().decode(G0Fixture.self, from: bytes)
    guard fixture.version == 1, (1...65535).contains(fixture.port),
          [fixture.outerCA, fixture.innerCA, fixture.certificate, fixture.privateKey].allSatisfy({ !$0.isEmpty && $0.count <= 16_384 }) else { throw Failure.invalidMaterial }
    return fixture
  }

  var identity: G0ProbeIdentity {
    G0ProbeIdentity(outerCA: outerCA, innerCA: innerCA, certificate: certificate, privateKey: privateKey)
  }
  var anchorDigest: String { SHA256.hash(data: innerCA).map { String(format: "%02x", $0) }.joined() }
}
