// Generated from wire.schema.json. Do not edit.
import Foundation

enum WireError: Error { case invalidFields; case invalidField(String) }
private struct WireKey: CodingKey {
  let stringValue: String
  let intValue: Int? = nil
  init?(stringValue: String) { self.stringValue = stringValue }
  init?(intValue: Int) { return nil }
}

struct ProbeRequest: Codable, Sendable {
  let protocolMajor: Int
  let requestId: String
  let operation: String
  let payload: String
  private enum CodingKeys: String, CodingKey { case protocolMajor, requestId, operation, payload }
  init(protocolMajor: Int, requestId: String, operation: String, payload: String) throws {
    self.protocolMajor = protocolMajor
    self.requestId = requestId
    self.operation = operation
    self.payload = payload
    try validate()
  }
  init(from decoder: Decoder) throws {
    let all = try decoder.container(keyedBy: WireKey.self)
    guard Set(all.allKeys.map(\.stringValue)) == Set(["protocolMajor", "requestId", "operation", "payload"]) else { throw WireError.invalidFields }
    let values = try decoder.container(keyedBy: CodingKeys.self)
    protocolMajor = try values.decode(Int.self, forKey: .protocolMajor)
    requestId = try values.decode(String.self, forKey: .requestId)
    operation = try values.decode(String.self, forKey: .operation)
    payload = try values.decode(String.self, forKey: .payload)
    try validate()
  }
  private func validate() throws {
    guard protocolMajor >= 1, protocolMajor <= 1 else { throw WireError.invalidField("protocolMajor") }
    guard requestId.unicodeScalars.count >= 1, requestId.unicodeScalars.count <= 64 else { throw WireError.invalidField("requestId") }
    guard operation.unicodeScalars.count >= 0, ["probe.echo"].contains(operation) else { throw WireError.invalidField("operation") }
    guard payload.unicodeScalars.count >= 0, payload.unicodeScalars.count <= 4096 else { throw WireError.invalidField("payload") }
  }
}

struct ProbeResponse: Codable, Sendable {
  let protocolMajor: Int
  let requestId: String
  let kind: String
  let payload: String
  private enum CodingKeys: String, CodingKey { case protocolMajor, requestId, kind, payload }
  init(protocolMajor: Int, requestId: String, kind: String, payload: String) throws {
    self.protocolMajor = protocolMajor
    self.requestId = requestId
    self.kind = kind
    self.payload = payload
    try validate()
  }
  init(from decoder: Decoder) throws {
    let all = try decoder.container(keyedBy: WireKey.self)
    guard Set(all.allKeys.map(\.stringValue)) == Set(["protocolMajor", "requestId", "kind", "payload"]) else { throw WireError.invalidFields }
    let values = try decoder.container(keyedBy: CodingKeys.self)
    protocolMajor = try values.decode(Int.self, forKey: .protocolMajor)
    requestId = try values.decode(String.self, forKey: .requestId)
    kind = try values.decode(String.self, forKey: .kind)
    payload = try values.decode(String.self, forKey: .payload)
    try validate()
  }
  private func validate() throws {
    guard protocolMajor >= 1, protocolMajor <= 1 else { throw WireError.invalidField("protocolMajor") }
    guard requestId.unicodeScalars.count >= 1, requestId.unicodeScalars.count <= 64 else { throw WireError.invalidField("requestId") }
    guard kind.unicodeScalars.count >= 0, ["result"].contains(kind) else { throw WireError.invalidField("kind") }
    guard payload.unicodeScalars.count >= 0, payload.unicodeScalars.count <= 4096 else { throw WireError.invalidField("payload") }
  }
}

struct PairProofRequest: Codable, Sendable {
  let protocolMajor: Int
  let requestId: String
  let operation: String
  let pairingId: String
  let secret: String
  let csrPEM: String
  let deviceLabel: String
  private enum CodingKeys: String, CodingKey { case protocolMajor, requestId, operation, pairingId, secret, csrPEM, deviceLabel }
  init(protocolMajor: Int, requestId: String, operation: String, pairingId: String, secret: String, csrPEM: String, deviceLabel: String) throws {
    self.protocolMajor = protocolMajor
    self.requestId = requestId
    self.operation = operation
    self.pairingId = pairingId
    self.secret = secret
    self.csrPEM = csrPEM
    self.deviceLabel = deviceLabel
    try validate()
  }
  init(from decoder: Decoder) throws {
    let all = try decoder.container(keyedBy: WireKey.self)
    guard Set(all.allKeys.map(\.stringValue)) == Set(["protocolMajor", "requestId", "operation", "pairingId", "secret", "csrPEM", "deviceLabel"]) else { throw WireError.invalidFields }
    let values = try decoder.container(keyedBy: CodingKeys.self)
    protocolMajor = try values.decode(Int.self, forKey: .protocolMajor)
    requestId = try values.decode(String.self, forKey: .requestId)
    operation = try values.decode(String.self, forKey: .operation)
    pairingId = try values.decode(String.self, forKey: .pairingId)
    secret = try values.decode(String.self, forKey: .secret)
    csrPEM = try values.decode(String.self, forKey: .csrPEM)
    deviceLabel = try values.decode(String.self, forKey: .deviceLabel)
    try validate()
  }
  private func validate() throws {
    guard protocolMajor >= 1, protocolMajor <= 1 else { throw WireError.invalidField("protocolMajor") }
    guard requestId.unicodeScalars.count >= 1, requestId.unicodeScalars.count <= 64 else { throw WireError.invalidField("requestId") }
    guard operation.unicodeScalars.count >= 0, ["pair.prove"].contains(operation) else { throw WireError.invalidField("operation") }
    guard pairingId.unicodeScalars.count >= 36, pairingId.unicodeScalars.count <= 36 else { throw WireError.invalidField("pairingId") }
    guard secret.unicodeScalars.count >= 43, secret.unicodeScalars.count <= 43 else { throw WireError.invalidField("secret") }
    guard csrPEM.unicodeScalars.count >= 1, csrPEM.unicodeScalars.count <= 16384 else { throw WireError.invalidField("csrPEM") }
    guard deviceLabel.unicodeScalars.count >= 1, deviceLabel.unicodeScalars.count <= 80 else { throw WireError.invalidField("deviceLabel") }
  }
}

struct PairStatusRequest: Codable, Sendable {
  let protocolMajor: Int
  let requestId: String
  let operation: String
  let pairingId: String
  let secret: String
  private enum CodingKeys: String, CodingKey { case protocolMajor, requestId, operation, pairingId, secret }
  init(protocolMajor: Int, requestId: String, operation: String, pairingId: String, secret: String) throws {
    self.protocolMajor = protocolMajor
    self.requestId = requestId
    self.operation = operation
    self.pairingId = pairingId
    self.secret = secret
    try validate()
  }
  init(from decoder: Decoder) throws {
    let all = try decoder.container(keyedBy: WireKey.self)
    guard Set(all.allKeys.map(\.stringValue)) == Set(["protocolMajor", "requestId", "operation", "pairingId", "secret"]) else { throw WireError.invalidFields }
    let values = try decoder.container(keyedBy: CodingKeys.self)
    protocolMajor = try values.decode(Int.self, forKey: .protocolMajor)
    requestId = try values.decode(String.self, forKey: .requestId)
    operation = try values.decode(String.self, forKey: .operation)
    pairingId = try values.decode(String.self, forKey: .pairingId)
    secret = try values.decode(String.self, forKey: .secret)
    try validate()
  }
  private func validate() throws {
    guard protocolMajor >= 1, protocolMajor <= 1 else { throw WireError.invalidField("protocolMajor") }
    guard requestId.unicodeScalars.count >= 1, requestId.unicodeScalars.count <= 64 else { throw WireError.invalidField("requestId") }
    guard operation.unicodeScalars.count >= 0, ["pair.status"].contains(operation) else { throw WireError.invalidField("operation") }
    guard pairingId.unicodeScalars.count >= 36, pairingId.unicodeScalars.count <= 36 else { throw WireError.invalidField("pairingId") }
    guard secret.unicodeScalars.count >= 43, secret.unicodeScalars.count <= 43 else { throw WireError.invalidField("secret") }
  }
}

struct PairPendingResponse: Codable, Sendable {
  let protocolMajor: Int
  let requestId: String
  let kind: String
  let pairingId: String
  let publicKeySHA256: String
  private enum CodingKeys: String, CodingKey { case protocolMajor, requestId, kind, pairingId, publicKeySHA256 }
  init(protocolMajor: Int, requestId: String, kind: String, pairingId: String, publicKeySHA256: String) throws {
    self.protocolMajor = protocolMajor
    self.requestId = requestId
    self.kind = kind
    self.pairingId = pairingId
    self.publicKeySHA256 = publicKeySHA256
    try validate()
  }
  init(from decoder: Decoder) throws {
    let all = try decoder.container(keyedBy: WireKey.self)
    guard Set(all.allKeys.map(\.stringValue)) == Set(["protocolMajor", "requestId", "kind", "pairingId", "publicKeySHA256"]) else { throw WireError.invalidFields }
    let values = try decoder.container(keyedBy: CodingKeys.self)
    protocolMajor = try values.decode(Int.self, forKey: .protocolMajor)
    requestId = try values.decode(String.self, forKey: .requestId)
    kind = try values.decode(String.self, forKey: .kind)
    pairingId = try values.decode(String.self, forKey: .pairingId)
    publicKeySHA256 = try values.decode(String.self, forKey: .publicKeySHA256)
    try validate()
  }
  private func validate() throws {
    guard protocolMajor >= 1, protocolMajor <= 1 else { throw WireError.invalidField("protocolMajor") }
    guard requestId.unicodeScalars.count >= 1, requestId.unicodeScalars.count <= 64 else { throw WireError.invalidField("requestId") }
    guard kind.unicodeScalars.count >= 0, ["pair.pending"].contains(kind) else { throw WireError.invalidField("kind") }
    guard pairingId.unicodeScalars.count >= 36, pairingId.unicodeScalars.count <= 36 else { throw WireError.invalidField("pairingId") }
    guard publicKeySHA256.unicodeScalars.count >= 64, publicKeySHA256.unicodeScalars.count <= 64 else { throw WireError.invalidField("publicKeySHA256") }
  }
}

struct PairGrantedResponse: Codable, Sendable {
  let protocolMajor: Int
  let requestId: String
  let kind: String
  let pairingId: String
  let deviceId: String
  let certificatePEM: String
  let certificateSHA256: String
  let expiresAt: Int
  let scope: String
  private enum CodingKeys: String, CodingKey { case protocolMajor, requestId, kind, pairingId, deviceId, certificatePEM, certificateSHA256, expiresAt, scope }
  init(protocolMajor: Int, requestId: String, kind: String, pairingId: String, deviceId: String, certificatePEM: String, certificateSHA256: String, expiresAt: Int, scope: String) throws {
    self.protocolMajor = protocolMajor
    self.requestId = requestId
    self.kind = kind
    self.pairingId = pairingId
    self.deviceId = deviceId
    self.certificatePEM = certificatePEM
    self.certificateSHA256 = certificateSHA256
    self.expiresAt = expiresAt
    self.scope = scope
    try validate()
  }
  init(from decoder: Decoder) throws {
    let all = try decoder.container(keyedBy: WireKey.self)
    guard Set(all.allKeys.map(\.stringValue)) == Set(["protocolMajor", "requestId", "kind", "pairingId", "deviceId", "certificatePEM", "certificateSHA256", "expiresAt", "scope"]) else { throw WireError.invalidFields }
    let values = try decoder.container(keyedBy: CodingKeys.self)
    protocolMajor = try values.decode(Int.self, forKey: .protocolMajor)
    requestId = try values.decode(String.self, forKey: .requestId)
    kind = try values.decode(String.self, forKey: .kind)
    pairingId = try values.decode(String.self, forKey: .pairingId)
    deviceId = try values.decode(String.self, forKey: .deviceId)
    certificatePEM = try values.decode(String.self, forKey: .certificatePEM)
    certificateSHA256 = try values.decode(String.self, forKey: .certificateSHA256)
    expiresAt = try values.decode(Int.self, forKey: .expiresAt)
    scope = try values.decode(String.self, forKey: .scope)
    try validate()
  }
  private func validate() throws {
    guard protocolMajor >= 1, protocolMajor <= 1 else { throw WireError.invalidField("protocolMajor") }
    guard requestId.unicodeScalars.count >= 1, requestId.unicodeScalars.count <= 64 else { throw WireError.invalidField("requestId") }
    guard kind.unicodeScalars.count >= 0, ["pair.granted"].contains(kind) else { throw WireError.invalidField("kind") }
    guard pairingId.unicodeScalars.count >= 36, pairingId.unicodeScalars.count <= 36 else { throw WireError.invalidField("pairingId") }
    guard deviceId.unicodeScalars.count >= 36, deviceId.unicodeScalars.count <= 36 else { throw WireError.invalidField("deviceId") }
    guard certificatePEM.unicodeScalars.count >= 1, certificatePEM.unicodeScalars.count <= 16384 else { throw WireError.invalidField("certificatePEM") }
    guard certificateSHA256.unicodeScalars.count >= 64, certificateSHA256.unicodeScalars.count <= 64 else { throw WireError.invalidField("certificateSHA256") }
    guard expiresAt >= 0, expiresAt <= 9007199254740991 else { throw WireError.invalidField("expiresAt") }
    guard scope.unicodeScalars.count >= 0, ["g0_echo_only"].contains(scope) else { throw WireError.invalidField("scope") }
  }
}

struct PairRevokedResponse: Codable, Sendable {
  let protocolMajor: Int
  let requestId: String
  let kind: String
  let pairingId: String
  let deviceId: String
  private enum CodingKeys: String, CodingKey { case protocolMajor, requestId, kind, pairingId, deviceId }
  init(protocolMajor: Int, requestId: String, kind: String, pairingId: String, deviceId: String) throws {
    self.protocolMajor = protocolMajor
    self.requestId = requestId
    self.kind = kind
    self.pairingId = pairingId
    self.deviceId = deviceId
    try validate()
  }
  init(from decoder: Decoder) throws {
    let all = try decoder.container(keyedBy: WireKey.self)
    guard Set(all.allKeys.map(\.stringValue)) == Set(["protocolMajor", "requestId", "kind", "pairingId", "deviceId"]) else { throw WireError.invalidFields }
    let values = try decoder.container(keyedBy: CodingKeys.self)
    protocolMajor = try values.decode(Int.self, forKey: .protocolMajor)
    requestId = try values.decode(String.self, forKey: .requestId)
    kind = try values.decode(String.self, forKey: .kind)
    pairingId = try values.decode(String.self, forKey: .pairingId)
    deviceId = try values.decode(String.self, forKey: .deviceId)
    try validate()
  }
  private func validate() throws {
    guard protocolMajor >= 1, protocolMajor <= 1 else { throw WireError.invalidField("protocolMajor") }
    guard requestId.unicodeScalars.count >= 1, requestId.unicodeScalars.count <= 64 else { throw WireError.invalidField("requestId") }
    guard kind.unicodeScalars.count >= 0, ["pair.revoked"].contains(kind) else { throw WireError.invalidField("kind") }
    guard pairingId.unicodeScalars.count >= 36, pairingId.unicodeScalars.count <= 36 else { throw WireError.invalidField("pairingId") }
    guard deviceId.unicodeScalars.count >= 36, deviceId.unicodeScalars.count <= 36 else { throw WireError.invalidField("deviceId") }
  }
}

struct PairDeniedResponse: Codable, Sendable {
  let protocolMajor: Int
  let requestId: String
  let kind: String
  let code: String
  private enum CodingKeys: String, CodingKey { case protocolMajor, requestId, kind, code }
  init(protocolMajor: Int, requestId: String, kind: String, code: String) throws {
    self.protocolMajor = protocolMajor
    self.requestId = requestId
    self.kind = kind
    self.code = code
    try validate()
  }
  init(from decoder: Decoder) throws {
    let all = try decoder.container(keyedBy: WireKey.self)
    guard Set(all.allKeys.map(\.stringValue)) == Set(["protocolMajor", "requestId", "kind", "code"]) else { throw WireError.invalidFields }
    let values = try decoder.container(keyedBy: CodingKeys.self)
    protocolMajor = try values.decode(Int.self, forKey: .protocolMajor)
    requestId = try values.decode(String.self, forKey: .requestId)
    kind = try values.decode(String.self, forKey: .kind)
    code = try values.decode(String.self, forKey: .code)
    try validate()
  }
  private func validate() throws {
    guard protocolMajor >= 1, protocolMajor <= 1 else { throw WireError.invalidField("protocolMajor") }
    guard requestId.unicodeScalars.count >= 1, requestId.unicodeScalars.count <= 64 else { throw WireError.invalidField("requestId") }
    guard kind.unicodeScalars.count >= 0, ["pair.denied"].contains(kind) else { throw WireError.invalidField("kind") }
    guard code.unicodeScalars.count >= 1, code.unicodeScalars.count <= 64 else { throw WireError.invalidField("code") }
  }
}
