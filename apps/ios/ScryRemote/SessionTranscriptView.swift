import SwiftUI
import RemoteTransport

// A session opened from the list: read-only replay of its past turns PLUS a live
// composer to CONTINUE the conversation. A follow-up resumes the SAME Provider
// session (RemoteRunStore.submitFollowUp with resume = the session id), so the
// run keeps the prior context. It stays honest (CLAUDE.md 证据不能说谎): past
// turns are the host's read of real archived content, the live turn shows the
// REAL lifecycle + streamed output (a possibly-incomplete cache), and nothing is
// fabricated. File diffs still live on the Mac.
struct SessionTranscriptView: View {
  @EnvironmentObject var model: AppModel
  @EnvironmentObject var run: RemoteRunStore
  private var composer: Binding<AppModel.ComposerDraft> {
    model.composerDraft(for: sessionIdentity.map(AppModel.DraftKey.conversation) ?? .newTask)
  }
  private var draft: String { composer.wrappedValue.text }
  private var attachments: [DraftAttachment] { composer.wrappedValue.attachments }

  private var session: OpenedSession? { model.openedSession }
  private var hasLiveTurn: Bool { run.prompt != nil }
  private var sessionIdentity: RemoteRunStore.SessionIdentity? {
    guard let s = session else { return nil }
    return .opened(providerId: s.providerId, cwd: s.cwd, externalSessionId: s.externalSessionId)
  }
  private var completedTurns: [RemoteRunStore.CompletedLiveTurn] {
    guard let identity = sessionIdentity else { return [] }
    return run.completedTurns(for: identity)
  }
  private var runBusy: Bool { run.isBusy }
  private var controlsMatch: Bool {
    guard let session else { return false }
    return run.controlsReady && run.chosenProvider?.id == session.providerId &&
      run.chosenProvider?.agentProfileId == session.agentProfileId
  }
  private var historyReadyForDisplay: Bool {
    if case .loaded = run.history { return true }
    if case .empty = run.history { return true }
    return false
  }

  var body: some View {
    VStack(spacing: 0) {
      header
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
      ConversationScrollView(revision: "\(historyReadyForDisplay)-\(completedTurns.count)-\(run.output.count)-\(run.lifecycle)") {
        historyBody
        if hasLiveTurn { liveTurn }
      }
      footer
    }
    .background(Palette.surface)
    .onAppear {
      guard let s = session else { return }
      // Keep a live run when leaving and re-opening this same session. A
      // different session identity invalidates old history/poll callbacks.
      run.prepareForSession(providerId: s.providerId, cwd: s.cwd, externalSessionId: s.externalSessionId)
      run.loadProviders(preferredId: s.providerId, preferredAgentProfileId: s.agentProfileId)
      run.loadCommands(providerId: s.providerId, cwd: s.cwd, agentProfileId: s.agentProfileId)
    }
    .task(id: session?.externalSessionId) {
      guard let s = session, s.isActive else { return }
      var active = true
      while active && !Task.isCancelled {
        try? await Task.sleep(nanoseconds: 1_500_000_000)
        guard !Task.isCancelled else { return }
        active = await run.refreshMacSession(providerId: s.providerId, cwd: s.cwd,
                                             externalSessionId: s.externalSessionId)
        if !active {
          // The catalog can flip to terminal just before the archive rename.
          // Give that atomic commit one beat, then fetch the final durable turn.
          try? await Task.sleep(nanoseconds: 1_000_000_000)
          if !Task.isCancelled {
            run.loadHistory(providerId: s.providerId, cwd: s.cwd,
                            externalSessionId: s.externalSessionId, force: true)
          }
        }
      }
    }
  }

  @ViewBuilder private var historyBody: some View {
    switch run.history {
    case .idle, .loading:
      transcriptLoadingState
    case let .loaded(turns):
      ForEach(Array(turns.enumerated()), id: \.offset) { _, turn in turnView(turn) }
      ForEach(completedTurns) { turn in completedTurnView(turn) }
      Text("以上为主机读取的历史记录，可能不完整；文件 diff 需在 Mac 上查看。")
        .font(.system(size: 10)).foregroundStyle(Palette.muted)
        .frame(maxWidth: .infinity, alignment: .leading)
    case .empty:
      ForEach(completedTurns) { turn in completedTurnView(turn) }
      Text("这条会话没有可读取的历史记录，你仍可以在下方继续对话。")
        .font(.system(size: 13)).foregroundStyle(Palette.muted)
        .frame(maxWidth: .infinity, alignment: .leading).padding(.top, 20)
    case let .failed(reason):
      EmptyState(title: "暂时无法读取会话", detail: "请确认 Mac 的 Scry 正在运行且网络可用。已输入的草稿会保留。", symbol: "wifi.exclamationmark")
      Button("重新读取") {
        if let s = session {
          run.loadHistory(providerId: s.providerId, cwd: s.cwd, externalSessionId: s.externalSessionId, force: true)
        }
      }
      .buttonStyle(.borderedProminent).frame(maxWidth: .infinity)
      DisclosureGroup("错误详情") { Text(reason).font(.caption).textSelection(.enabled) }
        .font(.caption).foregroundStyle(Palette.muted)
      ForEach(completedTurns) { turn in completedTurnView(turn) }
    }
  }

  private var transcriptLoadingState: some View {
    VStack(alignment: .leading, spacing: 22) {
      HStack(spacing: 12) {
        ZStack {
          Circle().fill(Palette.blue.opacity(0.08)).frame(width: 34, height: 34)
          ProgressView().controlSize(.small).tint(Palette.blue)
        }
        VStack(alignment: .leading, spacing: 3) {
          Text("正在同步会话")
            .font(.system(size: 14, weight: .semibold))
            .foregroundStyle(Palette.ink)
          Text("从已配对的 Mac 安全读取历史记录")
            .font(.system(size: 11.5))
            .foregroundStyle(Palette.muted)
        }
      }
      .padding(.vertical, 12).padding(.horizontal, 13)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(Palette.canvas.opacity(0.82), in: RoundedRectangle(cornerRadius: 14, style: .continuous))

      VStack(alignment: .leading, spacing: 18) {
        HStack {
          Spacer(minLength: 72)
          RoundedRectangle(cornerRadius: 17, style: .continuous)
            .fill(Palette.canvas)
            .frame(height: 58)
        }
        VStack(alignment: .leading, spacing: 10) {
          RoundedRectangle(cornerRadius: 4).fill(Palette.line).frame(width: 174, height: 10)
          RoundedRectangle(cornerRadius: 4).fill(Palette.line).frame(maxWidth: .infinity).frame(height: 10)
          RoundedRectangle(cornerRadius: 4).fill(Palette.line).frame(width: 236, height: 10)
        }
      }
      .accessibilityHidden(true)
      .opacity(0.72)
    }
    .padding(.top, 8)
    .frame(maxWidth: .infinity, alignment: .leading)
  }

  private var header: some View {
    RemoteHeader(title: session?.label.isEmpty == false ? session!.label : "会话",
                 subtitle: "\(projectName(session?.cwd)) · \(session?.providerId.uppercased() ?? "")",
                 link: model.link, backAction: { model.goBack() }) {
      Menu {
        if let s = session {
          Button { run.loadHistory(providerId: s.providerId, cwd: s.cwd, externalSessionId: s.externalSessionId, force: true) } label: {
            Label("刷新会话", systemImage: "arrow.clockwise")
          }
        }
        Button { run.resetRun(); model.route = .newSession } label: { Label("新任务", systemImage: Symbol.compose) }
        Button { model.route = .settings } label: { Label("设置", systemImage: Symbol.gear) }
      } label: {
        Image(systemName: Symbol.more).font(.system(size: 17, weight: .medium)).frame(width: 44, height: 44)
      }
    }
  }

  private func projectName(_ cwd: String?) -> String {
    guard let cwd else { return "" }
    return cwd.split(separator: "/").last.map(String.init) ?? cwd
  }

  private func turnView(_ turn: G0Transport.RunHistoryTurn) -> some View {
    VStack(alignment: .leading, spacing: 10) {
      if !turn.userText.isEmpty { userBubble(turn.userText) }
      ForEach(Array(turn.items.enumerated()), id: \.offset) { _, item in ConversationChunk(kind: item.kind, text: item.text) }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }

  // The in-progress follow-up: user bubble + honest lifecycle + streamed output.
  private func completedTurnView(_ turn: RemoteRunStore.CompletedLiveTurn) -> some View {
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

  private var liveTurn: some View {
    VStack(alignment: .leading, spacing: 10) {
      if let prompt = run.prompt { userBubble(prompt, attachments: run.sentAttachments) }
      HStack(spacing: 8) {
        Circle().fill(stateColor).frame(width: 7, height: 7)
        Text(stateLabel).font(.system(size: 12, weight: .medium)).foregroundStyle(Palette.muted)
        if run.lifecycle == .running { ProgressView().controlSize(.mini) }
      }
      if run.output.isEmpty {
        Text(placeholderForState).font(.system(size: 15)).foregroundStyle(Palette.muted)
      } else {
        ForEach(run.output) { line in ConversationChunk(kind: line.kind, text: line.text) }
      }
      if let result = run.resultSummary { EvidenceChip(symbol: Symbol.gauge, text: "用量 · \(result)") }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }

  private var footer: some View {
    VStack(alignment: .leading, spacing: 5) {
      MessageComposer(text: composer.text, attachments: composer.attachments,
                      placeholder: "继续这段对话…", disabled: !run.hasConnection,
                      sendDisabled: runBusy || !controlsMatch || draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                      contextLabel: run.chosenProvider?.label ?? session?.providerId.uppercased(), contextLocked: true,
                      modelOptions: run.modelOptions, selectedModelId: run.chosenModelId,
                      onModel: { run.chooseModel($0) },
                      effortOptions: run.effortOptions, selectedEffort: run.chosenEffort,
                      onEffort: { run.chooseEffort($0) },
                      permissionOptions: run.chosenProvider?.permissions ?? [], selectedPermission: run.permissionMode,
                      onPermission: { run.choosePermission($0) },
                      slashCommands: run.slashCommands, slashCommandsLoading: run.slashCommandsLoading,
                      slashCommandsReason: run.slashCommandsReason,
                      onRefreshSlashCommands: {
                        if let s = session {
                          run.loadCommands(providerId: s.providerId, cwd: s.cwd,
                                           agentProfileId: s.agentProfileId, force: true)
                        }
                      }) {
        guard let s = session else { return }
        if run.submitFollowUp(prompt: draft, providerId: s.providerId, agentProfileId: s.agentProfileId,
                             cwd: s.cwd, resume: s.externalSessionId, attachments: attachments.map(\.wireValue)) {
          composer.wrappedValue = .init()
        }
      }
      if runBusy {
        Text("可先写下一条消息；本轮结果同步完成后再发送。")
          .font(.system(size: 11)).foregroundStyle(Palette.muted).padding(.horizontal, 5)
      } else if !controlsMatch {
        Button("重新读取原 Provider 设置") {
          if let s = session { run.loadProviders(preferredId: s.providerId, preferredAgentProfileId: s.agentProfileId, force: true) }
        }.font(.system(size: 12)).padding(.horizontal, 5)
      }
    }
    .padding(.horizontal, 14).padding(.top, 7).padding(.bottom, 8)
    .background(Palette.surface)
    .overlay(alignment: .top) { Rectangle().fill(Palette.line.opacity(0.7)).frame(height: 0.5) }
  }

  private func userBubble(_ text: String, attachments: [RemoteRunStore.SentAttachment] = []) -> some View {
    HStack {
      Spacer(minLength: 40)
      VStack(alignment: .leading, spacing: 8) {
        ForEach(attachments) { item in
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
