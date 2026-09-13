import SwiftUI

// v2 会话, now rendering ONE real remote run driven by RemoteRunStore. It shows:
//   - the durable lifecycle (recorded/dispatched/running/settled/failed/cancelled),
//   - the assistant's REAL streamed output content (a live cache, labeled as such
//     and possibly truncated), and
//   - Provider-canonical result usage verbatim when the host reports it.
// It never fabricates a reply, a token/cost number or a file diff. With no active
// run it shows a truthful empty state; recorded != executed.
struct ChatView: View {
  @EnvironmentObject var model: AppModel
  @EnvironmentObject var run: RemoteRunStore
  @State private var draft = ""

  private var paired: Bool { run.hasConnection }

  var body: some View {
    VStack(spacing: 0) {
      header
      if !paired { Notice(text: "尚未连接 Mac · 发送已停用。") }
      if let error = run.submitError { Notice(text: error, warning: true) }
      ScrollView {
        VStack(alignment: .leading, spacing: 14) {
          lifecycleChip
          if run.runId == nil && run.lifecycle == .unknown {
            EmptyState(title: "还没有可显示的回执",
                       detail: "任务提交不代表 Agent 已开始执行；结果需从主机读取，不沿用其他会话。")
          } else {
            outputSection
          }
        }
        .padding(.horizontal, 18)
        .padding(.top, 8)
      }
      .scrollIndicators(.hidden)
      footer
    }
    .background(Palette.surface)
    .onDisappear { /* keep the run polling; do not fabricate a stop */ }
  }

  private var header: some View {
    HStack(spacing: 12) {
      CircleButton(symbol: Symbol.back, label: "返回会话列表") { model.route = .home }
      VStack(alignment: .leading, spacing: 2) {
        Text("会话").font(.system(size: 17, weight: .semibold)).lineLimit(1)
        Text(run.hostLabel ?? model.link.host ?? "未连接").font(.system(size: 12)).foregroundStyle(Palette.muted).lineLimit(1)
      }
      Spacer()
      HStack(spacing: 3) {
        PlainIcon(symbol: Symbol.compose, label: "新建会话") { run.resetRun(); model.route = .newSession }
        PlainIcon(symbol: Symbol.more, label: "会话选项") {}
      }
      .padding(.horizontal, 3)
      .glass(cornerRadius: 28)
    }
    .padding(.horizontal, 14)
    .padding(.top, 6)
    .padding(.bottom, 10)
    .frame(minHeight: 66)
  }

  private var lifecycleChip: some View {
    HStack(spacing: 8) {
      Circle().fill(stateColor).frame(width: 7, height: 7)
      Text(stateLabel).font(.system(size: 13, weight: .medium)).foregroundStyle(Palette.ink)
      if let runId = run.runId {
        Text(runId.prefix(8) + "…").font(.system(size: 11).monospaced()).foregroundStyle(Palette.muted)
      }
      Spacer()
    }
    .padding(.vertical, 8)
    .padding(.horizontal, 12)
    .glass(cornerRadius: 20)
  }

  @ViewBuilder private var outputSection: some View {
    // The output is a live host cache of the assistant's real trace content.
    Text("以下为主机实时输出的缓存" + (run.truncated ? " · 已达缓存上限，内容被截断" : "，可能不完整"))
      .font(.system(size: 11)).foregroundStyle(Palette.muted)

    if run.output.isEmpty {
      Text(run.lifecycle == .running ? "运行中 · 尚无输出内容" : "主机未缓存此运行的输出内容")
        .font(.system(size: 13)).foregroundStyle(Palette.muted)
    } else {
      ForEach(run.output) { line in outputLine(line) }
    }

    if let result = run.resultSummary {
      EvidenceChip(symbol: Symbol.gauge, text: "用量 · \(result)")
    }
  }

  private func outputLine(_ line: RemoteRunStore.OutputLine) -> some View {
    VStack(alignment: .leading, spacing: 3) {
      switch line.kind {
      case "reasoning":
        Text("思考").font(.system(size: 10, weight: .semibold)).foregroundStyle(Palette.muted)
        Text(line.text).font(.system(size: 14)).foregroundStyle(Palette.muted).italic()
      case "tool":
        Label(line.text, systemImage: Symbol.agent).font(.system(size: 13)).foregroundStyle(Color(hex: 0x67676A))
      case "tool_result":
        Text("工具结果").font(.system(size: 10, weight: .semibold)).foregroundStyle(Palette.muted)
        Text(line.text).font(.system(size: 13).monospaced()).foregroundStyle(Color(hex: 0x424244))
      default:
        Text(line.text).font(.system(size: 15)).foregroundStyle(Palette.ink)
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }

  private var footer: some View {
    VStack(spacing: 12) {
      HStack(spacing: 4) {
        PlainIcon(symbol: Symbol.plus, label: "附件") {}
        TextField(paired ? "在 \(run.hostLabel ?? "Mac") 上发起新任务…" : "连接后可输入", text: $draft, axis: .vertical)
          .font(.system(size: 17))
          .lineLimit(1...5)
          .disabled(!paired)
        PlainIcon(symbol: Symbol.gauge, label: "Provider 和模型") {}
        CircleButton(symbol: Symbol.send, label: "发送新任务", filled: true,
                     disabled: !paired || run.chosen == nil || draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty) {
          run.submit(prompt: draft, providerId: "claude")
          draft = ""
        }
      }
      .padding(.horizontal, 7)
      .padding(.vertical, 2)
      .frame(minHeight: 49)
      .glass(cornerRadius: 32)
      if run.chosen == nil {
        Text("发送前请在“新建会话”里选择一个主机已授权的项目。")
          .font(.system(size: 11)).foregroundStyle(Palette.muted)
          .frame(maxWidth: .infinity, alignment: .leading)
      }
    }
    .padding(.horizontal, 16)
    .padding(.top, 8)
    .padding(.bottom, 20)
    .background(Color(hex: 0xFAFAFA))
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
