import SwiftUI

// v2 会话: header + evidence chips + compact composer. There is no real host
// transcript feed yet, so this shows a truthful "awaiting host" empty state and
// never renders a fabricated assistant reply or cached diff from another
// session. Reachable only once a real session exists.
struct ChatView: View {
  @EnvironmentObject var model: AppModel
  @State private var draft = ""

  private var connected: Bool { model.link.isConnected }

  var body: some View {
    VStack(spacing: 0) {
      header
      if !connected { Notice(text: "离线 · 可以阅读缓存，发送已停用。") }
      ScrollView {
        EmptyState(title: "还没有可显示的回执",
                   detail: "任务提交不代表 Agent 已开始执行；结果需从主机读取，不沿用其他会话。")
      }
      .scrollIndicators(.hidden)
      footer
    }
    .background(Palette.surface)
  }

  private var header: some View {
    HStack(spacing: 12) {
      CircleButton(symbol: Symbol.back, label: "返回会话列表") { model.route = .home }
      VStack(alignment: .leading, spacing: 2) {
        Text("会话").font(.system(size: 17, weight: .semibold)).lineLimit(1)
        Text(model.link.host ?? "未连接").font(.system(size: 12)).foregroundStyle(Palette.muted).lineLimit(1)
      }
      Spacer()
      HStack(spacing: 3) {
        PlainIcon(symbol: Symbol.compose, label: "新建会话") { model.route = .newSession }
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

  private var footer: some View {
    VStack(spacing: 12) {
      HStack(spacing: 7) {
        EvidenceChip(symbol: nil, text: "文件证据未缓存")
        EvidenceChip(symbol: Symbol.agent, text: "Agent 状态未知")
      }
      HStack(spacing: 4) {
        PlainIcon(symbol: Symbol.plus, label: "附件") {}
        TextField(connected ? "在 \(model.link.host ?? "Mac") 上工作…" : "连接后可输入", text: $draft, axis: .vertical)
          .font(.system(size: 17))
          .lineLimit(1...5)
          .disabled(!connected)
        PlainIcon(symbol: Symbol.gauge, label: "Provider 和模型") {}
        CircleButton(symbol: Symbol.send, label: "发送消息", filled: true,
                     disabled: !connected || draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty) {}
      }
      .padding(.horizontal, 7)
      .padding(.vertical, 2)
      .frame(minHeight: 49)
      .glass(cornerRadius: 32)
    }
    .padding(.horizontal, 16)
    .padding(.top, 8)
    .padding(.bottom, 20)
    .background(Color(hex: 0xFAFAFA))
  }
}
