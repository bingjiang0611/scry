import Foundation
import NIOCore
import NIOPosix
import NIOHTTP1
import NIOWebSocket
import NIOSSL
import NIOTLS

extension G0Transport {
  // Intentionally loopback-only until a separate public test endpoint is
  // authorized and authenticated routing exists. This is not a business API.
  public static func echo(port: Int, identity: G0ProbeIdentity, payload: String) async throws -> Data {
    let request = try ProbeRequest(protocolMajor: 1, requestId: UUID().uuidString, operation: "probe.echo", payload: payload)
    let bytes = try await exchange(port: port, identity: identity, request: JSONEncoder().encode(request))
    let reply = try JSONDecoder().decode(ProbeResponse.self, from: bytes)
    guard reply.requestId == request.requestId, reply.payload == request.payload else { throw ProbeError.unexpectedReply }
    return try JSONEncoder().encode(reply)
  }

  // Pairing bootstrap over a host-authenticated channel. Returns the raw JSON
  // response line; the caller decides local UI meaning. This does not itself
  // establish trust: the device must have verified the host anchor from the QR
  // code, and a granted certificate still needs the host user's confirmation.
  public enum PairOutcome: Sendable, Equatable {
    case pending(publicKeySHA256: String)
    case granted(certificatePEM: String, deviceId: String, expiresAt: Int)
    case revoked(deviceId: String)
    case denied(code: String)
  }

  public static func pairProve(port: Int, identity: G0ProbeIdentity, pairingId: String, secret: String, csrPEM: String, deviceLabel: String) async throws -> PairOutcome {
    let requestId = UUID().uuidString
    let request = try PairProofRequest(protocolMajor: 1, requestId: requestId, operation: "pair.prove", pairingId: pairingId, secret: secret, csrPEM: csrPEM, deviceLabel: deviceLabel)
    return try decodePair(await exchange(port: port, identity: identity, request: JSONEncoder().encode(request), route: "/pair"), requestId: requestId)
  }

  public static func pairStatus(port: Int, identity: G0ProbeIdentity, pairingId: String, secret: String) async throws -> PairOutcome {
    let requestId = UUID().uuidString
    let request = try PairStatusRequest(protocolMajor: 1, requestId: requestId, operation: "pair.status", pairingId: pairingId, secret: secret)
    return try decodePair(await exchange(port: port, identity: identity, request: JSONEncoder().encode(request), route: "/pair"), requestId: requestId)
  }

  public static func relayPairProve(endpoint: RelayEndpoint, identity: G0ProbeIdentity, pairingId: String, secret: String, csrPEM: String, deviceLabel: String) async throws -> PairOutcome {
    let requestId = UUID().uuidString
    let request = try PairProofRequest(protocolMajor: 1, requestId: requestId, operation: "pair.prove", pairingId: pairingId, secret: secret, csrPEM: csrPEM, deviceLabel: deviceLabel)
    return try decodePair(await exchangeRelay(endpoint: endpoint, mode: "pair", identity: identity, request: JSONEncoder().encode(request)), requestId: requestId)
  }

  public static func relayPairStatus(endpoint: RelayEndpoint, identity: G0ProbeIdentity, pairingId: String, secret: String) async throws -> PairOutcome {
    let requestId = UUID().uuidString
    let request = try PairStatusRequest(protocolMajor: 1, requestId: requestId, operation: "pair.status", pairingId: pairingId, secret: secret)
    return try decodePair(await exchangeRelay(endpoint: endpoint, mode: "pair", identity: identity, request: JSONEncoder().encode(request)), requestId: requestId)
  }
  private static func decodePair(_ bytes: Data, requestId: String) throws -> PairOutcome {
    // Correlate the response to our own request id before trusting any field.
    if let granted = try? JSONDecoder().decode(PairGrantedResponse.self, from: bytes), granted.requestId == requestId {
      return .granted(certificatePEM: granted.certificatePEM, deviceId: granted.deviceId, expiresAt: granted.expiresAt)
    }
    if let pending = try? JSONDecoder().decode(PairPendingResponse.self, from: bytes), pending.requestId == requestId {
      return .pending(publicKeySHA256: pending.publicKeySHA256)
    }
    if let revoked = try? JSONDecoder().decode(PairRevokedResponse.self, from: bytes), revoked.requestId == requestId {
      return .revoked(deviceId: revoked.deviceId)
    }
    if let denied = try? JSONDecoder().decode(PairDeniedResponse.self, from: bytes), denied.requestId == requestId {
      return .denied(code: denied.code)
    }
    throw ProbeError.unexpectedReply
  }
}
