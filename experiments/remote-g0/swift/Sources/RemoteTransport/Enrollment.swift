import Foundation
import Crypto
import X509

// Software P-256 material for G0 enrollment. The caller must persist the private
// key in its credential service before sending the public CSR. A self-signed
// bootstrap certificate is NOT an owner-device credential or a new trust root.
public struct G0EnrollmentMaterial: Sendable {
  public let privateKeyPEM: Data
  public let csrPEM: Data
  public let bootstrapPEM: Data
  public let publicKeySHA256: String

  public static func generate() throws -> G0EnrollmentMaterial {
    try make(key: P256.Signing.PrivateKey())
  }

  public static func restore(privateKeyPEM: Data) throws -> G0EnrollmentMaterial {
    guard !privateKeyPEM.isEmpty, privateKeyPEM.count <= 4096,
          let pem = String(data: privateKeyPEM, encoding: .utf8) else { throw EnrollmentError.invalidKey }
    let material = try make(key: P256.Signing.PrivateKey(pemRepresentation: pem))
    // Restore only our canonical P-256 PKCS#8 export, not a different curve's
    // scalar reinterpreted by a permissive PEM importer or a mixed key bundle.
    guard material.privateKeyPEM == privateKeyPEM else { throw EnrollmentError.invalidKey }
    return material
  }

  private static func make(key: P256.Signing.PrivateKey) throws -> G0EnrollmentMaterial {
    let fingerprint = SHA256.hash(data: key.publicKey.derRepresentation).map { String(format: "%02x", $0) }.joined()
    let subject = try DistinguishedName { CommonName("scry-unpaired-" + fingerprint.prefix(24)) }
    let signingKey = Certificate.PrivateKey(key)
    let csr = try CertificateSigningRequest(version: .v1, subject: subject, privateKey: signingKey,
      attributes: .init([]), signatureAlgorithm: .ecdsaWithSHA256)
    let extensions = try Certificate.Extensions([
      .init(BasicConstraints.notCertificateAuthority, critical: true),
      .init(KeyUsage(digitalSignature: true), critical: true),
      .init(ExtendedKeyUsage([.clientAuth]), critical: false)
    ])
    let now = Date()
    let bootstrap = try Certificate(version: .v3, serialNumber: .init(), publicKey: signingKey.publicKey,
      notValidBefore: now.addingTimeInterval(-60), notValidAfter: now.addingTimeInterval(600),
      issuer: subject, subject: subject, signatureAlgorithm: .ecdsaWithSHA256,
      extensions: extensions, issuerPrivateKey: signingKey)
    return try G0EnrollmentMaterial(privateKeyPEM: Data(key.pemRepresentation.utf8),
      csrPEM: Data(csr.serializeAsPEM().pemString.utf8),
      bootstrapPEM: Data(bootstrap.serializeAsPEM().pemString.utf8), publicKeySHA256: fingerprint)
  }
}

private enum EnrollmentError: Error { case invalidKey }
