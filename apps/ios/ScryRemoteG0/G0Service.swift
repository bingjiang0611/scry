import Foundation
import RemoteTransport

// Credential material stays in this actor and the transport adapter. SwiftUI
// and its observable model receive only a public summary and a verified result.
actor G0Service {
  struct Summary: Sendable { let port: Int; let anchorDigest: String }
  enum Failure: Error { case busy, noIdentity }
  private let keychain: G0Keychain
  private var running = false

  init(keychain: G0Keychain = G0Keychain()) { self.keychain = keychain }

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
  }
}
