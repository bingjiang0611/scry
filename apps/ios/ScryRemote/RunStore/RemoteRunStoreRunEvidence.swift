import Foundation
import RemoteTransport

extension RemoteRunStore {
  func drainOutput(client: RemoteRunClient, runId: String, cursor: Int,
                          generation: Int, identity: SessionIdentity) async -> Bool {
    var cursor = cursor
    while !Task.isCancelled {
      let page: G0Transport.RunOutputPage
      do {
        page = try await client.output(runId: runId, cursor: cursor)
      } catch {
        await MainActor.run {
          guard self.isCurrent(generation, identity: identity) else { return }
          self.observationInterrupted = true
          self.submitError = Self.observationFailure(error, lifecycle: self.lifecycle, operation: "最后输出读取")
        }
        return false
      }
      let next = page.cursor
      for chunk in page.chunks {
        append(chunk: chunk, generation: generation, identity: identity)
      }
      // The host's cursor is authoritative. Stop only when the page is empty or
      // did not advance; this drains arbitrarily many pages, including >400 chunks.
      if !Self.shouldContinueDrain(cursor: cursor, next: next, chunkCount: page.chunks.count) { return true }
      cursor = next
    }
    return false
  }

  nonisolated static func responseMatches(currentGeneration: Int, requestGeneration: Int,
                                                   currentIdentity: SessionIdentity?, requestIdentity: SessionIdentity) -> Bool {
    currentGeneration == requestGeneration && currentIdentity == requestIdentity
  }

  nonisolated static func shouldContinueDrain(cursor: Int, next: Int, chunkCount: Int) -> Bool {
    chunkCount > 0 && next > cursor
  }

  nonisolated static func shouldIncludeCompletedTurn(_ turnId: String, currentRunId: String?, archived: Bool) -> Bool {
    !(archived && currentRunId == turnId)
  }

  nonisolated static func unresolvedState(pending: Bool, runId: String?, drained: Bool,
                                                   interrupted: Bool) -> Bool {
    pending || (runId != nil && (!drained || interrupted))
  }

  nonisolated static func followUpIdentity(current: SessionIdentity?, providerId: String,
                                                    cwd: String, originalResume: String,
                                                    scope: ExecutionTargetScope? = nil,
                                                    agentProfileId: String? = nil) -> SessionIdentity {
    current.flatMap { identity in
      identity.providerId == providerId && identity.agentProfileId == agentProfileId && identity.cwd == cwd &&
        identity.gatewayIdentity == scope?.gatewayIdentity && identity.gatewayHostId == scope?.gatewayHostId &&
        identity.targetId == scope?.targetId && identity.targetBinding == scope?.binding ? identity : nil
    } ?? SessionIdentity.opened(providerId: providerId, agentProfileId: agentProfileId, cwd: cwd,
                                 externalSessionId: originalResume, scope: scope)
  }

  func isCurrent(_ requestGeneration: Int, identity: SessionIdentity) -> Bool {
    Self.responseMatches(currentGeneration: generation, requestGeneration: requestGeneration,
                         currentIdentity: activeSessionIdentity, requestIdentity: identity)
  }

  func isTerminal(generation: Int, identity: SessionIdentity) -> Bool {
    isCurrent(generation, identity: identity) &&
      (lifecycle == .settled || lifecycle == .failed || lifecycle == .cancelled)
  }

  func apply(runState state: String, generation: Int, identity: SessionIdentity) {
    guard isCurrent(generation, identity: identity) else { return }
    switch state {
    case "queued": if lifecycle == .unknown { lifecycle = .queued }
    case "recorded": if lifecycle == .unknown || lifecycle == .submitting || lifecycle == .queued { lifecycle = .recorded }
    case "dispatched": if lifecycle != .running { lifecycle = .dispatched }
    // The host projects an interrupted Provider result as `settled`; keep the
    // more specific cancelled lifecycle already read from the settled marker.
    case "settled": if lifecycle != .cancelled { lifecycle = .settled }
    case "failed": lifecycle = .failed
    case "cancelled": lifecycle = .cancelled
    default: break
    }
  }

  func apply(event ev: G0Transport.RunLedgerEvent, generation: Int, identity: SessionIdentity) {
    guard isCurrent(generation, identity: identity) else { return }
    switch ev.kind {
    case "intent_recorded": if lifecycle == .unknown { lifecycle = .recorded }
    case "run_dispatched": if lifecycle == .recorded || lifecycle == .unknown { lifecycle = .dispatched }
    case "run_progress":
      // Honest lifecycle markers only. 'started' promotes to running; 'result'
      // carries Provider-canonical usage we surface verbatim (never synthesized).
      if let detail = ev.detail, let marker = Self.marker(detail) {
        // The Provider reporting its own session id is evidence it is executing.
        if marker["event"] == "started" || marker["event"] == "session",
           lifecycle == .dispatched || lifecycle == .recorded { lifecycle = .running }
        if marker["event"] == "result" { resultSummary = "主机报告完成（未提供用量）" }
        if marker["event"] == "settled", let status = marker["status"],
           status == "cancelled" || status == "interrupted" || status == "stopped" {
          lifecycle = .cancelled
        }
        // The Provider's own session id for THIS run. Captured so a chained
        // follow-up resumes the latest session (continuous memory), not a stale id.
        if marker["event"] == "session", let ext = marker["externalSessionId"], !ext.isEmpty {
          liveExternalSessionId = ext
          if modelSelectionSession == identity {
            modelSelectionSession = .opened(providerId: identity.providerId, agentProfileId: identity.agentProfileId,
              cwd: identity.cwd, externalSessionId: ext, scope: targetScope)
            rememberModelSelection()
          }
        }
        if marker["event"] == "bound", marker["ledgerRunId"] == runId, let id = marker["scryRunId"], !id.isEmpty { liveHostRunId = id }
      }
    case "run_settled": if lifecycle != .cancelled { lifecycle = .settled }
    case "run_failed": lifecycle = .failed; if let d = ev.detail, submitError == nil { submitError = "主机报告失败：\(d)" }
    case "run_cancelled": lifecycle = .cancelled
    default: break
    }
  }

  func append(chunk: G0Transport.RunOutputChunk, generation: Int, identity: SessionIdentity) {
    guard isCurrent(generation, identity: identity) else { return }
    if chunk.kind == "truncated" { truncated = true; return }
    // Coalescing replaces the visible row id with the newest seq, so the array
    // alone cannot remember every consumed chunk. Keep an explicit cursor set;
    // observation recovery starts from cursor 0 and must not append old deltas
    // a second time before reaching the live tail.
    guard seenOutputSequences.insert(chunk.seq).inserted else { return }
    // Real streamed Provider output proves execution has started.
    if lifecycle == .dispatched || lifecycle == .recorded { lifecycle = .running }
    Self.coalesce(chunk, into: &output)
  }

  // Providers stream text/reasoning in small deltas. Keep those deltas as one
  // readable block instead of rendering one SwiftUI Text row per token.
  static func coalesce(_ chunk: G0Transport.RunOutputChunk, into output: inout [OutputLine]) {
    if let last = output.last, last.kind == chunk.kind,
       chunk.kind == "output" || chunk.kind == "reasoning" {
      output[output.count - 1] = OutputLine(id: chunk.seq, kind: chunk.kind, text: last.text + chunk.text)
    } else {
      output.append(OutputLine(id: chunk.seq, kind: chunk.kind, text: chunk.text))
    }
  }

  // Parse a lifecycle marker JSON object into a flat [String:String]; only the
  // string-valued fields we render are kept, numbers are stringified.
  static func marker(_ json: String) -> [String: String]? {
    guard let data = json.data(using: .utf8),
          let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
    var out: [String: String] = [:]
    for (k, v) in obj {
      if let s = v as? String { out[k] = s }
      else if let n = v as? NSNumber { out[k] = n.stringValue }
      else if let b = v as? Bool { out[k] = b ? "true" : "false" }
    }
    return out
  }

  var terminalLifecycleKnown: Bool {
    [.settled, .failed, .cancelled].contains(lifecycle)
  }

  static func observationFailure(_ error: Error, lifecycle: Lifecycle, operation: String = "输出读取") -> String {
    let detail = "\(operation)：\(describe(error))"
    if [.settled, .failed, .cancelled].contains(lifecycle) {
      return "输出同步中断：\(detail)。主机已报告任务结束，输出尚未完整核对。"
    }
    return "观察中断：\(detail)。运行结果未知。"
  }
}
