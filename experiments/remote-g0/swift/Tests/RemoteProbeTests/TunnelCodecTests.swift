import XCTest
import NIOCore
import NIOEmbedded
import NIOWebSocket
@testable import RemoteTransport

private final class ErrorRecorder: ChannelInboundHandler, @unchecked Sendable {
  typealias InboundIn = ByteBuffer
  var errors: [Error] = []
  func errorCaught(context: ChannelHandlerContext, error: Error) { errors.append(error) }
}

final class TunnelCodecTests: XCTestCase {
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
