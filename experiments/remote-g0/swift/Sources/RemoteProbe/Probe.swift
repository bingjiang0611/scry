import Foundation
import RemoteTransport

enum CLIError: Error { case invalidArguments }

@main
struct RemoteProbe {
  static func main() async {
    do {
      let args = Array(CommandLine.arguments.dropFirst())
      if args.first == "pair" {
        try await pair(Array(args.dropFirst()))
      } else {
        try await echo(args)
      }
    } catch {
      FileHandle.standardError.write(Data("probe rejected: \(error)\n".utf8))
      exit(1)
    }
  }

  static func echo(_ args: [String]) async throws {
    guard args.count == 6, let port = Int(args[0]) else { throw CLIError.invalidArguments }
    let identity = try G0ProbeIdentity(
      outerCA: Data(contentsOf: URL(fileURLWithPath: args[1])),
      innerCA: Data(contentsOf: URL(fileURLWithPath: args[2])),
      certificate: Data(contentsOf: URL(fileURLWithPath: args[3])),
      privateKey: Data(contentsOf: URL(fileURLWithPath: args[4]))
    )
    let reply = try await G0Transport.echo(port: port, identity: identity, payload: args[5])
    print(String(decoding: reply, as: UTF8.self))
  }

  // pair <mode:prove|status> <port> <outer-ca> <host-anchor> <pairingId> <secret> [csrPath deviceLabel]
  static func pair(_ args: [String]) async throws {
    guard args.count >= 6, let port = Int(args[1]) else { throw CLIError.invalidArguments }
    let identity = try G0ProbeIdentity(
      outerCA: Data(contentsOf: URL(fileURLWithPath: args[2])),
      hostAnchor: Data(contentsOf: URL(fileURLWithPath: args[3]))
    )
    let pairingId = args[4], secret = args[5]
    let outcome: G0Transport.PairOutcome
    switch args[0] {
    case "prove":
      guard args.count == 8 else { throw CLIError.invalidArguments }
      let csr = try String(contentsOf: URL(fileURLWithPath: args[6]), encoding: .utf8)
      outcome = try await G0Transport.pairProve(port: port, identity: identity, pairingId: pairingId, secret: secret, csrPEM: csr, deviceLabel: args[7])
    case "status":
      guard args.count == 6 else { throw CLIError.invalidArguments }
      outcome = try await G0Transport.pairStatus(port: port, identity: identity, pairingId: pairingId, secret: secret)
    default: throw CLIError.invalidArguments
    }
    switch outcome {
    case let .pending(key): print("pending \(key)")
    case let .granted(certificatePEM, deviceId, expiresAt):
      // Summary line then the PEM so the harness can verify a real mTLS session.
      print("granted \(deviceId) \(expiresAt)\n" + certificatePEM)
    case let .revoked(deviceId): print("revoked \(deviceId)")
    case let .denied(code): print("denied \(code)")
    }
  }
}
