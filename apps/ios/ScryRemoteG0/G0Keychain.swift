import Foundation
import Security
import RemoteTransport

struct G0Keychain {
  enum Kind: String { case fixture = "current-test-identity", deviceKey = "enrollment-private-key" }
  let service: String
  private let kind: Kind
  init(service: String = "com.scry.remote.g0.fixture", kind: Kind = .fixture) {
    self.service = service
    self.kind = kind
  }
  struct Failure: Error {
    let status: OSStatus
    var isDuplicate: Bool { status == errSecDuplicateItem }
  }

  private var query: [String: Any] {
    [kSecClass as String: kSecClassGenericPassword,
     kSecAttrService as String: service,
     kSecAttrAccount as String: kind.rawValue,
     kSecAttrSynchronizable as String: false]
  }

  func load() throws -> Data? {
    var request = query
    request[kSecReturnData as String] = true
    request[kSecMatchLimit as String] = kSecMatchLimitOne
    var result: CFTypeRef?
    let status = SecItemCopyMatching(request as CFDictionary, &result)
    if status == errSecItemNotFound { return nil }
    guard status == errSecSuccess, let bytes = result as? Data else { throw Failure(status: status) }
    return bytes
  }

  func save(_ bytes: Data) throws {
    // Validate first; update in place. Never delete the old identity before a
    // fallible write, and do not silently fall back to UserDefaults/plain files.
    switch kind {
    case .fixture: _ = try G0Fixture.decode(bytes)
    case .deviceKey: _ = try G0EnrollmentMaterial.restore(privateKeyPEM: bytes)
    }
    let attributes: [String: Any] = [
      kSecValueData as String: bytes,
      kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    ]
    // Enrollment key creation is insert-only. Two actors must not silently
    // replace one another's key after a read-missing race.
    if kind == .deviceKey {
      let status = SecItemAdd(query.merging(attributes) { _, new in new } as CFDictionary, nil)
      guard status == errSecSuccess else { throw Failure(status: status) }
      return
    }
    var status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
    if status == errSecItemNotFound {
      status = SecItemAdd(query.merging(attributes) { _, new in new } as CFDictionary, nil)
    }
    guard status == errSecSuccess else { throw Failure(status: status) }
  }

  func remove() throws {
    let status = SecItemDelete(query as CFDictionary)
    guard status == errSecSuccess || status == errSecItemNotFound else { throw Failure(status: status) }
  }
}
