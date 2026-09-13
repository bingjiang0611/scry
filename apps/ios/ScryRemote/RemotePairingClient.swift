import Foundation
import RemoteTransport

// Device-side pairing orchestration over the PROVEN relay transport
// (ScryG0Transport). It generates/restores the device keypair (private key lives
// only in Keychain, insert-only), presents its self-signed bootstrap cert so the
// host derives the possession-proving key fingerprint from the TLS peer cert,
// pins the host anchor from the pairing code, and drives prove -> (Mac user
// confirms) -> re-prove -> granted. It NEVER fabricates a paired state: a pending
// receipt carries no certificate; only a host-issued grant does.
//
// Honesty on the outer hop: a publicly deployed relay is wss:// and the device
// must pin the relay CA (or a public root). The pairing code does not yet carry
// that, so today the client dials the relay without an outer-CA (the local smoke
// relay is ws://); the inner TLS 1.3 mTLS to the host is the real security root
// regardless. Wiring the outer relay CA is a deployment follow-up, not new
// crypto. Full on-device pairing still needs a reachable relay + running host.
enum PairingProgress: Equatable {
  case awaitingConfirmation(publicKeySHA256: String)
  case paired(deviceId: String, certificatePEM: String)
  case revoked(deviceId: String)
  case denied(code: String)
}

struct RemotePairingClient {
  let keychain: RemoteKeychain
  init(keychain: RemoteKeychain = RemoteKeychain()) { self.keychain = keychain }

  // Restore the one device key, or create it exactly once (insert-only).
  func ensureDeviceMaterial() throws -> G0EnrollmentMaterial {
    if let existing = try keychain.load(.deviceKey) {
      return try G0EnrollmentMaterial.restore(privateKeyPEM: existing)
    }
    let material = try G0EnrollmentMaterial.generate()
    do { try keychain.insertDeviceKey(material.privateKeyPEM) }
    catch let failure as RemoteKeychain.Failure where failure.isDuplicate {
      // Lost a creation race; adopt the persisted key instead of overwriting.
      guard let winner = try keychain.load(.deviceKey) else { throw failure }
      return try G0EnrollmentMaterial.restore(privateKeyPEM: winner)
    }
    return material
  }

  private func endpoint(_ code: PairingCode) -> G0Transport.RelayEndpoint {
    // A public wss relay (Cloudflare) trusts the platform's public roots; a local
    // dev relay is plain ws. The inner mTLS still pins the host anchor either way.
    let outerTLS: G0Transport.RelayEndpoint.OuterTLS = code.relayTLS == .system ? .system : .plaintext
    return G0Transport.RelayEndpoint(host: code.relayHost, port: code.relayPort, hostId: code.hostId, outerTLS: outerTLS)
  }

  private func identity(_ code: PairingCode, _ material: G0EnrollmentMaterial) throws -> G0ProbeIdentity {
    // outerCA empty: the outer TLS trust decision is the endpoint's OuterTLS mode
    // (system roots for public wss), not a code-carried CA. Inner mTLS pins the
    // host anchor and presents the self-signed bootstrap cert for possession proof.
    try G0ProbeIdentity(outerCA: Data(), innerCA: Data(code.anchorPEM.utf8),
                        certificate: material.bootstrapPEM, privateKey: material.privateKeyPEM)
  }

  private func map(_ outcome: G0Transport.PairOutcome) throws -> PairingProgress {
    switch outcome {
    case let .pending(key): return .awaitingConfirmation(publicKeySHA256: key)
    case let .granted(certificatePEM, deviceId, _):
      try keychain.upsertGrantedCert(Data(certificatePEM.utf8))
      return .paired(deviceId: deviceId, certificatePEM: certificatePEM)
    case let .revoked(deviceId): return .revoked(deviceId: deviceId)
    case let .denied(code): return .denied(code: code)
    }
  }

  // Prove key possession for this pairing code. Before local confirmation this
  // returns .awaitingConfirmation; the caller polls `refresh` until the Mac user
  // approves and a grant is issued.
  func prove(code: PairingCode, deviceLabel: String) async throws -> PairingProgress {
    let material = try ensureDeviceMaterial()
    let outcome = try await G0Transport.relayPairProve(
      endpoint: endpoint(code), identity: try identity(code, material),
      pairingId: code.pairingId, secret: code.secret,
      csrPEM: String(decoding: material.csrPEM, as: UTF8.self), deviceLabel: deviceLabel)
    return try map(outcome)
  }

  // Re-prove after the operator confirms on the Mac: the host returns the granted
  // certificate to the device that still holds the proving key.
  func refresh(code: PairingCode, deviceLabel: String) async throws -> PairingProgress {
    try await prove(code: code, deviceLabel: deviceLabel)
  }
}
