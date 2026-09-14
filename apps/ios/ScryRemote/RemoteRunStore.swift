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

  enum DirectoriesState: Equatable {
    case idle
    case loading
    case loaded(G0Transport.RunDirectoryListing)
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
  struct SentAttachment: Identifiable, Equatable {
    let id = UUID()
    let name: String
    let kind: RemoteRunClient.Attachment.Kind
    let size: Int
  }

  @Published private(set) var projects: ProjectsState = .idle
  @Published private(set) var directories: DirectoriesState = .idle
  @Published private(set) var chosen: G0Transport.RunProjectRef?
  @Published private(set) var providers: ProvidersState = .idle
  @Published private(set) var chosenProvider: G0Transport.RunProviderRef?
  @Published private(set) var chosenEffort: String?
  @Published private(set) var permissionMode: String = "default"

  // The host's session catalog (the SAME conversations the Mac lists). Loaded
  // from the host over the granted-cert channel; never fabricated. Opening a
  // session's full transcript on the phone is a separate host read.
  enum CatalogState: Equatable {
    case idle
    case loading
    case loaded([G0Transport.RunSessionRef])
    case empty
    case failed(String)
  }
  @Published private(set) var catalog: CatalogState = .idle

  // The REAL conversation content of the opened session (read-only replay).
  enum HistoryState: Equatable {
    case idle
    case loading
    case loaded([G0Transport.RunHistoryTurn])
    case empty
    case failed(String)
  }
  @Published private(set) var history: HistoryState = .idle
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
  @Published private(set) var sentAttachments: [SentAttachment] = []
  @Published private(set) var runId: String?
  @Published private(set) var submitError: String?
  @Published private(set) var truncated = false
  // Provider-canonical result evidence, surfaced verbatim from the ledger
  // `result` marker only. nil until the host reports it; never a fabricated 0.
  @Published private(set) var resultSummary: String?
  // The Provider session id the live run reported (from the ledger `session`
  // marker). Lets a follow-up into an opened session resume the LATEST id.
  @Published private(set) var liveExternalSessionId: String?

  private let connections = RemoteConnectionStore()
  private var pollTask: Task<Void, Never>?
  #if DEBUG
  private var mockMode = false
  #endif

  // A persisted PUBLIC connection descriptor means this device is paired and may
  // attempt a run; reachability of the host is only known by trying.
  var hasConnection: Bool {
    #if DEBUG
    if mockMode { return true }
    #endif
    return connections.load() != nil
  }
  var hostLabel: String? {
    #if DEBUG
    if mockMode { return "Studio Mac" }
    #endif
    return connections.load()?.relayHost
  }

  private func makeClient() -> RemoteRunClient? {
    guard let connection = connections.load() else { return nil }
    return RemoteRunClient(connection: connection)
  }

  func chooseProject(_ ref: G0Transport.RunProjectRef) { chosen = ref }
  func chooseProvider(_ ref: G0Transport.RunProviderRef) {
    chosenProvider = ref
    chosenEffort = ref.efforts?.first(where: { $0.isDefault == true })?.id ?? ref.efforts?.first?.id
    permissionMode = ref.permissions?.first(where: { $0.id == "default" })?.id ?? ref.permissions?.first?.id ?? "default"
  }
  func chooseEffort(_ id: String) {
    guard chosenProvider?.efforts?.contains(where: { $0.id == id }) == true else { return }
    chosenEffort = id
  }
  func choosePermission(_ id: String) {
    guard chosenProvider?.permissions?.contains(where: { $0.id == id }) == true else { return }
    permissionMode = id
  }

  // Load the host session catalog so the phone's session list shows the SAME
  // conversations the Mac has (fixes an always-empty list). Honest states only.
  func loadSessions() {
    #if DEBUG
    if mockMode { return }
    #endif
    guard let client = makeClient() else { catalog = .failed("尚未配对"); return }
    catalog = .loading
    Task { [weak self] in
      do {
        let list = try await client.sessions()
        await MainActor.run {
          self?.reachable = true
          self?.catalog = list.isEmpty ? .empty : .loaded(list)
        }
      } catch {
        await MainActor.run { self?.reachable = false; self?.catalog = .failed(Self.describe(error)) }
      }
    }
  }

  // Load one session's real conversation content so the phone can OPEN it.
  // Honest states only; never fabricates turns.
  func loadHistory(providerId: String, cwd: String, externalSessionId: String) {
    #if DEBUG
    if mockMode { return }
    #endif
    guard let client = makeClient() else { history = .failed("尚未配对"); return }
    history = .loading
    Task { [weak self] in
      do {
        let turns = try await client.history(providerId: providerId, cwd: cwd, externalSessionId: externalSessionId)
        await MainActor.run {
          self?.reachable = true
          self?.history = turns.isEmpty ? .empty : .loaded(turns)
        }
      } catch {
        await MainActor.run { self?.reachable = false; self?.history = .failed(Self.describe(error)) }
      }
    }
  }

  // Load the Providers the host offers. Only available ones are selectable (an
  // unavailable Provider cannot run). We deliberately do NOT auto-select a
  // default: describe() reports a Provider as available from CLI presence/auth,
  // which does not guarantee a run succeeds (e.g. a Provider whose CLI crashes on
  // launch). Auto-picking the first would silently send the first turn to a
  // Provider the user never chose - exactly the failure the owner hit. Requiring
  // an explicit pick (canSend gates on chosenProvider) keeps the choice honest.
  // If a previously-chosen Provider is no longer available, clear it.
  func loadProviders(preferredId: String? = nil) {
    #if DEBUG
    if mockMode {
      if let preferredId, case let .loaded(items) = providers,
         let preferred = items.first(where: { $0.id == preferredId }) { chooseProvider(preferred) }
      return
    }
    #endif
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
            self.chosenEffort = nil
            self.permissionMode = "default"
          }
          if let preferredId, let preferred = usable.first(where: { $0.id == preferredId }), self.chosenProvider?.id != preferredId {
            self.chooseProvider(preferred)
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
    #if DEBUG
    if mockMode { return }
    #endif
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

  // Browse exactly one hierarchy level. A nil path requests authorized roots;
  // the host rejects every path outside those roots before reading the folder.
  func loadDirectories(path: String? = nil) {
    #if DEBUG
    if mockMode { loadMockDirectories(path: path); return }
    #endif
    guard let client = makeClient() else { directories = .failed("尚未配对，无法读取文件夹"); return }
    directories = .loading
    Task { [weak self] in
      do {
        let listing = try await client.directories(path: path)
        await MainActor.run {
          self?.reachable = true
          self?.directories = .loaded(listing)
        }
      } catch {
        await MainActor.run { self?.reachable = false; self?.directories = .failed(Self.describe(error)) }
      }
    }
  }

  // Submit a durable intent and begin polling. Recorded != executed: the button
  // records intent; the host drives the real lifecycle we then observe.
  func submit(prompt: String, providerId: String, attachments: [RemoteRunClient.Attachment] = []) {
    let trimmed = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return }
    guard let cwd = chosen?.path else { submitError = "请先选择一个主机已授权的项目"; return }
    #if DEBUG
    if mockMode { applyMockRun(prompt: trimmed, attachments: attachments); return }
    #endif
    guard let client = makeClient() else { submitError = "尚未配对"; return }
    let modelId = chosenProvider?.modelId
    let effort = chosenEffort
    let permission = permissionMode
    submitError = nil
    resetRun()
    self.prompt = trimmed
    sentAttachments = attachments.map { SentAttachment(name: $0.name, kind: $0.kind, size: $0.size) }
    lifecycle = .recorded
    Task { [weak self] in
      do {
        let routing = RemoteRunClient.Routing(cwd: cwd, providerId: providerId, agentProfileId: nil, prompt: trimmed,
                                              modelId: modelId, effort: effort, permissionMode: permission,
                                              attachments: attachments)
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
        // The Provider's own session id for THIS run. Captured so a chained
        // follow-up resumes the latest session (continuous memory), not a stale id.
        if marker["event"] == "session", let ext = marker["externalSessionId"], !ext.isEmpty { liveExternalSessionId = ext }
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
    // Providers stream text/reasoning in small deltas. Keep those deltas as one
    // readable block instead of rendering one SwiftUI Text row per token.
    if let last = output.last, last.kind == chunk.kind,
       chunk.kind == "output" || chunk.kind == "reasoning" {
      output[output.count - 1] = OutputLine(id: chunk.seq, kind: chunk.kind, text: last.text + chunk.text)
    } else {
      output.append(OutputLine(id: chunk.seq, kind: chunk.kind, text: chunk.text))
    }
  }

  func resetRun() {
    pollTask?.cancel(); pollTask = nil
    lifecycle = .unknown
    output = []
    prompt = nil
    sentAttachments = []
    runId = nil
    truncated = false
    resultSummary = nil
    submitError = nil
    liveExternalSessionId = nil
  }

  // Send a follow-up that CONTINUES an opened session (same Provider + cwd +
  // session id) so the conversation keeps its context. Unlike submit(), the
  // target is explicit (from the opened session), not the new-session pickers.
  // Chained follow-ups resume the LATEST reported session id when available.
  func submitFollowUp(prompt: String, providerId: String, cwd: String, resume: String, attachments: [RemoteRunClient.Attachment] = []) {
    let trimmed = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return }
    #if DEBUG
    if mockMode { applyMockRun(prompt: trimmed, attachments: attachments); liveExternalSessionId = resume; return }
    #endif
    guard let client = makeClient() else { submitError = "尚未配对"; return }
    let resumeId = liveExternalSessionId ?? resume
    let modelId = chosenProvider?.id == providerId ? chosenProvider?.modelId : nil
    let effort = chosenProvider?.id == providerId ? chosenEffort : nil
    let permission = chosenProvider?.id == providerId ? permissionMode : "default"
    submitError = nil
    resetRun()
    self.prompt = trimmed
    sentAttachments = attachments.map { SentAttachment(name: $0.name, kind: $0.kind, size: $0.size) }
    lifecycle = .recorded
    liveExternalSessionId = resumeId
    Task { [weak self] in
      do {
        let routing = RemoteRunClient.Routing(cwd: cwd, providerId: providerId, agentProfileId: nil, prompt: trimmed,
                                              modelId: modelId, effort: effort, permissionMode: permission,
                                              resume: resumeId, attachments: attachments)
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
          self?.submitError = "发送失败：\(Self.describe(error))"
        }
      }
    }
  }

  #if DEBUG
  // Visual-only fixtures for `-uiPreview -uiMockData`. They deliberately never
  // touch Keychain, relay, Provider, ledger, or Release execution paths.
  func applyUIPreviewArguments() {
    guard ProcessInfo.processInfo.arguments.contains("-uiMockData") else { return }
    mockMode = true
    reachable = true

    let roots = [
      G0Transport.RunProjectRef(path: "/Users/demo/Projects/scry", label: "scry"),
      G0Transport.RunProjectRef(path: "/Users/demo/Projects/rate-native", label: "rate-native"),
      G0Transport.RunProjectRef(path: "/Users/demo/Work/atlas-web", label: "atlas-web")
    ]
    projects = .loaded(roots)
    chosen = G0Transport.RunProjectRef(path: "/Users/demo/Projects/scry/apps/ios", label: "ios")

    let efforts = [
      G0Transport.RunControlOption(id: "low", label: "低", description: "更快响应", isDefault: true),
      G0Transport.RunControlOption(id: "medium", label: "中", description: "平衡速度与推理"),
      G0Transport.RunControlOption(id: "high", label: "高", description: "更深入推理"),
      G0Transport.RunControlOption(id: "xhigh", label: "极高", description: "复杂任务")
    ]
    let permissions = [
      G0Transport.RunControlOption(id: "default", label: "默认审批", description: "危险操作前询问", isDefault: true),
      G0Transport.RunControlOption(id: "auto_review", label: "自动审查", description: "按策略自动处理"),
      G0Transport.RunControlOption(id: "full_access", label: "完全访问", description: "仅由设备所有者显式选择")
    ]
    let availableProviders = [
      G0Transport.RunProviderRef(id: "codex", label: "Codex", available: true, modelId: "gpt-5.6-sol", efforts: efforts, permissions: permissions),
      G0Transport.RunProviderRef(id: "qoder", label: "Qoder", available: true, modelId: "ultimate", efforts: nil, permissions: permissions),
      G0Transport.RunProviderRef(id: "opencode", label: "OpenCode", available: true, modelId: nil, efforts: nil, permissions: [permissions[0], permissions[2]])
    ]
    providers = .loaded(availableProviders)
    chooseProvider(availableProviders[0])

    let now = Date().timeIntervalSince1970 * 1_000
    catalog = .loaded([
      G0Transport.RunSessionRef(sessionId: "mock-pinned-1", externalSessionId: "codex-pinned-1", providerId: "codex", cwd: roots[0].path,
        label: "重构远程会话列表并统一信息层级", ts: now - 8 * 60_000, pinnedAt: now - 60_000),
      G0Transport.RunSessionRef(sessionId: "mock-pinned-2", externalSessionId: "qoder-pinned-2", providerId: "qoder", cwd: roots[1].path,
        label: "排查支付页偶发白屏与恢复流程", ts: now - 36 * 60_000, pinnedAt: now - 120_000),
      G0Transport.RunSessionRef(sessionId: "mock-scry-1", externalSessionId: "codex-scry-1", providerId: "codex", cwd: roots[0].path,
        label: "完成 iOS 工作目录选择器和附件发送", ts: now - 2 * 3_600_000),
      G0Transport.RunSessionRef(sessionId: "mock-scry-2", externalSessionId: "qoder-scry-2", providerId: "qoder", cwd: roots[0].path,
        label: "修复手机续聊在 Mac 端不可见的问题", ts: now - 5 * 3_600_000),
      G0Transport.RunSessionRef(sessionId: "mock-scry-running", providerId: "codex", cwd: roots[0].path,
        label: "正在分析大规模测试失败…", ts: now - 4 * 60_000),
      G0Transport.RunSessionRef(sessionId: "mock-rate-1", externalSessionId: "codex-rate-1", providerId: "codex", cwd: roots[1].path,
        label: "优化首页滚动性能并补充回归测试", ts: now - 24 * 3_600_000),
      G0Transport.RunSessionRef(sessionId: "mock-atlas-1", externalSessionId: "opencode-atlas-1", providerId: "opencode", cwd: roots[2].path,
        label: "实现登录错误态与离线重试体验", ts: now - 3 * 86_400_000)
    ])

    history = .loaded([
      G0Transport.RunHistoryTurn(userText: "请检查 iOS 远程首页的信息层级，并给出可以直接落地的修改。", items: [
        G0Transport.RunHistoryChunk(kind: "reasoning", text: "我会先检查会话分组、状态信息和底部操作区。"),
        G0Transport.RunHistoryChunk(kind: "tool", text: "读取 HomeView.swift"),
        G0Transport.RunHistoryChunk(kind: "tool_result", text: "已读取 281 行 · 未修改文件"),
        G0Transport.RunHistoryChunk(kind: "output", text: "发现三个主要问题：项目与会话的视觉层级接近、运行状态缺少时间语境、底部搜索和新建操作抢占了过多空间。建议先压缩标题区，再把 Provider 与时间放入会话元信息。")
      ]),
      G0Transport.RunHistoryTurn(userText: "按 Codex Refined 的方向继续，先不要加入底栏。", items: [
        G0Transport.RunHistoryChunk(kind: "output", text: "已保留无底栏结构，并将导航、内容与证据层分开。下一步可以重点比较列表密度和 Composer 的控制层级。")
      ])
    ])

    runId = "mock-run-visual-only"
    prompt = "把首页改成更紧凑的项目分组，同时保留真实运行证据。"
    sentAttachments = [
      SentAttachment(name: "home-reference.png", kind: .image, size: 184_320),
      SentAttachment(name: "notes.md", kind: .text, size: 4_812)
    ]
    lifecycle = .settled
    output = [
      OutputLine(id: 1, kind: "reasoning", text: "先对齐信息架构，再调整视觉密度。"),
      OutputLine(id: 2, kind: "tool", text: "编辑 HomeView.swift"),
      OutputLine(id: 3, kind: "tool_result", text: "3 个区块已更新 · 0 个错误"),
      OutputLine(id: 4, kind: "output", text: "首页已按“置顶 + 项目”重新组织。会话标题成为主信息，Provider、更新时间和运行状态降为轻量元信息；底部仅保留搜索与新建入口。")
    ]
    resultSummary = "输入 18,420 · 输出 1,286 · $0.084"
    liveExternalSessionId = "codex-mock-session"
    loadMockDirectories(path: chosen?.path)
    if ProcessInfo.processInfo.arguments.contains("-uiMockLoading") { history = .loading }
  }

  private func loadMockDirectories(path: String?) {
    let scry = G0Transport.RunProjectRef(path: "/Users/demo/Projects/scry", label: "scry")
    let ios = G0Transport.RunProjectRef(path: "\(scry.path)/apps/ios", label: "ios")
    switch path {
    case nil:
      directories = .loaded(G0Transport.RunDirectoryListing(directories: [scry,
        G0Transport.RunProjectRef(path: "/Users/demo/Projects/rate-native", label: "rate-native"),
        G0Transport.RunProjectRef(path: "/Users/demo/Work/atlas-web", label: "atlas-web")]))
    case scry.path:
      directories = .loaded(G0Transport.RunDirectoryListing(current: scry, directories: [
        G0Transport.RunProjectRef(path: "\(scry.path)/apps", label: "apps"),
        G0Transport.RunProjectRef(path: "\(scry.path)/docs", label: "docs"),
        G0Transport.RunProjectRef(path: "\(scry.path)/src", label: "src")
      ]))
    case "\(scry.path)/apps":
      directories = .loaded(G0Transport.RunDirectoryListing(
        current: G0Transport.RunProjectRef(path: "\(scry.path)/apps", label: "apps"), parent: scry,
        directories: [ios, G0Transport.RunProjectRef(path: "\(scry.path)/apps/desktop", label: "desktop")]))
    case ios.path:
      directories = .loaded(G0Transport.RunDirectoryListing(current: ios,
        parent: G0Transport.RunProjectRef(path: "\(scry.path)/apps", label: "apps"), directories: [
          G0Transport.RunProjectRef(path: "\(ios.path)/ScryRemote", label: "ScryRemote")
        ]))
    default:
      let current = G0Transport.RunProjectRef(path: path ?? scry.path, label: (path ?? scry.path).split(separator: "/").last.map(String.init) ?? "文件夹")
      directories = .loaded(G0Transport.RunDirectoryListing(current: current, parent: scry, directories: []))
    }
  }

  private func applyMockRun(prompt: String, attachments: [RemoteRunClient.Attachment]) {
    resetRun()
    self.prompt = prompt
    sentAttachments = attachments.map { SentAttachment(name: $0.name, kind: $0.kind, size: $0.size) }
    runId = "mock-run-visual-only"
    lifecycle = .settled
    output = [OutputLine(id: 1, kind: "output", text: "这是 DEBUG 视觉预览回复；没有连接 Provider，也没有写入真实 ledger。")]
    resultSummary = "Mock 数据 · 不代表真实用量"
  }
  #endif

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
