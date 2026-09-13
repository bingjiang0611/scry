import Foundation
import RemoteTransport

// Device-side RUN client over the POST-PAIRING channel: strict inner TLS 1.3
// mTLS to the host, presenting the CA-GRANTED device certificate (issued at
// pairing confirmation) and pinning the host anchor. It performs NO trust
// decision of its own — the granted cert + anchor-pinned inner TLS ARE the
// authorization, verified on the host by InnerMtlsHost -> HostController against
// the device's fingerprint (never anything in the request body).
//
// A submitted intent is a DURABLE INTENT (recorded != executed): the host
// records it, the dispatcher drives exactly-once execution through the gated
// executor, and the device learns the real lifecycle only by polling the ledger.
// This client never fabricates a lifecycle; it surfaces host/transport errors.
struct RemoteRunClient {
  let keychain: RemoteKeychain
  let connection: RemoteConnection

  init(connection: RemoteConnection, keychain: RemoteKeychain = RemoteKeychain()) {
    self.connection = connection
    self.keychain = keychain
  }

  enum ClientError: Error, Equatable { case missingCredentials }

  // The routing an intent resolves to on the host. `cwd` must already be an
  // authorized Scry project directory; the host fails closed otherwise.
  struct Routing: Encodable, Equatable {
    let cwd: String
    let providerId: String
    let agentProfileId: String?
    let prompt: String
  }

  private func identity() throws -> G0ProbeIdentity {
    guard let key = try keychain.load(.deviceKey), let cert = try keychain.load(.grantedCert) else {
      throw ClientError.missingCredentials
    }
    // outerCA empty: the outer TLS mode is the endpoint's (system for public wss,
    // plaintext for a local dev relay). innerCA = the pinned host anchor.
    return G0ProbeIdentity(outerCA: Data(), innerCA: Data(connection.anchorPEM.utf8), certificate: cert, privateKey: key)
  }

  private func endpoint() -> G0Transport.RelayEndpoint {
    let outerTLS: G0Transport.RelayEndpoint.OuterTLS = connection.relayTLS == "system" ? .system : .plaintext
    return G0Transport.RelayEndpoint(host: connection.relayHost, port: connection.relayPort, hostId: connection.hostId, outerTLS: outerTLS)
  }

  // Submit a durable run intent. Returns the host-assigned runId + whether it was
  // newly recorded or a duplicate of a prior intentId (idempotent submit).
  // intentId defaults to a fresh lowercase v4 UUID — the host ledger requires the
  // canonical lowercase form (Foundation's uuidString is uppercase).
  func submit(routing: Routing, intentId: String = UUID().uuidString.lowercased()) async throws -> G0Transport.RunSubmitOutcome {
    let detail = String(decoding: try JSONEncoder().encode(routing), as: UTF8.self)
    return try await G0Transport.relayRunSubmit(endpoint: endpoint(), identity: try identity(), intentId: intentId, detail: detail)
  }

  // Poll ledger events strictly after `cursor`; returns events + the next cursor.
  func poll(cursor: Int) async throws -> G0Transport.RunPollOutcome {
    try await G0Transport.relayRunPoll(endpoint: endpoint(), identity: try identity(), cursor: cursor)
  }

  // Current lifecycle of one run; nil means the host has no such run for us.
  func runState(runId: String) async throws -> String? {
    try await G0Transport.relayRunState(endpoint: endpoint(), identity: try identity(), runId: runId)
  }

  // The host-authorized project directories this device may target, for the
  // new-session picker. The phone cannot authorize a new directory; it only
  // chooses among these, and the host re-checks the cwd on submit.
  func projects() async throws -> [G0Transport.RunProjectRef] {
    try await G0Transport.relayRunProjects(endpoint: endpoint(), identity: try identity())
  }

  // The Providers the host currently offers for a new session (id/label/available).
  // The phone picks among these; the host re-validates the chosen providerId on
  // submit. It can never invent a provider the host does not have.
  func providers() async throws -> [G0Transport.RunProviderRef] {
    try await G0Transport.relayRunProviders(endpoint: endpoint(), identity: try identity())
  }

  // The host session catalog (the SAME conversations the Mac lists) this device
  // may browse. Display metadata only; the host re-authorizes any content read.
  func sessions() async throws -> [G0Transport.RunSessionRef] {
    try await G0Transport.relayRunSessions(endpoint: endpoint(), identity: try identity())
  }

  // The assistant's real streamed output content for one run, strictly after
  // `cursor`. This is the trace-derived CONTENT the chat view renders; tokens/
  // cost still come only from the ledger `result` event, never from here.
  func output(runId: String, cursor: Int) async throws -> G0Transport.RunOutputPage {
    try await G0Transport.relayRunOutput(endpoint: endpoint(), identity: try identity(), runId: runId, cursor: cursor)
  }
}
