import XCTest
import Foundation
import NIOCore
import NIOEmbedded
import NIOTLS
import NIOWebSocket
@testable import RemoteTransport

final class ProbeHandlerTests: XCTestCase {
  func testAlreadyClosedChannelSettlesRequest() throws {
    let channel = EmbeddedChannel()
    try channel.close().wait()
    let result = channel.eventLoop.makePromise(of: Data.self)
    var settled = false
    result.futureResult.whenComplete { _ in settled = true }
    try channel.pipeline.syncOperations.addHandler(ProbeHandler(request: Data(), result: result))
    channel.embeddedEventLoop.run()
    XCTAssertTrue(settled, "Request installed after relay close must not hang forever")
    // Settle the failing implementation too, so this regression fails cleanly.
    if !settled { result.fail(RelayTransportError.closed(code: nil, reason: "test cleanup")) }
    XCTAssertThrowsError(try result.futureResult.wait())
    _ = try channel.finish(acceptAlreadyClosed: true)
  }

  func testHandshakeAndResponseDeadlinesSettleRequest() throws {
    for handshake in [false, true] {
      let channel = EmbeddedChannel()
      try channel.connect(to: SocketAddress(ipAddress: "127.0.0.1", port: 443)).wait()
      let result = channel.eventLoop.makePromise(of: Data.self)
      var settled = false
      result.futureResult.whenComplete { _ in settled = true }
      try channel.pipeline.syncOperations.addHandler(ProbeHandler(request: Data("request".utf8), result: result))
      if handshake { channel.pipeline.fireUserInboundEventTriggered(TLSUserEvent.handshakeCompleted(negotiatedProtocol: nil)) }
      channel.embeddedEventLoop.advanceTime(by: .seconds(handshake ? 31 : 11))
      XCTAssertTrue(settled, "Missing peer must produce a bounded failure")
      if !settled { try channel.close().wait() }
      XCTAssertThrowsError(try result.futureResult.wait())
      _ = try channel.finish(acceptAlreadyClosed: true)
    }
  }

  func testSuccessfulReplyIsNotOverwrittenByCloseOrDeadline() throws {
    let channel = EmbeddedChannel()
    try channel.connect(to: SocketAddress(ipAddress: "127.0.0.1", port: 443)).wait()
    let result = channel.eventLoop.makePromise(of: Data.self)
    try channel.pipeline.syncOperations.addHandler(ProbeHandler(request: Data("request".utf8), result: result))
    XCTAssertNil(try channel.readOutbound(as: ByteBuffer.self))
    channel.pipeline.fireUserInboundEventTriggered(TLSUserEvent.handshakeCompleted(negotiatedProtocol: nil))
    XCTAssertEqual(try channel.readOutbound(as: ByteBuffer.self), ByteBuffer(string: "request\n"))
    _ = try channel.writeInbound(ByteBuffer(string: "reply\n"))
    channel.embeddedEventLoop.advanceTime(by: .seconds(60))
    XCTAssertEqual(try result.futureResult.wait(), Data("reply".utf8))
    _ = try channel.finish(acceptAlreadyClosed: true)
  }

  func testRelayCloseReasonSurvivesInsteadOfAnonymousEOF() throws {
    let channel = EmbeddedChannel(handler: TunnelCodec())
    try channel.connect(to: SocketAddress(ipAddress: "127.0.0.1", port: 443)).wait()
    let result = channel.eventLoop.makePromise(of: Data.self)
    try channel.pipeline.syncOperations.addHandler(ProbeHandler(request: Data(), result: result))
    var close = ByteBuffer()
    close.writeInteger(UInt16(1013)); close.writeString("no_host_leg")
    _ = try channel.writeInbound(WebSocketFrame(fin: true, opcode: .connectionClose, data: close))
    XCTAssertThrowsError(try result.futureResult.wait()) { error in
      guard case let RelayTransportError.closed(code, reason) = error else { return XCTFail("lost relay cause: \(error)") }
      XCTAssertEqual(code, 1013); XCTAssertEqual(reason, "no_host_leg")
    }
    _ = try channel.finish(acceptAlreadyClosed: true)
  }
}
