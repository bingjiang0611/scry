import XCTest
import Foundation
import NIOCore
import NIOEmbedded
import NIOTLS
@testable import RemoteTransport

final class LaneHandlerTests: XCTestCase {
  private func lane() throws -> (LaneHandler, EmbeddedChannel) {
    let channel = EmbeddedChannel()
    let handler = LaneHandler(ready: channel.eventLoop.makePromise(of: Void.self))
    try channel.pipeline.syncOperations.addHandler(handler)
    try channel.connect(to: SocketAddress(ipAddress: "127.0.0.1", port: 443)).wait()
    return (handler, channel)
  }

  private func phase(_ future: EventLoopFuture<Data>) -> String {
    do { _ = try future.wait(); return "ok" }
    catch LaneFailure.notSent { return "notSent" }
    catch LaneFailure.lost { return "lost" }
    catch { return "other" }
  }

  func testKeepAliveRequestPrefixKeepsFields() {
    let request = Data(#"{"op":"poll","cursor":3}"#.utf8)
    XCTAssertEqual(String(decoding: RelaySession.keepAliveRequest(request), as: UTF8.self), #"{"keepAlive":true,"op":"poll","cursor":3}"#)
  }

  func testMarkedRepliesKeepTheLaneAndSendInOrder() throws {
    let (handler, channel) = try lane()
    defer { _ = try? channel.finish(acceptAlreadyClosed: true) }
    let first = handler.request(Data("a".utf8), limit: 100, timeout: .seconds(30), on: channel)
    let second = handler.request(Data("b".utf8), limit: 100, timeout: .seconds(30), on: channel)
    XCTAssertNil(try channel.readOutbound(as: ByteBuffer.self), "no request before the inner handshake")
    channel.pipeline.fireUserInboundEventTriggered(TLSUserEvent.handshakeCompleted(negotiatedProtocol: nil))
    XCTAssertNoThrow(try handler.ready.futureResult.wait())
    XCTAssertEqual(try channel.readOutbound(as: ByteBuffer.self), ByteBuffer(string: "a\n"))
    XCTAssertNil(try channel.readOutbound(as: ByteBuffer.self), "one outstanding request")
    _ = try channel.writeInbound(ByteBuffer(string: "{\"keepAlive\":true,\"x\":1}\n"))
    XCTAssertEqual(try first.wait(), Data("{\"keepAlive\":true,\"x\":1}".utf8))
    XCTAssertEqual(try channel.readOutbound(as: ByteBuffer.self), ByteBuffer(string: "b\n"))
    _ = try channel.writeInbound(ByteBuffer(string: "{\"keepAlive\":true,\"x\":2}\n"))
    XCTAssertEqual(phase(second), "ok")
    XCTAssertTrue(handler.acceptsRequests.value)
  }

  func testOneShotHostReplyMovesQueuedRequestsToAFreshTunnel() throws {
    let (handler, channel) = try lane()
    defer { _ = try? channel.finish(acceptAlreadyClosed: true) }
    channel.pipeline.fireUserInboundEventTriggered(TLSUserEvent.handshakeCompleted(negotiatedProtocol: nil))
    let first = handler.request(Data("a".utf8), limit: 100, timeout: .seconds(30), on: channel)
    let queued = handler.request(Data("b".utf8), limit: 100, timeout: .seconds(30), on: channel)
    _ = try channel.readOutbound(as: ByteBuffer.self)
    _ = try channel.writeInbound(ByteBuffer(string: "{\"poll\":{}}\n"))
    XCTAssertEqual(phase(first), "ok")
    XCTAssertEqual(phase(queued), "notSent")
    XCTAssertNil(try channel.readOutbound(as: ByteBuffer.self), "queued request is never written to a one-shot tunnel")
    XCTAssertFalse(handler.acceptsRequests.value)
  }

  func testDisconnectSeparatesWrittenFromUnwrittenRequests() throws {
    let (handler, channel) = try lane()
    channel.pipeline.fireUserInboundEventTriggered(TLSUserEvent.handshakeCompleted(negotiatedProtocol: nil))
    let written = handler.request(Data("a".utf8), limit: 100, timeout: .seconds(30), on: channel)
    let unwritten = handler.request(Data("b".utf8), limit: 100, timeout: .seconds(30), on: channel)
    try channel.close().wait()
    XCTAssertEqual(phase(written), "lost")
    XCTAssertEqual(phase(unwritten), "notSent")
    let late = handler.request(Data("c".utf8), limit: 100, timeout: .seconds(30), on: channel)
    XCTAssertEqual(phase(late), "notSent")
    _ = try channel.finish(acceptAlreadyClosed: true)
  }

  func testStaleLegFailsTheHandshakeWithoutSendingAnything() throws {
    let (handler, channel) = try lane()
    let queued = handler.request(Data("a".utf8), limit: 100, timeout: .seconds(30), on: channel)
    channel.embeddedEventLoop.advanceTime(by: .seconds(9))
    XCTAssertThrowsError(try handler.ready.futureResult.wait())
    XCTAssertEqual(phase(queued), "notSent")
    XCTAssertFalse(channel.isActive)
    _ = try channel.finish(acceptAlreadyClosed: true)
  }

  func testResponseDeadlineIsInactivityBased() throws {
    let (handler, channel) = try lane()
    defer { _ = try? channel.finish(acceptAlreadyClosed: true) }
    channel.pipeline.fireUserInboundEventTriggered(TLSUserEvent.handshakeCompleted(negotiatedProtocol: nil))
    let reply = handler.request(Data("a".utf8), limit: 100, timeout: .seconds(10), on: channel)
    channel.embeddedEventLoop.advanceTime(by: .seconds(8))
    _ = try channel.writeInbound(ByteBuffer(string: "{\"keepAlive\":true,"))
    channel.embeddedEventLoop.advanceTime(by: .seconds(8))
    XCTAssertTrue(channel.isActive)
    _ = try channel.writeInbound(ByteBuffer(string: "\"x\":1}\n"))
    XCTAssertEqual(phase(reply), "ok")
    let silent = handler.request(Data("b".utf8), limit: 100, timeout: .seconds(10), on: channel)
    channel.embeddedEventLoop.advanceTime(by: .seconds(11))
    XCTAssertEqual(phase(silent), "lost")
    XCTAssertFalse(channel.isActive)
  }
}
