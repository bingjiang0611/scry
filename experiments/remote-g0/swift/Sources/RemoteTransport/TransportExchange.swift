import Foundation
import NIOCore
import NIOPosix
import NIOHTTP1
import NIOWebSocket
import NIOSSL
import NIOTLS

extension G0Transport {
  // Internal framed transport; public entry points must construct generated
  // request DTOs and validate/correlate the generated response before returning.
  static func exchange(port: Int, identity: G0ProbeIdentity, request: Data, route: String = "/device") async throws -> Data {
    guard (1...65535).contains(port), request.count < 65_536, ["/device", "/pair"].contains(route) else { throw ProbeError.invalidArguments }
    let group = MultiThreadedEventLoopGroup(numberOfThreads: 1)
    do {
      var outer = TLSConfiguration.makeClientConfiguration()
      outer.minimumTLSVersion = .tlsv13
      outer.maximumTLSVersion = .tlsv13
      outer.trustRoots = .certificates(try NIOSSLCertificate.fromPEMBytes(Array(identity.outerCA)))
      outer.certificateVerification = .fullVerification
      let outerContext = try NIOSSLContext(configuration: outer)
      var inner = TLSConfiguration.makeClientConfiguration()
      inner.minimumTLSVersion = .tlsv13
      inner.maximumTLSVersion = .tlsv13
      inner.trustRoots = .certificates(try NIOSSLCertificate.fromPEMBytes(Array(identity.innerCA)))
      inner.certificateVerification = .fullVerification
      if let certificate = identity.certificate, let privateKey = identity.privateKey {
        inner.certificateChain = try NIOSSLCertificate.fromPEMBytes(Array(certificate)).map { .certificate($0) }
        inner.privateKey = .privateKey(try NIOSSLPrivateKey(bytes: Array(privateKey), format: .pem))
      } else if route != "/pair" {
        // Only the pairing bootstrap route may omit the client certificate.
        throw ProbeError.invalidArguments
      }
      let innerContext = try NIOSSLContext(configuration: inner)
      let upgrade: EventLoopFuture<Channel> = try await ClientBootstrap(group: group)
        .connectTimeout(.seconds(10))
        .channelOption(ChannelOptions.writeBufferWaterMark, value: ChannelOptions.Types.WriteBufferWaterMark(low: 262_144, high: 524_288))
        .connect(host: "127.0.0.1", port: port) { channel in
          channel.eventLoop.makeCompletedFuture {
            let pipeline = channel.pipeline.syncOperations
            try pipeline.addHandler(NIOSSLClientHandler(context: outerContext, serverHostname: "localhost"))
            let upgrader = NIOTypedWebSocketClientUpgrader<Channel>(maxFrameSize: 1_572_864, upgradePipelineHandler: { channel, _ in
              channel.eventLoop.makeCompletedFuture {
                try channel.pipeline.syncOperations.addHandler(TunnelCodec())
                return channel
              }
            })
            let headers = HTTPHeaders([("Host", "localhost:\(port)"), ("Content-Length", "0")])
            let head = HTTPRequestHead(version: .http1_1, method: .GET, uri: route, headers: headers)
            let configuration = NIOTypedHTTPClientUpgradeConfiguration(upgradeRequestHead: head, upgraders: [upgrader], notUpgradingCompletionHandler: { channel in
              channel.eventLoop.makeFailedFuture(ProbeError.invalidFrame)
            })
            // Bound even a silent malicious relay; there is no reconnect/replay.
            channel.eventLoop.scheduleTask(in: .seconds(10)) { channel.close(promise: nil) }
            return try configureWebSocketUpgrade(pipeline, configuration: configuration)
          }
        }
      let channel = try await upgrade.get()
      // Create the reply promise only after the channel exists so a failed
      // connect/upgrade above can never leave an unfulfilled promise to leak
      // (NIO fatalErrors on a leaked promise in debug builds).
      let result = group.next().makePromise(of: Data.self)
      // The HTTP upgrader rejects outbound writes while its callback is active.
      // Install inner TLS only after upgrade completion, on the event loop, so
      // its immediate ClientHello cannot be silently rejected by HTTP state.
      do {
        try await channel.eventLoop.submit {
          try channel.pipeline.syncOperations.addHandler(NIOSSLClientHandler(context: innerContext, serverHostname: "scry-host.test"))
          try channel.pipeline.syncOperations.addHandler(ProbeHandler(request: request, result: result))
        }.get()
      } catch {
        // Handler install failed before ProbeHandler could complete the promise.
        result.fail(error)
        throw error
      }
      let reply = try await result.futureResult.get()
      try await group.shutdownGracefully()
      return reply
    } catch {
      try? await group.shutdownGracefully()
      throw error
    }
  }

  // Relay variant of `exchange`. Mirrors the loopback security decisions but
  // dials a public relay and routes by hostId+mode instead of a fixed port, and
  // pins the inner server to the host anchor without leaf-hostname verification.
  // Do not replay exchanges by matching error strings. A lost response is not
  // evidence that a request did not run; explicit UI reconciliation owns retry.
  static func exchangeRelay(endpoint: RelayEndpoint, mode: String, identity: G0ProbeIdentity, request: Data, responseLimit: Int? = nil,
                            lane: RelaySession.Lane = .control, replayable: Bool = true, wrapTarget: Bool = true,
                            useSession: Bool = true) async throws -> Data {
    guard request.count < 1_250_000 else { throw ProbeError.invalidArguments }
    let routedRequest: Data
    if mode == "run", wrapTarget, let target = endpoint.executionTarget {
      routedRequest = try wrapExecutionTargetRequest(request, target: target)
    } else {
      routedRequest = request
    }
    if mode == "run", useSession, let session = endpoint.session {
      return try await session.exchange(routedRequest, lane: lane, limit: responseLimit ?? 8 * 1_024 * 1_024, replayable: replayable)
    }
    return try await withRelayChannel(endpoint: endpoint, mode: mode, identity: identity) { channel, innerContext in
      let result = channel.eventLoop.makePromise(of: Data.self)
      do {
        try await channel.eventLoop.submit {
          try channel.pipeline.syncOperations.addHandler(NIOSSLClientHandler(context: innerContext, serverHostname: nil))
          let limit = responseLimit ?? (mode == "run" ? 8 * 1_024 * 1_024 : 65_536)
          try channel.pipeline.syncOperations.addHandler(ProbeHandler(request: routedRequest, result: result, maxResponseBytes: limit))
        }.get()
      } catch { result.fail(error); throw error }
      return try await result.futureResult.get()
    }
  }


}
