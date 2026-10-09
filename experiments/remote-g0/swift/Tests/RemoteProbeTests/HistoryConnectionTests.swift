import XCTest
import Foundation
import NIOCore
import NIOEmbedded
import NIOTLS
@testable import RemoteTransport

final class HistoryConnectionTests: XCTestCase {
  private func connectedChannel(_ handler: HistoryReadHandler) throws -> EmbeddedChannel {
    let channel = EmbeddedChannel(handler: handler)
    try channel.connect(to: SocketAddress(ipAddress: "127.0.0.1", port: 443)).wait()
    return channel
  }

  func testOneHandshakeSerializesPagesAndKeepsConnection() throws {
    let handler = HistoryReadHandler()
    let channel = try connectedChannel(handler)
    defer { _ = try? channel.finish(acceptAlreadyClosed: true) }
    let first = handler.request(Data("preview".utf8), limit: 100, on: channel)
    let second = handler.request(Data("page".utf8), limit: 100, on: channel)
    XCTAssertNil(try channel.readOutbound(as: ByteBuffer.self))
    channel.pipeline.fireUserInboundEventTriggered(TLSUserEvent.handshakeCompleted(negotiatedProtocol: nil))
    XCTAssertEqual(try channel.readOutbound(as: ByteBuffer.self), ByteBuffer(string: "preview\n"))
    XCTAssertNil(try channel.readOutbound(as: ByteBuffer.self))
    _ = try channel.writeInbound(ByteBuffer(string: "{\"status\":\"available\"}\n"))
    XCTAssertEqual(try first.wait(), Data("{\"status\":\"available\"}".utf8))
    XCTAssertEqual(try channel.readOutbound(as: ByteBuffer.self), ByteBuffer(string: "page\n"))
    _ = try channel.writeInbound(ByteBuffer(string: "{\"page\":1}\n"))
    XCTAssertEqual(try second.wait(), Data("{\"page\":1}".utf8))
    XCTAssertTrue(channel.isActive)
  }

  func testOverflowSettlesBothPagesAndCloses() throws {
    let handler = HistoryReadHandler()
    let channel = try connectedChannel(handler)
    defer { _ = try? channel.finish(acceptAlreadyClosed: true) }
    channel.pipeline.fireUserInboundEventTriggered(TLSUserEvent.handshakeCompleted(negotiatedProtocol: nil))
    let first = handler.request(Data("first".utf8), limit: 4, on: channel)
    let second = handler.request(Data("second".utf8), limit: 100, on: channel)
    _ = try channel.writeInbound(ByteBuffer(string: "overflow\n"))
    XCTAssertThrowsError(try first.wait())
    XCTAssertThrowsError(try second.wait())
    XCTAssertFalse(channel.isActive)
  }

  func testCancelledConnectionSettlesQueuedReads() throws {
    let handler = HistoryReadHandler()
    let channel = try connectedChannel(handler)
    let first = handler.request(Data("first".utf8), limit: 100, on: channel)
    let second = handler.request(Data("second".utf8), limit: 100, on: channel)
    try channel.close().wait()
    XCTAssertThrowsError(try first.wait())
    XCTAssertThrowsError(try second.wait())
    _ = try channel.finish(acceptAlreadyClosed: true)
  }

  func testHandshakeAndPageTimeoutsCannotLeakPromises() throws {
    for handshake in [false, true] {
      let handler = HistoryReadHandler()
      let channel = try connectedChannel(handler)
      if handshake { channel.pipeline.fireUserInboundEventTriggered(TLSUserEvent.handshakeCompleted(negotiatedProtocol: nil)) }
      let reply = handler.request(Data("request".utf8), limit: 100, on: channel)
      channel.embeddedEventLoop.advanceTime(by: .seconds(handshake ? 31 : 11))
      XCTAssertThrowsError(try reply.wait())
      XCTAssertFalse(channel.isActive)
      _ = try channel.finish(acceptAlreadyClosed: true)
    }
  }

  func testUnsolicitedOrTrailingRepliesFailClosed() throws {
    for payload in ["reply\nextra", "reply\n"] {
      let handler = HistoryReadHandler()
      let channel = try connectedChannel(handler)
      if payload.contains("extra") {
        channel.pipeline.fireUserInboundEventTriggered(TLSUserEvent.handshakeCompleted(negotiatedProtocol: nil))
        let reply = handler.request(Data("request".utf8), limit: 100, on: channel)
        _ = try channel.writeInbound(ByteBuffer(string: payload))
        XCTAssertThrowsError(try reply.wait())
      } else { _ = try channel.writeInbound(ByteBuffer(string: payload)) }
      XCTAssertFalse(channel.isActive)
      _ = try channel.finish(acceptAlreadyClosed: true)
    }
  }
}
