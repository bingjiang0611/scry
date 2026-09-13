import Foundation
import RemoteTransport

// Device-side observable state for ONE remote run, driven strictly by what the
// host proves over the granted-cert inner mTLS channel (RemoteRunClient). It
// never fabricates a lifecycle, an assistant reply, a token/cost number or a
// file diff (CLAUDE.md 证据不能说谎):
//
//   - Lifecycle comes only from the durable ledger poll: recorded/dispatched/
//     started/settled/failed/cancelled. "recorded" is NOT "executed".
//   - Output comes only from the separate output-content poll: the assistant's
//     real streamed text/reasoning/tool activity, a LIVE cache that may be
//     incomplete or truncated (labeled as such), never presented as complete.
//   - Token/cost, when shown, come only from the ledger `result` marker (exact
//     Provider-canonical evidence); they are never re-derived from output text.
//   - A transport failure surfaces verbatim; we never pretend "offline" success.
@MainActor
final class RemoteRunStore: ObservableObject {
  enum ProjectsState: Equatable {
    case idle
    case loading
    case loaded([G0Transport.RunProjectRef])
    case empty
    case failed(String)
  }

  // Host-advertised Providers for the new-session picker. Mirrors the host's real
  // describe(); we never invent a provider or fake availability.
  enum ProvidersState: Equatable {
    case idle
    case loading
    case loaded([G0Transport.RunProviderRef])
    case empty
    case failed(String)
  }

  // The device-observable lifecycle. `.unknown` = we have not learned a state
  // yet (e.g. before any poll), never shown as success.
  enum Lifecycle: String, Equatable {
    case unknown, recorded, dispatched, running, settled, failed, cancelled
  }

  struct OutputLine: Identifiable, Equatable {
    let id: Int      // per-run output seq
    let kind: String // output | reasoning | tool | tool_result | truncated
    let text: String
  }

  @Published private(set) var projects: ProjectsState = .idle
  @Published private(set) var chosen: G0Transport.RunProjectRef?
  @Published private(set) var providers: ProvidersState = .idle
  @Published private(set) var chosenProvider: G0Transport.RunProviderRef?
  // Whether the host was actually reached on the LAST attempt. Paired != reachable:
  // a persisted grant only means we MAY reach the host; only a real successful
  // exchange proves it. nil = not tried yet. This is the honest source of the
  // connection status (fixes "shows offline while sending works").
  @Published private(set) var reachable: Bool?
  @Published private(set) var lifecycle: Lifecycle = .unknown
  @Published private(set) var output: [OutputLine] = []
  // The user's own submitted message, echoed immediately as a chat bubble
  // (ChatGPT/Codex style) so the person sees exactly what they sent. This is the
  // literal local input, not host-derived, and is labeled as the user turn.
  @Published private(set) var prompt: String?
  @Published private(set) var runId: String?
  @Published private(set) var submitError: String?
  @Published private(set) var truncated = false
  // Provider-canonical result evidence, surfaced verbatim from the ledger
  // `result` marker only. nil until the host reports it; never a fabricated 0.
  @Published private(set) var resultSummary: String?

  private let connections = RemoteConnectionStore()
  private var pollTask: Task<Void, Never>?

  // A persisted PUBLIC connection descriptor means this device is paired and may
  // attempt a run; reachability of the host is only known by trying.
  var hasConnection: Bool { connections.load() != nil }
  var hostLabel: String? { connections.load()?.relayHost }

  private func makeClient() -> RemoteRunClient? {
    guard let connection = connections.load() else { return nil }
    return RemoteRunClient(connection: connection)
  }

  func chooseProject(_ ref: G0Transport.RunProjectRef) { chosen = ref }
  func chooseProvider(_ ref: G0Transport.RunProviderRef) { chosenProvider = ref }

  // Load the Providers the host offers. Only available ones are selectable (an
  // unavailable Provider cannot run). We deliberately do NOT auto-select a
  // default: describe() reports a Provider as available from CLI presence/auth,
  // which does not guarantee a run succeeds (e.g. a Provider whose CLI crashes on
  // launch). Auto-picking the first would silently send the first turn to a
  // Provider the user never chose - exactly the failure the owner hit. Requiring
  // an explicit pick (canSend gates on chosenProvider) keeps the choice honest.
  // If a previously-chosen Provider is no longer available, clear it.
  func loadProviders() {
    guard let client = makeClient() else { providers = .failed("尚未配对"); return }
    providers = .loading
    Task { [weak self] in
      do {
        let list = try await client.providers()
        await MainActor.run {
          guard let self else { return }
          self.reachable = true
          let usable = list.filter { $0.available }
          self.providers = usable.isEmpty ? .empty : .loaded(usable)
          if let chosen = self.chosenProvider, !usable.contains(where: { $0.id == chosen.id }) {
            self.chosenProvider = nil
          }
        }
      } catch {
        await MainActor.run { self?.reachable = false; self?.providers = .failed(Self.describe(error)) }
      }
    }
  }

  // Load the host-authorized project directories. The phone can never authorize
  // a new one; it only chooses among these, and the host re-checks on submit.
  func loadProjects() {
    guard let client = makeClient() else { projects = .failed("尚未配对，无法读取项目"); return }
    projects = .loading
    Task { [weak self] in
      do {
        let list = try await client.projects()
        await MainActor.run {
          self?.reachable = true
          self?.projects = list.isEmpty ? .empty : .loaded(list)
        }
      } catch {
        await MainActor.run { self?.reachable = false; self?.projects = .failed(Self.describe(error)) }
      }
    }
  }

  // Submit a durable intent and begin polling. Recorded != executed: the button
  // records intent; the host drives the real lifecycle we then observe.
  func submit(prompt: String, providerId: String) {
    let trimmed = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return }
    guard let cwd = chosen?.path else { submitError = "请先选择一个主机已授权的项目"; return }
    guard let client = makeClient() else { submitError = "尚未配对"; return }
    submitError = nil
    resetRun()
    self.prompt = trimmed
    lifecycle = .recorded
    Task { [weak self] in
      do {
        let routing = RemoteRunClient.Routing(cwd: cwd, providerId: providerId, agentProfileId: nil, prompt: trimmed)
        let outcome = try await client.submit(routing: routing)
        await MainActor.run {
          self?.reachable = true
          self?.runId = outcome.runId
          self?.startPolling(runId: outcome.runId, client: client)
        }
      } catch {
        await MainActor.run {
          self?.reachable = false
          self?.lifecycle = .unknown
          self?.submitError = "提交失败：\(Self.describe(error))"
        }
      }
    }
  }

  private func startPolling(runId: String, client: RemoteRunClient) {
    pollTask?.cancel()
    pollTask = Task { [weak self] in
      var ledgerCursor = 0
      var outputCursor = 0
      // Poll both channels until a terminal lifecycle, then drain once more so a
      // late final chunk is not lost. Bounded so a wedged host cannot spin.
      for _ in 0..<600 {
        if Task.isCancelled { return }
        do {
          let page = try await client.poll(cursor: ledgerCursor)
          ledgerCursor = page.cursor
          for ev in page.events where ev.runId == runId { await self?.apply(event: ev) }
          let out = try await client.output(runId: runId, cursor: outputCursor)
          outputCursor = out.cursor
          for chunk in out.chunks { await self?.append(chunk: chunk) }
          await MainActor.run { self?.reachable = true }
        } catch {
          // A transient transport error is not a run failure; surface it as a
          // non-terminal note and keep polling. We never invent a settlement.
          await MainActor.run { self?.reachable = false; self?.submitError = "连接主机时出错：\(Self.describe(error))" }
        }
        if await self?.isTerminal() == true {
          // Final output drain.
          if let out = try? await client.output(runId: runId, cursor: outputCursor) {
            for chunk in out.chunks { await self?.append(chunk: chunk) }
          }
          return
        }
        try? await Task.sleep(nanoseconds: 800_000_000)
      }
    }
  }

  private func isTerminal() -> Bool {
    lifecycle == .settled || lifecycle == .failed || lifecycle == .cancelled
  }

  private func apply(event ev: G0Transport.RunLedgerEvent) {
    switch ev.kind {
    case "intent_recorded": if lifecycle == .unknown { lifecycle = .recorded }
    case "run_dispatched": if lifecycle == .recorded || lifecycle == .unknown { lifecycle = .dispatched }
    case "run_progress":
      // Honest lifecycle markers only. 'started' promotes to running; 'result'
      // carries Provider-canonical usage we surface verbatim (never synthesized).
      if let detail = ev.detail, let marker = Self.marker(detail) {
        if marker["event"] == "started", lifecycle == .dispatched || lifecycle == .recorded { lifecycle = .running }
        if marker["event"] == "result" { resultSummary = Self.resultLine(marker) }
      }
    case "run_settled": lifecycle = .settled
    case "run_failed": lifecycle = .failed; if let d = ev.detail, submitError == nil { submitError = "主机报告失败：\(d)" }
    case "run_cancelled": lifecycle = .cancelled
    default: break
    }
  }

  private func append(chunk: G0Transport.RunOutputChunk) {
    if chunk.kind == "truncated" { truncated = true; return }
    if output.contains(where: { $0.id == chunk.seq }) { return }
    output.append(OutputLine(id: chunk.seq, kind: chunk.kind, text: chunk.text))
  }

  func resetRun() {
    pollTask?.cancel(); pollTask = nil
    lifecycle = .unknown
    output = []
    prompt = nil
    runId = nil
    truncated = false
    resultSummary = nil
    submitError = nil
  }

  func stop() { pollTask?.cancel(); pollTask = nil }

  // Parse a lifecycle marker JSON object into a flat [String:String]; only the
  // string-valued fields we render are kept, numbers are stringified.
  private static func marker(_ json: String) -> [String: String]? {
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

  private static func resultLine(_ marker: [String: String]) -> String {
    var parts: [String] = []
    if let ti = marker["tokensIn"] { parts.append("输入 \(ti)") }
    if let to = marker["tokensOut"] { parts.append("输出 \(to)") }
    if let cost = marker["costUsd"] { parts.append("$\(cost)") }
    return parts.isEmpty ? "主机报告完成（未提供用量）" : parts.joined(separator: " · ")
  }

  private static func describe(_ error: Error) -> String {
    if let runError = error as? G0Transport.RunError, case let .host(code) = runError {
      return code
    }
    return "\(error)"
  }
}
