import Foundation
import Security

// Device credential storage. The device private key is created ONCE and is
// insert-only: two actors must never silently replace one another's key after a
// read-missing race, and we never fall back to UserDefaults or a plain file. The
// granted certificate (issued by the host after local confirmation) is stored
// separately and may be updated on renewal. Both are device-only, available
// after first unlock, and never synchronized to iCloud.
struct RemoteKeychain {
  enum Item: String { case deviceKey = "device-private-key", grantedCert = "granted-certificate" }
  let service: String
  init(service: String = "com.scry.remote.credentials") { self.service = service }

  struct Failure: Error { let status: OSStatus; var isDuplicate: Bool { status == errSecDuplicateItem } }

  private func query(_ item: Item) -> [String: Any] {
    [kSecClass as String: kSecClassGenericPassword,
     kSecAttrService as String: service,
     kSecAttrAccount as String: item.rawValue,
     kSecAttrSynchronizable as String: false]
  }

  func load(_ item: Item) throws -> Data? {
    var request = query(item)
    request[kSecReturnData as String] = true
    request[kSecMatchLimit as String] = kSecMatchLimitOne
    var result: CFTypeRef?
    let status = SecItemCopyMatching(request as CFDictionary, &result)
    if status == errSecItemNotFound { return nil }
    guard status == errSecSuccess, let bytes = result as? Data else { throw Failure(status: status) }
    return bytes
  }

  // Insert-only: fails closed (duplicate) rather than overwriting an existing
  // device key. Callers restore the existing key on duplicate.
  func insertDeviceKey(_ bytes: Data) throws {
    let attributes: [String: Any] = [kSecValueData as String: bytes,
                                      kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
    let status = SecItemAdd(query(.deviceKey).merging(attributes) { _, new in new } as CFDictionary, nil)
    guard status == errSecSuccess else { throw Failure(status: status) }
  }

  // The granted cert may be replaced on renewal; update in place or insert.
  func upsertGrantedCert(_ bytes: Data) throws {
    let attributes: [String: Any] = [kSecValueData as String: bytes,
                                      kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
    var status = SecItemUpdate(query(.grantedCert) as CFDictionary, attributes as CFDictionary)
    if status == errSecItemNotFound {
      status = SecItemAdd(query(.grantedCert).merging(attributes) { _, new in new } as CFDictionary, nil)
    }
    guard status == errSecSuccess else { throw Failure(status: status) }
  }

  func remove(_ item: Item) throws {
    let status = SecItemDelete(query(item) as CFDictionary)
    guard status == errSecSuccess || status == errSecItemNotFound else { throw Failure(status: status) }
  }

  // Destructive unpair is transactional from the app's point of view: the
  // public descriptor must remain while credentials are uncertain. If the
  // second delete fails, restore the first item so pairing cannot be left in a
  // descriptor/key mismatch that traps the next enrollment.
  func clearAll() throws {
    let key = try load(.deviceKey)
    let certificate = try load(.grantedCert)
    do {
      try remove(.deviceKey)
      try remove(.grantedCert)
    } catch {
      if let key { try? insertDeviceKey(key) }
      if let certificate { try? upsertGrantedCert(certificate) }
      throw error
    }
  }
}
