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
  @State private var draft = ""

  private var session: OpenedSession? { model.openedSession }
  private var hasLiveTurn: Bool { run.prompt != nil }

  var body: some View {
    VStack(spacing: 0) {
      header
      if let error = run.submitError { Notice(text: error, warning: true) }
      ScrollViewReader { proxy in
        ScrollView {
          VStack(alignment: .leading, spacing: 18) {
            historyBody
            if hasLiveTurn { liveTurn }
            Color.clear.frame(height: 1).id("bottom")
          }
          .padding(.horizontal, 16)
          .padding(.top, 12)
        }
        .scrollIndicators(.hidden)
        .onChange(of: run.output.count) { withAnimation { proxy.scrollTo("bottom", anchor: .bottom) } }
        .onChange(of: run.lifecycle) { withAnimation { proxy.scrollTo("bottom", anchor: .bottom) } }
      }
      footer
    }
    .background(Palette.surface)
    .onAppear {
      guard let s = session else { return }
      // Fresh view of this session: drop any prior live turn, then replay history.
      run.resetRun()
      run.loadHistory(providerId: s.providerId, cwd: s.cwd, externalSessionId: s.externalSessionId)
    }
  }

  @ViewBuilder private var historyBody: some View {
    switch run.history {
    case .idle, .loading:
      ProgressView("正在读取会话内容…").padding(.top, 32)
    case let .loaded(turns):
      ForEach(Array(turns.enumerated()), id: \.offset) { _, turn in turnView(turn) }
      Text("以上为主机读取的历史记录，可能不完整；文件 diff 需在 Mac 上查看。")
        .font(.system(size: 10)).foregroundStyle(Palette.muted)
        .frame(maxWidth: .infinity, alignment: .leading)
    case .empty:
      Text("这条会话没有可读取的历史记录，你仍可以在下方继续对话。")
        .font(.system(size: 13)).foregroundStyle(Palette.muted)
        .frame(maxWidth: .infinity, alignment: .leading).padding(.top, 20)
    case let .failed(reason):
      EmptyState(title: "无法读取历史记录", detail: reason).padding(.top, 24)
    }
  }

  private var header: some View {
    HStack(spacing: 12) {
      CircleButton(symbol: Symbol.back, label: "返回会话列表") { model.route = .home }
      VStack(alignment: .leading, spacing: 2) {
        Text(session?.label.isEmpty == false ? session!.label : "会话")
          .font(.system(size: 17, weight: .semibold)).lineLimit(1)
        Text("续聊 · \(session?.providerId.uppercased() ?? "")")
          .font(.system(size: 12)).foregroundStyle(Palette.muted).lineLimit(1)
      }
      Spacer()
    }
    .padding(.horizontal, 14).padding(.top, 6).padding(.bottom, 10).frame(minHeight: 66)
  }

  private func turnView(_ turn: G0Transport.RunHistoryTurn) -> some View {
    VStack(alignment: .leading, spacing: 10) {
      if !turn.userText.isEmpty { userBubble(turn.userText) }
      ForEach(Array(turn.items.enumerated()), id: \.offset) { _, item in chunkView(kind: item.kind, text: item.text) }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }

  // The in-progress follow-up: user bubble + honest lifecycle + streamed output.
  private var liveTurn: some View {
    VStack(alignment: .leading, spacing: 10) {
      if let prompt = run.prompt { userBubble(prompt) }
      HStack(spacing: 8) {
        Circle().fill(stateColor).frame(width: 7, height: 7)
        Text(stateLabel).font(.system(size: 12, weight: .medium)).foregroundStyle(Palette.muted)
        if run.lifecycle == .running { ProgressView().controlSize(.mini) }
      }
      if run.output.isEmpty {
        Text(placeholderForState).font(.system(size: 15)).foregroundStyle(Palette.muted)
      } else {
        ForEach(run.output) { line in chunkView(kind: line.kind, text: line.text) }
      }
      if let result = run.resultSummary { EvidenceChip(symbol: Symbol.gauge, text: "用量 · \(result)") }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }

  private var footer: some View {
    HStack(spacing: 4) {
      TextField("继续这段对话…", text: $draft, axis: .vertical)
        .font(.system(size: 17)).lineLimit(1...5)
        .disabled(!run.hasConnection)
      CircleButton(symbol: Symbol.send, label: "发送", filled: true,
                   disabled: !run.hasConnection || draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty) {
        guard let s = session else { return }
        run.submitFollowUp(prompt: draft, providerId: s.providerId, cwd: s.cwd, resume: s.externalSessionId)
        draft = ""
      }
    }
    .padding(.horizontal, 7).padding(.vertical, 2).frame(minHeight: 49)
    .glass(cornerRadius: 32)
    .padding(.horizontal, 16).padding(.top, 8).padding(.bottom, 20)
    .background(Color(hex: 0xFAFAFA))
  }

  private func userBubble(_ text: String) -> some View {
    HStack {
      Spacer(minLength: 40)
      Text(text).font(.system(size: 16)).foregroundStyle(Color.white)
        .padding(.vertical, 10).padding(.horizontal, 14)
        .background(Palette.blue, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
    }
  }

  // Same rendering as the live ChatView output so replay + live look identical.
  private func chunkView(kind: String, text: String) -> some View {
    Group {
      switch kind {
      case "reasoning":
        HStack(alignment: .top, spacing: 6) {
          Image(systemName: "brain").font(.system(size: 11)).foregroundStyle(Palette.muted)
          Text(text).font(.system(size: 14)).foregroundStyle(Palette.muted).italic()
        }
      case "tool":
        Label(text, systemImage: Symbol.agent)
          .font(.system(size: 13)).foregroundStyle(Color(hex: 0x67676A))
          .padding(.vertical, 5).padding(.horizontal, 10).glass(cornerRadius: 12)
      case "tool_result":
        Text(text)
          .font(.system(size: 12).monospaced()).foregroundStyle(Color(hex: 0x424244))
          .padding(.vertical, 6).padding(.horizontal, 10)
          .frame(maxWidth: .infinity, alignment: .leading)
          .background(Color(hex: 0xF3F3F3), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
      default:
        Text(text).font(.system(size: 16)).foregroundStyle(Palette.ink)
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }

  private var placeholderForState: String {
    switch run.lifecycle {
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
    case .cancelled, .recorded, .dispatched: return Palette.amber
    case .unknown: return Palette.muted
    }
  }
}
