import Foundation
import RemoteTransport

enum CLIError: Error { case invalidArguments }

@main
struct RemoteProbe {
  static func main() async {
    do {
      let args = Array(CommandLine.arguments.dropFirst())
      guard args.count == 6, let port = Int(args[0]) else {
        throw CLIError.invalidArguments
      }
      let identity = try G0ProbeIdentity(
        outerCA: Data(contentsOf: URL(fileURLWithPath: args[1])),
        innerCA: Data(contentsOf: URL(fileURLWithPath: args[2])),
        certificate: Data(contentsOf: URL(fileURLWithPath: args[3])),
        privateKey: Data(contentsOf: URL(fileURLWithPath: args[4]))
      )
      let reply = try await G0Transport.echo(port: port, identity: identity, payload: args[5])
      print(String(decoding: reply, as: UTF8.self))
    } catch {
      FileHandle.standardError.write(Data("probe rejected: \(error)\n".utf8))
      exit(1)
    }
  }
}
