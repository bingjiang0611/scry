import Foundation
import NIOCore
import NIOPosix
#if canImport(Network)
import NIOTransportServices
#endif

// One TCP connect path for every outbound tunnel (relay and direct).
//
// On Apple platforms this uses Network.framework through NIOTransportServices:
// unlike BSD sockets it activates the cellular radio and on-demand VPN, waits
// for connectivity within the connect timeout, and races IPv4/IPv6. Elsewhere
// (Linux tests, tools) it uses NIOPosix. Both use the classic initializer API so
// the pipeline is built identically before any byte is exchanged; TLS, the
// WebSocket upgrade and inner mTLS stay NIOSSL/NIO handlers on either path.
enum RemoteBootstrap {
  static let writeBufferWaterMark = ChannelOptions.Types.WriteBufferWaterMark(low: 262_144, high: 524_288)

  // `initialize` runs on the channel's event loop before connect and returns a
  // future for whatever the pipeline produces (e.g. a WebSocket upgrade).
  static func connect<Output: Sendable>(host: String, port: Int, timeout: TimeAmount,
                                        posixGroup: EventLoopGroup? = nil,
                                        initialize: @escaping @Sendable (Channel) throws -> EventLoopFuture<Output>) async throws -> Output {
    let produced = LockedValue<EventLoopFuture<Output>?>(nil)
    let initializer: @Sendable (Channel) -> EventLoopFuture<Void> = { channel in
      do {
        produced.value = try initialize(channel)
        return channel.eventLoop.makeSucceededVoidFuture()
      } catch {
        return channel.eventLoop.makeFailedFuture(error)
      }
    }
    let channel: Channel
    #if canImport(Network)
    _ = posixGroup
    channel = try await NIOTSConnectionBootstrap(group: NIOTSEventLoopGroup.singleton)
      .connectTimeout(timeout)
      .channelOption(ChannelOptions.writeBufferWaterMark, value: writeBufferWaterMark)
      .channelInitializer(initializer)
      .connect(host: host, port: port).get()
    #else
    channel = try await ClientBootstrap(group: posixGroup ?? MultiThreadedEventLoopGroup.singleton)
      .connectTimeout(timeout)
      .channelOption(ChannelOptions.writeBufferWaterMark, value: writeBufferWaterMark)
      .channelInitializer(initializer)
      .connect(host: host, port: port).get()
    #endif
    guard let future = produced.value else {
      channel.close(promise: nil)
      throw ProbeError.disconnected
    }
    do {
      return try await future.get()
    } catch {
      // A failed upgrade (e.g. a non-101 answer on a kept-alive connection)
      // hands the caller no channel, so nothing else would ever close it.
      channel.close(promise: nil)
      throw error
    }
  }

  // Plain connected channel with handlers installed before connect.
  static func connectChannel(host: String, port: Int, timeout: TimeAmount, posixGroup: EventLoopGroup? = nil,
                             initialize: @escaping @Sendable (Channel) throws -> Void) async throws -> Channel {
    try await connect(host: host, port: port, timeout: timeout, posixGroup: posixGroup) { channel -> EventLoopFuture<Channel> in
      try initialize(channel)
      return channel.eventLoop.makeSucceededFuture(channel)
    }
  }
}
