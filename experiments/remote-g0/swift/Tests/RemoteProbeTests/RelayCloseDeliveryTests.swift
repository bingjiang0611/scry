import XCTest
import Foundation
import Crypto
import X509
import NIOCore
import NIOEmbedded
import NIOConcurrencyHelpers
import NIOWebSocket
import NIOSSL
@testable import RemoteTransport

final class RelayCloseDeliveryTests: XCTestCase {
  func testAuthenticatedReplyIsDeliveredBeforeCoalescedRelayClose() throws {
    let reply = Data("{\"ok\":true}".utf8)
    let result = try exchangeThenClose(response: reply + Data([10]))
    XCTAssertEqual(try result.get(), reply)
  }

  func testPartialAuthenticatedReplyStillFailsOnRelayClose() throws {
    let result = try exchangeThenClose(response: Data("{\"ok\":".utf8))
    guard case let .failure(error) = result,
          case let RelayTransportError.closed(code, reason) = error else {
      return XCTFail("A partial reply must not become success: \(result)")
    }
    XCTAssertEqual(code, 1000)
    XCTAssertEqual(reason, "peer_closed")
  }

  func testCorruptedTLSRecordCannotBecomeSuccessOnRelayClose() throws {
    let result = try exchangeThenClose(response: Data("{\"ok\":true}\n".utf8), corruptRecord: true)
    guard case let .failure(error) = result else {
      return XCTFail("An unauthenticated TLS record must not become success")
    }
    guard let tls = error as? BoringSSLError, case .sslError = tls else {
      return XCTFail("The record-authentication failure must not become a relay close: \(error)")
    }
  }

  private func exchangeThenClose(response: Data, corruptRecord: Bool = false) throws -> Result<Data, Error> {
    // Real TLS on both sides, with an ephemeral trust anchor valid for client
    // and server authentication. No verification callbacks or real credentials.
    let key = P256.Signing.PrivateKey()
    let signingKey = Certificate.PrivateKey(key)
    let subject = try DistinguishedName { CommonName("scry-relay-close-fixture") }
    let extensions = try Certificate.Extensions([
      .init(BasicConstraints.isCertificateAuthority(maxPathLength: nil), critical: true),
      .init(ExtendedKeyUsage([.serverAuth, .clientAuth]), critical: false)
    ])
    let now = Date()
    let certificate = try Certificate(version: .v3, serialNumber: .init(), publicKey: signingKey.publicKey,
      notValidBefore: now.addingTimeInterval(-60), notValidAfter: now.addingTimeInterval(600),
      issuer: subject, subject: subject, signatureAlgorithm: .ecdsaWithSHA256,
      extensions: extensions, issuerPrivateKey: signingKey)
    let leaf = try NIOSSLCertificate(bytes: Array(certificate.serializeAsPEM().pemString.utf8), format: .pem)
    let privateKey = try NIOSSLPrivateKey(bytes: Array(key.pemRepresentation.utf8), format: .pem)
    var serverConfiguration = TLSConfiguration.makeServerConfiguration(certificateChain: [.certificate(leaf)], privateKey: .privateKey(privateKey))
    serverConfiguration.minimumTLSVersion = .tlsv13
    serverConfiguration.maximumTLSVersion = .tlsv13
    serverConfiguration.certificateVerification = .noHostnameVerification
    serverConfiguration.trustRoots = .certificates([leaf])
    var clientConfiguration = TLSConfiguration.makeClientConfiguration()
    clientConfiguration.minimumTLSVersion = .tlsv13
    clientConfiguration.maximumTLSVersion = .tlsv13
    clientConfiguration.certificateVerification = .noHostnameVerification
    clientConfiguration.trustRoots = .certificates([leaf])
    clientConfiguration.certificateChain = [.certificate(leaf)]
    clientConfiguration.privateKey = .privateKey(privateKey)
    let client = EmbeddedChannel()
    let server = EmbeddedChannel()
    let result = client.eventLoop.makePromise(of: Data.self)
    let completion = NIOLockedValueBox<Result<Data, Error>?>(nil)
    result.futureResult.whenComplete { value in completion.withLockedValue { $0 = value } }
    try client.pipeline.syncOperations.addHandlers([
      TunnelCodec(),
      NIOSSLClientHandler(context: NIOSSLContext(configuration: clientConfiguration), serverHostname: nil),
      ProbeHandler(request: Data("{}".utf8), result: result)
    ])
    try server.pipeline.syncOperations.addHandler(NIOSSLServerHandler(context: NIOSSLContext(configuration: serverConfiguration)))
    let serverTLSContext = try server.pipeline.syncOperations.context(handlerType: NIOSSLServerHandler.self)
    defer {
      // Force the fixture transport closed. A graceful TLS shutdown would wait
      // forever for a peer already closed by this deliberately abrupt scenario.
      serverTLSContext.close(promise: nil)
      server.embeddedEventLoop.run()
      _ = try? client.finish(acceptAlreadyClosed: true)
      _ = try? server.finish(acceptAlreadyClosed: true)
    }
    let address = try SocketAddress(ipAddress: "127.0.0.1", port: 443)
    try server.connect(to: address).wait()
    try client.connect(to: address).wait()
    for _ in 0..<100 {
      var progressed = false
      while let frame = try client.readOutbound(as: WebSocketFrame.self) {
        _ = try server.writeInbound(frame.data)
        progressed = true
      }
      while let bytes = try server.readOutbound(as: ByteBuffer.self) {
        _ = try client.writeInbound(WebSocketFrame(fin: true, opcode: .binary, data: bytes))
        progressed = true
      }
      client.embeddedEventLoop.run()
      server.embeddedEventLoop.run()
      if !progressed { break }
    }
    let request = try XCTUnwrap(server.readInbound(as: ByteBuffer.self))
    XCTAssertEqual(String(decoding: request.readableBytesView, as: UTF8.self), "{}\n")
    _ = try server.writeOutbound(ByteBuffer(bytes: response))
    var deliveredRecord = false
    while var bytes = try server.readOutbound(as: ByteBuffer.self) {
      if corruptRecord {
        let index = bytes.writerIndex - 1
        bytes.setInteger(bytes.getInteger(at: index, as: UInt8.self)! ^ 1, at: index)
      }
      // Do not fire readComplete yet: a real WebSocket decoder can deliver a
      // binary record and the following close in one underlying socket read.
      client.pipeline.fireChannelRead(WebSocketFrame(fin: true, opcode: .binary, data: bytes))
      deliveredRecord = true
    }
    XCTAssertTrue(deliveredRecord)
    var close = client.allocator.buffer(capacity: 13)
    close.writeInteger(UInt16(1000))
    close.writeString("peer_closed")
    client.pipeline.fireChannelRead(WebSocketFrame(fin: true, opcode: .connectionClose, data: close))
    client.pipeline.fireChannelReadComplete()
    client.embeddedEventLoop.run()
    return try XCTUnwrap(completion.withLockedValue { $0 }, "The terminal relay close must settle the request")
  }
}
