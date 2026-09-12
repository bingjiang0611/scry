// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "ScryRemoteG0",
  platforms: [.macOS(.v14), .iOS(.v17)],
  products: [
    .executable(name: "scry-remote-probe", targets: ["RemoteProbe"]),
    .executable(name: "scry-enrollment-fixture", targets: ["EnrollmentFixture"]),
    .library(name: "ScryG0Transport", targets: ["RemoteTransport"])
  ],
  dependencies: [
    .package(url: "https://github.com/apple/swift-nio.git", exact: "2.90.1"),
    .package(url: "https://github.com/apple/swift-nio-ssl.git", exact: "2.36.1"),
    .package(url: "https://github.com/apple/swift-certificates.git", exact: "1.20.0"),
    .package(url: "https://github.com/apple/swift-crypto.git", exact: "4.5.2")
  ],
  targets: [
    .executableTarget(name: "RemoteProbe", dependencies: ["RemoteTransport"]),
    .executableTarget(name: "EnrollmentFixture", dependencies: ["RemoteTransport"]),
    .target(name: "RemoteTransport", dependencies: [
      .product(name: "NIOCore", package: "swift-nio"),
      .product(name: "NIOTLS", package: "swift-nio"),
      .product(name: "NIOPosix", package: "swift-nio"),
      .product(name: "NIOHTTP1", package: "swift-nio"),
      .product(name: "NIOWebSocket", package: "swift-nio"),
      .product(name: "NIOSSL", package: "swift-nio-ssl"),
      .product(name: "X509", package: "swift-certificates"),
      .product(name: "Crypto", package: "swift-crypto")
    ]),
    .testTarget(name: "RemoteProbeTests", dependencies: [
      "RemoteTransport", .product(name: "X509", package: "swift-certificates"),
      .product(name: "NIOSSL", package: "swift-nio-ssl")
    ])
  ]
)
