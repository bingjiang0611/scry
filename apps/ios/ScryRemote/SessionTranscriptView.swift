import SwiftUI
import RemoteTransport

// A session opened from the list: read-only replay of its past turns PLUS a live
// composer to CONTINUE the conversation. A follow-up resumes the SAME Provider
// session (RemoteRunStore.submitFollowUp with resume = the session id), so the
// run keeps the prior context. It stays honest (CLAUDE.md 证据不能说谎): past
// turns are the host's read of real archived content, the live turn shows only
// streamed output (a possibly-incomplete cache) while its REAL lifecycle sits
// in the status strip, and nothing is fabricated. File diffs still live on the Mac.
// Full text stays inline. Parse archived Markdown off the UI actor; the
// conversation virtualizes rows, while each visible reply exposes its full
// height so tail positioning does not stop at a placeholder.
private struct HistoryChunkView: View {
  let kind: String
  let text: String
  var result: String?
  @State private var blocks: [ConversationMarkdownBlock]?
  @State private var parsedSource: String?

  @ViewBuilder var body: some View {
    switch kind {
    case "reasoning", "tool", "tool_result", "truncated":
      ConversationChunk(kind: kind, text: text, result: result)
    default:
      Group {
        if let blocks, parsedSource == text {
          ConversationMarkdownText(source: "", parsedBlocks: blocks)
        } else { ProgressView() }
      }
      .task(id: text) {
        let parsed = await ConversationMarkdownParser.parseForReading(text)
        guard !Task.isCancelled else { return }
        blocks = parsed
        parsedSource = text
      }
    }
  }
}

private struct HistoryTurnView: View {
  let turn: G0Transport.RunHistoryTurn
  var body: some View {
    // The conversation owns the lazy layout. Nested lazy stacks estimate whole
    // tall turns independently and can leave the tail viewport empty.
    Group {
      if !turn.userText.isEmpty { TurnUserBubble(text: turn.userText, runId: turn.runId) }
      ForEach(ConversationEntry.group(turn.items, id: { index, _ in index }, kind: \.kind, text: \.text)) { entry in
        HistoryChunkView(kind: entry.kind, text: entry.text, result: entry.result)
      }
    }.frame(maxWidth: .infinity, alignment: .leading)
  }
}

// Browsing another session must not reset an unresolved recovery task. Reuse
// the history implementation and protected cache, but never restore its run.
struct ReadOnlySessionTranscriptView: View {
  @EnvironmentObject var model: AppModel
  @State private var history: RemoteRunStore

  init(owner: RemoteRunStore) {
    _history = State(initialValue: RemoteRunStore(historyFor: owner))
  }

  var body: some View {
    SessionTranscriptView(readOnly: true)
      .environment(history)
      .onChange(of: history.reachable) { if let ok = history.reachable { model.markReachable(ok) } }
      .onChange(of: history.connectionObservation) { _, observation in model.markObservation(observation) }
  }
}

struct SessionTranscriptView: View {
  @Environment(\.scenePhase) private var scenePhase
  @State private var controlsVisible = false
  var readOnly = false
  @EnvironmentObject var model: AppModel
  @Environment(RemoteRunStore.self) var run
  @State private var showFiles = false
  @State private var showHistoryDetails = false
  @State private var olderReadRequest = 0
  @State private var latestReadRequest = 0
  @State private var followingLatest = true
  @State private var showLiveQuestion = false
  @State private var stopTarget: StopTarget?
  // One stop confirmation for every run, wherever it was started.
  private enum StopTarget { case focused, live(G0Transport.LiveRun) }
  private var composer: Binding<AppModel.ComposerDraft> {
    model.composerDraft(for: sessionIdentity.map(AppModel.DraftKey.conversation) ?? .newTask(model.targetCoordinator.selectedScope))
  }
  private var draft: String { composer.wrappedValue.text }
  private var attachments: [DraftAttachment] { composer.wrappedValue.attachments }

  private var session: OpenedSession? { model.openedSession }
  private var hasLiveTurn: Bool { run.prompt != nil }
  private var sessionIdentity: RemoteRunStore.SessionIdentity? {
    guard let s = session else { return nil }
    return s.identity
  }
  private var completedTurns: [RemoteRunStore.CompletedLiveTurn] {
    guard let identity = sessionIdentity else { return [] }
    return run.completedTurns(for: identity)
  }
  // A run in this session that this store is not watching: started on the Mac,
  // or left running when the user switched away from it.
  private var otherLive: G0Transport.LiveRun? { readOnly ? nil : run.otherLiveRun(for: sessionIdentity) }
  private var otherLiveQuestion: G0Transport.RunQuestionRequest? { otherLive.flatMap { run.openLiveQuestion($0) } }
  // This conversation's message that is still sending after the user left it.
  private var backgroundSend: RemoteRunStore.PendingSubmission? { readOnly ? nil : run.backgroundSend(for: sessionIdentity) }
  private var runBusy: Bool { run.isBusy || otherLive != nil || backgroundSend != nil }
  // Show the detached run's streamed output unless history already holds its
  // turn (a Provider transcript written live); never show both.
  private var detachedLive: G0Transport.LiveRun? {
    guard let live = otherLive, live.origin == "remote", run.detachedRunId == live.runId,
          run.activeSessionIdentity == sessionIdentity else { return nil }
    if run.detachedTurnInHistory { return nil }
    return live
  }
  private var controlsMatch: Bool {
    guard let session else { return false }
    return run.controlsMatch(providerId: session.providerId, agentProfileId: session.agentProfileId, cwd: session.cwd)
  }
  private var historyAllowsControls: Bool {
    guard run.activeSessionIdentity == sessionIdentity else { return false }
    switch run.history { case .idle, .loading: return false; default: return true }
  }
  private var historyReadyForDisplay: Bool {
    guard run.activeSessionIdentity == sessionIdentity else { return false }
    if case .loaded = run.history { return true }
    if case .partial = run.history { return true }
    if case .empty = run.history { return true }
    return false
  }

  var body: some View {
    VStack(spacing: 0) {
      header
      ConversationScrollView(revision: "\(historyReadyForDisplay)-\(run.historyRevision)-\(completedTurns.count)-\(run.output.count)-\(run.lifecycle)-\(run.detachedOutput.count)", stopFollowingRequest: olderReadRequest,
                             followLatestRequest: latestReadRequest, onFollowingChange: { value in
        guard run.activeSessionIdentity == sessionIdentity else { return }
        run.historyFollowingLatest = value
        followingLatest = value
      }) {
        historyBody
        if hasLiveTurn && !run.liveTurnInHistory { FocusedTurnView() }
        if let live = detachedLive { detachedTurn(live) }
        if let pending = backgroundSend {
          TurnUserBubble(text: pending.routing.prompt,
                         attachments: pending.routing.attachments.map(RemoteRunStore.SentAttachment.init),
                         usagePending: true)
        }
      }
      .id(sessionIdentity)
      statusStrip
      if !readOnly { footer }
    }
    .background(Palette.surface)
    .sheet(isPresented: $showFiles) {
      if let session { WorkspaceBrowserView(cwd: session.cwd).id(session.cwd) }
    }
    .sheet(isPresented: $showHistoryDetails) {
      HistoryEvidenceDetails(status: historyStatus, lastChecked: run.historyFetchedAt,
                             refreshError: run.historyRefreshError, storageNotice: run.historyStorageNotice)
    }
    .macLocalLinks(cwd: session?.cwd)
    .onChange(of: otherLiveQuestion?.questionId, initial: true) { _, id in showLiveQuestion = id != nil }
    .confirmationDialog("停止这次运行？",
                        isPresented: Binding(get: { stopTarget != nil }, set: { if !$0 { stopTarget = nil } }),
                        titleVisibility: .visible, presenting: stopTarget) { target in
      Button("停止运行", role: .destructive) {
        switch target {
        case .focused: run.stopRun()
        case let .live(live): run.stopLiveRun(live)
        }
      }
    } message: { _ in
      Text("请求 Agent 停止，结果以 Agent 实际结束为准。")
    }
    .sheet(isPresented: $showLiveQuestion) {
      if let live = otherLive, let request = otherLiveQuestion {
        RemoteQuestionSheet(request: request, submitting: run.liveActionRunId == live.runId, error: run.liveActionError,
          onAnswer: { run.answerLiveQuestion(live, request: request, answers: $0) },
          onCancel: { run.answerLiveQuestion(live, request: request, answers: [:], cancel: true) })
          .id(run.questionIdentity(request))
      }
    }
    .onAppear {
      controlsVisible = true
      guard let s = session else { return }
      // Keep a live run when leaving and re-opening this same session. A
      // different session identity invalidates old history/poll callbacks.
      run.prepareForSession(providerId: s.providerId, cwd: s.cwd, externalSessionId: s.externalSessionId, agentProfileId: s.agentProfileId)
      if !readOnly && historyAllowsControls { loadSessionControls() }
      if !readOnly { run.watchHistory(sessionIdentity) }
    }
    .onDisappear { controlsVisible = false; if !readOnly { run.watchHistory(nil); run.followDetached(nil) } }
    .onChange(of: scenePhase) { _, phase in
      if phase == .active, controlsVisible, !readOnly, historyAllowsControls, !runBusy, !run.providerControlsLoading { reloadProviders() }
    }
    .onChange(of: otherLive?.runId, initial: true) { _, _ in run.followDetached(otherLive) }
    .onChange(of: historyAllowsControls) {
      if !readOnly && historyAllowsControls { loadSessionControls() }
    }
    .task(id: followingLatest ? sessionIdentity : nil) {
      guard followingLatest, let s = session else { return }
      // Returning to the tail must reconcile a version the long-poll already
      // reported while the reader was browsing older messages.
      await run.refreshHistory(providerId: s.providerId, cwd: s.cwd, externalSessionId: s.externalSessionId, agentProfileId: s.agentProfileId)
    }
    .task(id: sessionIdentity) {
      guard let s = session else { return }
      // The Mac can start another turn after this screen opens. Keep checking
      // while it is visible, including after a terminal/archive transition.
      while !Task.isCancelled {
        try? await Task.sleep(nanoseconds: 3_000_000_000)
        guard !Task.isCancelled else { return }
        // The live-run long-poll already delivers this session's changes.
        if run.historyIsWatched(sessionIdentity) { continue }
        await run.refreshHistory(providerId: s.providerId, cwd: s.cwd,
                                 externalSessionId: s.externalSessionId, agentProfileId: s.agentProfileId)
      }
    }
  }

  @ViewBuilder private var historyBody: some View {
    if run.activeSessionIdentity == sessionIdentity, run.historyCapacityLimit {
      Button("加载完整历史（完整字节传输）") {
        if let s = session { run.loadCompleteHistory(providerId: s.providerId, cwd: s.cwd, externalSessionId: s.externalSessionId, agentProfileId: s.agentProfileId) }
      }
      .buttonStyle(.borderedProminent)
      .disabled(run.historySyncing)
      .accessibilityHint("明确选择后下载完整历史；不会裁剪内容")
    }
    switch run.activeSessionIdentity == sessionIdentity ? run.history : .loading {
    case .idle, .loading:
      // The detached run's live turn is already real content; a skeleton
      // above it would read as "nothing loaded yet".
      if detachedLive == nil { transcriptLoadingState }
    case let .partial(turns), let .loaded(turns):
      if run.historyOlderBefore != nil {
        Button(run.historySyncing ? "正在读取更早历史…" : "加载更早的完整历史") {
          olderReadRequest += 1
          if let s = session { run.loadOlderHistory(providerId: s.providerId, cwd: s.cwd, externalSessionId: s.externalSessionId, agentProfileId: s.agentProfileId) }
        }
        .buttonStyle(.bordered)
        .disabled(run.historySyncing)
        .accessibilityHint("仅读取更早轮次，不会裁剪当前历史")
      }
      // Snapshot ordinals preserve existing view identity when older pages are
      // prepended. They are presentation positions, not canonical turn IDs.
      let first = run.historyPageOffset
      ForEach(first..<(first + turns.count), id: \.self) { ordinal in
        HistoryTurnView(turn: turns[ordinal - first])
      }
      ForEach(completedTurns) { turn in CompletedTurnView(turn: turn) }
    case .empty:
      ForEach(completedTurns) { turn in CompletedTurnView(turn: turn) }
      Text(ConnectionCopy.noReadableHistory)
        .font(.system(size: 13)).foregroundStyle(Palette.muted)
        .frame(maxWidth: .infinity, alignment: .leading).padding(.top, 20)
    case .baseUnavailable:
      // The missing record is reported once, in the status strip.
      ForEach(completedTurns) { turn in CompletedTurnView(turn: turn) }
    case .failed("history_unavailable") where detachedLive != nil:
      // A session this run is creating has no record until the run ends.
      EmptyView()
    case let .failed(reason):
      EmptyState(title: "暂时无法读取会话", detail: reason + "\n已输入的草稿会保留。", symbol: "exclamationmark.triangle")
      Button("重新读取") {
        if let s = session {
          run.loadHistory(providerId: s.providerId, cwd: s.cwd, externalSessionId: s.externalSessionId, force: true, agentProfileId: s.agentProfileId)
        }
      }
      .buttonStyle(.borderedProminent).frame(maxWidth: .infinity)
      DisclosureGroup("错误详情") { Text(reason).font(.caption).textSelection(.enabled) }
        .font(.caption).foregroundStyle(Palette.muted)
      ForEach(completedTurns) { turn in CompletedTurnView(turn: turn) }
    }
  }

  private var transcriptLoadingState: some View {
    VStack(alignment: .leading, spacing: 22) {
      HStack(spacing: 12) {
        ZStack {
          Circle().fill(Palette.blue.opacity(0.08)).frame(width: 34, height: 34)
          Circle().fill(Palette.line.opacity(0.5)).frame(width: 12, height: 12)
        }
        VStack(alignment: .leading, spacing: 3) {
          RoundedRectangle(cornerRadius: 4).fill(Palette.line.opacity(0.6)).frame(width: 150, height: 12)
          RoundedRectangle(cornerRadius: 4).fill(Palette.line.opacity(0.35)).frame(width: 105, height: 10)
        }
      }
      .padding(.vertical, 12).padding(.horizontal, 13)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(Palette.canvas.opacity(0.82), in: RoundedRectangle(cornerRadius: 14, style: .continuous))

      VStack(alignment: .leading, spacing: 18) {
        HStack {
          Spacer(minLength: 72)
          RoundedRectangle(cornerRadius: 17, style: .continuous)
            .fill(Palette.canvas)
            .frame(height: 58)
        }
        VStack(alignment: .leading, spacing: 10) {
          RoundedRectangle(cornerRadius: 4).fill(Palette.line).frame(width: 174, height: 10)
          RoundedRectangle(cornerRadius: 4).fill(Palette.line).frame(maxWidth: .infinity).frame(height: 10)
          RoundedRectangle(cornerRadius: 4).fill(Palette.line).frame(width: 236, height: 10)
        }
      }
      .accessibilityHidden(true)
      .opacity(0.72)
    }
    .padding(.top, 8)
    .frame(maxWidth: .infinity, alignment: .leading)
  }

  private var header: some View {
    RemoteHeader(title: session?.label.isEmpty == false ? session!.label : ConnectionCopy.session,
                 subtitle: headerSubtitle, link: model.link, titleLineLimit: 2,
                 backAction: { model.goBack() }) {
      Button { showFiles = true } label: {
        Image(systemName: "folder").font(.system(size: 18)).frame(width: 44, height: 44)
      }.accessibilityLabel(ConnectionCopy.projectFilesAndDiff).disabled(session == nil)
      MoreMenu(label: ConnectionCopy.moreWithStatus(historyStatus)) {
        Section(ConnectionCopy.historyStatus) {
          Text(historyStatus)
          if let date = run.historyFetchedAt { Text("上次核对 \(date.formatted(date: .abbreviated, time: .shortened))") }
          if let reason = run.historyRefreshError { Text(reason) }
          if let notice = run.historyStorageNotice { Text(notice) }
        }
        if let s = session {
          Button { run.loadHistory(providerId: s.providerId, cwd: s.cwd, externalSessionId: s.externalSessionId, force: true, agentProfileId: s.agentProfileId) } label: {
            Label(ConnectionCopy.historyRefresh, systemImage: "arrow.clockwise")
          }
        }
        if !readOnly {
          Button { if model.targetCoordinator.beginNewTask(scope: model.targetCoordinator.selectedScope) { model.route = .newSession } } label: { Label("新任务", systemImage: Symbol.compose) }
        }
        Button { model.route = .settings } label: { Label("设置", systemImage: Symbol.gear) }
      }
    }
  }

  private func loadSessionControls() {
    guard let s = session else { return }
    run.loadSessionProviderControls(providerId: s.providerId, agentProfileId: s.agentProfileId, cwd: s.cwd)
    run.loadCommands(providerId: s.providerId, cwd: s.cwd, agentProfileId: s.agentProfileId)
  }

  private var headerSubtitle: String {
    // Identity only; every run state is in the status strip.
    [projectName(session?.cwd), providerName].filter { !$0.isEmpty }.joined(separator: " · ")
  }

  private var providerName: String {
    guard let id = session?.providerId else { return "" }
    if let provider = run.chosenProvider, provider.id == id {
      return provider.label.components(separatedBy: " · ").first ?? provider.label
    }
    return id.prefix(1).uppercased() + id.dropFirst()
  }

  // Design A: one line above the composer for everything happening in this
  // session, most urgent first. A run reads the same whether this phone or the
  // Mac started it.
  @ViewBuilder private var statusStrip: some View {
    if let status {
      SessionStatusStrip(status: status)
    } else if let session, !readOnly, run.liveRunsStatus != .observed {
      // Hosts without the live-run long-poll: the slower status read fills in.
      SessionRunStatusView(session: session)
    }
  }

  private var status: SessionStatusLine? {
    if readOnly {
      let issue = historyIssue
      return .init(text: issue.map { "只读浏览 · \($0.text)" } ?? "只读浏览，不影响正在恢复的任务",
                   tone: issue?.tone ?? .neutral, busy: issue?.busy ?? false,
                   action: .init(title: "返回任务", perform: { model.route = .chat }))
    }
    if !run.hasConnection { return .offline }
    if run.activeSessionIdentity == sessionIdentity,
       let focused = SessionStatusLine.focusedRun(run, onAnswer: { model.showRunQuestion = true },
                                              onStop: { stopTarget = .focused }) {
      return focused
    }
    if let live = otherLive {
      if otherLiveQuestion != nil {
        return .init(text: "需要你决定", tone: .attention, action: .init(title: "回答", perform: { showLiveQuestion = true }))
      }
      if let error = run.liveActionError {
        return .init(text: error, tone: .warning,
                     action: .init(title: "停止", destructive: true, disabled: run.liveActionRunId != nil,
                                   perform: { stopTarget = .live(live) }))
      }
      if live.state == "stopping" { return .init(text: "正在停止，等待 Agent 实际结束", busy: true) }
      return .init(text: "运行中", tone: .running, busy: true,
                   action: .init(title: run.liveActionRunId == live.runId ? "请求中…" : "停止", destructive: true,
                                 disabled: run.liveActionRunId != nil, perform: { stopTarget = .live(live) }))
    }
    if let pending = backgroundSend {
      if pending.uncertainty != nil {
        return .init(text: ConnectionCopy.targetResultUnknown, tone: .warning,
                     action: .init(title: ConnectionCopy.reconcileResult, perform: { run.reconcileUncertain(intentId: pending.intentId) }))
      }
      return .init(text: ConnectionCopy.sending, busy: true)
    }
    if let history = historyIssue { return history }
    if !runBusy, historyAllowsControls, let notice = run.providerControlsNotice {
      return .init(text: notice, busy: run.providerControlsLoading,
                   action: run.providerControlsLoading ? nil : .init(title: controlsMatch ? ConnectionCopy.refreshProviderControls : ConnectionCopy.retry, perform: reloadProviders))
    }
    if !runBusy, historyAllowsControls, !controlsMatch, run.providers != .loading {
      return .init(text: ConnectionCopy.providerControlsUnavailable,
                   action: .init(title: ConnectionCopy.retry, perform: reloadProviders))
    }
    return nil
  }

  private var historyIssue: SessionStatusLine? {
    guard run.activeSessionIdentity == sessionIdentity else { return nil }
    // The exact reason stays in the header menu (历史状态); the paced
    // refresh keeps retrying while this error stands (historyIsWatched).
    let details = SessionStatusLine.Action(title: ConnectionCopy.details, perform: { showHistoryDetails = true })
    if historyReadyForDisplay || run.history == .baseUnavailable, run.historyRefreshError != nil {
      return .init(text: run.history == .baseUnavailable ? ConnectionCopy.historyUnavailable
                                                          : ConnectionCopy.historySyncFailed,
                   tone: .warning, busy: true, action: details)
    }
    if run.historyStorageNotice != nil {
      return .init(text: ConnectionCopy.historyStorageLimited, tone: .warning, action: details)
    }
    if case .partial = run.history {
      return .init(text: ConnectionCopy.historyPartial, tone: .warning, action: details)
    }
    if run.historyFromCache {
      return .init(text: run.historySyncing ? ConnectionCopy.historyCheckingCache : ConnectionCopy.historyFromCache,
                   busy: run.historySyncing, action: details)
    }
    guard run.history == .baseUnavailable else { return nil }
    if run.historySyncing { return .init(text: ConnectionCopy.historyReading, busy: true) }
    return .init(text: ConnectionCopy.historyEarlierUnavailable,
                 action: .init(title: ConnectionCopy.retry, perform: {
                   if let s = session { run.loadHistory(providerId: s.providerId, cwd: s.cwd, externalSessionId: s.externalSessionId, force: true, agentProfileId: s.agentProfileId) }
                 }))
  }

  private func reloadProviders() {
    guard let s = session else { return }
    if controlsMatch { run.retryProviderControls() }
    else { run.loadSessionProviderControls(providerId: s.providerId, agentProfileId: s.agentProfileId, cwd: s.cwd, force: true) }
  }

  private var historyStatus: String {
    if run.historyNativeUnavailable { return ConnectionCopy.historyNativeUnavailable }
    if let source = run.historyPageSource, run.historyOlderBefore != nil {
      return ConnectionCopy.historyRecentComplete(source)
    }
    if case .partial = run.history { return ConnectionCopy.historyPartial }
    if run.historyFromCache { return ConnectionCopy.historyFromCache }
    if run.historySyncing { return ConnectionCopy.historyReading }
    if run.historyFetchedAt != nil { return ConnectionCopy.historyVerified }
    return ConnectionCopy.historyStateUnavailable
  }

  private func projectName(_ cwd: String?) -> String {
    guard let cwd else { return "" }
    return cwd.split(separator: "/").last.map(String.init) ?? cwd
  }

  // A run in this session that this store is not driving. It streams until the
  // session record holds the turn (detachedLive), then history replaces it.
  private func detachedTurn(_ live: G0Transport.LiveRun) -> some View {
    Group {
      if !live.prompt.isEmpty { TurnUserBubble(text: live.prompt, runId: live.runId, usagePending: true) }
      TurnOutputList(lines: run.detachedOutput)
      // This cache can omit or truncate chunks; it is not the archive.
      Text("实时输出可能不完整；运行结束后以会话记录为准。")
        .font(.system(size: 12.5)).foregroundStyle(Palette.muted)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }

  private var footer: some View {
    VStack(alignment: .leading, spacing: 5) {
      MessageComposer(text: composer.text, attachments: composer.attachments,
                      placeholder: !run.hasConnection ? "连接后可输入" : runBusy ? "运行结束后可发送，先写也行" : "继续这段对话…",
                      disabled: !run.hasConnection,
                      sendDisabled: runBusy || !controlsMatch || draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                      contextLabel: run.chosenProvider?.label ?? session?.providerId.uppercased(), contextLocked: true,
                      modelOptions: run.modelOptions, selectedModelId: run.chosenModelId,
                      modelSelectionIssue: run.modelSelectionIssue,
                      onModel: { run.chooseModel($0) },
                      effortOptions: run.effortOptions, selectedEffort: run.chosenEffort,
                      onEffort: { run.chooseEffort($0) },
                      permissionOptions: run.chosenProvider?.permissions ?? [], selectedPermission: run.permissionMode,
                      onPermission: { run.choosePermission($0) },
                      slashCommands: run.activeSessionIdentity == sessionIdentity && controlsMatch ? run.slashCommands : [],
                      slashCommandsLoading: run.slashCommandsLoading,
                      slashCommandsReason: run.slashCommandsReason,
                      onRefreshSlashCommands: {
                        if let s = session {
                          run.loadCommands(providerId: s.providerId, cwd: s.cwd,
                                           agentProfileId: s.agentProfileId, force: true)
                        }
                      }) {
        guard let s = session else { return }
        if run.submitFollowUp(prompt: draft, providerId: s.providerId, agentProfileId: s.agentProfileId,
                             cwd: s.cwd, resume: s.externalSessionId, attachments: attachments.map(\.wireValue)) {
          composer.wrappedValue = .init()
          latestReadRequest += 1
        }
      }
    }
    .padding(.horizontal, 14).padding(.bottom, 4)
    .background(Palette.surface)
    .overlay(alignment: .top) { Rectangle().fill(Palette.line.opacity(0.7)).frame(height: 0.5) }
  }
}

private struct HistoryEvidenceDetails: View {
  let status: String
  let lastChecked: Date?
  let refreshError: String?
  let storageNotice: String?
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    NavigationStack {
      List {
        Section(ConnectionCopy.historyStatus) {
          Text(status)
          Text(lastChecked.map(ConnectionCopy.historyLastCheckedText) ?? ConnectionCopy.historyNotChecked)
            .font(.system(size: 13)).foregroundStyle(Palette.muted)
        }
        if let refreshError {
          Section(ConnectionCopy.historySyncIssue) {
            Text(refreshError).font(.system(size: 13)).textSelection(.enabled)
          }
        }
        if let storageNotice {
          Section(ConnectionCopy.historyStorageIssue) {
            Text(storageNotice).font(.system(size: 13)).textSelection(.enabled)
          }
        }
      }
      .navigationTitle(ConnectionCopy.historyDetailsTitle)
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .confirmationAction) {
          Button(ConnectionCopy.done) { dismiss() }
        }
      }
    }
  }
}
