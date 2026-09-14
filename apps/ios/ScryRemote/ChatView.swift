import SwiftUI

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
  private var hasTurn: Bool { run.prompt != nil || run.runId != nil || run.lifecycle != .unknown }
  private var runBusy: Bool { run.lifecycle == .recorded || run.lifecycle == .dispatched || run.lifecycle == .running }

  var body: some View {
    VStack(spacing: 0) {
      header
      if !paired { Notice(text: "尚未连接 Mac · 发送已停用。") }
      if let error = run.submitError { Notice(text: error, warning: true) }
      ScrollViewReader { proxy in
        ScrollView {
          VStack(alignment: .leading, spacing: 16) {
            if !hasTurn {
              EmptyState(title: "开始一段新会话",
                         detail: "你发送的消息会在这里显示；Agent 的执行状态与输出从主机实时读取，不沿用其他会话。")
            } else {
              if let prompt = run.prompt { userBubble(prompt) }
              assistantTurn
            }
            Color.clear.frame(height: 1).id("bottom")
          }
          .padding(.horizontal, 16)
          .padding(.top, 10)
        }
        .scrollIndicators(.hidden)
        .onChange(of: run.output.count) { withAnimation { proxy.scrollTo("bottom", anchor: .bottom) } }
        .onChange(of: run.lifecycle) { withAnimation { proxy.scrollTo("bottom", anchor: .bottom) } }
      }
      footer
    }
    .background(Palette.surface)
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
  private func userBubble(_ text: String) -> some View {
    HStack {
      Spacer(minLength: 40)
      VStack(alignment: .leading, spacing: 8) {
        ForEach(run.sentAttachments) { item in
          Label(item.name, systemImage: item.kind == .image ? Symbol.photo : Symbol.file)
            .font(.system(size: 11, weight: .medium)).lineLimit(1)
        }
        Text(text).font(.system(size: 16))
      }
      .foregroundStyle(Palette.ink)
      .padding(.vertical, 10).padding(.horizontal, 14)
      .background(Color(hex: 0xF0F0F2), in: RoundedRectangle(cornerRadius: 20, style: .continuous))
    }
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
        ForEach(run.output) { line in outputLine(line) }
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

  private func outputLine(_ line: RemoteRunStore.OutputLine) -> some View {
    Group {
      switch line.kind {
      case "reasoning":
        HStack(alignment: .top, spacing: 6) {
          Image(systemName: "brain").font(.system(size: 11)).foregroundStyle(Palette.muted)
          Text(line.text).font(.system(size: 14)).foregroundStyle(Palette.muted).italic()
        }
      case "tool":
        Label(line.text, systemImage: Symbol.agent)
          .font(.system(size: 13)).foregroundStyle(Color(hex: 0x67676A))
          .padding(.vertical, 5).padding(.horizontal, 10)
          .glass(cornerRadius: 12)
      case "tool_result":
        Text(line.text)
          .font(.system(size: 12).monospaced()).foregroundStyle(Color(hex: 0x424244))
          .padding(.vertical, 6).padding(.horizontal, 10)
          .frame(maxWidth: .infinity, alignment: .leading)
          .background(Color(hex: 0xF3F3F3), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
      default:
        Text(line.text).font(.system(size: 16)).foregroundStyle(Palette.ink)
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
                      onPermission: { run.choosePermission($0) }) {
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
    .padding(.horizontal, 13).padding(.top, 8).padding(.bottom, 12)
    .background(Palette.surface)
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
