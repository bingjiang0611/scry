import SwiftUI

@main
struct ScryRemoteApp: App {
  @StateObject private var model = AppModel()
  @StateObject private var runStore = RemoteRunStore()
  init() {
    #if DEBUG
    RemoteSelfTest.runIfRequested()
    RemoteSelfTest.runRelayTLSProbeIfRequested()
    RemoteSelfTest.runRunProbeIfRequested()
    RemoteSelfTest.runLiveProviderProbeIfRequested()
    RemoteSelfTest.runDirectoryAttachmentProbeIfRequested()
    RemoteSelfTest.runSessionReadProbeIfRequested()
    #endif
  }
  var body: some Scene {
    WindowGroup {
      RootView().environmentObject(model).environmentObject(runStore)
    }
  }
}

// Routes by real state through the v5 Codex Refined flow. No screen is shown as
// connected unless a real paired transport exchange has proved reachability.
struct RootView: View {
  @EnvironmentObject var model: AppModel
  @EnvironmentObject var run: RemoteRunStore
  @State private var showQuestion = false

  var body: some View {
    Group {
      if !model.signedIn {
        SignInView()
      } else {
        switch model.route {
        case .home: HomeView()
        case .newSession: NewSessionView()
        case .chat: ChatView()
        case .pair: PairView()
        case .transcript: SessionTranscriptView()
        case .settings: SettingsView()
        }
      }
    }
    .tint(Palette.blue)
    .safeAreaInset(edge: .top, spacing: 0) {
      if model.signedIn, !run.pendingQuestions.isEmpty, !showQuestion {
        Button { showQuestion = true } label: {
          Label("任务正在等待你的决定 · 查看", systemImage: "hand.raised")
            .font(.system(size: 14, weight: .semibold)).frame(maxWidth: .infinity, minHeight: 44)
            .background(Palette.warnBg)
        }
      }
    }
    // Questions belong to the run, not a particular route. Returning home or
    // continuing an archived conversation must never hide a waiting request.
    .onChange(of: run.pendingQuestions.first?.questionId) { _, id in showQuestion = model.signedIn && id != nil }
    .sheet(isPresented: Binding(get: { model.signedIn && showQuestion }, set: { showQuestion = $0 })) {
      if model.signedIn, let request = run.pendingQuestions.first {
        RemoteQuestionSheet(request: request, submitting: run.questionAnswering, error: run.questionError,
          onAnswer: { if model.signedIn { run.answerPendingQuestion(answers: $0) } },
          onCancel: { if model.signedIn { run.answerPendingQuestion(answers: [:], cancel: true) } })
          .id(request.questionId)
      }
    }
    .simultaneousGesture(
      DragGesture(minimumDistance: 18)
        .onEnded { value in
          guard model.canGoBack, value.startLocation.x <= 24 else { return }
          let horizontal = value.translation.width
          let vertical = abs(value.translation.height)
          if horizontal > 72 && horizontal > vertical * 1.35 { model.goBack() }
        }
    )
    .animation(.easeInOut(duration: 0.2), value: model.route)
    .animation(.easeInOut(duration: 0.2), value: model.signedIn)
    // The run channel is the honest source of reachability: reflect a real
    // successful/failed host exchange into the paired link status so the UI never
    // shows "offline" while sending actually works.
    .onChange(of: run.reachable) { if let ok = run.reachable { model.markReachable(ok) } }
    .onChange(of: run.liveExternalSessionId) {
      if let external = run.liveExternalSessionId, let identity = run.activeSessionIdentity {
        model.bindDraft(externalSessionId: external, to: identity)
      }
    }
    .onChange(of: model.signedIn) { signedIn in
      showQuestion = signedIn && !run.pendingQuestions.isEmpty
      if signedIn, run.hasRecoverableRun { model.route = .chat }
    }
    .onAppear {
      #if DEBUG
      model.applyUIPreviewArguments()
      run.applyUIPreviewArguments()
      #endif
      if model.signedIn, run.hasRecoverableRun { model.route = .chat }
    }
  }
}
