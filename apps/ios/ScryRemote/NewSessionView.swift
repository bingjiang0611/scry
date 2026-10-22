import SwiftUI
import RemoteTransport

// v5 · Codex Refined: context is explicit and close to the composer. Project and
// Provider are full-width controls backed only by host-authorized data. The +
// control stages real, bounded image/text attachments for the encrypted request.
struct NewSessionView: View {
  @Environment(\.scenePhase) private var scenePhase
  @State private var controlsVisible = false
  @EnvironmentObject var model: AppModel
  @EnvironmentObject var run: RemoteRunStore
  @EnvironmentObject var targets: ExecutionTargetCoordinator
  private var composer: Binding<AppModel.ComposerDraft> { model.composerDraft(for: .newTask(targets.newTaskScope)) }
  private var draft: String { composer.wrappedValue.text }
  private var attachments: [DraftAttachment] { composer.wrappedValue.attachments }
  @State private var showProjects = false
  @State private var showProviders = false
  @State private var showTargets = false

  private var paired: Bool { run.hasConnection && (targets.newTaskScope.isLocal || run.executionTargetAvailable) }
  private var canSend: Bool {
    paired && !run.isBusy && run.chosen != nil && run.controlsReady &&
      !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
  }

  var body: some View {
    VStack(spacing: 0) {
      RemoteHeader(title: "新任务", subtitle: displayHost,
                   link: model.link, backAction: { model.goBack() }) {
        Color.clear.frame(width: 44, height: 44)
      }
      if !paired { Notice(text: targets.newTaskScope.isLocal ? ConnectionCopy.noGatewayForNewTask : ConnectionCopy.targetUnavailable, warning: true) }
      if let error = run.submitError { Notice(text: error, warning: true) }

      ScrollView {
        VStack(alignment: .leading, spacing: 0) {
          VStack(spacing: 0) {
            contextRow(symbol: Symbol.laptop, eyebrow: ConnectionCopy.executionHost,
                       value: displayHost, enabled: true, connected: nil) { showTargets = true }
            contextRow(symbol: Symbol.folder, eyebrow: "工作目录",
                       value: run.chosen?.label ?? "选择文件夹", enabled: paired) {
              run.loadDirectories(path: run.chosen?.path); showProjects = true
            }
            contextRow(symbol: Symbol.gauge, eyebrow: "PROVIDER",
                       value: run.chosenProvider?.label ?? "选择 Provider", enabled: paired) { showProviders = true }
          }
        }
        .padding(.horizontal, 19).padding(.top, 12).padding(.bottom, 18)
      }
      .scrollIndicators(.hidden)
      .scrollDismissesKeyboard(.interactively)

      if run.chosen == nil || run.chosenProvider == nil {
        Text(run.chosen == nil ? ConnectionCopy.chooseWorkspaceFirst : ConnectionCopy.chooseProviderToSend)
          .font(.system(size: 13)).foregroundStyle(Palette.muted).padding(.horizontal, 20)
          .frame(maxWidth: .infinity, alignment: .leading)
      }
      if run.chosenProvider != nil, let notice = run.providerControlsNotice {
        HStack {
          Text(notice).font(.system(size: 13)).foregroundStyle(Palette.muted)
          if !run.providerControlsLoading {
            Button(run.controlsReady ? ConnectionCopy.refreshProviderControls : ConnectionCopy.retry) { run.retryProviderControls() }
          }
        }
        .padding(.horizontal, 20).frame(maxWidth: .infinity, alignment: .leading)
      }
      MessageComposer(text: composer.text, attachments: composer.attachments,
                      placeholder: paired ? "描述任务，或粘贴错误信息…" : "连接后可输入",
                      disabled: !paired, sendDisabled: !canSend,
                      contextLabel: run.chosenProvider?.label, onContext: { showProviders = true },
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
        guard let providerId = run.chosenProvider?.id else { return }
        let payload = attachments.map(\.wireValue)
        if run.submit(prompt: draft, providerId: providerId, attachments: payload) {
          composer.wrappedValue = .init()
          targets.focusNewTask()
          model.route = .chat
        }
      }
      .padding(.horizontal, 14).padding(.bottom, 4)
      .background(Palette.surface)
      .overlay(alignment: .top) { Rectangle().fill(Palette.line).frame(height: 0.5) }
    }
    .background(Palette.surface)
    // A discovered target can become ready without changing its identity.
    .task(id: paired ? targets.newTaskScope.id : nil) { if paired { run.loadProjects(); run.loadProviders() } }
    .onAppear { controlsVisible = true }
    .onDisappear { controlsVisible = false }
    .onChange(of: scenePhase) { _, phase in
      if phase == .active, controlsVisible, paired, !run.isBusy, !run.providerControlsLoading { run.retryProviderControls() }
    }
    .sheet(isPresented: $showProjects) {
      ProjectPickerSheet { run.chooseProject($0); showProjects = false }
    }
    .sheet(isPresented: $showProviders) {
      ProviderPickerSheet { run.chooseProvider($0); showProviders = false }
    }
    .sheet(isPresented: $showTargets) { targetPicker }
  }

  private var displayHost: String { run.hasConnection ? targets.newTaskScope.label : ConnectionCopy.unconnected }

  private var targetPicker: some View {
    SelectionSheet(title: ConnectionCopy.selectExecutionHost, subtitle: ConnectionCopy.targetPickerSubtitle, onRefresh: {
      Task { await targets.refreshTargets() }
    }) {
      VStack(spacing: 0) {
        SelectionRow(title: targets.localScope.label, detail: ConnectionCopy.localExecutionHost, selected: targets.newTaskScope.isLocal) {
          targets.selectNewTask(targets.localScope); showTargets = false
        }
        ForEach(targets.discoveredTargets) { target in
          SelectionRow(title: target.label, detail: ConnectionCopy.throughGateway,
                       selected: target.id == targets.newTaskScope.id) {
            targets.selectNewTask(target); showTargets = false
          }
        }
      }
    }
  }

  private func contextRow(symbol: String, eyebrow: String, value: String, enabled: Bool,
                          connected: Bool? = nil, action: @escaping () -> Void = {}) -> some View {
    Button(action: action) {
      HStack(spacing: 13) {
        Image(systemName: symbol).font(.system(size: 17)).foregroundStyle(Palette.muted).frame(width: 22)
        VStack(alignment: .leading, spacing: 2) {
          Text(eyebrow).font(.system(size: 9, weight: .semibold)).tracking(0.8).foregroundStyle(Palette.muted)
          Text(value).font(.system(size: 15, weight: .medium)).foregroundStyle(enabled || connected != nil ? Palette.ink : Palette.muted).lineLimit(2)
        }
        Spacer()
        if let connected {
          Circle().fill(connected ? Palette.green : Palette.faint).frame(width: 7, height: 7)
        } else if enabled {
          Image(systemName: Symbol.chevron).font(.system(size: 12, weight: .semibold)).foregroundStyle(Palette.faint)
        }
      }
      .frame(minHeight: 59).contentShape(Rectangle())
    }
    .buttonStyle(.plain).disabled(!enabled)
    .overlay(alignment: .bottom) { Rectangle().fill(Palette.line).frame(height: 1) }
  }
}

extension G0Transport.RunProviderRef {
  // Multiple profiles share a provider ID; SwiftUI row identity must not.
  var selectionId: String { id + "\u{1f}" + (agentProfileId ?? "") }
}
