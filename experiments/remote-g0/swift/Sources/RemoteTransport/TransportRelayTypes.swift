import Foundation
import NIOCore
import NIOPosix
import NIOHTTP1
import NIOWebSocket
import NIOSSL
import NIOTLS

extension G0Transport {
  // Relay endpoint: outer WS(S) hop to a public relay that byte-shuttles to the
  // NAT-bound host's reverse tunnel. Routing is `/?host=<hostId>&mode=pair`; the
  // relay never sees inner keys. The device pins the host anchor (from the QR
  // code) for the inner TLS 1.3 mTLS and skips leaf hostname verification
  // because the per-launch host server cert carries no SAN (chain-to-anchor is
  // the only trust decision). Outer TLS is used only when a relay CA is given.
  public struct ExecutionTargetBinding: Codable, Equatable, Hashable, Sendable {
    public let id: String
    public let binding: String

    public init(id: String, binding: String) {
      self.id = id
      self.binding = binding
    }

    public var isValid: Bool {
      !id.isEmpty && id.utf16.count <= 300 && binding.utf8.count == 64 && binding.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil
    }
  }

  public struct ExecutionTargetRef: Codable, Equatable, Hashable, Sendable {
    public let id: String
    public let binding: String
    public let hostId: String
    public let label: String
    public let state: String

    public init(id: String, binding: String, hostId: String, label: String, state: String) {
      self.id = id; self.binding = binding; self.hostId = hostId; self.label = label; self.state = state
    }
  }

  public struct ExecutionTargetCatalog: Codable, Equatable, Hashable, Sendable {
    public struct Gateway: Codable, Equatable, Hashable, Sendable {
      public let hostId: String
      public let label: String
      public init(hostId: String, label: String) { self.hostId = hostId; self.label = label }
    }
    public let version: Int
    public let gateway: Gateway
    public let targets: [ExecutionTargetRef]
    public init(version: Int, gateway: Gateway, targets: [ExecutionTargetRef]) {
      self.version = version; self.gateway = gateway; self.targets = targets
    }
  }

  public struct RelayEndpoint: Sendable {
    // Outer transport TLS to the relay. This is NOT the security root: the inner
    // TLS 1.3 mTLS to the host (pinned to the anchor) is. Outer TLS only stops a
    // passive network from reading the already-encrypted relay hop.
    public enum OuterTLS: Sendable {
      case plaintext   // ws:// — a local dev relay
      case system      // wss:// with a publicly-trusted cert (e.g. Cloudflare): default trust roots + hostname verification
      case pinned      // wss:// pinned to identity.outerCA (a private relay CA)
    }
    public let host: String
    public let port: Int
    public let hostId: String
    public let relayServerName: String?
    public let outerTLS: OuterTLS
    // When present, run requests are wrapped for this approved desktop target.
    // The gateway hostId and this binding are immutable for the endpoint lifetime.
    public let executionTarget: ExecutionTargetBinding?
    // When present, run-mode exchanges reuse this session's persistent lanes
    // instead of dialing one tunnel per request. Pairing never uses it.
    public let session: RelaySession?
    public init(host: String, port: Int, hostId: String, relayServerName: String? = nil, outerTLS: OuterTLS = .plaintext,
                session: RelaySession? = nil, executionTarget: ExecutionTargetBinding? = nil) {
      self.host = host
      self.port = port
      self.hostId = hostId
      self.relayServerName = relayServerName
      self.outerTLS = outerTLS
      self.executionTarget = executionTarget
      self.session = session
    }
  }


}
