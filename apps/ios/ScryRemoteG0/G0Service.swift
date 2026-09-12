import Foundation
import RemoteTransport

// Credential material stays in this actor and the transport adapter. SwiftUI
// and its observable model receive only a public summary and a verified result.
actor G0Service {
  struct Summary: Sendable { let port: Int; let anchorDigest: String }
  struct EnrollmentProof: Sendable { let csrPEM: Data; let bootstrapPEM: Data; let publicKeySHA256: String }
  enum Failure: Error { case busy, noIdentity }
  private let keychain: G0Keychain
  private let deviceKeychain: G0Keychain
  private var running = false

  init(keychain: G0Keychain = G0Keychain()) {
    self.keychain = keychain
    self.deviceKeychain = G0Keychain(service: keychain.service, kind: .deviceKey)
  }

  // Public proof leaves the credential actor only after acknowledged Keychain save
  // and readback. Preparing a key is not pairing or local host confirmation.
  func prepareEnrollment() throws -> EnrollmentProof {
    guard !running else { throw Failure.busy }
    if try deviceKeychain.load() == nil {
      let generated = try G0EnrollmentMaterial.generate()
      do { try deviceKeychain.save(generated.privateKeyPEM) }
      catch let error as G0Keychain.Failure where error.isDuplicate {
        // Another actor created the same account first. Return its persisted
        // identity below, not the unused generated key and never overwrite it.
      }
    }
    guard let bytes = try deviceKeychain.load() else { throw Failure.noIdentity }
    let material = try G0EnrollmentMaterial.restore(privateKeyPEM: bytes)
    return EnrollmentProof(csrPEM: material.csrPEM, bootstrapPEM: material.bootstrapPEM, publicKeySHA256: material.publicKeySHA256)
  }

  func summary() throws -> Summary? {
    guard let bytes = try keychain.load() else { return nil }
    let fixture = try G0Fixture.decode(bytes)
    return Summary(port: fixture.port, anchorDigest: fixture.anchorDigest)
  }

  func importFile(_ url: URL) throws -> Summary {
    guard !running else { throw Failure.busy }
    let scoped = url.startAccessingSecurityScopedResource()
    defer { if scoped { url.stopAccessingSecurityScopedResource() } }
    let file = try FileHandle(forReadingFrom: url)
    defer { try? file.close() }
    let bytes = try file.read(upToCount: 65_537) ?? Data()
    let fixture = try G0Fixture.decode(bytes)
    try keychain.save(bytes)
    return Summary(port: fixture.port, anchorDigest: fixture.anchorDigest)
  }

  func verify() async throws {
    guard !running else { throw Failure.busy }
    running = true
    defer { running = false }
    guard let bytes = try keychain.load() else { throw Failure.noIdentity }
    let fixture = try G0Fixture.decode(bytes)
    _ = try await G0Transport.echo(port: fixture.port, identity: fixture.identity, payload: "scry-g0-" + UUID().uuidString)
  }

  func remove() throws {
    guard !running else { throw Failure.busy }
    try keychain.remove()
    try deviceKeychain.remove()
  }
}
