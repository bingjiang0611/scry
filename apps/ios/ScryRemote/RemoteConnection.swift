import Foundation

// Non-secret connection descriptor captured at pairing so the device can reach
// the SAME host again for run operations without re-scanning a QR. The device
// private key + the CA-granted certificate stay in the Keychain; this only holds
// PUBLIC routing/trust material: relay coordinates, the hostId the relay routes
// by, the anchor (host CA) PEM the device pins for the inner TLS, and the
// device's own grant id. Persisted in UserDefaults (nothing here is a secret).
struct RemoteConnection: Codable, Equatable {
  var relayHost: String
  var relayPort: Int
  var relayTLS: String   // "system" | "plaintext" — mirrors PairingCode.RelayTLS
  var hostId: String
  var anchorPEM: String
  var deviceId: String
}

struct RemoteConnectionStore {
  let defaults: UserDefaults
  let key: String
  init(defaults: UserDefaults = .standard, key: String = "com.scry.remote.connection") {
    self.defaults = defaults
    self.key = key
  }

  func load() -> RemoteConnection? {
    guard let data = defaults.data(forKey: key) else { return nil }
    return try? JSONDecoder().decode(RemoteConnection.self, from: data)
  }

  func save(_ connection: RemoteConnection) {
    guard let data = try? JSONEncoder().encode(connection) else { return }
    defaults.set(data, forKey: key)
  }

  func clear() { defaults.removeObject(forKey: key) }
}
