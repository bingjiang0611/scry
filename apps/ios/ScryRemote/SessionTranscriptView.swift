import SwiftUI
import RemoteTransport

struct SessionTranscriptView: View {
  @Environment(\.scenePhase) private var scenePhase
  @State private var controlsVisible = false
  var readOnly = false
  @EnvironmentObject var model: AppModel
  @Environment(RemoteRunStore.self) var run
  @State private var showFiles = false
  @State private var showOverview = false
  @State var showHistoryDetails = false
  @State var olderReadRequest = 0
  @State private var latestReadRequest = 0
  @State var splitPlans: [String: [Int: ConversationSplitPlan]] = [:]
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

  var session: OpenedSession? { model.openedSession }
  var hasLiveTurn: Bool { run.prompt != nil }
  var sessionIdentity: RemoteRunStore.SessionIdentity? {
    guard let s = session else { return nil }
    return s.identity
  }
  var completedTurns: [RemoteRunStore.CompletedLiveTurn] {
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
  var detachedLive: G0Transport.LiveRun? {
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
  var hasVisibleTurn: Bool {
    !completedTurns.isEmpty || detachedLive != nil || (hasLiveTurn && !run.liveTurnInHistory) || backgroundSend != nil
  }

  var historyReadyForDisplay: Bool {
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
        historyBody(split: splitPlans)
        if hasLiveTurn && !run.liveTurnInHistory {
          ForEach(ConversationTurn.focused(run).withSplitPlans(splitPlans["focused"] ?? [:]).rows(id: "focused")) { $0 }
        }
        if let live = detachedLive { detachedTurn(live) }
        if let pending = backgroundSend {
          TurnUserBubble(text: pending.routing.prompt,
                         attachments: pending.routing.attachments.map(RemoteRunStore.SentAttachment.init),
                         usagePending: true)
        }
      }
      .id(sessionIdentity)
      .conversationArrival()
      .task(id: splitRevision) { await refreshSplitBlocks() }
      statusStrip
      if !readOnly { footer }
    }
    .background(Palette.main)
    .environment(\.conversationProvider, providerName)
    .sheet(isPresented: $showFiles) {
      if let session { WorkspaceBrowserView(cwd: session.cwd).id(session.cwd) }
    }
    .sheet(isPresented: $showHistoryDetails) {
      HistoryEvidenceDetails(status: historyStatus, lastChecked: run.historyFetchedAt,
                             refreshError: run.historyRefreshError, storageNotice: run.historyStorageNotice)
    }
    .sheet(isPresented: $showOverview) { overview }
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
        RemoteQuestionSheet(request: request, subtitle: SheetCopy.context(title: session?.label, provider: providerName),
          submitting: run.liveActionRunId == live.runId, error: run.liveActionError,
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
    .task(id: readOnly && scenePhase == .active ? sessionIdentity : nil) {
      guard readOnly, scenePhase == .active, let identity = sessionIdentity else { return }
      await run.observeReadOnlyHistory(identity)
    }
  }

  private var header: some View {
    RemoteHeader(title: session?.label.isEmpty == false ? session!.label : ConnectionCopy.session,
                 subtitle: headerSubtitle, providerId: session?.providerId, titleLineLimit: 2,
                 transitionIdentity: sessionIdentity,
                 backAction: { model.goBack() }) {
      HStack(spacing: 0) {
        CircleButton(symbol: "sidebar.right", label: SheetCopy.overview) { showOverview = true }
          .accessibilityIdentifier("session-overview")
        MoreMenu(label: ConnectionCopy.moreWithStatus(historyStatus)) {
          Button { showFiles = true } label: {
            Label(ConnectionCopy.projectFilesAndDiff, systemImage: Symbol.folder)
          }.disabled(session == nil)
          Section(ConnectionCopy.historyStatus) {
            Button(ConnectionCopy.details) { showHistoryDetails = true }
            Text(historyStatus)
            if let date = run.historyFetchedAt { Text(SheetCopy.lastChecked(date)) }
            if let reason = run.historyRefreshError { Text(reason) }
            if let notice = run.historyStorageNotice { Text(notice) }
          }
          if let s = session {
            Button { run.loadHistory(providerId: s.providerId, cwd: s.cwd, externalSessionId: s.externalSessionId, force: true, agentProfileId: s.agentProfileId) } label: {
              Label(ConnectionCopy.historyRefresh, systemImage: "arrow.clockwise")
            }
          }
          if !readOnly {
            Button { if model.targetCoordinator.beginNewTask(scope: model.targetCoordinator.selectedScope) { model.route = .newSession } } label: { Label(ConversationCopy.newTask, systemImage: Symbol.compose) }
          }
          Button { model.route = .settings } label: { Label(ConversationCopy.settings, systemImage: Symbol.gear) }
        }
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
    ConversationCopy.context(project: projectName(session?.cwd), provider: providerName)
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
    if !runBusy, historyAllowsControls, !run.controlsReady, run.providers != .loading {
      // Blocking reason first: without it the arrow just looks dead behind a
      // history notice. A restored choice the Provider no longer offers cannot be
      // fixed by re-reading, so offer the explicit default reset instead.
      return .init(text: run.providerControlsNotice ?? ConnectionCopy.providerControlsUnavailable,
                   tone: .warning,
                   action: .init(title: run.restoredControlsBlockSend ? ConnectionCopy.useProviderDefaults : ConnectionCopy.retry,
                                 perform: run.restoredControlsBlockSend ? applyRestoredDefaults : reloadProviders))
    }
    if let history = historyIssue { return history }
    if !runBusy, historyAllowsControls, let notice = run.providerControlsNotice {
      return .init(text: notice, busy: run.providerControlsLoading,
                   action: run.providerControlsLoading ? nil : .init(title: controlsMatch ? ConnectionCopy.refreshProviderControls : ConnectionCopy.retry, perform: reloadProviders))
    }
    return nil
  }


  // Explicit recovery: drop ONLY the restored choices the Provider no longer offers.
  // Never fold this into a refresh — that would silently change the user's
  // permission or model when the app merely becomes active.
  private func applyRestoredDefaults() {
    if run.useProviderDefaultsForRestoredControls() { return }
    reloadProviders()
  }

  private func reloadProviders() {
    guard let s = session else { return }
    if controlsMatch { run.retryProviderControls() }
    else { run.loadSessionProviderControls(providerId: s.providerId, agentProfileId: s.agentProfileId, cwd: s.cwd, force: true) }
  }


  private func projectName(_ cwd: String?) -> String {
    guard let cwd else { return "" }
    return cwd.split(separator: "/").last.map(String.init) ?? cwd
  }

  // A run in this session that this store is not driving. It streams until the
  // session record holds the turn (detachedLive), then history replaces it.
  private func detachedTurn(_ live: G0Transport.LiveRun) -> some View {
    let turn = ConversationTurn(prompt: live.prompt.isEmpty ? nil : live.prompt, runId: live.runId,
      running: live.state == "running", usagePending: true,
      entries: ConversationEntry.group(run.detachedOutput, kind: \.kind, text: \.text),
      notice: ConversationCopy.liveCache)
    return ForEach(turn.withSplitPlans(splitPlans[live.runId] ?? [:]).rows(id: live.runId)) { $0 }
  }

  private var isDelegatedChildSession: Bool {
    sessionIdentity.map(run.isDelegatedChildSession) == true
  }

  private var footer: some View {
    VStack(alignment: .leading, spacing: 5) {
      MessageComposer(text: composer.text, attachments: composer.attachments,
                      placeholder: isDelegatedChildSession ? "委派子会话为只读，不能直接发送消息" : !run.hasConnection ? ConversationCopy.connectedInput : runBusy ? ConversationCopy.busyInput : ConversationCopy.followUpInput,
                      disabled: !run.hasConnection || isDelegatedChildSession,
                      sendDisabled: isDelegatedChildSession || runBusy || !run.controlsReady || draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                      sendBlockReason: isDelegatedChildSession ? "委派子会话为只读，不能直接发送消息" : (runBusy || run.controlsReady ? nil : (run.providerControlsNotice ?? ConnectionCopy.providerControlsUnavailable)),
                      contextLocked: true,
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
        guard !isDelegatedChildSession, let s = session else { return }
        if run.submitFollowUp(prompt: draft, providerId: s.providerId, agentProfileId: s.agentProfileId,
                             cwd: s.cwd, resume: s.externalSessionId, attachments: attachments.map(\.wireValue)) {
          composer.wrappedValue = .init()
          latestReadRequest += 1
        }
      }
    }
    .padding(.horizontal, 14).padding(.bottom, 4)
    .background(Palette.main)
  }
}
