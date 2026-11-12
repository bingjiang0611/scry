import SwiftUI
import RemoteTransport

@main
struct ScryRemoteApp: App {
  @StateObject private var model = AppModel()
  init() {
    #if DEBUG
    RemoteSelfTest.runIfRequested()
    RemoteSelfTest.runCatalogRefreshChecksIfRequested()
    RemoteSelfTest.runHistoryCacheTestIfRequested()
    RemoteSelfTest.runRelayTLSProbeIfRequested()
    RemoteSelfTest.runRunProbeIfRequested()
    RemoteSelfTest.runLiveProviderProbeIfRequested()
    RemoteSelfTest.runDirectoryAttachmentProbeIfRequested()
    RemoteSelfTest.runSessionReadProbeIfRequested()
    RemoteSelfTest.runHistoryContractProbeIfRequested()
    RemoteSelfTest.runNetBenchIfRequested()
    RemoteRunStore.runOpenFlowProbeIfRequested()
    #endif
  }
  var body: some Scene {
    WindowGroup {
      Group {
        #if DEBUG
        if RemoteSelfTest.netBenchRequested {
          Text("netBench running").font(.footnote).foregroundStyle(.secondary)
        } else if let mode = SheetPreview.requestedMode {
          SheetPreview(mode: mode)
        } else {
          RootView()
        }
        #else
        RootView()
        #endif
      }
      .environmentObject(model).environment(model.targetCoordinator)
    }
  }
}

// Routes by real state through the v5 Codex Refined flow. No screen is shown as
// connected unless a real paired transport exchange has proved reachability.
struct RootView: View {
  @EnvironmentObject var model: AppModel
  @Environment(ExecutionTargetCoordinator.self) var targets

  // `.home` keeps the selected store so the waiting-decision banner, its sheet,
  // reachability write-back and resumeRecoveredRun keep the pre-L1 source. The
  // new-session page injects `targets.newTaskStore` for itself.
  private var run: RemoteRunStore { model.route == .newSession ? targets.newTaskStore : targets.selectedStore }
  @Environment(\.scenePhase) private var scenePhase
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var transition = ConversationTransition()
  @State private var viewportWidth: CGFloat = 0

  @ViewBuilder private var routeContent: some View {
    if !model.canShowWorkspace {
      PairView()
    } else {
      switch model.route {
      // One page: launch lands on a new session with the list in a collapsed
      // drawer; `.newSession` only adds the keyboard focus.
      case .home, .newSession: WorkspaceShell(focusComposer: model.route == .newSession)
      case .chat: ChatView()
      case .pair: PairView()
      case .transcript:
        // A session switch inside this route (the waiting-decision banner)
        // must re-run onAppear, which loads and watches the new session.
        let identity = model.openedSession?.identity
        if model.readOnlyTranscript {
          ReadOnlySessionTranscriptView(owner: run).id(identity)
        } else {
          SessionTranscriptView().id(identity)
        }
      case .settings: SettingsView()
      case let .toolPanel(kind): ToolPanelView(kind: kind)
      }
    }
  }

  var body: some View {
    ZStack {
      routeContent
        .transition(Motion.none)
        .animation(nil, value: model.route)
    }
    .environment(run)
    .environment(\.conversationTransition, ConversationTransitionContext(state: transition, route: model.route))
    .overlay { ConversationTransitionOverlay(state: transition) }
    .task(id: transition.ticket) {
      guard let ticket = transition.ticket else { return }
      // Missing destination geometry must not retain captured pixels forever.
      // Normal completion comes from the overlay, never from delaying routing.
      do { try await Task.sleep(for: .seconds(Motion.large * 3)) }
      catch { return }
      if transition.ticket == ticket { transition.cancel() }
    }
    .onChange(of: model.route) { _, route in
      switch transition.destination {
      case .session: if route != .transcript { transition.cancel() }
      case .submission: if route != .chat { transition.cancel() }
      case nil: break
      }
    }
    .onChange(of: model.openedSession?.identity) { _, identity in
      if case let .session(expected) = transition.destination, identity != expected { transition.cancel() }
    }
    .onChange(of: run.activeSessionIdentity) { _, identity in
      if case let .submission(expected) = transition.destination, identity != expected { transition.cancel() }
    }
    .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width in
      if viewportWidth != 0, viewportWidth != width { transition.cancel() }
      viewportWidth = width
    }
    .foregroundStyle(Palette.fg)
    .background(Palette.main.ignoresSafeArea())
    .tint(Palette.accent)
    .safeAreaInset(edge: .top, spacing: 0) {
      // A screen that shows the focused run puts this in its status strip instead.
      if model.canShowWorkspace, !run.pendingQuestions.isEmpty, !model.showRunQuestion, !focusedRunOnScreen {
        Button { model.showRunQuestion = true } label: {
          Label(ConnectionCopy.focusedTaskNeedsDecision, systemImage: "hand.raised")
            .font(.system(size: 14, weight: .semibold)).frame(maxWidth: .infinity, minHeight: 44)
            .background(Palette.warn.opacity(0.12))
        }
      } else if model.canShowWorkspace, let waiting = waitingElsewhere.first, let external = waiting.externalSessionId {
        // A run this screen is not showing waits for a decision (another
        // session, or a run started on the Mac). Open its session to answer.
        Button {
          model.open(OpenedSession(providerId: waiting.providerId, agentProfileId: waiting.agentProfileId, cwd: waiting.cwd,
                                   externalSessionId: external, label: waiting.prompt, isActive: true,
                                   scope: targets.selectedScope.isLocal ? nil : targets.selectedScope), run: run)
        } label: {
          Label(ConnectionCopy.otherTasksNeedDecision(waitingElsewhere.count), systemImage: "hand.raised")
            .font(.system(size: 14, weight: .semibold)).frame(maxWidth: .infinity, minHeight: 44)
            .background(Palette.warn.opacity(0.12))
        }
      }
    }
    // Questions belong to the run, not a particular route. Returning home or
    // continuing an archived conversation must never hide a waiting request.
    .onChange(of: run.focusedQuestionIdentity) { _, id in model.showRunQuestion = model.canShowWorkspace && id != nil }
    .sheet(isPresented: Binding(get: { model.canShowWorkspace && model.showRunQuestion }, set: { model.showRunQuestion = $0 })) {
      if model.canShowWorkspace, let request = run.pendingQuestions.first {
        RemoteQuestionSheet(request: request, subtitle: SheetCopy.context(title: questionSessionTitle,
          provider: (request.providerId ?? run.activeSessionIdentity?.providerId).map(ConnectionCopy.providerLabel)),
          submitting: run.questionAnswering, error: run.questionError,
          onAnswer: { if model.canShowWorkspace { run.answerPendingQuestion(answers: $0) } },
          onCancel: { if model.canShowWorkspace { run.answerPendingQuestion(answers: [:], cancel: true) } })
          .id(run.questionIdentity(request))
      }
    }
    .simultaneousGesture(
      DragGesture(minimumDistance: 18)
        .onEnded { value in
          // `.home`/`.newSession` are the drawer's own page: WorkspaceShell turns
          // an edge swipe into the drawer instead of navigating back.
          guard model.canGoBack, model.route != .newSession, value.startLocation.x <= 24 else { return }
          let horizontal = value.translation.width
          let vertical = abs(value.translation.height)
          if horizontal > 72 && horizontal > vertical * 1.35 { model.goBack() }
        }
    )
    // Route replacement can remove a focused TextField while the system is
    // resizing for its keyboard. An implicit animation of the entire root
    // loops SwiftUI layout on iOS 26.5; keep page replacement unanimated.
    .animation(reduceMotion ? nil : Motion.animation(.page, reduceMotion: false), value: model.canShowWorkspace)
    // The run channel is the honest source of reachability: reflect a real
    // successful/failed host exchange into the paired link status so the UI never
    // shows "offline" while sending actually works.
    .onChange(of: run.reachable) { if run.targetScope == nil, let ok = run.reachable { model.markReachable(ok) } }
    .onChange(of: run.connectionObservation) { _, observation in if run.targetScope == nil { model.markObservation(observation) } }
    .onChange(of: run.liveExternalSessionId) {
      if let external = run.liveExternalSessionId, let identity = run.activeSessionIdentity {
        model.bindDraft(externalSessionId: external, to: identity)
      }
    }
    // iOS suspends sockets in the background; drop tunnels explicitly so the
    // next request opens a fresh one instead of waiting on a dead connection.
    .onChange(of: scenePhase) { _, phase in
      switch phase {
      case .background:
        transition.cancel()
        targets.backgrounded()
        Task {
          await RemoteSessionRegistry.shared.setForeground(false)
          await RemoteSessionRegistry.shared.resetAll()
        }
      case .active:
        Task { await RemoteSessionRegistry.shared.setForeground(true) }
        if model.canShowWorkspace { targets.foregrounded() }
      default: break
      }
    }
    .onChange(of: model.canShowWorkspace) { paired in
      model.showRunQuestion = paired && !run.pendingQuestions.isEmpty
      if paired { resumeRecoveredRun(); targets.foregrounded() } else { targets.backgrounded() }
    }
    .onAppear {
      // onChange(of: scenePhase) does not fire for the launch phase.
      let launchedActive = scenePhase == .active
      Task { await RemoteSessionRegistry.shared.setForeground(launchedActive) }
      #if DEBUG
      model.applyUIPreviewArguments(runStore: run)
      run.applyUIPreviewArguments()
      let arguments = ProcessInfo.processInfo.arguments
      if arguments.contains("-uiPreview"), arguments.contains("-uiMockData"), arguments.contains("-uiDraftAttachments") {
        // In-memory fixture for removal/reindexing through the real composer.
        model.composerDraft(for: .newTask(targets.newTaskScope)).wrappedValue.attachments = [
          DraftAttachment(kind: .text, name: "a.txt", mimeType: "text/plain", data: Data("first".utf8)),
          DraftAttachment(kind: .text, name: "b.txt", mimeType: "text/plain", data: Data("second".utf8))
        ]
      }
      #endif
      resumeRecoveredRun()
      if model.canShowWorkspace { targets.foregrounded() }
    }
  }

  private var questionSessionTitle: String? {
    if let session = model.openedSession, session.identity == run.activeSessionIdentity { return session.label }
    guard let identity = run.activeSessionIdentity else { return nil }
    return run.completedTurns(for: identity, historyRendered: false).first?.prompt ?? run.prompt
  }

  // ChatView always shows the focused run; a transcript shows it when the run
  // belongs to the opened session (SessionTranscriptView's status strip).
  private var focusedRunOnScreen: Bool {
    switch model.route {
    case .chat: return true
    case .transcript:
      guard !model.readOnlyTranscript, let s = model.openedSession else { return false }
      return run.activeSessionIdentity == s.identity
    default: return false
    }
  }

  // Waiting runs other than the one the current transcript already presents.
  private var waitingElsewhere: [G0Transport.LiveRun] {
    let shown = model.route == .transcript ? model.openedSession : nil
    return run.waitingLiveRuns.filter { live in
      guard let shown else { return true }
      return !(live.providerId == shown.providerId && live.agentProfileId == shown.agentProfileId && live.cwd == shown.cwd && live.externalSessionId == shown.externalSessionId)
    }
  }

  private func resumeRecoveredRun() {
    #if DEBUG
    // A visual fixture is not a recoverable run. Keep the requested route so
    // transcript/new-task checks do not silently exercise ChatView instead.
    guard !ProcessInfo.processInfo.arguments.contains("-uiPreview") else { return }
    #endif
    if model.canShowWorkspace, run.hasRecoverableRun { model.route = .chat }
  }
}
