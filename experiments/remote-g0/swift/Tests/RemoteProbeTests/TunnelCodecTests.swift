import XCTest
import NIOCore
import NIOEmbedded
import NIOWebSocket
import NIOSSL
import NIOConcurrencyHelpers
@testable import RemoteTransport

private final class ErrorRecorder: ChannelInboundHandler, @unchecked Sendable {
  typealias InboundIn = ByteBuffer
  var errors: [Error] = []
  func errorCaught(context: ChannelHandlerContext, error: Error) { errors.append(error) }
}

private final class WriteDuringCloseDrain: ChannelInboundHandler, @unchecked Sendable {
  typealias InboundIn = ByteBuffer
  let writeResult: EventLoopPromise<Void>
  init(writeResult: EventLoopPromise<Void>) { self.writeResult = writeResult }
  func channelReadComplete(context: ChannelHandlerContext) {
    context.channel.writeAndFlush(ByteBuffer(string: "queued ciphertext"), promise: writeResult)
  }
  func errorCaught(context: ChannelHandlerContext, error: Error) {}
}

final class TunnelCodecTests: XCTestCase {
  func testCloseDrainCannotEmitNewCiphertext() throws {
    let channel = EmbeddedChannel()
    let write = channel.eventLoop.makePromise(of: Void.self)
    let failure = NIOLockedValueBox<Error?>(nil)
    write.futureResult.whenFailure { error in failure.withLockedValue { $0 = error } }
    try channel.pipeline.syncOperations.addHandlers([TunnelCodec(), WriteDuringCloseDrain(writeResult: write)])
    defer { _ = try? channel.finish(acceptAlreadyClosed: true) }
    var payload = channel.allocator.buffer(capacity: 13)
    payload.writeInteger(UInt16(1000))
    payload.writeString("peer_closed")
    channel.pipeline.fireChannelRead(WebSocketFrame(fin: true, opcode: .connectionClose, data: payload))
    channel.embeddedEventLoop.run()
    XCTAssertNil(try channel.readOutbound(as: WebSocketFrame.self))
    guard let error = failure.withLockedValue({ $0 }), case RelayTransportError.closed = error else {
      return XCTFail("A reentrant write escaped the relay-close fence")
    }
  }

  func testEarlyCloseSurvivesTeardownWithoutReplacingTLSFailures() throws {
    let codec = TunnelCodec()
    let recorder = ErrorRecorder()
    let channel = EmbeddedChannel()
    try channel.pipeline.syncOperations.addHandlers([codec, recorder])
    defer { _ = try? channel.finish(acceptAlreadyClosed: true) }
    var payload = channel.allocator.buffer(capacity: 13)
    payload.writeInteger(UInt16(1013))
    payload.writeString("no_host_leg")
    _ = try channel.writeInbound(WebSocketFrame(fin: true, opcode: .connectionClose, data: payload))
    // Pipeline destruction is queued on the event loop after the close event.
    channel.embeddedEventLoop.run()
    let teardownError: Error
    do {
      try channel.pipeline.syncOperations.addHandler(ErrorRecorder())
      return XCTFail("Installing a handler after teardown unexpectedly succeeded")
    } catch {
      teardownError = error
      guard case ChannelError.ioOnClosedChannel = error else {
        return XCTFail("Expected ioOnClosedChannel after teardown, got \(error)")
      }
    }
    for failure in [ProbeError.disconnected, teardownError] {
      let recovered = codec.retainingCloseCause(for: failure)
      guard case let RelayTransportError.closed(code, reason) = recovered else {
        return XCTFail("A late consumer lost the original relay close: \(recovered)")
      }
      XCTAssertEqual(code, 1013)
      XCTAssertEqual(reason, "no_host_leg")
    }
    let rejected = NIOSSLError.handshakeFailed(.sslError([]))
    XCTAssertEqual(codec.retainingCloseCause(for: rejected) as? NIOSSLError, rejected)
    guard case ProbeError.invalidFrame = codec.retainingCloseCause(for: ProbeError.invalidFrame) else {
      return XCTFail("An unrelated failure was replaced by the relay close")
    }
    let noCauseCodec = TunnelCodec()
    guard case ChannelError.ioOnClosedChannel = noCauseCodec.retainingCloseCause(for: teardownError) else {
      return XCTFail("An ioOnClosedChannel without a relay close cause was replaced")
    }
  }

  // An older Mac sent a whole history page as one frame. The real NIO decoder
  // rejects it; the device must see a named error, not "invalidFrameLength".
  func testOversizedFrameBecomesFrameTooLarge() throws {
    let recorder = ErrorRecorder()
    let channel = EmbeddedChannel()
    try channel.pipeline.syncOperations.addHandlers([
      ByteToMessageHandler(WebSocketFrameDecoder(maxFrameSize: 16)), TunnelCodec(), recorder
    ])
    defer { _ = try? channel.finish(acceptAlreadyClosed: true) }
    var frame = channel.allocator.buffer(capacity: 34)
    frame.writeBytes([0x82, 32])
    frame.writeBytes([UInt8](repeating: 1, count: 32))
    // The recorder consumes the error, so the write itself does not throw.
    _ = try channel.writeInbound(frame)
    XCTAssertEqual(recorder.errors.count, 1)
    guard case .frameTooLarge? = recorder.errors.first as? RelayTransportError else {
      return XCTFail("expected frameTooLarge, got \(recorder.errors)")
    }
  }
}
