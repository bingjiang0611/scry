import SwiftUI
import RemoteTransport

// A conversation view aligned with ChatGPT / Codex mobile: the user's message
// appears immediately as a right-aligned bubble, and the assistant's turn streams
// in below it. It stays honest (CLAUDE.md 证据不能说谎): the status strip shows
// the REAL lifecycle (recorded/dispatched/running/failed/cancelled), and the turn
// shows only the host's REAL streamed output content (a live cache, possibly
// incomplete/truncated). Token/cost come only from the ledger `result` marker.
// Nothing is fabricated; with no active run it shows a truthful empty state.
struct ChatView: View {
  @Environment(\.scenePhase) private var scenePhase
  @State private var controlsVisible = false
  @EnvironmentObject var model: AppModel
  @Environment(RemoteRunStore.self) var run
  @State private var showFiles = false
  @State private var showOverview = false
  @State private var latestReadRequest = 0
  @State private var splitBlocks: [String: [Int: [ConversationMarkdownBlock]]] = [:]
  @State private var confirmStop = false
  private var projectCwd: String? { run.activeSessionIdentity?.cwd ?? run.chosen?.path }
  private var composer: Binding<AppModel.ComposerDraft> {
    model.composerDraft(for: run.activeSessionIdentity.map(AppModel.DraftKey.conversation) ?? .newTask(model.targetCoordinator.selectedScope))
  }
  private var draft: String { composer.wrappedValue.text }
  private var attachments: [DraftAttachment] { composer.wrappedValue.attachments }

  private var paired: Bool { run.hasConnection }
  private var completedTurns: [RemoteRunStore.CompletedLiveTurn] {
    guard let identity = run.activeSessionIdentity else { return [] }
    return run.completedTurns(for: identity, historyRendered: false)
  }
  private var hasTurn: Bool { !completedTurns.isEmpty || run.prompt != nil || run.runId != nil || run.lifecycle != .unknown }
  private var runBusy: Bool { run.isBusy }

  var body: some View {
    VStack(spacing: 0) {
      header
      ConversationScrollView(revision: "\(completedTurns.count)-\(run.output.count)-\(run.lifecycle)", followLatestRequest: latestReadRequest) {
            if !hasTurn {
              EmptyState(title: ConversationCopy.startTitle,
                         detail: ConversationCopy.startDetail)
            } else {
              ForEach(completedTurns.flatMap { row in
                ConversationTurn.completed(row).withSplitBlocks(splitBlocks[row.id] ?? [:]).rows(id: row.id)
              }) { $0 }
              if run.prompt != nil {
                ForEach(ConversationTurn.focused(run).withSplitBlocks(splitBlocks["focused"] ?? [:]).rows(id: "focused")) { $0 }
              }
            }
      }
      .id(run.activeSessionIdentity)
      if let status { SessionStatusStrip(status: status) }
      footer
    }
    .background(Palette.main)
    .environment(\.conversationProvider, run.chosenProvider?.label.components(separatedBy: " · ").first ?? run.activeSessionIdentity?.providerId ?? "")
    .sheet(isPresented: $showFiles) {
      if let projectCwd { WorkspaceBrowserView(cwd: projectCwd).id(projectCwd) }
    }
    .sheet(isPresented: $showOverview) { overview }
    .macLocalLinks(cwd: projectCwd)
    .confirmationDialog(ConversationCopy.stopTitle, isPresented: $confirmStop, titleVisibility: .visible) {
      Button(ConversationCopy.stop, role: .destructive) { run.stopRun() }
    } message: {
      Text(ConversationCopy.stopDetail)
    }
    .task(id: splitRevision) { await refreshSplitBlocks() }
    .onAppear { controlsVisible = true; run.loadActiveContext() }
    .onDisappear { controlsVisible = false }
    .onChange(of: scenePhase) { _, phase in
      if phase == .active, controlsVisible, !runBusy, !run.providerControlsLoading { run.retryProviderControls() }
    }
#if DEBUG
    .onAppear {
      if draft.isEmpty, ProcessInfo.processInfo.arguments.contains("-uiMockSlash") { composer.wrappedValue.text = "/" }
    }
#endif
  }

  // Cheap identity for the background split task: turn/output counts, no text.
  private var splitRevision: String { "\(completedTurns.count)-\(run.output.count)-\(run.lifecycle)" }

  private func refreshSplitBlocks() async {
    let turns: [(String, ConversationTurn)] =
      completedTurns.map { ($0.id, ConversationTurn.completed($0)) }
      + (run.prompt != nil ? [("focused", ConversationTurn.focused(run))] : [])
    var ready: [String: [Int: [ConversationMarkdownBlock]]] = [:]
    for (id, turn) in turns {
      var hit: [Int: [ConversationMarkdownBlock]] = [:]
      for candidate in turn.splitCandidates {
        if let blocks = ConversationMarkdownSplitter.ready(turnID: id, candidate: candidate) { hit[candidate.index] = blocks }
      }
      ready[id] = hit
    }
    splitBlocks = ready
    for (id, turn) in turns {
      for candidate in turn.splitCandidates where ready[id]?[candidate.index] == nil {
        guard let blocks = await ConversationMarkdownSplitter.parse(turnID: id, candidate: candidate) else { continue }
        guard !Task.isCancelled else { return }
        ready[id, default: [:]][candidate.index] = blocks
        splitBlocks = ready
      }
    }
  }

  private var header: some View {
    RemoteHeader(title: completedTurns.first?.prompt ?? run.prompt ?? ConnectionCopy.session,
                 subtitle: sessionContext, providerId: run.activeSessionIdentity?.providerId ?? run.chosenProvider?.id, titleLineLimit: 2,
                 backAction: { model.goBack() }) {
      HStack(spacing: 0) {
        CircleButton(symbol: "sidebar.right", label: SheetCopy.overview) { showOverview = true }
          .accessibilityIdentifier("session-overview")
        MoreMenu {
          Button { showFiles = true } label: {
            Label(ConnectionCopy.projectFilesAndDiff, systemImage: Symbol.folder)
          }.disabled(projectCwd == nil)
          // Leaving keeps an unsent message sending and a run running on the Mac.
          Button { if model.targetCoordinator.beginNewTask(scope: model.targetCoordinator.selectedScope) { model.route = .newSession } } label: { Label(ConversationCopy.newTask, systemImage: Symbol.compose) }
          Button { model.route = .settings } label: { Label(ConversationCopy.settings, systemImage: Symbol.gear) }
        }
      }
    }
  }

  private var overview: some View {
    SessionOverviewSheet(externalSessionId: run.activeSessionIdentity?.externalSessionId ?? run.liveExternalSessionId,
      provider: (run.activeSessionIdentity?.providerId ?? run.chosenProvider?.id).map(ConnectionCopy.providerLabel),
      host: (run.targetScope ?? model.targetCoordinator.selectedScope).label, cwd: projectCwd,
      turns: completedTurns.map(SessionOverviewTurn.completed) + (run.prompt != nil ? [.focused(run)] : []))
  }

  private var sessionContext: String {
    let value = ConversationCopy.context(project: projectCwd?.split(separator: "/").last.map(String.init),
                                         provider: run.chosenProvider?.label.components(separatedBy: " · ").first)
    if !value.isEmpty { return value }
    return run.hasConnection ? ConversationCopy.pairedMac : ConversationCopy.disconnected
  }

  // Design A: this run's state in one line above the composer, most urgent first.
  private var status: SessionStatusLine? {
    if !paired { return .offline }
    if let focused = SessionStatusLine.focusedRun(run, onAnswer: { model.showRunQuestion = true },
                                                  onStop: { confirmStop = true }) {
      return focused
    }
    if !runBusy, run.chosen == nil || run.chosenProvider == nil {
      return .init(text: ConnectionCopy.chooseTaskContext)
    }
    if !runBusy, let notice = run.providerControlsNotice {
      return .init(text: notice, busy: run.providerControlsLoading,
                   action: run.providerControlsLoading ? nil : .init(title: run.controlsReady ? ConnectionCopy.refreshProviderControls : ConnectionCopy.retry, perform: run.retryProviderControls))
    }
    return nil
  }

  private var footer: some View {
    VStack(alignment: .leading, spacing: 6) {
      MessageComposer(text: composer.text, attachments: composer.attachments,
                      placeholder: !paired ? ConversationCopy.connectedInput : runBusy ? ConversationCopy.busyInput : ConversationCopy.followUpInput,
                      disabled: !paired,
                      sendDisabled: runBusy || run.chosen == nil || !run.controlsReady || draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                      contextLocked: true,
                      modelOptions: run.modelOptions, selectedModelId: run.chosenModelId,
                      modelSelectionIssue: run.modelSelectionIssue,
                      onModel: { run.chooseModel($0) },
                      effortOptions: run.effortOptions, selectedEffort: run.chosenEffort,
                      onEffort: { run.chooseEffort($0) },
                      permissionOptions: run.chosenProvider?.permissions ?? [], selectedPermission: run.permissionMode,
                      onPermission: { run.choosePermission($0) },
                      slashCommands: run.slashCommands, slashCommandsLoading: run.slashCommandsLoading,
                      slashCommandsReason: run.slashCommandsReason,
                      onRefreshSlashCommands: {
                        if let providerId = run.chosenProvider?.id, let cwd = run.chosen?.path {
                          run.loadCommands(providerId: providerId, cwd: cwd,
                                           agentProfileId: run.chosenProvider?.agentProfileId, force: true)
                        }
                      }) {
        guard let providerId = run.chosenProvider?.id, let project = run.chosen else { return }
        let payload = attachments.map(\.wireValue)
        let currentDraft = composer
        let accepted: Bool
        if let resume = run.liveExternalSessionId {
          accepted = run.submitFollowUp(prompt: draft, providerId: providerId, agentProfileId: run.chosenProvider?.agentProfileId,
                                       cwd: project.path, resume: resume, attachments: payload)
        } else {
          accepted = run.submit(prompt: draft, providerId: providerId, attachments: payload)
        }
        if accepted {
          currentDraft.wrappedValue = .init()
          latestReadRequest += 1
        }
      }
    }
    .padding(.horizontal, 14).padding(.bottom, 4)
    .background(Palette.main)
  }

}
