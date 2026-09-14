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
    .animation(.easeInOut(duration: 0.2), value: model.route)
    .animation(.easeInOut(duration: 0.2), value: model.signedIn)
    // The run channel is the honest source of reachability: reflect a real
    // successful/failed host exchange into the paired link status so the UI never
    // shows "offline" while sending actually works.
    .onChange(of: run.reachable) { if let ok = run.reachable { model.markReachable(ok) } }
    .onAppear {
      #if DEBUG
      model.applyUIPreviewArguments()
      run.applyUIPreviewArguments()
      #endif
    }
  }
}
