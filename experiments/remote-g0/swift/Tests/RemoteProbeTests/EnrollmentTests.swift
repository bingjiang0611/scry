import Foundation
import XCTest
import X509
import NIOSSL
@testable import RemoteTransport

final class EnrollmentTests: XCTestCase {
  func testSoftwareKeyCSRAndBootstrapRoundTrip() throws {
    let material = try G0EnrollmentMaterial.generate()
    let restored = try G0EnrollmentMaterial.restore(privateKeyPEM: material.privateKeyPEM)
    XCTAssertEqual(material.publicKeySHA256, restored.publicKeySHA256)
    XCTAssertEqual(material.privateKeyPEM, restored.privateKeyPEM)
    let csr = try CertificateSigningRequest(pemEncoded: String(decoding: material.csrPEM, as: UTF8.self))
    let certificate = try Certificate(pemEncoded: String(decoding: material.bootstrapPEM, as: UTF8.self))
    XCTAssertTrue(csr.publicKey.isValidSignature(csr.signature, for: csr))
    XCTAssertEqual(csr.publicKey, certificate.publicKey)
    XCTAssertEqual(try certificate.extensions.basicConstraints, .notCertificateAuthority)
    _ = try NIOSSLPrivateKey(bytes: Array(material.privateKeyPEM), format: .pem)
    XCTAssertEqual(try NIOSSLCertificate.fromPEMBytes(Array(material.bootstrapPEM)).count, 1)
  }

  func testInvalidOrOversizedKeyIsNotRestored() throws {
    XCTAssertThrowsError(try G0EnrollmentMaterial.restore(privateKeyPEM: Data()))
    XCTAssertThrowsError(try G0EnrollmentMaterial.restore(privateKeyPEM: Data(repeating: 65, count: 4097)))
    XCTAssertThrowsError(try G0EnrollmentMaterial.restore(privateKeyPEM: Data("not a private key".utf8)))
    let valid = try G0EnrollmentMaterial.generate().privateKeyPEM
    XCTAssertThrowsError(try G0EnrollmentMaterial.restore(privateKeyPEM: valid + Data("\n".utf8)))
    XCTAssertThrowsError(try G0EnrollmentMaterial.restore(privateKeyPEM: valid + valid))
  }
}
