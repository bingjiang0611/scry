import XCTest
import Foundation
import NIOCore
import NIOEmbedded
import NIOTLS
@testable import RemoteTransport

final class MuxHandlerTests: XCTestCase {
  private func mux(handshaken: Bool = false) throws -> (MuxHandler, EmbeddedChannel) {
    let channel = EmbeddedChannel()
    let handler = MuxHandler(ready: channel.eventLoop.makePromise(of: Void.self), handshaken: handshaken)
    try channel.pipeline.syncOperations.addHandler(handler)
    try channel.connect(to: SocketAddress(ipAddress: "127.0.0.1", port: 443)).wait()
    return (handler, channel)
  }

  private func request(_ handler: MuxHandler, _ channel: EmbeddedChannel, id: Int, op: String,
                       timeout: TimeAmount = .seconds(30), fatal: Bool = false) -> EventLoopFuture<Data> {
    handler.request(id: id, Data(#"{"keepAlive":true,"op":"\#(op)"}"#.utf8), limit: 4_096, timeout: timeout,
                    fatalOnTimeout: fatal, on: channel)
  }

  private func phase(_ future: EventLoopFuture<Data>) -> String {
    do { _ = try future.wait(); return "ok" }
    catch LaneFailure.notSent { return "notSent" }
    catch LaneFailure.lost { return "lost" }
    catch is CancellationError { return "cancelled" }
    catch { return "other" }
  }

  private func handshake(_ channel: EmbeddedChannel) {
    channel.pipeline.fireUserInboundEventTriggered(TLSUserEvent.handshakeCompleted(negotiatedProtocol: nil))
  }

  func testFramingInsertsTheIdAfterTheKeepAliveMarker() {
    XCTAssertEqual(MuxHandler.frame(Data(#"{"keepAlive":true,"op":"poll"}"#.utf8), id: 7),
                   Data(#"{"keepAlive":true,"id":7,"op":"poll"}"#.utf8))
    XCTAssertEqual(MuxHandler.frame(Data(#"{"keepAlive":true}"#.utf8), id: 1), Data(#"{"keepAlive":true,"id":1}"#.utf8))
    XCTAssertNil(MuxHandler.frame(Data(#"{"op":"poll"}"#.utf8), id: 1))
    XCTAssertEqual(MuxHandler.replyId(Data(#"{"keepAlive":true,"id":42,"x":1}"#.utf8)), 42)
    XCTAssertEqual(MuxHandler.replyId(Data(#"{"keepAlive":true,"id":0}"#.utf8)), 0)
    XCTAssertNil(MuxHandler.replyId(Data(#"{"keepAlive":true,"error":"mux_id_required"}"#.utf8)))
    XCTAssertNil(MuxHandler.replyId(Data(#"{"keepAlive":true,"id":-1}"#.utf8)))
  }

  func testRequestsQueueUntilHandshakeThenRunConcurrentlyAndReplyOutOfOrder() throws {
    let (handler, channel) = try mux()
    defer { _ = try? channel.finish(acceptAlreadyClosed: true) }
    let watch = request(handler, channel, id: 1, op: "watch")
    let ping = request(handler, channel, id: 2, op: "ping")
    XCTAssertNil(try channel.readOutbound(as: ByteBuffer.self), "no request before the inner handshake")
    handshake(channel)
    XCTAssertNoThrow(try handler.ready.futureResult.wait())
    XCTAssertEqual(try channel.readOutbound(as: ByteBuffer.self), ByteBuffer(string: "{\"keepAlive\":true,\"id\":1,\"op\":\"watch\"}\n"))
    XCTAssertEqual(try channel.readOutbound(as: ByteBuffer.self), ByteBuffer(string: "{\"keepAlive\":true,\"id\":2,\"op\":\"ping\"}\n"))
    // Both replies in one read, the later request first.
    _ = try channel.writeInbound(ByteBuffer(string: "{\"keepAlive\":true,\"id\":2,\"pong\":{}}\n{\"keepAlive\":true,\"id\":1,\"watch\":{}}\n"))
    XCTAssertEqual(try ping.wait(), Data(#"{"keepAlive":true,"id":2,"pong":{}}"#.utf8))
    XCTAssertEqual(try watch.wait(), Data(#"{"keepAlive":true,"id":1,"watch":{}}"#.utf8))
    XCTAssertTrue(handler.acceptsRequests.value)
  }

  func testCancellingOneRequestDropsItsReplyAndKeepsTheTunnel() throws {
    let (handler, channel) = try mux(handshaken: true)
    defer { _ = try? channel.finish(acceptAlreadyClosed: true) }
    let superseded = request(handler, channel, id: 3, op: "watch")
    _ = try channel.readOutbound(as: ByteBuffer.self)
    handler.cancel(id: 3)
    XCTAssertEqual(phase(superseded), "cancelled")
    _ = try channel.writeInbound(ByteBuffer(string: "{\"keepAlive\":true,\"id\":3,\"watch\":{}}\n"))
    let next = request(handler, channel, id: 4, op: "ping")
    _ = try channel.writeInbound(ByteBuffer(string: "{\"keepAlive\":true,\"id\":4,\"pong\":{}}\n"))
    XCTAssertEqual(phase(next), "ok")
    XCTAssertTrue(handler.acceptsRequests.value)
  }

  func testReplyWithoutIdEndsTheTunnelAndFlagsTheMismatch() throws {
    let (handler, channel) = try mux(handshaken: true)
    defer { _ = try? channel.finish(acceptAlreadyClosed: true) }
    let written = request(handler, channel, id: 1, op: "poll")
    _ = try? channel.writeInbound(ByteBuffer(string: "{\"keepAlive\":true,\"error\":\"mux_id_required\"}\n"))
    XCTAssertEqual(phase(written), "lost")
    XCTAssertTrue(handler.protocolMismatch.value)
    XCTAssertFalse(handler.acceptsRequests.value)
  }

  func testDisconnectSeparatesWrittenFromQueuedRequests() throws {
    let (handler, channel) = try mux()
    let queued = request(handler, channel, id: 1, op: "submit")
    _ = try channel.close().wait()
    XCTAssertEqual(phase(queued), "notSent")

    let (other, open) = try mux(handshaken: true)
    let written = request(other, open, id: 1, op: "submit")
    _ = try open.close().wait()
    XCTAssertEqual(phase(written), "lost")
  }

  func testOneSlowRequestTimesOutAloneButAnUnansweredProbeEndsTheTunnel() throws {
    let (handler, channel) = try mux(handshaken: true)
    defer { _ = try? channel.finish(acceptAlreadyClosed: true) }
    let slow = request(handler, channel, id: 1, op: "history", timeout: .seconds(30))
    let longPoll = request(handler, channel, id: 2, op: "watch", timeout: .seconds(60))
    channel.embeddedEventLoop.advanceTime(by: .seconds(31))
    XCTAssertEqual(phase(slow), "lost")
    XCTAssertTrue(handler.acceptsRequests.value, "one request's timeout does not end a live tunnel")
    let probe = request(handler, channel, id: 3, op: "ping", timeout: .seconds(5), fatal: true)
    channel.embeddedEventLoop.advanceTime(by: .seconds(6))
    XCTAssertEqual(phase(probe), "lost")
    XCTAssertEqual(phase(longPoll), "lost")
    XCTAssertFalse(handler.acceptsRequests.value)
  }

  func testPushedStreamKeepsItsIdOpenUntilTheFinalLine() throws {
    let (handler, channel) = try mux(handshaken: true)
    defer { _ = try? channel.finish(acceptAlreadyClosed: true) }
    let items = LockedValue<[String]>([])
    let ending = handler.request(id: 9, Data(#"{"keepAlive":true,"op":"watchStream"}"#.utf8), limit: 4_096, timeout: .seconds(40),
                                onItem: { line in items.withValue { $0.append(String(decoding: line, as: UTF8.self)) } }, on: channel)
    XCTAssertTrue(MuxHandler.isStreamItem(Data(#"{"keepAlive":true,"id":9,"more":true,"watch":{}}"#.utf8), id: 9))
    XCTAssertFalse(MuxHandler.isStreamItem(Data(#"{"keepAlive":true,"id":9,"more":false,"watch":{}}"#.utf8), id: 9))
    _ = try channel.writeInbound(ByteBuffer(string: "{\"keepAlive\":true,\"id\":9,\"more\":true,\"n\":1}\n{\"keepAlive\":true,\"id\":9,\"more\":true,\"n\":2}\n"))
    XCTAssertEqual(items.value.count, 2)
    // Heartbeats keep the id alive past a single deadline.
    channel.embeddedEventLoop.advanceTime(by: .seconds(30))
    _ = try channel.writeInbound(ByteBuffer(string: "{\"keepAlive\":true,\"id\":9,\"more\":true,\"n\":3}\n"))
    channel.embeddedEventLoop.advanceTime(by: .seconds(30))
    _ = try channel.writeInbound(ByteBuffer(string: "{\"keepAlive\":true,\"id\":9,\"more\":false,\"n\":4}\n"))
    XCTAssertEqual(try ending.wait(), Data(#"{"keepAlive":true,"id":9,"more":false,"n":4}"#.utf8))
    XCTAssertEqual(items.value.count, 3)
  }

  func testCancellingAPushedStreamTellsTheHost() throws {
    let (handler, channel) = try mux(handshaken: true)
    defer { _ = try? channel.finish(acceptAlreadyClosed: true) }
    let stream = handler.request(id: handler.nextId(), Data(#"{"keepAlive":true,"op":"watchStream"}"#.utf8), limit: 4_096,
                                 timeout: .seconds(40), onItem: { _ in }, on: channel)
    let sent = try XCTUnwrap(channel.readOutbound(as: ByteBuffer.self))
    XCTAssertTrue(String(buffer: sent).hasPrefix("{\"keepAlive\":true,\"id\":1,\"op\":\"watchStream\""))
    handler.cancel(id: 1)
    XCTAssertEqual(phase(stream), "cancelled")
    let cancel = try XCTUnwrap(channel.readOutbound(as: ByteBuffer.self))
    XCTAssertEqual(String(buffer: cancel), "{\"keepAlive\":true,\"id\":2,\"op\":\"cancel\",\"target\":1}\n")
    // The host's late items and its cancel reply are dropped by id.
    _ = try channel.writeInbound(ByteBuffer(string: "{\"keepAlive\":true,\"id\":1,\"more\":true}\n{\"keepAlive\":true,\"id\":2,\"cancelled\":true}\n"))
    XCTAssertTrue(handler.acceptsRequests.value)
  }

  func testInboundProgressReArmsEveryWaiter() throws {
    let (handler, channel) = try mux(handshaken: true)
    defer { _ = try? channel.finish(acceptAlreadyClosed: true) }
    let waiting = request(handler, channel, id: 1, op: "watch", timeout: .seconds(10))
    let page = request(handler, channel, id: 2, op: "historyPage", timeout: .seconds(10))
    for _ in 0..<3 {
      channel.embeddedEventLoop.advanceTime(by: .seconds(8))
      _ = try channel.writeInbound(ByteBuffer(string: "{\"keepAlive\":true,\"id\":2,\"part\":\""))
    }
    _ = try channel.writeInbound(ByteBuffer(string: "x\"}\n"))
    XCTAssertEqual(phase(page), "ok")
    _ = try channel.writeInbound(ByteBuffer(string: "{\"keepAlive\":true,\"id\":1,\"watch\":{}}\n"))
    XCTAssertEqual(phase(waiting), "ok")
  }
}

final class HostTransportStateTests: XCTestCase {
  override func tearDown() {
    HostTransportState.localNetworkAvailable.value = false
    HostTransportState.directRoutesEnabled.value = true
    super.tearDown()
  }

  func testRouteKindsAcceptOnlyPrivateAndOverlayIPv4() {
    XCTAssertEqual(DirectRoute(host: "192.168.1.20", port: 1).kind, .localNetwork)
    XCTAssertEqual(DirectRoute(host: "10.0.0.5", port: 1).kind, .localNetwork)
    XCTAssertEqual(DirectRoute(host: "172.20.1.1", port: 1).kind, .localNetwork)
    XCTAssertEqual(DirectRoute(host: "100.101.2.3", port: 1).kind, .overlay)
    XCTAssertEqual(DirectRoute(host: "8.8.8.8", port: 1).kind, .other)
    XCTAssertEqual(DirectRoute(host: "172.32.0.1", port: 1).kind, .other)
    XCTAssertEqual(DirectRoute(host: "fe80::1", port: 1).kind, .other)
    XCTAssertEqual(DirectRoute(host: "scry.example", port: 1).kind, .other)
  }

  func testCandidatesFollowTheNetworkAndCoolDownAfterFailure() {
    let state = HostTransportState(hostId: UUID().uuidString)
    let lan = DirectRoute(host: "192.168.1.20", port: 4100)
    let overlay = DirectRoute(host: "100.80.1.2", port: 4100)
    state.learn(capabilities: ["ping", "mux", "lan"], routes: [overlay, lan, DirectRoute(host: "8.8.8.8", port: 4100)])
    XCTAssertTrue(state.multiplexed)
    XCTAssertEqual(state.routes, [overlay, lan], "public addresses are never dialed directly")
    HostTransportState.localNetworkAvailable.value = false
    XCTAssertEqual(state.candidateRoutes(), [overlay], "no LAN dial on cellular")
    HostTransportState.localNetworkAvailable.value = true
    XCTAssertEqual(state.candidateRoutes(), [lan, overlay], "LAN first on Wi-Fi")
    state.coolDown(lan, now: 1_000)
    XCTAssertEqual(state.candidateRoutes(now: 2_000), [overlay])
    XCTAssertEqual(state.candidateRoutes(now: 1_000 + HostTransportState.routeCooldownNanos + 1), [lan, overlay])
    HostTransportState.directRoutesEnabled.value = false
    XCTAssertEqual(state.candidateRoutes(), [])
  }

  func testLegacyAndForgottenCapabilities() {
    let state = HostTransportState(hostId: UUID().uuidString)
    XCTAssertEqual(state.capabilities, .unknown)
    state.markLegacy()
    XCTAssertEqual(state.capabilities, .legacy)
    XCTAssertFalse(state.multiplexed)
    state.learn(capabilities: ["ping", "mux"], routes: nil)
    XCTAssertTrue(state.multiplexed)
    state.forgetCapabilities()
    XCTAssertEqual(state.capabilities, .unknown)
  }

  func testPingReplyDecodesCapabilitiesAndRoutes() throws {
    let reply = try JSONDecoder().decode(PingReply.self, from: Data(#"{"keepAlive":true,"pong":{"serverTime":1,"idleTimeoutMs":75000,"capabilities":["ping","mux","lan"],"lan":{"port":4100,"addresses":["192.168.1.20"]}}}"#.utf8))
    XCTAssertEqual(reply.pong?.capabilities, ["ping", "mux", "lan"])
    XCTAssertEqual(reply.routes, [DirectRoute(host: "192.168.1.20", port: 4100)])
    let legacy = try JSONDecoder().decode(PingReply.self, from: Data(#"{"keepAlive":true,"error":"unknown_op"}"#.utf8))
    XCTAssertNil(legacy.pong)
  }

  func testColoComesFromTheRaySuffixOnly() {
    XCTAssertEqual(ConnectTimingRecorder.colo(fromRay: "8c1f2e3d4a5b6c7d-NRT"), "NRT")
    XCTAssertEqual(ConnectTimingRecorder.colo(fromRay: "8c1f2e3d4a5b6c7d-hkg"), "HKG")
    XCTAssertNil(ConnectTimingRecorder.colo(fromRay: nil))
    XCTAssertNil(ConnectTimingRecorder.colo(fromRay: "no-dash-0"))
  }

  func testHostOfflineIsRecognizedThroughLaneFailures() {
    let offline = RelayTransportError.closed(code: 4001, reason: "host_offline")
    XCTAssertTrue(RelayTransportError.isHostOffline(offline))
    XCTAssertTrue(RelayTransportError.isHostOffline(LaneFailure.notSent(offline)))
    XCTAssertFalse(RelayTransportError.isHostOffline(RelayTransportError.closed(code: 1013, reason: "no_host_leg")))
    XCTAssertTrue(RelayTransportError.permitsReadRecovery(offline))
  }
}
