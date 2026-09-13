import Foundation

// The out-of-band pairing code the Mac displays (QR or copyable string). It is
// the ONLY channel that bootstraps trust: the device pins the host anchor from
// here, so a tampered/MITM relay cannot impersonate the host. The code is
// `scry1:` + base64url(JSON) with no padding. It carries the relay endpoint, the
// stable hostId the relay routes by, the short-lived pairingId + single-use
// secret, and the full host CA (anchor) PEM the device pins for the inner TLS.
//
// This is the device's view of the contract; the Mac emits exactly this shape.
// It intentionally carries the anchor PEM (not just its SHA-256) so the device
// has a concrete trust root without a second fetch.
struct PairingCode: Equatable {
  // Outer transport TLS to the relay, declared by the Mac. `.system` is a public
  // wss relay (e.g. Cloudflare, publicly-trusted cert); `.plaintext` is a local
  // ws dev relay. This is not the trust root — the inner mTLS pins the anchor.
  enum RelayTLS: String, Equatable { case system, plaintext }

  let relayHost: String
  let relayPort: Int
  let relayTLS: RelayTLS
  let hostId: String
  let pairingId: String
  let secret: String
  let anchorPEM: String

  enum ParseError: Error, Equatable { case badPrefix, badBase64, badJSON, invalidField(String) }

  private static let uuid = try! NSRegularExpression(pattern: "^[0-9a-fA-F-]{36}$")
  private static let secretPattern = try! NSRegularExpression(pattern: "^[A-Za-z0-9_-]{43}$")

  private struct Payload: Decodable {
    let relayHost: String
    let relayPort: Int
    let relayTLS: String?
    let hostId: String
    let pairingId: String
    let secret: String
    let anchorPEM: String
  }

  static func parse(_ raw: String) throws -> PairingCode {
    let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    guard trimmed.hasPrefix("scry1:") else { throw ParseError.badPrefix }
    let encoded = String(trimmed.dropFirst("scry1:".count))
    guard let data = base64urlDecode(encoded) else { throw ParseError.badBase64 }
    guard let payload = try? JSONDecoder().decode(Payload.self, from: data) else { throw ParseError.badJSON }
    try validate(field: "relayHost", payload.relayHost.count >= 1 && payload.relayHost.count <= 253)
    try validate(field: "relayPort", (1...65535).contains(payload.relayPort))
    try validate(field: "hostId", matches(uuid, payload.hostId))
    try validate(field: "pairingId", matches(uuid, payload.pairingId))
    try validate(field: "secret", matches(secretPattern, payload.secret))
    try validate(field: "anchorPEM", payload.anchorPEM.contains("BEGIN CERTIFICATE") && payload.anchorPEM.contains("END CERTIFICATE"))
    // Default to the secure public-wss mode when the field is absent; a local
    // dev relay must explicitly opt into plaintext.
    guard let relayTLS = RelayTLS(rawValue: payload.relayTLS ?? "system") else { throw ParseError.invalidField("relayTLS") }
    return PairingCode(relayHost: payload.relayHost, relayPort: payload.relayPort, relayTLS: relayTLS, hostId: payload.hostId,
                       pairingId: payload.pairingId, secret: payload.secret, anchorPEM: payload.anchorPEM)
  }

  private static func matches(_ re: NSRegularExpression, _ value: String) -> Bool {
    re.firstMatch(in: value, range: NSRange(value.startIndex..., in: value)) != nil
  }
  private static func validate(field: String, _ ok: Bool) throws { if !ok { throw ParseError.invalidField(field) } }

  static func base64urlDecode(_ value: String) -> Data? {
    var s = value.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
    let pad = s.count % 4
    if pad > 0 { s += String(repeating: "=", count: 4 - pad) }
    return Data(base64Encoded: s)
  }

  static func base64urlEncode(_ data: Data) -> String {
    data.base64EncodedString()
      .replacingOccurrences(of: "+", with: "-")
      .replacingOccurrences(of: "/", with: "_")
      .replacingOccurrences(of: "=", with: "")
  }
}
