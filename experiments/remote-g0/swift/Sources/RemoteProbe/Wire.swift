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
