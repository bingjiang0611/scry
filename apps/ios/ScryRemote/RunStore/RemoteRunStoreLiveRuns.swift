import Foundation
import Observation
import CryptoKit
import RemoteTransport
#if canImport(UIKit)
import UIKit
#endif

// MARK: - Live runs (multi-task, Mac runs)

extension RemoteRunStore {
  // Pull-to-refresh: reload the catalog and wait for that request to finish.
  // The Bool is true only for a complete host refresh whose cache write did not
  // report a failure; automatic refreshes do not call this method.
  @discardableResult
  func refreshSessions() async -> Bool {
    #if DEBUG
    if mockMode, ProcessInfo.processInfo.arguments.contains("-uiRefreshFeedback") {
      applyCatalogRefreshFixture()
      return true
    }
    #endif
    let revision = catalogRefreshRevision
    loadSessions(force: true)
    let requestID = catalogRequestID
    let requestGeneration = dataGeneration
    await catalogTask?.value
    return isCurrentCatalogRequest(requestID, dataGeneration: requestGeneration) &&
      catalogRefreshRevision > revision && catalogRefreshFailure == nil
  }

  func startLiveRuns() {
    #if DEBUG
    if mockMode { return }
    #endif
    guard liveRunsForegroundEligible, !historyOnly, liveRunsTask == nil, liveRunsStatus != .unsupported, hasConnection else { return }
    liveRunsTask = Task { [weak self] in await self?.runLiveRunsLoop() }
  }

  func setLiveRunsForegroundEligible(_ eligible: Bool) {
    liveRunsForegroundEligible = eligible
    if !eligible { stopLiveRuns() }
  }

  func stopLiveRuns() {
    liveRunsTask?.cancel()
    liveRunsTask = nil
  }

  // The open transcript joins its history version to the live-run long-poll.
  // A new target restarts the poll instead of waiting up to 20 s for the old one.
  func watchHistory(_ identity: SessionIdentity?) {
    guard liveHistoryTarget != identity else { return }
    liveHistoryTarget = identity
    if liveRunsTask != nil { stopLiveRuns(); startLiveRuns() }
  }

  func observeReadOnlyHistory(_ identity: SessionIdentity) async {
    guard historyOnly else { return }
    #if DEBUG
    if mockMode { return }
    #endif
    liveHistoryTarget = identity
    await runLiveRunsLoop()
  }

  // A version remains eligible for reconciliation until its content read succeeds.
  func verifiedHistoryVersion(_ observed: String?) -> String? {
    historyRefreshError == nil ? observed : nil
  }

  func runLiveRunsLoop() async {
    var failures = 0
    var seen: (target: SessionIdentity, version: String)?
    while !Task.isCancelled {
      guard let client = makeClient() else { break }
      let target = liveHistoryTarget
      let known = verifiedHistoryVersion(target.flatMap { current in seen?.target == current ? seen?.version : nil })
      let history = target.flatMap { current in
        current.externalSessionId.map { (providerId: current.providerId, cwd: current.cwd, externalSessionId: $0, known: known) }
      }
      do {
        let outcome = try await client.liveRuns(revision: liveRunsRevision, waitMs: 20_000, history: history, historyAgentProfileId: target?.agentProfileId)
        if Task.isCancelled { return }
        failures = 0
        recordSuccess()
        liveRunsRevision = outcome.revision
        if liveRuns != outcome.runs {
          liveRuns = outcome.runs
          let open = Set(outcome.runs.flatMap { run in run.questions.map { "\(run.runId)\u{0}\($0.questionId)" } })
          liveAnsweredQuestions.formIntersection(open)
        }
        liveRunsStatus = .observed
        if let target, let externalSessionId = target.externalSessionId,
           let version = outcome.historyVersion?.version, version != known {
          seen = (target, version)
          await refreshHistory(providerId: target.providerId, cwd: target.cwd, externalSessionId: externalSessionId,
                               agentProfileId: target.agentProfileId, observedVersion: version)
        }
      } catch is CancellationError {
        return
      } catch let error as G0Transport.RunError where !error.isRecoverableReadRefusal {
        recordFailure(error)
        liveRunsStatus = .failed(Self.describe(error))
        break
      } catch {
        if Task.isCancelled { return }
        failures += 1
        liveRunsStatus = .failed(Self.describe(error))
        try? await Task.sleep(for: .seconds(min(8, 1 << min(failures, 3))))
      }
    }
    liveRunsTask = nil
  }

  // Any live run in this session, including the one this store is watching.
  func liveRun(providerId: String, cwd: String, externalSessionId: String?, agentProfileId: String? = nil) -> G0Transport.LiveRun? {
    guard let externalSessionId else { return nil }
    return liveRuns.first { $0.providerId == providerId && $0.agentProfileId == agentProfileId && $0.cwd == cwd && $0.externalSessionId == externalSessionId }
  }

  // A live run in this session that this store is not already watching.
  func otherLiveRun(for identity: SessionIdentity?) -> G0Transport.LiveRun? {
    guard let identity, let run = liveRun(providerId: identity.providerId, cwd: identity.cwd,
                                          externalSessionId: identity.externalSessionId, agentProfileId: identity.agentProfileId),
          run.runId != runId else { return nil }
    return run
  }

  // Runs other than the watched one that wait for a decision.
  var waitingLiveRuns: [G0Transport.LiveRun] {
    liveRuns.filter { $0.runId != runId && openLiveQuestion($0) != nil }
  }

  func openLiveQuestion(_ run: G0Transport.LiveRun) -> G0Transport.RunQuestionRequest? {
    run.questions.first { !liveAnsweredQuestions.contains("\(run.runId)\u{0}\($0.questionId)") }
  }

  func followDetached(_ live: G0Transport.LiveRun?) {
    let runId = live?.origin == "remote" ? live?.runId : nil
    guard runId != detachedRunId else { return }
    detachedTask?.cancel()
    detachedTask = nil
    detachedRunId = runId
    detachedHostRunId = nil
    detachedOutput = []
    guard let runId, let client = makeClient() else { return }
    detachedTask = Task { [weak self] in
      var ledgerCursor = 0, outputCursor = 0, failures = 0
      while !Task.isCancelled {
        do {
          let watch = try await client.watch(runId: runId, cursor: ledgerCursor, outputCursor: outputCursor)
          guard !Task.isCancelled, let self, self.detachedRunId == runId else { return }
          failures = 0
          ledgerCursor = watch.poll.cursor
          outputCursor = watch.output.cursor
          for event in watch.poll.events where event.runId == runId {
            if let detail = event.detail, let marker = Self.marker(detail),
               marker["event"] == "bound", marker["ledgerRunId"] == runId,
               let id = marker["scryRunId"], !id.isEmpty {
              self.detachedHostRunId = id
            }
          }
          // Chunks arrive strictly after outputCursor, so none repeats. A
          // "truncated" marker is covered by the view's may-be-incomplete note.
          for chunk in watch.output.chunks where chunk.kind != "truncated" {
            Self.coalesce(chunk, into: &self.detachedOutput)
          }
          // The run's own terminal state ends the stream; history takes over.
          if ["settled", "failed", "cancelled"].contains(watch.state ?? "") { return }
        } catch is CancellationError {
          return
        } catch {
          if Task.isCancelled { return }
          failures += 1
          try? await Task.sleep(for: .seconds(min(8, 1 << min(failures, 3))))
        }
      }
    }
  }

  func stopLiveRun(_ run: G0Transport.LiveRun) {
    guard liveActionRunId == nil, let client = makeClient() else { return }
    liveActionRunId = run.runId
    liveActionError = nil
    Task { [weak self] in
      do {
        _ = try await client.stop(runId: run.runId)
        self?.liveActionRunId = nil
      } catch {
        self?.liveActionRunId = nil
        self?.liveActionError = "停止请求结果未知：\(Self.describe(error))。可再次点击停止。"
      }
    }
  }

  func answerLiveQuestion(_ run: G0Transport.LiveRun, request: G0Transport.RunQuestionRequest,
                          answers: [String: String], cancel: Bool = false) {
    guard liveActionRunId == nil, let client = makeClient() else { return }
    let key = "\(run.runId)\u{0}\(request.questionId)"
    // A retry after an unknown outcome reuses the answer id (remote runs dedupe by it).
    let answerId = liveAnswerIds[key] ?? UUID().uuidString.lowercased()
    liveAnswerIds[key] = answerId
    liveActionRunId = run.runId
    liveActionError = nil
    let response = G0Transport.RunQuestionResponse(runId: run.runId, questionId: request.questionId,
                                                   behavior: cancel ? "cancelled" : "answered",
                                                   answers: cancel ? nil : answers)
    Task { [weak self] in
      do {
        _ = try await client.answerQuestion(runId: run.runId, answerId: answerId, response: response)
        self?.liveAnswerIds[key] = nil
        self?.liveAnsweredQuestions.insert(key)
        self?.liveActionRunId = nil
      } catch G0Transport.RunError.host(code: "question_not_pending") {
        self?.liveAnswerIds[key] = nil
        self?.liveAnsweredQuestions.insert(key)
        self?.liveActionRunId = nil
        self?.liveActionError = "该问题已不再等待（可能已在 Mac 或其他设备上回答或关闭）。"
      } catch {
        self?.liveActionRunId = nil
        self?.liveActionError = "回答结果未知：\(Self.describe(error))。再次提交会复用同一回答标识。"
      }
    }
  }
}
