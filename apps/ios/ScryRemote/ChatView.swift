import SwiftUI
import RemoteTransport

// A conversation view aligned with ChatGPT / Codex mobile: the user's message
// appears immediately as a right-aligned bubble, and the assistant's turn streams
// in below it. It stays honest (CLAUDE.md 证据不能说谎): the assistant turn shows
// the REAL lifecycle (recorded/dispatched/running/settled/failed/cancelled) and
// only the host's REAL streamed output content (a live cache, possibly
// incomplete/truncated). Token/cost come only from the ledger `result` marker.
// Nothing is fabricated; with no active run it shows a truthful empty state.
struct ChatView: View {
  @EnvironmentObject var model: AppModel
  @EnvironmentObject var run: RemoteRunStore
  @State private var draft = ""
  @State private var attachments: [DraftAttachment] = []

  private var paired: Bool { run.hasConnection }
  private var completedTurns: [RemoteRunStore.CompletedLiveTurn] {
    guard let identity = run.activeSessionIdentity else { return [] }
    return run.completedTurns(for: identity)
  }
  private var hasTurn: Bool { !completedTurns.isEmpty || run.prompt != nil || run.runId != nil || run.lifecycle != .unknown }
  private var runBusy: Bool { run.lifecycle == .submitting || run.lifecycle == .recorded || run.lifecycle == .dispatched || run.lifecycle == .running }

  var body: some View {
    VStack(spacing: 0) {
      header
      if !paired { Notice(text: "尚未连接 Mac · 发送已停用。") }
      if let error = run.submitError {
        VStack(alignment: .leading, spacing: 7) {
          Notice(text: error, warning: true)
          if run.retryAvailable {
            Button("重试核对（复用同一 intentId）") { run.retrySubmission() }
              .font(.system(size: 13, weight: .semibold)).padding(.horizontal, 16)
          }
          if run.observationInterrupted {
            Button("重新连接并继续观察") { run.retryObservation() }
              .font(.system(size: 13, weight: .semibold)).padding(.horizontal, 16)
          }
        }
      }
      ScrollViewReader { proxy in
        ScrollView {
          LazyVStack(alignment: .leading, spacing: 18) {
            if !hasTurn {
              EmptyState(title: "开始一段新会话",
                         detail: "你发送的消息会在这里显示；Agent 的执行状态与输出从主机实时读取，不沿用其他会话。")
            } else {
              ForEach(completedTurns) { turn in completedTurn(turn) }
              if let prompt = run.prompt { userBubble(prompt) }
              if run.prompt != nil { assistantTurn }
            }
            Color.clear.frame(height: 1).id("bottom")
          }
          .padding(.horizontal, 18)
          .padding(.top, 14)
          .padding(.bottom, 10)
        }
        .scrollIndicators(.hidden)
        .onChange(of: run.output.count) { proxy.scrollTo("bottom", anchor: .bottom) }
        .onChange(of: run.lifecycle) { proxy.scrollTo("bottom", anchor: .bottom) }
      }
      footer
    }
    .background(Palette.surface)
    .sheet(isPresented: Binding(
      get: { !run.pendingQuestions.isEmpty },
      set: { _ in }
    )) {
      if let request = run.pendingQuestions.first {
        RemoteQuestionSheet(
          request: request,
          submitting: run.questionAnswering,
          error: run.questionError,
          onAnswer: { run.answerPendingQuestion(answers: $0) },
          onCancel: { run.answerPendingQuestion(answers: [:], cancel: true) }
        )
        .interactiveDismissDisabled()
      }
    }
#if DEBUG
    .onAppear {
      if draft.isEmpty, ProcessInfo.processInfo.arguments.contains("-uiMockSlash") { draft = "/" }
    }
#endif
  }

  private var header: some View {
    RemoteHeader(title: "会话", subtitle: sessionContext, link: model.link,
                 backAction: { model.route = .home }) {
      Menu {
        Button { run.resetRun(); model.route = .newSession } label: { Label("新任务", systemImage: Symbol.compose) }
        Button { model.route = .settings } label: { Label("设置", systemImage: Symbol.gear) }
      } label: {
        Image(systemName: Symbol.more).font(.system(size: 17, weight: .medium)).frame(width: 44, height: 44)
      }
    }
  }

  private var sessionContext: String {
    let value = [run.chosen?.label, run.chosenProvider?.label].compactMap { $0 }.joined(separator: " · ")
    if !value.isEmpty { return value }
    return run.hasConnection ? "已配对的 Mac" : "未连接"
  }

  // The user's own message — right-aligned filled bubble, ChatGPT/Codex style.
  private func userBubble(_ text: String, attachments: [RemoteRunStore.SentAttachment]? = nil) -> some View {
    HStack {
      Spacer(minLength: 40)
      VStack(alignment: .leading, spacing: 8) {
        ForEach(attachments ?? run.sentAttachments) { item in
          Label(item.name, systemImage: item.kind == .image ? Symbol.photo : Symbol.file)
            .font(.system(size: 11, weight: .medium)).lineLimit(1)
        }
        Text(text).font(.system(size: 16)).lineSpacing(3).textSelection(.enabled)
      }
      .foregroundStyle(Palette.ink)
      .padding(.vertical, 10).padding(.horizontal, 14)
      .frame(maxWidth: 320, alignment: .leading)
      .background(Color(hex: 0xF0F1F3), in: RoundedRectangle(cornerRadius: 19, style: .continuous))
    }
  }

  private func completedTurn(_ turn: RemoteRunStore.CompletedLiveTurn) -> some View {
    VStack(alignment: .leading, spacing: 10) {
      userBubble(turn.prompt, attachments: turn.attachments)
      HStack(spacing: 8) {
        Circle().fill(turn.lifecycle == .settled ? Palette.green : Palette.negative).frame(width: 7, height: 7)
        Text(turn.lifecycle == .settled ? "已完成" : "运行结束：\(turn.lifecycle.rawValue)")
          .font(.system(size: 12, weight: .medium)).foregroundStyle(Palette.muted)
      }
      ForEach(turn.output) { line in ConversationChunk(kind: line.kind, text: line.text) }
      if let result = turn.resultSummary { EvidenceChip(symbol: Symbol.gauge, text: "用量 · \(result)") }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }

  // The assistant turn: a small state chip, the streamed content, and honest
  // provenance. Left-aligned like an assistant message.
  @ViewBuilder private var assistantTurn: some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack(spacing: 8) {
        Circle().fill(stateColor).frame(width: 7, height: 7)
        Text(stateLabel).font(.system(size: 12, weight: .medium)).foregroundStyle(Palette.muted)
        if run.lifecycle == .running {
          ProgressView().controlSize(.mini)
        }
      }

      if run.output.isEmpty {
        Text(placeholderForState)
          .font(.system(size: 15)).foregroundStyle(Palette.muted)
      } else {
        ForEach(run.output) { line in ConversationChunk(kind: line.kind, text: line.text) }
      }

      if let result = run.resultSummary {
        EvidenceChip(symbol: Symbol.gauge, text: "用量 · \(result)")
      }

      if !run.output.isEmpty || run.lifecycle == .settled {
        Text("以上为主机实时输出的缓存" + (run.truncated ? " · 已达上限，内容被截断" : "，可能不完整；文件 diff 需在主机查看"))
          .font(.system(size: 10)).foregroundStyle(Palette.muted)
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }

  private var footer: some View {
    VStack(alignment: .leading, spacing: 6) {
      MessageComposer(text: $draft, attachments: $attachments,
                      placeholder: paired ? "继续这段对话…" : "连接后可输入",
                      disabled: !paired,
                      sendDisabled: runBusy || run.chosen == nil || run.chosenProvider == nil || draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                      contextLabel: run.chosenProvider?.label,
                      effortOptions: run.chosenProvider?.efforts ?? [], selectedEffort: run.chosenEffort,
                      onEffort: { run.chooseEffort($0) },
                      permissionOptions: run.chosenProvider?.permissions ?? [], selectedPermission: run.permissionMode,
                      onPermission: { run.choosePermission($0) },
                      slashCommands: run.slashCommands, slashCommandsLoading: run.slashCommandsLoading,
                      slashCommandsReason: run.slashCommandsReason,
                      onRefreshSlashCommands: {
                        if let providerId = run.chosenProvider?.id, let cwd = run.chosen?.path {
                          run.loadCommands(providerId: providerId, cwd: cwd, force: true)
                        }
                      }) {
        guard let providerId = run.chosenProvider?.id, let project = run.chosen else { return }
        let payload = attachments.map(\.wireValue)
        if let resume = run.liveExternalSessionId {
          run.submitFollowUp(prompt: draft, providerId: providerId, cwd: project.path, resume: resume, attachments: payload)
        } else {
          run.submit(prompt: draft, providerId: providerId, attachments: payload)
        }
        draft = ""; attachments = []
      }
      if runBusy {
        Text("当前任务结束后才能继续发送。")
          .font(.system(size: 11)).foregroundStyle(Palette.muted).padding(.horizontal, 5)
      } else if run.chosen == nil || run.chosenProvider == nil {
        Text("发送前请在“新任务”中选择项目与 Provider。")
          .font(.system(size: 11)).foregroundStyle(Palette.muted).padding(.horizontal, 5)
      }
    }
    .padding(.horizontal, 14).padding(.top, 7).padding(.bottom, 8)
    .background(Palette.surface)
    .overlay(alignment: .top) { Rectangle().fill(Palette.line.opacity(0.7)).frame(height: 0.5) }
  }

  private var placeholderForState: String {
    switch run.lifecycle {
    case .submitting: return "正在核对提交结果…结果未知时可安全重试"
    case .recorded: return "意图已记录，等待主机派发…（recorded ≠ 已执行）"
    case .dispatched: return "主机已派发，准备执行…"
    case .running: return "运行中 · 尚无输出内容"
    case .failed, .cancelled: return "主机未缓存此运行的输出内容"
    default: return "等待主机…"
    }
  }
  private var stateLabel: String {
    switch run.lifecycle {
    case .unknown: return "等待主机"
    case .submitting: return "提交中 · 结果未知"
    case .recorded: return "意图已记录（未执行）"
    case .dispatched: return "主机已派发"
    case .running: return "运行中"
    case .settled: return "已完成"
    case .failed: return "失败"
    case .cancelled: return "已取消"
    }
  }
  private var stateColor: Color {
    switch run.lifecycle {
    case .settled: return Palette.green
    case .running: return Palette.blue
    case .failed: return Color(hex: 0xB95D60)
    case .cancelled, .submitting, .recorded, .dispatched: return Palette.amber
    case .unknown: return Palette.muted
    }
  }
}

private struct RemoteQuestionSheet: View {
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
              Text(question.header).font(.caption.weight(.semibold)).foregroundStyle(Palette.muted)
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
                    HStack(alignment: .top) {
                      Image(systemName: (selections[question.question] ?? []).contains(option.label) ? "checkmark.square.fill" : "square")
                      optionLabel(option)
                    }
                  }
                  .buttonStyle(.plain)
                }
              } else {
                Picker("请选择", selection: textBinding(question.question)) {
                  Text("请选择").tag("")
                  ForEach(question.options, id: \.label) { option in Text(option.label).tag(option.label) }
                }
                .pickerStyle(.menu)
                if let selected = question.options.first(where: { $0.label == answers[question.question] }) {
                  optionDetail(selected)
                }
              }
            }
          }
          if let error { Text(error).font(.caption).foregroundStyle(Palette.negative) }
        }
        .padding(20)
      }
      .navigationTitle("需要你的决定")
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("取消运行", action: onCancel).disabled(submitting)
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
      Text(option.description).font(.caption).foregroundStyle(Palette.muted)
      if let preview = option.preview { Text(preview).font(.caption.monospaced()).foregroundStyle(Palette.muted) }
    }
  }

  @ViewBuilder private func optionDetail(_ option: G0Transport.RunQuestionOption) -> some View {
    Text(option.description).font(.caption).foregroundStyle(Palette.muted)
    if let preview = option.preview { Text(preview).font(.caption.monospaced()).foregroundStyle(Palette.muted) }
  }
}
