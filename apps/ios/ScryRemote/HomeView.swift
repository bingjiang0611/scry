import SwiftUI
import RemoteTransport

// v2 首页 chrome: menu / centered host caption / more, optional offline notice,
// session list (truthfully empty today), and the bottom search + compose dock.
struct HomeView: View {
  @EnvironmentObject var model: AppModel
  @EnvironmentObject var run: RemoteRunStore

  var body: some View {
    VStack(spacing: 0) {
      header
      if !model.link.isConnected { Notice(text: offlineText) }
      content
      dock
    }
    .background(Palette.surface)
    .onAppear { if run.hasConnection { run.loadSessions() } }
  }

  private var header: some View {
    HStack(spacing: 12) {
      CircleButton(symbol: Symbol.menu, label: "打开导航") {}
      VStack(spacing: 2) {
        Text("远程").font(.system(size: 17, weight: .semibold))
        Button {
          model.route = .home
        } label: {
          HStack(spacing: 5) {
            StatusDot(link: model.link)
            Image(systemName: Symbol.laptop).font(.system(size: 12))
            Text(model.link.host ?? "未连接").lineLimit(1)
          }
          .font(.system(size: 12))
          .foregroundStyle(Palette.muted)
        }
      }
      .frame(maxWidth: .infinity)
      CircleButton(symbol: Symbol.more, label: "更多选项") {}
    }
    .padding(.horizontal, 14)
    .padding(.top, 6)
    .padding(.bottom, 10)
    .frame(minHeight: 66)
  }

  @ViewBuilder private var content: some View {
    ScrollView {
      switch run.catalog {
      case .idle, .loading:
        if !run.hasConnection {
          notPairedEmpty
        } else {
          ProgressView("正在读取主机会话…").padding(.top, 40)
        }
      case let .loaded(list):
        LazyVStack(alignment: .leading, spacing: 0) {
          ForEach(list, id: \.sessionId) { s in sessionRow(s) }
        }
        .padding(.horizontal, 14)
        .padding(.top, 6)
      case .empty:
        VStack(spacing: 14) {
          EmptyState(title: model.query.isEmpty ? "主机还没有会话" : "没有匹配的会话",
                     detail: "在 Mac 的 Scry 里（或从手机新建）发起会话后会出现在这里。")
        }.padding(.top, 30)
      case let .failed(reason):
        VStack(spacing: 14) { EmptyState(title: "无法读取会话", detail: reason) }.padding(.top, 30)
      }
    }
    .scrollIndicators(.hidden)
  }

  private var notPairedEmpty: some View {
    VStack(spacing: 18) {
      EmptyState(title: emptyTitle, detail: emptyDetail)
      Button { model.route = .pair } label: {
        Text("连接 Mac")
          .font(.system(size: 15, weight: .medium))
          .foregroundStyle(Color.white)
          .padding(.horizontal, 22)
          .frame(minHeight: 44)
          .background(Palette.ink, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
      }
    }.padding(.top, 30)
  }

  // One catalog row: provider badge + label + project + relative time. This is
  // the SAME session metadata the Mac lists. Opening the full transcript on the
  // phone is a host read that is not wired yet, so rows are display-only for now.
  private func sessionRow(_ s: G0Transport.RunSessionRef) -> some View {
    HStack(spacing: 10) {
      Text(s.providerId.uppercased())
        .font(.system(size: 10, weight: .bold)).foregroundStyle(Palette.muted)
        .padding(.vertical, 3).padding(.horizontal, 7)
        .background(Color(hex: 0xEFEFEF), in: RoundedRectangle(cornerRadius: 7, style: .continuous))
      VStack(alignment: .leading, spacing: 2) {
        Text(s.label.isEmpty ? "(无预览)" : s.label)
          .font(.system(size: 16)).foregroundStyle(Palette.ink).lineLimit(1)
        Text(projectName(s.cwd)).font(.system(size: 12)).foregroundStyle(Palette.muted).lineLimit(1)
      }
      Spacer(minLength: 8)
      Text(Self.relativeTime(s.ts)).font(.system(size: 12)).foregroundStyle(Palette.muted)
    }
    .padding(.vertical, 10)
    .frame(maxWidth: .infinity, alignment: .leading)
  }

  private func projectName(_ cwd: String) -> String {
    cwd.split(separator: "/").last.map(String.init) ?? cwd
  }

  private static func relativeTime(_ ms: Double) -> String {
    let secs = Date().timeIntervalSince1970 - ms / 1000
    if secs < 60 { return "刚刚" }
    if secs < 3600 { return "\(Int(secs / 60))m" }
    if secs < 86400 { return "\(Int(secs / 3600))h" }
    return "\(Int(secs / 86400))d"
  }

  private var dock: some View {
    HStack(spacing: 10) {
      HStack(spacing: 9) {
        Image(systemName: Symbol.search).font(.system(size: 15)).foregroundStyle(Palette.muted)
        TextField("搜索聊天", text: $model.query)
          .textInputAutocapitalization(.never)
          .autocorrectionDisabled()
          .font(.system(size: 17))
      }
      .padding(.horizontal, 13)
      .frame(height: 48)
      .glass(cornerRadius: 30)

      // Enabled once paired (a persisted connection exists); reachability of the
      // host is only learned by attempting a run, never faked here.
      CircleButton(symbol: Symbol.compose, label: "新建会话", filled: true, disabled: !run.hasConnection) {
        model.route = .newSession
      }
    }
    .padding(.horizontal, 20)
    .padding(.top, 14)
    .padding(.bottom, 22)
  }

  private var offlineText: String {
    switch model.link {
    case .notPaired: return "尚未连接 Mac · 只能浏览界面，发送与审批已停用。"
    case .pairing: return "配对中 · 等待 Mac 上确认，尚未授予权限。"
    case .offline: return "已配对 · 尚未验证与主机的连接；发送任务即会尝试连接。"
    case .connected: return ""
    }
  }
  private var emptyTitle: String {
    switch model.link {
    case .notPaired, .pairing: return "还没有连接 Mac"
    default: return model.query.isEmpty ? "还没有会话" : "没有匹配的聊天"
    }
  }
  private var emptyDetail: String {
    switch model.link {
    case .notPaired, .pairing: return "在 Mac 上打开 Scry → 连接 iPhone 后开始"
    default: return model.query.isEmpty ? "从右下角开始一项新任务" : "试试其他关键词"
    }
  }
}
