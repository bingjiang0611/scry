import XCTest
import NIOSSL
import NIOCore
import NIOPosix
@testable import RemoteTransport

private final class CloseOnClientHello: ChannelInboundHandler {
  typealias InboundIn = ByteBuffer
  func channelRead(context: ChannelHandlerContext, data: NIOAny) {
    context.close(promise: nil)
  }
}

final class TLSLayerTests: XCTestCase {
  func testOuterHandshakeEOFIsTaggedByProductionConnector() async throws {
    let material = try G0EnrollmentMaterial.generate()
    let identity = G0ProbeIdentity(outerCA: Data(), hostAnchor: material.bootstrapPEM)
    let group = MultiThreadedEventLoopGroup(numberOfThreads: 1)
    let server: Channel
    do {
      server = try await ServerBootstrap(group: group)
        .childChannelInitializer { $0.pipeline.addHandler(CloseOnClientHello()) }
        .bind(host: "127.0.0.1", port: 0).get()
    } catch {
      try await group.shutdownGracefully()
      throw error
    }
    let endpoint = G0Transport.RelayEndpoint(host: "127.0.0.1", port: server.localAddress!.port!,
      hostId: "fixture", relayServerName: "localhost", outerTLS: .system)
    var failure: Error?
    do {
      _ = try await G0Transport.connectRelayChannel(endpoint: endpoint, mode: "pair", identity: identity, group: group)
    } catch { failure = error }
    try await server.close().get()
    try await group.shutdownGracefully()
    guard let failure, case let RelayTransportError.tlsHandshake(layer, detail) = failure else {
      return XCTFail("Production connector did not preserve the outer TLS layer: \(String(describing: failure))")
    }
    XCTAssertEqual(layer, .relay)
    XCTAssertTrue(detail.contains("handshakeFailed"))
  }

  func testHandshakeFailureRetainsItsLayerAndOriginalDiagnostic() {
    let original = NIOSSLError.handshakeFailed(.sslError([]))
    for layer in [RelayTransportError.TLSLayer.relay, .host] {
      let annotated = RelayTransportError.identifyingHandshake(original, layer: layer)
      guard case let RelayTransportError.tlsHandshake(actualLayer, detail) = annotated else {
        return XCTFail("Missing TLS layer")
      }
      XCTAssertEqual(actualLayer, layer)
      XCTAssertEqual(detail, String(describing: original))
    }
  }

  func testNonHandshakeTLSFailureRemainsUnchanged() {
    let original = NIOSSLError.unableToValidateCertificate
    let result = RelayTransportError.identifyingHandshake(original, layer: .host)
    XCTAssertEqual(result as? NIOSSLError, original)
  }

  func testRelayCloseCauseIsNotRelabeledAsTLSFailure() {
    let original = RelayTransportError.closed(code: 1013, reason: "fixture busy")
    let result = RelayTransportError.identifyingHandshake(original, layer: .host)
    guard case let RelayTransportError.closed(code, reason) = result else {
      return XCTFail("Relay close cause was lost")
    }
    XCTAssertEqual(code, 1013)
    XCTAssertEqual(reason, "fixture busy")
  }

  func testLayerAnnotationCannotEnableTLSOpenRetries() {
    XCTAssertTrue(LaneConnection.isNonRetryableOpenError(NIOSSLError.failedToLoadCertificate))
    XCTAssertTrue(LaneConnection.isNonRetryableOpenError(NIOSSLError.handshakeFailed(.sslError([]))))
    for layer in [RelayTransportError.TLSLayer.relay, .host] {
      XCTAssertTrue(LaneConnection.isNonRetryableOpenError(
        RelayTransportError.tlsHandshake(layer: layer, detail: "fixture EOF")))
    }
    XCTAssertFalse(LaneConnection.isNonRetryableOpenError(
      RelayTransportError.closed(code: 1013, reason: "fixture busy")))
  }
}
