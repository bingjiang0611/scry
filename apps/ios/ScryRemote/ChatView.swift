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
  @EnvironmentObject var model: AppModel
  @EnvironmentObject var run: RemoteRunStore
  @State private var showFiles = false
  @State private var latestReadRequest = 0
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
              EmptyState(title: "开始一段新会话",
                         detail: "你发送的消息会在这里显示；Agent 的执行状态与输出从主机实时读取，不沿用其他会话。")
            } else {
              ForEach(completedTurns) { turn in CompletedTurnView(turn: turn) }
              if run.prompt != nil { FocusedTurnView() }
            }
      }
      .id(run.activeSessionIdentity)
      if let status { SessionStatusStrip(status: status) }
      footer
    }
    .background(Palette.surface)
    .sheet(isPresented: $showFiles) {
      if let projectCwd { WorkspaceBrowserView(cwd: projectCwd).id(projectCwd) }
    }
    .macLocalLinks(cwd: projectCwd)
    .confirmationDialog("停止这次运行？", isPresented: $confirmStop, titleVisibility: .visible) {
      Button("停止运行", role: .destructive) { run.stopRun() }
    } message: {
      Text("请求 Agent 停止，结果以 Agent 实际结束为准。")
    }
    .onAppear { run.loadActiveContext() }
#if DEBUG
    .onAppear {
      if draft.isEmpty, ProcessInfo.processInfo.arguments.contains("-uiMockSlash") { composer.wrappedValue.text = "/" }
    }
#endif
  }

  private var header: some View {
    RemoteHeader(title: completedTurns.first?.prompt ?? run.prompt ?? ConnectionCopy.session,
                 subtitle: sessionContext, link: model.link, titleLineLimit: 2,
                 backAction: { model.goBack() }) {
      Button { showFiles = true } label: {
        Image(systemName: "folder").font(.system(size: 18)).frame(width: 44, height: 44)
      }.accessibilityLabel(ConnectionCopy.projectFilesAndDiff).disabled(projectCwd == nil)
      MoreMenu {
        // Leaving keeps an unsent message sending and a run running on the Mac.
        Button { if model.targetCoordinator.beginNewTask(scope: model.targetCoordinator.selectedScope) { model.route = .newSession } } label: { Label("新任务", systemImage: Symbol.compose) }
        Button { model.route = .settings } label: { Label("设置", systemImage: Symbol.gear) }
      }
    }
  }

  private var sessionContext: String {
    let value = [run.chosen?.label, run.chosenProvider?.label].compactMap { $0 }.joined(separator: " · ")
    if !value.isEmpty { return value }
    return run.hasConnection ? "已配对的 Mac" : "未连接"
  }

  // Design A: this run's state in one line above the composer, most urgent first.
  private var status: SessionStatusLine? {
    if !paired { return .offline }
    if let focused = SessionStatusLine.focusedRun(run, onAnswer: { model.showRunQuestion = true },
                                                  onStop: { confirmStop = true }) {
      return focused
    }
    if !runBusy, run.chosen == nil || run.chosenProvider == nil {
      return .init(text: "发送前请在“新任务”中选择项目与 Provider")
    }
    return nil
  }

  private var footer: some View {
    VStack(alignment: .leading, spacing: 6) {
      MessageComposer(text: composer.text, attachments: composer.attachments,
                      placeholder: !paired ? "连接后可输入" : runBusy ? "运行结束后可发送，先写也行" : "继续这段对话…",
                      disabled: !paired,
                      sendDisabled: runBusy || run.chosen == nil || !run.controlsReady || draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                      contextLabel: run.chosenProvider?.label, contextLocked: true,
                      modelOptions: run.modelOptions, selectedModelId: run.chosenModelId,
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
    .background(Palette.surface)
    .overlay(alignment: .top) { Rectangle().fill(Palette.line.opacity(0.7)).frame(height: 0.5) }
  }

}

struct RemoteQuestionSheet: View {
  let request: G0Transport.RunQuestionRequest
  let submitting: Bool
  let error: String?
  let onAnswer: ([String: String]) -> Void
  let onCancel: () -> Void

  @State private var answers: [String: String]
  @State private var selections: [String: Set<String>]

  init(request: G0Transport.RunQuestionRequest, submitting: Bool, error: String?,
       onAnswer: @escaping ([String: String]) -> Void, onCancel: @escaping () -> Void) {
    self.request = request
    self.submitting = submitting
    self.error = error
    self.onAnswer = onAnswer
    self.onCancel = onCancel
    _answers = State(initialValue: [:])
    _selections = State(initialValue: [:])
  }

  private var complete: Bool {
    request.questions.allSatisfy { question in
      if question.multiSelect { return !(selections[question.question] ?? []).isEmpty }
      return !(answers[question.question] ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
  }

  private var resolvedAnswers: [String: String] {
    var resolved = answers
    for question in request.questions where question.multiSelect {
      let selected = selections[question.question] ?? []
      resolved[question.question] = question.options.map(\.label).filter(selected.contains).joined(separator: ", ")
    }
    return resolved
  }

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 20) {
          Text(request.questionKind == "permission" ? "Provider 请求授权" : "Provider 需要输入")
            .font(.headline)
          ForEach(Array(request.questions.enumerated()), id: \.offset) { _, question in
            VStack(alignment: .leading, spacing: 10) {
              if !question.header.isEmpty && !question.question.contains(question.header) {
                Text(question.header).font(.caption.weight(.semibold)).foregroundStyle(Palette.muted)
              }
              Text(question.question).font(.body.weight(.medium))
              if question.inputMode != nil {
                if question.inputMode == "multiline" {
                  TextEditor(text: textBinding(question.question))
                    .frame(minHeight: 120).padding(8)
                    .background(Palette.canvas).clipShape(RoundedRectangle(cornerRadius: 10))
                } else {
                  TextField("请输入", text: textBinding(question.question))
                    .textFieldStyle(.roundedBorder)
                }
              } else if question.multiSelect {
                ForEach(question.options, id: \.label) { option in
                  Button {
                    var selected = selections[question.question] ?? []
                    if selected.contains(option.label) { selected.remove(option.label) } else { selected.insert(option.label) }
                    selections[question.question] = selected
                  } label: {
                    optionRow(option, selected: (selections[question.question] ?? []).contains(option.label),
                              symbol: (selections[question.question] ?? []).contains(option.label) ? "checkmark.square.fill" : "square")
                  }
                  .buttonStyle(.plain)
                }
              } else {
                // Every option visible at once, one tap to choose (as on the Mac).
                ForEach(question.options, id: \.label) { option in
                  Button { answers[question.question] = option.label } label: {
                    optionRow(option, selected: answers[question.question] == option.label,
                              symbol: answers[question.question] == option.label ? "largecircle.fill.circle" : "circle")
                  }
                  .buttonStyle(.plain)
                  .accessibilityAddTraits(answers[question.question] == option.label ? .isSelected : [])
                }
              }
            }
          }
          if let error { Text(error).font(.caption).foregroundStyle(Palette.negative) }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(20)
      }
      .navigationTitle("需要你的决定")
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("取消请求", action: onCancel).disabled(submitting)
        }
        ToolbarItem(placement: .confirmationAction) {
          Button(submitting ? "提交中…" : "提交") { onAnswer(resolvedAnswers) }
            .disabled(submitting || !complete)
        }
      }
    }
  }

  private func textBinding(_ key: String) -> Binding<String> {
    Binding(get: { answers[key] ?? "" }, set: { answers[key] = $0 })
  }

  private func optionLabel(_ option: G0Transport.RunQuestionOption) -> some View {
    VStack(alignment: .leading, spacing: 3) {
      Text(option.label).foregroundStyle(Palette.ink)
      if !option.description.isEmpty {
        Text(option.description).font(.caption).foregroundStyle(Palette.muted)
      }
      if let preview = option.preview { Text(preview).font(.caption.monospaced()).foregroundStyle(Palette.muted) }
    }
  }

  private func optionRow(_ option: G0Transport.RunQuestionOption, selected: Bool, symbol: String) -> some View {
    HStack(alignment: .top, spacing: 12) {
      Image(systemName: symbol).font(.system(size: 18))
        .foregroundStyle(selected ? Palette.blue : Palette.muted).padding(.top, 1)
      optionLabel(option)
      Spacer(minLength: 0)
    }
    .padding(.horizontal, 14).padding(.vertical, 12)
    .frame(maxWidth: .infinity, minHeight: 48, alignment: .leading)
    .background(Palette.canvas, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
    .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous)
      .stroke(selected ? Palette.blue : Palette.line, lineWidth: selected ? 1.5 : 0.5))
    .contentShape(Rectangle())
  }
}
