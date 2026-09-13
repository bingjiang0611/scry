import SwiftUI

// v2 新会话: back header, context rows, bottom composer. The project row is a
// picker over the HOST-AUTHORIZED directories only (the phone can never
// authorize a new one; the host re-checks the cwd on submit). Sending records a
// durable intent through RemoteRunClient and routes to the chat view, which
// then renders the real lifecycle + output. Nothing is faked: with no live
// connection the composer is disabled, and a submit error is surfaced verbatim.
struct NewSessionView: View {
  @EnvironmentObject var model: AppModel
  @EnvironmentObject var run: RemoteRunStore
  @State private var draft = ""
  @State private var showProjects = false
  @State private var showProviders = false

  private var paired: Bool { run.hasConnection }
  private var canSend: Bool {
    paired && run.chosen != nil && run.chosenProvider != nil && !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
  }

  var body: some View {
    VStack(spacing: 0) {
      HStack {
        CircleButton(symbol: Symbol.back, label: "返回会话列表") { model.route = .home }
        Spacer()
      }
      .padding(.horizontal, 14)
      .padding(.top, 6)
      .padding(.bottom, 10)
      .frame(minHeight: 62)

      if !paired { Notice(text: "尚未连接 Mac · 无法创建会话。") }
      if let error = run.submitError { Notice(text: error, warning: true) }

      ScrollView {
        VStack(spacing: 0) {
          contextRow(Symbol.laptop, run.hostLabel ?? model.link.host ?? "选择电脑", action: nil)
          contextRow(Symbol.folder, run.chosen?.label ?? "选择项目", action: paired ? { showProjects = true } : nil)
          contextRow(Symbol.gauge, run.chosenProvider?.label ?? "选择 Provider", action: paired ? { showProviders = true } : nil)
        }
        .padding(.top, 56)
        .padding(.horizontal, 24)
      }
      .scrollIndicators(.hidden)

      composer
    }
    .background(Palette.surface)
    .onAppear { if paired { run.loadProjects(); run.loadProviders() } }
    .sheet(isPresented: $showProjects) { projectPicker }
    .sheet(isPresented: $showProviders) { providerPicker }
  }

  private func contextRow(_ symbol: String, _ text: String, action: (() -> Void)?) -> some View {
    Button { action?() } label: {
      HStack(spacing: 13) {
        Image(systemName: symbol).font(.system(size: 18)).foregroundStyle(Color(hex: 0x909193)).frame(width: 21)
        Text(text).font(.system(size: 17)).foregroundStyle(Color(hex: 0x626264)).lineLimit(1)
        Spacer()
        if action != nil {
          Image(systemName: Symbol.chevrons).font(.system(size: 12)).foregroundStyle(Color(hex: 0xC4C4C6))
        }
      }
      .frame(minHeight: 47)
    }
    .disabled(action == nil)
  }

  // Host-authorized project directories only. Three honest states: reading,
  // list, and empty ("手机不能自行授权新目录").
  private var projectPicker: some View {
    NavigationStack {
      Group {
        switch run.projects {
        case .idle, .loading:
          ProgressView("读取主机已授权的项目…").padding()
        case let .loaded(list):
          List(list, id: \.path) { ref in
            Button {
              run.chooseProject(ref); showProjects = false
            } label: {
              VStack(alignment: .leading, spacing: 2) {
                Text(ref.label).font(.system(size: 16)).foregroundStyle(Palette.ink)
                Text(ref.path).font(.system(size: 11)).foregroundStyle(Palette.muted).lineLimit(1)
              }
            }
          }
        case .empty:
          EmptyState(title: "主机上没有已授权的项目",
                     detail: "在 Mac 的 Scry 里用目录选择器授权项目后再试；手机不能自行授权新目录。")
        case let .failed(reason):
          EmptyState(title: "无法读取项目", detail: reason)
        }
      }
      .navigationTitle("选择项目")
      .toolbar {
        ToolbarItem(placement: .cancellationAction) { Button("取消") { showProjects = false } }
        ToolbarItem(placement: .primaryAction) { Button("刷新") { run.loadProjects() } }
      }
    }
    .presentationDetents([.medium, .large])
  }

  // Host-advertised Providers only (available ones). The phone can never invent a
  // Provider; the host re-validates the chosen id on submit. Honest states.
  private var providerPicker: some View {
    NavigationStack {
      Group {
        switch run.providers {
        case .idle, .loading:
          ProgressView("读取主机可用的 Provider…").padding()
        case let .loaded(list):
          List(list, id: \.id) { ref in
            Button {
              run.chooseProvider(ref); showProviders = false
            } label: {
              HStack {
                Text(ref.label).font(.system(size: 16)).foregroundStyle(Palette.ink)
                Spacer()
                if run.chosenProvider?.id == ref.id {
                  Image(systemName: "checkmark").foregroundStyle(Palette.blue)
                }
              }
            }
          }
        case .empty:
          EmptyState(title: "主机没有可用的 Provider",
                     detail: "在 Mac 的 Scry 里登录/配置一个 Provider（如 qoder、claude）后再试。")
        case let .failed(reason):
          EmptyState(title: "无法读取 Provider", detail: reason)
        }
      }
      .navigationTitle("选择 Provider")
      .toolbar {
        ToolbarItem(placement: .cancellationAction) { Button("取消") { showProviders = false } }
        ToolbarItem(placement: .primaryAction) { Button("刷新") { run.loadProviders() } }
      }
    }
    .presentationDetents([.medium, .large])
  }

  private var composer: some View {
    VStack(spacing: 7) {
      TextField(paired ? "在 \(run.hostLabel ?? "Mac") 上工作" : "连接后可输入", text: $draft, axis: .vertical)
        .font(.system(size: 17))
        .lineLimit(1...6)
        .disabled(!paired)
      HStack(spacing: 3) {
        PlainIcon(symbol: Symbol.plus, label: "附件") {}
        PlainIcon(symbol: Symbol.shield, label: "权限模式", tint: Palette.amber) {}
        Spacer()
        PlainIcon(symbol: Symbol.gauge, label: "Provider 和模型") { if paired { showProviders = true } }
        CircleButton(symbol: Symbol.send, label: "发送新任务", filled: true, disabled: !canSend) {
          guard let providerId = run.chosenProvider?.id else { return }
          run.submit(prompt: draft, providerId: providerId)
          draft = ""
          model.route = .chat
        }
      }
    }
    .padding(.horizontal, 13)
    .padding(.top, 12)
    .padding(.bottom, 7)
    .glass(cornerRadius: 28)
    .padding(.horizontal, 11)
    .padding(.bottom, 14)
  }
}
