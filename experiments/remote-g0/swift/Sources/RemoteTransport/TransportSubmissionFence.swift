extension G0Transport {
  // The outbox owns intent IDs across reconnects. A tunnel can be evicted
  // while the same intent is still pending, so pending fences outlive tunnels.
  actor SubmissionFence {
    static let shared = SubmissionFence()

    struct Reservation: Sendable {
      let logId: String?
      let first: Bool
    }

    private struct Attempt {
      let hostId: String
      let target: ExecutionTargetBinding?
      let logId: String?
      var retried = false
    }

    private var pending: [String: Attempt] = [:]

    private func prior(_ intentId: String, endpoint: RelayEndpoint) throws -> Attempt? {
      guard let attempt = pending[intentId] else { return nil }
      guard attempt.hostId == endpoint.hostId, attempt.target == endpoint.executionTarget else {
        throw RunError.host(code: "orchestration_log_changed")
      }
      return attempt
    }

    func submitLog(_ intentId: String, endpoint: RelayEndpoint,
                   discover: @Sendable () async throws -> String?) async throws -> Reservation {
      if let attempt = try prior(intentId, endpoint: endpoint) { return try retry(intentId, attempt: attempt) }
      let discovered = try await discover()
      if let attempt = try prior(intentId, endpoint: endpoint) { return try retry(intentId, attempt: attempt) }
      guard pending.count < 512 else { throw RunError.host(code: "unknown_intents_pending") }
      pending[intentId] = Attempt(hostId: endpoint.hostId, target: endpoint.executionTarget, logId: discovered)
      return Reservation(logId: discovered, first: true)
    }

    private func retry(_ intentId: String, attempt: Attempt) throws -> Reservation {
      // An older v2 host can accept a first send, but it cannot prove that
      // its log survived a lost receipt. Reconcile through the read-only op.
      guard let logId = attempt.logId else { throw RunError.host(code: "intent_payload_conflict") }
      pending[intentId]?.retried = true
      return Reservation(logId: logId, first: false)
    }

    func statusLog(_ intentId: String, endpoint: RelayEndpoint) throws -> String? {
      try prior(intentId, endpoint: endpoint)?.logId
    }

    func acknowledge(_ intentId: String, endpoint: RelayEndpoint) throws {
      if try prior(intentId, endpoint: endpoint) != nil { pending.removeValue(forKey: intentId) }
    }

    func rejected(_ intentId: String, endpoint: RelayEndpoint, reservation: Reservation, code: String) throws {
      // Only an authenticated, pre-recording rejection to the first request
      // proves that there is no earlier attempt to protect.
      let beforeRecording = ["invalid_request", "invalid_intent_id", "invalid_submit",
                             "workspace_not_authorized", "desktop_remote_attachments_unsupported"]
      if reservation.first, beforeRecording.contains(code),
         let attempt = try prior(intentId, endpoint: endpoint), !attempt.retried {
        pending.removeValue(forKey: intentId)
      }
    }
  }
}
