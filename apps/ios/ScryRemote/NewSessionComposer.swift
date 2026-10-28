import SwiftUI
import RemoteTransport

// The new-session page's composer. It is the home screen's composer (project and
// Provider capsules, attachments, permission, model · effort, send) plus the
// pre-send states the old standalone new-task page reported: submit errors, the
// missing project/Provider hint, Provider control refresh, slash commands, and a
// metadata reload when the app returns to the foreground.
struct NewSessionComposer: View {
  /// Non-nil asks for the keyboard (`MessageComposer.focusTicket`).
  var focusTicket: Int?

  @EnvironmentObject private var model: AppModel
  @Environment(RemoteRunStore.self) private var run
  @Environment(ExecutionTargetCoordinator.self) private var targets
  @Environment(\.scenePhase) private var scenePhase
  @State private var visible = false
  @State private var showProjects = false
  @State private var showProviders = false

  private var composer: Binding<AppModel.ComposerDraft> {
    model.composerDraft(for: .newTask(targets.newTaskScope))
  }
  private var draft: String { composer.wrappedValue.text }
  private var paired: Bool {
    run.hasConnection && (targets.newTaskScope.isLocal || run.executionTargetAvailable)
  }
  private var canSend: Bool {
    paired && !run.isBusy && run.chosen != nil && run.chosenProvider != nil && run.controlsReady &&
      !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      if let error = run.submitError {
        Notice(text: error, warning: true).padding(.horizontal, 4).padding(.bottom, 6)
      }
      if run.chosen == nil || run.chosenProvider == nil {
        Text(run.chosen == nil ? ConnectionCopy.chooseWorkspaceFirst : ConnectionCopy.chooseProviderToSend)
          .font(.system(size: 13)).foregroundStyle(Palette.dim)
          .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 8).padding(.bottom, 6)
      }
      if run.chosenProvider != nil, let notice = run.providerControlsNotice {
        HStack(spacing: 4) {
          Text(notice).font(.system(size: 13)).foregroundStyle(Palette.dim)
          if !run.providerControlsLoading {
            Button(run.controlsReady ? ConnectionCopy.refreshProviderControls : ConnectionCopy.retry) { run.retryProviderControls() }
              .font(.system(size: 13)).frame(minHeight: 44)
          }
        }
        .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 8).padding(.bottom, 6)
      }
      MessageComposer(text: composer.text, attachments: composer.attachments,
                      placeholder: paired ? ConnectionCopy.composerPlaceholder : ConnectionCopy.composerUnavailable,
                      disabled: !paired, sendDisabled: !canSend,
                      projectLabel: run.chosen?.label ?? ConnectionCopy.composerNeedsProject,
                      onProject: { showProjects = true }, providerId: run.chosenProvider?.id,
                      contextLabel: run.chosenProvider?.label ?? ConnectionCopy.composerNeedsProvider,
                      onContext: { showProviders = true },
                      modelOptions: run.modelOptions, selectedModelId: run.chosenModelId,
                      modelSelectionIssue: run.modelSelectionIssue, onModel: { run.chooseModel($0) },
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
                      },
                      focusTicket: focusTicket) { send() }
    }
    .padding(.horizontal, 12).padding(.bottom, 6)
    // A discovered target can become ready without changing its identity.
    .task(id: paired ? targets.newTaskScope.id : nil) { if paired { run.loadProjects(); run.loadProviders() } }
    .onAppear { visible = true }
    .onDisappear { visible = false }
    .onChange(of: scenePhase) { _, phase in
      if phase == .active, visible, paired, !run.isBusy, !run.providerControlsLoading { run.retryProviderControls() }
    }
    .sheet(isPresented: $showProjects) {
      ProjectPickerSheet { run.chooseProject($0); showProjects = false }
    }
    .sheet(isPresented: $showProviders) {
      ProviderPickerSheet { run.chooseProvider($0); showProviders = false }
    }
  }

  private func send() {
    guard let providerId = run.chosenProvider?.id else { return }
    let payload = composer.wrappedValue.attachments.map(\.wireValue)
    if run.submit(prompt: draft, providerId: providerId, attachments: payload) {
      composer.wrappedValue = .init()
      targets.focusNewTask()
      model.route = .chat
    }
  }
}
