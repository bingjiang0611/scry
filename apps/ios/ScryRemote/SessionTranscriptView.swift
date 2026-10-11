import SwiftUI
import RemoteTransport

// A session opened from the list: read-only replay of its past turns PLUS a live
// composer to CONTINUE the conversation. A follow-up resumes the SAME Provider
// session (RemoteRunStore.submitFollowUp with resume = the session id), so the
// run keeps the prior context. It stays honest (CLAUDE.md 证据不能说谎): past
// turns are the host's read of real archived content, the live turn shows the
// REAL lifecycle + streamed output (a possibly-incomplete cache), and nothing is
// fabricated. File diffs still live on the Mac.
// Full text stays inline. Parse archived Markdown off the UI actor and create
// blocks lazily as the reader scrolls, rather than hiding content behind buttons.
private struct HistoryChunkView: View {
  let kind: String
  let text: String
  var result: String?
  @State private var blocks: [ConversationMarkdownBlock]?
  @State private var parsedSource: String?

  @ViewBuilder var body: some View {
    switch kind {
    case "reasoning", "tool", "tool_result", "truncated":
      ConversationChunk(kind: kind, text: text, result: result)
    default:
      Group {
        if let blocks, parsedSource == text {
          ConversationMarkdownText(source: "", parsedBlocks: blocks)
        } else { ProgressView() }
      }
      .task(id: text) {
        let parsed = await ConversationMarkdownParser.parseForReading(text)
        guard !Task.isCancelled else { return }
        blocks = parsed
        parsedSource = text
      }
    }
  }
}

private struct HistoryTurnView: View {
  let turn: G0Transport.RunHistoryTurn
  var body: some View {
    // The conversation owns the lazy layout. Nested lazy stacks estimate whole
    // tall turns independently and can leave the tail viewport empty.
    Group {
      if !turn.userText.isEmpty {
        HStack {
          Spacer(minLength: 40)
          Text(turn.userText)
            .font(.system(size: 16)).lineSpacing(3).textSelection(.enabled)
            .foregroundStyle(Palette.ink).padding(.vertical, 10).padding(.horizontal, 14)
            .frame(maxWidth: 320, alignment: .leading)
            .background(Palette.message, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
        }
      }
      ForEach(ConversationEntry.group(turn.items, id: { index, _ in index }, kind: \.kind, text: \.text)) { entry in
        HistoryChunkView(kind: entry.kind, text: entry.text, result: entry.result)
      }
    }.frame(maxWidth: .infinity, alignment: .leading)
  }
}

// Browsing another session must not reset an unresolved recovery task. Reuse
// the history implementation and protected cache, but never restore its run.
struct ReadOnlySessionTranscriptView: View {
  @EnvironmentObject var model: AppModel
  @StateObject private var history: RemoteRunStore

  init(owner: RemoteRunStore) {
    _history = StateObject(wrappedValue: RemoteRunStore(historyFor: owner))
  }

  var body: some View {
    SessionTranscriptView(readOnly: true)
      .environmentObject(history)
      .onChange(of: history.reachable) { if let ok = history.reachable { model.markReachable(ok) } }
      .onChange(of: history.connectionObservation) { _, observation in model.markObservation(observation) }
  }
}

struct SessionTranscriptView: View {
  var readOnly = false
  @EnvironmentObject var model: AppModel
  @EnvironmentObject var run: RemoteRunStore
  @State private var showFiles = false
  @State private var olderReadRequest = 0
  @State private var showLiveQuestion = false
  @State private var confirmStop: G0Transport.LiveRun?
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
  // A run in this session that this store is not watching: started on the Mac,
  // or left running when the user switched away from it.
  private var otherLive: G0Transport.LiveRun? { readOnly ? nil : run.otherLiveRun(for: sessionIdentity) }
  private var otherLiveQuestion: G0Transport.RunQuestionRequest? { otherLive.flatMap { run.openLiveQuestion($0) } }
  private var runBusy: Bool { run.isBusy || otherLive != nil }
  // Show the detached run's streamed output unless history already holds its
  // turn (a Provider transcript written live); never show both.
  private var detachedLive: G0Transport.LiveRun? {
    guard let live = otherLive, live.origin == "remote", run.detachedRunId == live.runId,
          run.activeSessionIdentity == sessionIdentity else { return nil }
    switch run.history {
    case let .loaded(turns), let .partial(turns):
      if !live.prompt.isEmpty, turns.last?.userText.hasPrefix(live.prompt) == true { return nil }
    default: break
    }
    return live
  }
  private var controlsMatch: Bool {
    guard let session else { return false }
    return run.controlsReady && run.chosenProvider?.id == session.providerId &&
      run.chosenProvider?.agentProfileId == session.agentProfileId
  }
  private var historyAllowsControls: Bool {
    guard run.activeSessionIdentity == sessionIdentity else { return false }
    switch run.history { case .idle, .loading: return false; default: return true }
  }
  private var historyReadyForDisplay: Bool {
    guard run.activeSessionIdentity == sessionIdentity else { return false }
    if case .loaded = run.history { return true }
    if case .partial = run.history { return true }
    if case .empty = run.history { return true }
    return false
  }

  var body: some View {
    VStack(spacing: 0) {
      header
      if let session {
        if run.activeSessionIdentity == sessionIdentity, run.canStop {
          // This device's own live run. Remote runs are not in the Mac
          // RunRegistry, so the host status read would say "not observed".
          Label(run.observationReconnecting ? "连接中断，正在重连 · 运行状态以 Mac 为准"
                  : !run.pendingQuestions.isEmpty ? "等待你的决定"
                  : run.lifecycle == .running ? "运行中" : "主机已派发",
                systemImage: run.observationReconnecting ? "wifi.exclamationmark" : "play.circle.fill")
            .font(.system(size: 12, weight: .medium))
            .foregroundStyle(run.observationReconnecting ? Palette.muted : Palette.blue)
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading).padding(.horizontal, 20)
            .accessibilityIdentifier("session-runtime-status")
        } else if let live = otherLive {
          liveRunBar(live)
        } else if run.liveRunsStatus == .observed {
          Label("未检测到运行", systemImage: "info.circle")
            .font(.system(size: 12, weight: .medium)).foregroundStyle(Palette.muted)
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading).padding(.horizontal, 20)
            .accessibilityIdentifier("session-runtime-status")
        } else {
          SessionRunStatusView(session: session)
        }
      }
      if readOnly {
        Notice(text: "只读历史浏览，不改变旧任务与草稿；请返回恢复任务核对结果后再续聊。", warning: true)
        Button("返回恢复任务") { model.route = .chat }
          .font(.system(size: 13, weight: .semibold)).padding(.vertical, 6)
      }
      if historyReadyForDisplay, run.historyRefreshError != nil {
        Notice(text: "历史更新失败，当前显示已读取内容。详情见右上角菜单。", warning: true)
      }
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
      ConversationScrollView(revision: "\(historyReadyForDisplay)-\(run.historyRevision)-\(completedTurns.count)-\(run.output.count)-\(run.lifecycle)-\(run.detachedOutput.count)", stopFollowingRequest: olderReadRequest) {
        historyBody
        if hasLiveTurn { liveTurn }
        if let live = detachedLive { detachedTurn(live) }
      }
      if !readOnly { footer }
    }
    .background(Palette.surface)
    .sheet(isPresented: $showFiles) {
      if let session { WorkspaceBrowserView(cwd: session.cwd).id(session.cwd) }
    }
    .onChange(of: otherLiveQuestion?.questionId, initial: true) { _, id in showLiveQuestion = id != nil }
    .confirmationDialog(confirmStop?.origin == "mac" ? "停止 Mac 上的这次运行？" : "停止这次运行？",
                        isPresented: Binding(get: { confirmStop != nil }, set: { if !$0 { confirmStop = nil } }),
                        titleVisibility: .visible, presenting: confirmStop) { live in
      Button("停止运行", role: .destructive) { run.stopLiveRun(live) }
    } message: { _ in
      Text("与 Mac 上的停止按钮相同：请求 Agent 停止，结果以 Agent 实际结束为准。")
    }
    .sheet(isPresented: $showLiveQuestion) {
      if let live = otherLive, let request = otherLiveQuestion {
        RemoteQuestionSheet(request: request, submitting: run.liveActionRunId == live.runId, error: run.liveActionError,
          onAnswer: { run.answerLiveQuestion(live, request: request, answers: $0) },
          onCancel: { run.answerLiveQuestion(live, request: request, answers: [:], cancel: true) })
          .id(request.questionId)
      }
    }
    .onAppear {
      guard let s = session else { return }
      // Keep a live run when leaving and re-opening this same session. A
      // different session identity invalidates old history/poll callbacks.
      run.prepareForSession(providerId: s.providerId, cwd: s.cwd, externalSessionId: s.externalSessionId)
      if !readOnly && historyAllowsControls { loadSessionControls() }
      if !readOnly { run.watchHistory(sessionIdentity) }
    }
    .onDisappear { if !readOnly { run.watchHistory(nil); run.followDetached(nil) } }
    .onChange(of: otherLive?.runId, initial: true) { _, _ in run.followDetached(otherLive) }
    .onChange(of: historyAllowsControls) {
      if !readOnly && historyAllowsControls { loadSessionControls() }
    }
    .task(id: sessionIdentity) {
      guard let s = session else { return }
      // The Mac can start another turn after this screen opens. Keep checking
      // while it is visible, including after a terminal/archive transition.
      while !Task.isCancelled {
        try? await Task.sleep(nanoseconds: 3_000_000_000)
        guard !Task.isCancelled else { return }
        // The live-run long-poll already delivers this session's changes.
        if run.historyIsWatched(sessionIdentity) { continue }
        await run.refreshHistory(providerId: s.providerId, cwd: s.cwd,
                                 externalSessionId: s.externalSessionId)
      }
    }
  }

  @ViewBuilder private var historyBody: some View {
    if run.activeSessionIdentity == sessionIdentity, run.historyCapacityLimit {
      Button("加载完整历史（完整字节传输）") {
        if let s = session { run.loadCompleteHistory(providerId: s.providerId, cwd: s.cwd, externalSessionId: s.externalSessionId) }
      }
      .buttonStyle(.borderedProminent)
      .disabled(run.historySyncing)
      .accessibilityHint("明确选择后下载完整历史；不会裁剪内容")
    }
    switch run.activeSessionIdentity == sessionIdentity ? run.history : .loading {
    case .idle, .loading:
      // The detached run's live turn is already real content; a skeleton
      // above it would read as "nothing loaded yet".
      if detachedLive == nil { transcriptLoadingState }
    case let .partial(turns), let .loaded(turns):
      if run.historyOlderBefore != nil {
        Button(run.historySyncing ? "正在读取更早历史…" : "加载更早的完整历史") {
          olderReadRequest += 1
          if let s = session { run.loadOlderHistory(providerId: s.providerId, cwd: s.cwd, externalSessionId: s.externalSessionId) }
        }
        .buttonStyle(.bordered)
        .disabled(run.historySyncing)
        .accessibilityHint("仅读取更早轮次，不会裁剪当前历史")
      }
      // Snapshot ordinals preserve existing view identity when older pages are
      // prepended. They are presentation positions, not canonical turn IDs.
      let first = run.historyPageOffset
      ForEach(first..<(first + turns.count), id: \.self) { ordinal in
        HistoryTurnView(turn: turns[ordinal - first])
      }
      ForEach(completedTurns) { turn in completedTurnView(turn) }
    case .empty:
      ForEach(completedTurns) { turn in completedTurnView(turn) }
      Text("这条会话没有可读取的历史记录，你仍可以在下方继续对话。")
        .font(.system(size: 13)).foregroundStyle(Palette.muted)
        .frame(maxWidth: .infinity, alignment: .leading).padding(.top, 20)
    case .baseUnavailable:
      Text("历史基底当前不可用，并不表示会话没有历史。以下仅显示本机保留的运行记录。")
        .font(.system(size: 13)).foregroundStyle(Palette.muted)
      ForEach(completedTurns) { turn in completedTurnView(turn) }
    case .failed("history_unavailable") where detachedLive != nil:
      // A session this run is creating has no record until the run ends.
      EmptyView()
    case let .failed(reason):
      EmptyState(title: "暂时无法读取会话", detail: reason + "\n已输入的草稿会保留。", symbol: "exclamationmark.triangle")
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
          Circle().fill(Palette.line.opacity(0.5)).frame(width: 12, height: 12)
        }
        VStack(alignment: .leading, spacing: 3) {
          RoundedRectangle(cornerRadius: 4).fill(Palette.line.opacity(0.6)).frame(width: 150, height: 12)
          RoundedRectangle(cornerRadius: 4).fill(Palette.line.opacity(0.35)).frame(width: 105, height: 10)
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
      Button { showFiles = true } label: {
        Image(systemName: "folder").font(.system(size: 18)).frame(width: 44, height: 44)
      }.accessibilityLabel("项目文件与 Diff").disabled(session == nil)
      Menu {
        Section("历史状态") {
          Text(historyStatus)
          if let date = run.historyFetchedAt { Text("上次核对 \(date.formatted(date: .abbreviated, time: .shortened))") }
          if let reason = run.historyRefreshError { Text(reason) }
          if let notice = run.historyStorageNotice { Text(notice) }
        }
        if let s = session {
          Button { run.loadHistory(providerId: s.providerId, cwd: s.cwd, externalSessionId: s.externalSessionId, force: true) } label: {
            Label("刷新会话", systemImage: "arrow.clockwise")
          }
        }
        if !readOnly {
          Button { run.resetRun(); model.route = .newSession } label: { Label("新任务", systemImage: Symbol.compose) }
        }
        Button { model.route = .settings } label: { Label("设置", systemImage: Symbol.gear) }
      } label: {
        Image(systemName: historyIsPartial ? "clock" : Symbol.more)
          .font(.system(size: 17, weight: .medium)).frame(width: 44, height: 44)
      }
      .accessibilityLabel("更多选项，\(historyStatus)")
    }
  }

  private func loadSessionControls() {
    guard let s = session else { return }
    run.loadProviders(preferredId: s.providerId, preferredAgentProfileId: s.agentProfileId)
    run.loadCommands(providerId: s.providerId, cwd: s.cwd, agentProfileId: s.agentProfileId)
  }

  private var historyIsPartial: Bool {
    if case .partial = run.history { return true }
    return run.historyFromCache || run.historyRefreshError != nil
  }

  private var historyStatus: String {
    if let source = run.historyPageSource, run.historyOlderBefore != nil { return "最近完整历史 · \(source) · 可继续加载更早轮次" }
    if case .partial = run.history { return "部分历史 · 完整性尚未核对" }
    if run.historyFromCache { return "本地历史 · 尚未重新核对主机" }
    if run.historySyncing { return "正在读取历史" }
    if run.historyFetchedAt != nil { return "历史快照已核对；文件 diff 需在 Mac 查看" }
    return "历史状态不可用"
  }

  private func projectName(_ cwd: String?) -> String {
    guard let cwd else { return "" }
    return cwd.split(separator: "/").last.map(String.init) ?? cwd
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
      ForEach(ConversationEntry.group(turn.output, id: { $1.id }, kind: \.kind, text: \.text)) { entry in
        ConversationChunk(kind: entry.kind, text: entry.text, result: entry.result)
      }
      if let result = turn.resultSummary { EvidenceChip(symbol: Symbol.gauge, text: "用量 · \(result)") }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }

  private func detachedTurn(_ live: G0Transport.LiveRun) -> some View {
    VStack(alignment: .leading, spacing: 10) {
      if !live.prompt.isEmpty { userBubble(live.prompt, attachments: []) }
      if run.detachedOutput.isEmpty {
        Text("运行中 · 尚无输出内容").font(.system(size: 15)).foregroundStyle(Palette.muted)
      } else {
        ForEach(ConversationEntry.group(run.detachedOutput, id: { $1.id }, kind: \.kind, text: \.text)) { entry in
          ConversationChunk(kind: entry.kind, text: entry.text, result: entry.result)
        }
      }
      Text("以上为主机实时输出的缓存，可能不完整；运行结束后以会话记录为准。")
        .font(.system(size: 11)).foregroundStyle(Palette.muted)
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
        ForEach(ConversationEntry.group(run.output, id: { $1.id }, kind: \.kind, text: \.text)) { entry in
        ConversationChunk(kind: entry.kind, text: entry.text, result: entry.result)
      }
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
                      slashCommands: run.activeSessionIdentity == sessionIdentity && controlsMatch ? run.slashCommands : [],
                      slashCommandsLoading: run.slashCommandsLoading,
                      slashCommandsReason: run.slashCommandsReason,
                      onRefreshSlashCommands: {
                        if let s = session {
                          run.loadCommands(providerId: s.providerId, cwd: s.cwd,
                                           agentProfileId: s.agentProfileId, force: true)
                        }
                      },
                      onStop: run.canStop ? { run.stopRun() } : nil,
                      stopping: run.stopRequesting) {
        guard let s = session else { return }
        if run.submitFollowUp(prompt: draft, providerId: s.providerId, agentProfileId: s.agentProfileId,
                             cwd: s.cwd, resume: s.externalSessionId, attachments: attachments.map(\.wireValue)) {
          composer.wrappedValue = .init()
        }
      }
      if let stopError = run.stopError {
        Text(stopError).font(.system(size: 11)).foregroundStyle(Palette.negative).padding(.horizontal, 5)
      } else if run.stopRequested && run.canStop {
        Text("已请求停止，等待 Mac 上的 Agent 实际结束…")
          .font(.system(size: 11)).foregroundStyle(Palette.muted).padding(.horizontal, 5)
      } else if let live = otherLive {
        Text(live.origin == "mac" ? "此会话正在 Mac 上运行；可先写下一条消息，结束后再发送。"
                                  : "此会话的任务仍在运行；可先写下一条消息，结束后再发送。")
          .font(.system(size: 11)).foregroundStyle(Palette.muted).padding(.horizontal, 5)
      } else if runBusy {
        Text("可先写下一条消息；本轮结果同步完成后再发送。")
          .font(.system(size: 11)).foregroundStyle(Palette.muted).padding(.horizontal, 5)
      } else if !controlsMatch {
        Button("重新读取原 Provider 设置") {
          if let s = session { run.loadProviders(preferredId: s.providerId, preferredAgentProfileId: s.agentProfileId, force: true) }
        }.font(.system(size: 12)).padding(.horizontal, 5)
      }
    }
    .padding(.horizontal, 14).padding(.bottom, 4)
    .background(Palette.surface)
    .overlay(alignment: .top) { Rectangle().fill(Palette.line.opacity(0.7)).frame(height: 0.5) }
  }

  private func liveRunBar(_ live: G0Transport.LiveRun) -> some View {
    let waiting = run.openLiveQuestion(live) != nil
    let origin = live.origin == "mac" ? "Mac 上" : "任务"
    let text = live.state == "stopping" ? "\(origin)正在停止…"
      : waiting ? "\(origin)等待你的决定" : "\(origin)正在运行 · 内容随 Mac 记录更新"
    return VStack(alignment: .leading, spacing: 2) {
      HStack(spacing: 8) {
        Button { if waiting { showLiveQuestion = true } } label: {
          Label(text, systemImage: waiting ? "hand.raised" : "play.circle.fill")
            .font(.system(size: 12, weight: .medium))
            .foregroundStyle(waiting ? Palette.amber : Palette.blue)
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
        }
        .buttonStyle(.plain).accessibilityIdentifier("session-runtime-status")
        if live.state != "stopping" {
          Button(run.liveActionRunId == live.runId ? "请求中…" : "停止") { confirmStop = live }
            .font(.system(size: 12, weight: .semibold)).foregroundStyle(Palette.negative)
            .disabled(run.liveActionRunId != nil)
            .frame(minWidth: 44, minHeight: 44)
            .accessibilityIdentifier("stop-live-run")
        }
      }
      if let error = run.liveActionError {
        Text(error).font(.system(size: 11)).foregroundStyle(Palette.negative)
      }
    }
    .padding(.horizontal, 20)
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
      .background(Palette.message, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
    }
  }

  private var placeholderForState: String {
    switch run.lifecycle {
    case .submitting: return "正在核对提交结果…结果未知时可安全重试"
    case .recorded: return "意图已记录，等待主机派发…（recorded ≠ 已执行）"
    case .dispatched: return "主机已派发，准备执行…"
    case .running: return "运行中 · 尚无输出内容"
    case .failed, .cancelled: return "尚未读取到此运行的输出"
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
    case .failed: return Palette.negative
    case .cancelled, .submitting, .recorded, .dispatched: return Palette.amber
    case .unknown: return Palette.muted
    }
  }
}
