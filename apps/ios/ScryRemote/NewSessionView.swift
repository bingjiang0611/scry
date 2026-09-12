import SwiftUI

// v2 新会话: back header, context rows (host/project/workspace/branch), and the
// bottom composer. The composer is disabled while not connected — there is no
// real host to accept a task, and we never queue a fake "submitted" task.
struct NewSessionView: View {
  @EnvironmentObject var model: AppModel
  @State private var draft = ""

  private var connected: Bool { model.link.isConnected }

  var body: some View {
    VStack(spacing: 0) {
      HStack {
        CircleButton(symbol: Symbol.back, label: "返回会话列表") { model.route = .home }
        Spacer()
      }
      .padding(.horizontal, 14)
      .padding(.top, 6)
      .padding(.bottom, 10)
      .frame(minHeight: 62)

      if !connected { Notice(text: "尚未连接 Mac · 无法创建会话。") }

      ScrollView {
        VStack(spacing: 0) {
          contextRow(Symbol.laptop, model.link.host ?? "选择电脑")
          contextRow(Symbol.folder, "选择项目")
          contextRow(Symbol.laptop, "在本地工作")
          contextRow(Symbol.branch, "main")
        }
        .padding(.top, 56)
        .padding(.horizontal, 24)
      }
      .scrollIndicators(.hidden)

      composer
    }
    .background(Palette.surface)
  }

  private func contextRow(_ symbol: String, _ text: String) -> some View {
    HStack(spacing: 13) {
      Image(systemName: symbol).font(.system(size: 18)).foregroundStyle(Color(hex: 0x909193)).frame(width: 21)
      Text(text).font(.system(size: 17)).foregroundStyle(Color(hex: 0x626264))
      Spacer()
      Image(systemName: Symbol.chevrons).font(.system(size: 12)).foregroundStyle(Color(hex: 0xC4C4C6))
    }
    .frame(minHeight: 47)
  }

  private var composer: some View {
    VStack(spacing: 7) {
      TextField(connected ? "在 \(model.link.host ?? "Mac") 上工作" : "连接后可输入", text: $draft, axis: .vertical)
        .font(.system(size: 17))
        .lineLimit(1...6)
        .disabled(!connected)
      HStack(spacing: 3) {
        PlainIcon(symbol: Symbol.plus, label: "附件") {}
        PlainIcon(symbol: Symbol.shield, label: "权限模式", tint: Palette.amber) {}
        Spacer()
        PlainIcon(symbol: Symbol.gauge, label: "Provider 和模型") {}
        CircleButton(symbol: Symbol.send, label: "发送新任务", filled: true,
                     disabled: !connected || draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty) {}
      }
    }
    .padding(.horizontal, 13)
    .padding(.top, 12)
    .padding(.bottom, 7)
    .glass(cornerRadius: 28)
    .padding(.horizontal, 11)
    .padding(.bottom, 14)
  }
}
