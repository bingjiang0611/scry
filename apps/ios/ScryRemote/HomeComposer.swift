import SwiftUI
import RemoteTransport

// Composer-first entry: the home screen's main action is describing a task. The
// project and provider chips are the only required context, and both come from
// the host; sending submits the same durable run intent as the new-task screen.
struct HomeComposer: View {
  @EnvironmentObject var model: AppModel
  @EnvironmentObject var run: RemoteRunStore
  @EnvironmentObject var targets: ExecutionTargetCoordinator
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
    VStack(spacing: 8) {
      contextRow
      if let error = store.submitError {
        Text(error).font(.system(size: 12)).foregroundStyle(Palette.warnInk)
          .frame(maxWidth: .infinity, alignment: .leading)
      }
      MessageComposer(text: composer.text, attachments: composer.attachments,
                      placeholder: paired ? ConnectionCopy.composerPlaceholder : ConnectionCopy.composerUnavailable,
                      disabled: !paired, sendDisabled: !canSend,
                      onSend: send)
    }
    .padding(.horizontal, 14).padding(.top, 8).padding(.bottom, 6)
    .background(Palette.surface)
    .overlay(alignment: .top) { Rectangle().fill(Palette.line).frame(height: 0.5) }
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

  private var contextRow: some View {
    HStack(spacing: 8) {
      chip(symbol: Symbol.folder,
           title: store.chosen?.label ?? ConnectionCopy.composerNeedsProject,
           filled: store.chosen != nil, enabled: paired) { showProjects = true }
      chip(symbol: Symbol.agent,
           title: store.chosenProvider?.label ?? ConnectionCopy.composerNeedsProvider,
           filled: store.chosenProvider != nil, enabled: paired) { showProviders = true }
      Spacer(minLength: 0)
      if targets.aggregatesHosts {
        Text(targets.newTaskScope.label).font(.system(size: 11)).foregroundStyle(Palette.faint).lineLimit(1)
      }
    }
  }

  private func chip(symbol: String, title: String, filled: Bool, enabled: Bool,
                    action: @escaping () -> Void) -> some View {
    Button(action: action) {
      HStack(spacing: 5) {
        Image(systemName: symbol).font(.system(size: 11, weight: .medium))
        Text(title).font(.system(size: 12, weight: .medium)).lineLimit(1)
      }
      .foregroundStyle(filled ? Palette.ink : Palette.muted)
      .padding(.horizontal, 10).frame(minHeight: 30)
      .background(Palette.message, in: Capsule())
    }
    .buttonStyle(.plain).disabled(!enabled)
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
