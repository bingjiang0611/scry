import SwiftUI
import RemoteTransport

// Read-only replay of a past session's REAL conversation, loaded from the host
// over the granted-cert channel (RemoteRunStore.loadHistory). It renders the
// SAME content kinds a live run streams (output/reasoning/tool/tool_result) and
// stays honest (CLAUDE.md 证据不能说谎): it never fabricates turns, shows a
// truthful empty/failed state, and labels the content as host-read (file diffs
// still live on the Mac). Follow-up sending is intentionally not offered here -
// this is a replay, not the live composer.
struct SessionTranscriptView: View {
  @EnvironmentObject var model: AppModel
  @EnvironmentObject var run: RemoteRunStore

  var body: some View {
    VStack(spacing: 0) {
      header
      ScrollView {
        switch run.history {
        case .idle, .loading:
          ProgressView("正在读取会话内容…").padding(.top, 44)
        case let .loaded(turns):
          LazyVStack(alignment: .leading, spacing: 18) {
            ForEach(Array(turns.enumerated()), id: \.offset) { _, turn in turnView(turn) }
            Text("以上为主机读取的会话记录，可能不完整；文件 diff 需在 Mac 上查看。")
              .font(.system(size: 10)).foregroundStyle(Palette.muted)
              .frame(maxWidth: .infinity, alignment: .leading)
          }
          .padding(.horizontal, 16)
          .padding(.top, 12)
        case .empty:
          EmptyState(title: "这条会话没有可读取的内容",
                     detail: "主机上没有找到这条会话的对话记录（可能是较早、未归档或已在 Mac 上删除的会话）。")
            .padding(.top, 36)
        case let .failed(reason):
          EmptyState(title: "无法读取会话内容", detail: reason).padding(.top, 36)
        }
      }
      .scrollIndicators(.hidden)
    }
    .background(Palette.surface)
    .onAppear {
      guard let s = model.openedSession else { return }
      run.loadHistory(providerId: s.providerId, cwd: s.cwd, externalSessionId: s.externalSessionId)
    }
  }

  private var header: some View {
    HStack(spacing: 12) {
      CircleButton(symbol: Symbol.back, label: "返回会话列表") { model.route = .home }
      VStack(alignment: .leading, spacing: 2) {
        Text(model.openedSession?.label.isEmpty == false ? model.openedSession!.label : "会话")
          .font(.system(size: 17, weight: .semibold)).lineLimit(1)
        Text(model.openedSession?.providerId.uppercased() ?? "")
          .font(.system(size: 12)).foregroundStyle(Palette.muted).lineLimit(1)
      }
      Spacer()
    }
    .padding(.horizontal, 14)
    .padding(.top, 6)
    .padding(.bottom, 10)
    .frame(minHeight: 66)
  }

  private func turnView(_ turn: G0Transport.RunHistoryTurn) -> some View {
    VStack(alignment: .leading, spacing: 10) {
      if !turn.userText.isEmpty { userBubble(turn.userText) }
      ForEach(Array(turn.items.enumerated()), id: \.offset) { _, item in chunkView(item) }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }

  private func userBubble(_ text: String) -> some View {
    HStack {
      Spacer(minLength: 40)
      Text(text)
        .font(.system(size: 16)).foregroundStyle(Color.white)
        .padding(.vertical, 10).padding(.horizontal, 14)
        .background(Palette.blue, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
    }
  }

  // Same rendering as the live ChatView output so a replay looks identical.
  private func chunkView(_ item: G0Transport.RunHistoryChunk) -> some View {
    Group {
      switch item.kind {
      case "reasoning":
        HStack(alignment: .top, spacing: 6) {
          Image(systemName: "brain").font(.system(size: 11)).foregroundStyle(Palette.muted)
          Text(item.text).font(.system(size: 14)).foregroundStyle(Palette.muted).italic()
        }
      case "tool":
        Label(item.text, systemImage: Symbol.agent)
          .font(.system(size: 13)).foregroundStyle(Color(hex: 0x67676A))
          .padding(.vertical, 5).padding(.horizontal, 10)
          .glass(cornerRadius: 12)
      case "tool_result":
        Text(item.text)
          .font(.system(size: 12).monospaced()).foregroundStyle(Color(hex: 0x424244))
          .padding(.vertical, 6).padding(.horizontal, 10)
          .frame(maxWidth: .infinity, alignment: .leading)
          .background(Color(hex: 0xF3F3F3), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
      default:
        Text(item.text).font(.system(size: 16)).foregroundStyle(Palette.ink)
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }
}
