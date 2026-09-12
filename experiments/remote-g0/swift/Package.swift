// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "ScryRemoteG0",
  platforms: [.macOS(.v14), .iOS(.v17)],
  products: [
    .executable(name: "scry-remote-probe", targets: ["RemoteProbe"]),
    .library(name: "ScryG0Transport", targets: ["RemoteTransport"])
  ],
  dependencies: [
    .package(url: "https://github.com/apple/swift-nio.git", exact: "2.90.1"),
    .package(url: "https://github.com/apple/swift-nio-ssl.git", exact: "2.36.1")
  ],
  targets: [
    .executableTarget(name: "RemoteProbe", dependencies: ["RemoteTransport"]),
    .target(name: "RemoteTransport", dependencies: [
      .product(name: "NIOCore", package: "swift-nio"),
      .product(name: "NIOTLS", package: "swift-nio"),
      .product(name: "NIOPosix", package: "swift-nio"),
      .product(name: "NIOHTTP1", package: "swift-nio"),
      .product(name: "NIOWebSocket", package: "swift-nio"),
      .product(name: "NIOSSL", package: "swift-nio-ssl")
    ]),
    .testTarget(name: "RemoteProbeTests", dependencies: ["RemoteTransport"])
  ]
)
