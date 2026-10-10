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
      } else if args.first == "relay-pair" {
        try await relayPair(Array(args.dropFirst()))
      } else if args.first == "relay-run" {
        try await relayRun(Array(args.dropFirst()))
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
    printOutcome(outcome)
  }

  // relay-pair <prove|status> <relayHost> <relayPort> <hostId> <host-anchor> <bootstrapPem> <deviceKey> <pairingId> <secret> [csrPath deviceLabel]
  // No outer CA: the local smoke relay is ws://. The device pins ONLY the host
  // anchor for the inner TLS 1.3 mTLS; the relay is an untrusted byte rendezvous.
  // It presents its SELF-SIGNED bootstrap cert as the inner client cert so the
  // host derives the possession-proving key fingerprint from the TLS peer cert.
  static func relayPair(_ args: [String]) async throws {
    guard args.count >= 9, let port = Int(args[2]) else { throw CLIError.invalidArguments }
    let identity = try G0ProbeIdentity(
      outerCA: Data(),
      innerCA: Data(contentsOf: URL(fileURLWithPath: args[4])),
      certificate: Data(contentsOf: URL(fileURLWithPath: args[5])),
      privateKey: Data(contentsOf: URL(fileURLWithPath: args[6]))
    )
    let endpoint = G0Transport.RelayEndpoint(host: args[1], port: port, hostId: args[3])
    let pairingId = args[7], secret = args[8]
    let outcome: G0Transport.PairOutcome
    switch args[0] {
    case "prove":
      guard args.count == 11 else { throw CLIError.invalidArguments }
      let csr = try String(contentsOf: URL(fileURLWithPath: args[9]), encoding: .utf8)
      outcome = try await G0Transport.relayPairProve(endpoint: endpoint, identity: identity, pairingId: pairingId, secret: secret, csrPEM: csr, deviceLabel: args[10])
    case "status":
      guard args.count == 9 else { throw CLIError.invalidArguments }
      outcome = try await G0Transport.relayPairStatus(endpoint: endpoint, identity: identity, pairingId: pairingId, secret: secret)
    default: throw CLIError.invalidArguments
    }
    printOutcome(outcome)
  }

  // relay-run <submit|poll|state> <relayHost> <relayPort> <hostId> <host-anchor> <grantedCertPem> <deviceKey> <arg>
  //   submit: <arg> = path to routing-detail JSON; prints "submit <runId> <status>"
  //   poll:   <arg> = cursor;                       prints "event <kind> <runId>" per event, then "poll-cursor <n>"
  //   state:  <arg> = runId;                        prints "state <lifecycle|none>"
  //   projects: no <arg>;                            prints "project <path>" per authorized dir
  //   output: <runId> <cursor>;                      prints "output <kind> <text>" per chunk, then "output-cursor <n>"
  // Drives the POST-PAIRING run channel with the CA-granted device cert (full
  // inner mTLS), exactly as the product RemoteRunClient does.
  static func relayRun(_ args: [String]) async throws {
    guard args.count >= 7, let port = Int(args[2]) else { throw CLIError.invalidArguments }
    let identity = try G0ProbeIdentity(
      outerCA: Data(),
      innerCA: Data(contentsOf: URL(fileURLWithPath: args[4])),
      certificate: Data(contentsOf: URL(fileURLWithPath: args[5])),
      privateKey: Data(contentsOf: URL(fileURLWithPath: args[6]))
    )
    let endpoint = G0Transport.RelayEndpoint(host: args[1], port: port, hostId: args[3])
    switch args[0] {
    case "submit":
      guard args.count == 8 else { throw CLIError.invalidArguments }
      let detail = try String(contentsOf: URL(fileURLWithPath: args[7]), encoding: .utf8)
      let outcome = try await G0Transport.relayRunSubmit(endpoint: endpoint, identity: identity, intentId: UUID().uuidString.lowercased(), detail: detail)
      print("submit \(outcome.runId) \(outcome.status)")
    case "poll":
      guard args.count == 8, let cursor = Int(args[7]) else { throw CLIError.invalidArguments }
      let outcome = try await G0Transport.relayRunPoll(endpoint: endpoint, identity: identity, cursor: cursor)
      for e in outcome.events { print("event \(e.kind) \(e.runId)") }
      print("poll-cursor \(outcome.cursor)")
    case "state":
      guard args.count == 8 else { throw CLIError.invalidArguments }
      let state = try await G0Transport.relayRunState(endpoint: endpoint, identity: identity, runId: args[7])
      print("state \(state ?? "none")")
    case "projects":
      let projects = try await G0Transport.relayRunProjects(endpoint: endpoint, identity: identity)
      for p in projects { print("project \(p.path)") }
      print("projects-count \(projects.count)")
    case "providers":
      let providers = try await G0Transport.relayRunProviders(endpoint: endpoint, identity: identity)
      for p in providers { print("provider \(p.id) \(p.available ? "available" : "unavailable") \(p.label)") }
      print("providers-count \(providers.count)")
    case "sessions":
      let sessions = try await G0Transport.relayRunSessions(endpoint: endpoint, identity: identity)
      for s in sessions { print("session \(s.providerId) \(s.externalSessionId ?? "-") \(s.label)") }
      print("sessions-count \(sessions.count)")
    case "history":
      // <arg> layout: args[7]=providerId args[8]=cwd args[9]=externalSessionId
      guard args.count >= 10 else { throw CLIError.invalidArguments }
      let turns = try await G0Transport.relayRunHistory(endpoint: endpoint, identity: identity, providerId: args[7], cwd: args[8], externalSessionId: args[9])
      for (i, t) in turns.enumerated() { print("turn \(i) user=\(t.userText.prefix(40)) items=\(t.items.count)") }
      print("turns-count \(turns.count)")
    case "output":
      guard args.count == 9, let cursor = Int(args[8]) else { throw CLIError.invalidArguments }
      let page = try await G0Transport.relayRunOutput(endpoint: endpoint, identity: identity, runId: args[7], cursor: cursor)
      for c in page.chunks { print("output \(c.kind) \(c.text)") }
      print("output-cursor \(page.cursor)")
    case "live":
      // <arg> = routing-detail JSON; args[8] = "watch" | "stop". One persistent
      // RelaySession carries submit, every watch long-poll and (optionally) stop.
      guard args.count == 9 else { throw CLIError.invalidArguments }
      setvbuf(stdout, nil, _IOLBF, 0)
      let detail = try String(contentsOf: URL(fileURLWithPath: args[7]), encoding: .utf8)
      let session = RelaySession(endpoint: endpoint) { identity }
      let live = G0Transport.RelayEndpoint(host: endpoint.host, port: endpoint.port, hostId: endpoint.hostId, session: session)
      let clock = ContinuousClock()
      let begin = clock.now
      let millis = { (d: Duration) in Int(d.components.seconds * 1000 + d.components.attoseconds / 1_000_000_000_000_000) }
      let submitted = try await G0Transport.relayRunSubmit(endpoint: live, identity: identity, intentId: UUID().uuidString.lowercased(), detail: detail)
      print("submit \(submitted.runId) \(submitted.status) ms=\(millis(clock.now - begin))")
      var cursor = 0, outputCursor = 0
      var stopSent = false
      while true {
        let started = clock.now
        let watch = try await G0Transport.relayRunWatch(endpoint: live, identity: identity, runId: submitted.runId,
                                                        cursor: cursor, outputCursor: outputCursor, waitMs: 5_000)
        cursor = watch.poll.cursor; outputCursor = watch.output.cursor
        for e in watch.poll.events where e.runId == submitted.runId { print("event \(e.kind)") }
        for c in watch.output.chunks { print("output \(c.kind) \(c.text)") }
        print("watch state=\(watch.state ?? "none") ms=\(millis(clock.now - started))")
        if ["settled", "failed", "cancelled"].contains(watch.state ?? "") { break }
        if args[8] == "stop", !stopSent, ["dispatched", "running"].contains(watch.state ?? "") {
          let stopStarted = clock.now
          print("stop \(try await G0Transport.relayRunStop(endpoint: live, identity: identity, runId: submitted.runId)) ms=\(millis(clock.now - stopStarted))")
          stopSent = true
        }
      }
      print("total ms=\(millis(clock.now - begin))")
      await session.reset()
    default: throw CLIError.invalidArguments
    }
  }

  static func printOutcome(_ outcome: G0Transport.PairOutcome) {
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
