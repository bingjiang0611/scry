import Foundation
import NIOCore
import NIOPosix
import NIOHTTP1
import NIOWebSocket
import NIOSSL
import NIOTLS

extension G0Transport {
  static func configureWebSocketUpgrade(_ pipeline: ChannelPipeline.SynchronousOperations,
    configuration: NIOTypedHTTPClientUpgradeConfiguration<Channel>) throws -> EventLoopFuture<Channel> {
    var options = NIOUpgradableHTTPClientPipelineConfiguration(upgradeConfiguration: configuration)
    // HTTP 101 and the first WebSocket frame can arrive in the same read.
    // NIO's default drops those buffered bytes, including an early close cause.
    options.leftOverBytesStrategy = .forwardBytes
    return try pipeline.configureUpgradableHTTPClientPipeline(configuration: options)
  }

  static func withRelayChannel<T: Sendable>(endpoint: RelayEndpoint, mode: String, identity: G0ProbeIdentity,
    body: @Sendable (Channel, NIOSSLContext) async throws -> T) async throws -> T {
    // One-shot tunnels share the process-wide loop: creating and tearing down a
    // thread per request only added latency.
    let (channel, innerContext, tunnel) = try await connectRelayChannel(endpoint: endpoint, mode: mode, identity: identity,
                                                                         group: MultiThreadedEventLoopGroup.singleton)
    // Cancel an established tunnel immediately. Bootstrap retains its
    // bounded 10-second deadline, rather than leaving a detached connection.
    let reply: T
    do {
      reply = try await withTaskCancellationHandler {
        try Task.checkCancellation()
        return try await body(channel, innerContext)
      } onCancel: { channel.close(promise: nil) }
    } catch {
      let failure = try await channel.eventLoop.submit { tunnel.retainingCloseCause(for: error) }.get()
      try? await channel.close()
      throw RelayTransportError.identifyingHandshake(failure, layer: .host)
    }
    try? await channel.close()
    return reply
  }

  // Dials the relay and completes the outer WebSocket upgrade. Returns the
  // channel (TunnelCodec installed, no inner TLS yet) and the inner mTLS context
  // pinned to the host anchor. Retain the codec to recover an early close cause
  // after pipeline teardown. The caller owns the channel. `group` is used only
  // by the POSIX path; Apple platforms dial through Network.framework.
  static func connectRelayChannel(endpoint: RelayEndpoint, mode: String, identity: G0ProbeIdentity,
                                  group: EventLoopGroup, recorder: ConnectTimingRecorder? = nil) async throws -> (Channel, NIOSSLContext, TunnelCodec) {
    guard (1...65535).contains(endpoint.port), ["pair", "run"].contains(mode),
          !endpoint.hostId.isEmpty, endpoint.hostId.count <= 64 else { throw ProbeError.invalidArguments }
    do {
      // Outer TLS mode is decided by the endpoint (from the pairing code), not by
      // whether a CA happens to be present. `.system` trusts the platform's
      // public roots for a wss relay like Cloudflare; `.pinned` trusts only the
      // supplied private relay CA; `.plaintext` is ws:// for the local dev relay.
      let outerContext: NIOSSLContext?
      switch endpoint.outerTLS {
      case .plaintext:
        outerContext = nil
      case .system:
        var outer = TLSConfiguration.makeClientConfiguration()
        outer.minimumTLSVersion = .tlsv12
        outer.maximumTLSVersion = .tlsv13
        outer.trustRoots = .default
        outer.certificateVerification = .fullVerification
        outerContext = try NIOSSLContext(configuration: outer)
      case .pinned:
        guard !identity.outerCA.isEmpty else { throw ProbeError.invalidArguments }
        var outer = TLSConfiguration.makeClientConfiguration()
        outer.minimumTLSVersion = .tlsv13
        outer.maximumTLSVersion = .tlsv13
        outer.trustRoots = .certificates(try NIOSSLCertificate.fromPEMBytes(Array(identity.outerCA)))
        outer.certificateVerification = .fullVerification
        outerContext = try NIOSSLContext(configuration: outer)
      }
      let innerContext = try innerTLSContext(identity: identity, mode: mode)
      let tunnel = TunnelCodec()
      let uri = "/?host=\(endpoint.hostId)&mode=\(mode)"
      let hostHeader = endpoint.relayServerName ?? endpoint.host
      let serverName = endpoint.relayServerName ?? endpoint.host
      let channel = try await RemoteBootstrap.connect(host: endpoint.host, port: endpoint.port, timeout: .seconds(10),
                                                      posixGroup: group) { channel -> EventLoopFuture<Channel> in
        let pipeline = channel.pipeline.syncOperations
        if let outerContext {
          try pipeline.addHandler(NIOSSLClientHandler(context: outerContext, serverHostname: serverName))
        }
        if let recorder {
          try pipeline.addHandler(ConnectTimingHandler(recorder: recorder, observesOuterTLS: outerContext != nil))
        }
        let upgrader = NIOTypedWebSocketClientUpgrader<Channel>(maxFrameSize: 1_572_864, upgradePipelineHandler: { channel, response in
          // Untrusted diagnostics from the relay's 101 response.
          recorder?.mark(\.upgradeMs)
          recorder?.update { timing in
            timing.colo = ConnectTimingRecorder.colo(fromRay: response.headers.first(name: "cf-ray"))
            timing.relayWaitMs = response.headers.first(name: "x-scry-relay-wait-ms").flatMap { Int($0) }
          }
          return channel.eventLoop.makeCompletedFuture {
            try channel.pipeline.syncOperations.addHandler(tunnel)
            return channel
          }
        })
        let headers = HTTPHeaders([("Host", hostHeader), ("Content-Length", "0")])
        let head = HTTPRequestHead(version: .http1_1, method: .GET, uri: uri, headers: headers)
        let configuration = NIOTypedHTTPClientUpgradeConfiguration(upgradeRequestHead: head, upgraders: [upgrader], notUpgradingCompletionHandler: { channel in
          channel.eventLoop.makeFailedFuture(ProbeError.invalidFrame)
        })
        let timeout = channel.eventLoop.scheduleTask(in: .seconds(10)) { channel.close(promise: nil) }
        let upgraded = try configureWebSocketUpgrade(pipeline, configuration: configuration)
        upgraded.whenComplete { _ in timeout.cancel() }
        return upgraded
      }
      return (channel, innerContext, tunnel)
    } catch {
      // An HTTP WebSocket upgrade cannot complete before outer TLS succeeds.
      throw RelayTransportError.identifyingHandshake(error, layer: .relay)
    }
  }

  // Verify ONLY the outer/system TLS trust used by `.system`: open a NIOSSL
  // client with the platform's public trust roots (.default) + full verification
  // to host:port and wait for the TLS handshake to complete. Success proves THIS
  // device trusts the relay's PUBLICLY-signed certificate (e.g. Cloudflare) via
  // the system store. No inner TLS, no WebSocket, no token; throws on any
  // trust/handshake failure. Used by the on-device self-test's -relayTLSProbe.
  public static func probeSystemTLS(host: String, port: Int = 443) async throws -> String {
    guard (1...65535).contains(port), !host.isEmpty else { throw ProbeError.invalidArguments }
    let group = MultiThreadedEventLoopGroup(numberOfThreads: 1)
    do {
      var outer = TLSConfiguration.makeClientConfiguration()
      outer.minimumTLSVersion = .tlsv12
      outer.maximumTLSVersion = .tlsv13
      outer.trustRoots = .default
      outer.certificateVerification = .fullVerification
      let context = try NIOSSLContext(configuration: outer)
      let done = group.next().makePromise(of: String.self)
      let bootstrap = ClientBootstrap(group: group)
        .connectTimeout(.seconds(10))
        .channelInitializer { channel in
          do {
            try channel.pipeline.syncOperations.addHandler(NIOSSLClientHandler(context: context, serverHostname: host))
            try channel.pipeline.syncOperations.addHandler(TLSHandshakeReporter(promise: done))
            return channel.eventLoop.makeSucceededFuture(())
          } catch {
            return channel.eventLoop.makeFailedFuture(error)
          }
        }
      let channel: Channel
      do {
        channel = try await bootstrap.connect(host: host, port: port).get()
      } catch {
        // Resolve the promise so it never leaks, and surface the real connect
        // error (DNS/TCP/timeout) instead of NIO's leaked-promise fatalError.
        done.fail(error)
        try? await group.shutdownGracefully()
        throw error
      }
      // The reporter resolves `done` on handshake completion (trust OK) or on the
      // first error / early close (trust or transport failure). connectTimeout
      // bounds the TCP connect; the caller bounds the overall run.
      let negotiated: String
      do {
        negotiated = try await done.futureResult.get()
      } catch {
        try? await channel.close()
        try? await group.shutdownGracefully()
        throw error
      }
      try? await channel.close()
      try await group.shutdownGracefully()
      return negotiated
    } catch {
      try? await group.shutdownGracefully()
      throw error
    }
  }
}

// Fulfils on TLS handshake completion (trust validated) or fails on the first
// error / early close. This isolates the outer-TLS trust decision from any HTTP,
// WebSocket or inner-TLS behaviour.
private final class TLSHandshakeReporter: ChannelInboundHandler {
  typealias InboundIn = ByteBuffer
  private let promise: EventLoopPromise<String>
  private var settled = false
  init(promise: EventLoopPromise<String>) { self.promise = promise }
  func userInboundEventTriggered(context: ChannelHandlerContext, event: Any) {
    if let tls = event as? TLSUserEvent, case .handshakeCompleted(let negotiated) = tls, !settled {
      settled = true
      promise.succeed(negotiated ?? "tls")
    }
    context.fireUserInboundEventTriggered(event)
  }
  func errorCaught(context: ChannelHandlerContext, error: Error) {
    if !settled { settled = true; promise.fail(error) }
    context.close(promise: nil)
  }
  func channelInactive(context: ChannelHandlerContext) {
    if !settled { settled = true; promise.fail(ProbeError.disconnected) }
    context.fireChannelInactive()
  }
}
