import SwiftUI

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
      if model.sessions.isEmpty {
        VStack(spacing: 18) {
          EmptyState(title: emptyTitle, detail: emptyDetail)
          if !model.link.isConnected {
            Button { model.route = .pair } label: {
              Text("连接 Mac")
                .font(.system(size: 15, weight: .medium))
                .foregroundStyle(Color.white)
                .padding(.horizontal, 22)
                .frame(minHeight: 44)
                .background(Palette.ink, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
            }
          }
        }
      } else {
        // Reserved for a real host session feed. No mock rows are shown.
        VStack(alignment: .leading, spacing: 0) {
          ForEach(model.sessions) { session in
            Text(session.title).font(.system(size: 17)).padding(.vertical, 11)
          }
        }
        .padding(.horizontal, 19)
      }
    }
    .scrollIndicators(.hidden)
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
