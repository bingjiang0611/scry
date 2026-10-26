import SwiftUI
import RemoteTransport

// Composer-first entry: the home screen's main action is describing a task. The
// project and provider chips are the only required context, and both come from
// the host; sending submits the same durable run intent as the new-task screen.
struct HomeComposer: View {
  @EnvironmentObject var model: AppModel
  @Environment(RemoteRunStore.self) var run
  @Environment(ExecutionTargetCoordinator.self) var targets
  @State private var showProjects = false
  @State private var showProviders = false

  private var store: RemoteRunStore { targets.newTaskStore }
  private var composer: Binding<AppModel.ComposerDraft> {
    model.composerDraft(for: .newTask(targets.newTaskScope))
  }
  private var draft: String { composer.wrappedValue.text }
  private var paired: Bool {
    run.hasConnection && (targets.newTaskScope.isLocal || run.executionTargetAvailable)
  }
  private var canSend: Bool {
    paired && !store.isBusy && store.chosen != nil && store.chosenProvider != nil && store.controlsReady &&
      !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
  }

  var body: some View {
    MessageComposer(text: composer.text, attachments: composer.attachments,
                    placeholder: paired ? ConnectionCopy.composerPlaceholder : ConnectionCopy.composerUnavailable,
                    disabled: !paired, sendDisabled: !canSend,
                    projectLabel: store.chosen?.label ?? ConnectionCopy.composerNeedsProject,
                    onProject: { showProjects = true }, providerId: store.chosenProvider?.id,
                    submissionError: store.submitError,
                    hostLabel: targets.aggregatesHosts ? targets.newTaskScope.label : nil,
                    contextLabel: store.chosenProvider?.label ?? ConnectionCopy.composerNeedsProvider,
                    onContext: { showProviders = true },
                    modelOptions: store.modelOptions, selectedModelId: store.chosenModelId,
                    modelSelectionIssue: store.modelSelectionIssue, onModel: { store.chooseModel($0) },
                    effortOptions: store.effortOptions, selectedEffort: store.chosenEffort,
                    onEffort: { store.chooseEffort($0) },
                    permissionOptions: store.chosenProvider?.permissions ?? [], selectedPermission: store.permissionMode,
                    onPermission: { store.choosePermission($0) },
                    onSend: send)
    .padding(.horizontal, 12).padding(.top, 8).padding(.bottom, 6)
    .task(id: paired) {
      guard paired else { return }
      store.loadProjects()
      store.loadProviders()
    }
    .sheet(isPresented: $showProjects) {
      ProjectPickerSheet { store.chooseProject($0); showProjects = false }
    }
    .sheet(isPresented: $showProviders) {
      ProviderPickerSheet { store.chooseProvider($0); showProviders = false }
    }
  }

  private func send() {
    guard let providerId = store.chosenProvider?.id else { return }
    let payload = composer.wrappedValue.attachments.map(\.wireValue)
    if store.submit(prompt: draft, providerId: providerId, attachments: payload) {
      composer.wrappedValue = .init()
      targets.focusNewTask()
      model.route = .chat
    }
  }
}
