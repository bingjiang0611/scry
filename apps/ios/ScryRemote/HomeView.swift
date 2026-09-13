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
        LazyVStack(alignment: .leading, spacing: 4) {
          Text("项目").font(.system(size: 17, weight: .semibold)).foregroundStyle(Palette.ink)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.bottom, 6)
          ForEach(groupedByProject(list), id: \.cwd) { group in
            projectHeader(group.cwd)
            ForEach(group.sessions, id: \.sessionId) { s in sessionRow(s) }
          }
        }
        .padding(.horizontal, 18)
        .padding(.top, 10)
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

  // Group the flat catalog by project (cwd), most-recently-active project first,
  // so the phone list mirrors the Mac's project-grouped session list.
  private struct ProjectGroup { let cwd: String; let sessions: [G0Transport.RunSessionRef] }
  private func groupedByProject(_ list: [G0Transport.RunSessionRef]) -> [ProjectGroup] {
    var order: [String] = []
    var byCwd: [String: [G0Transport.RunSessionRef]] = [:]
    for s in list {
      if byCwd[s.cwd] == nil { byCwd[s.cwd] = []; order.append(s.cwd) }
      byCwd[s.cwd]?.append(s)
    }
    return order.map { ProjectGroup(cwd: $0, sessions: byCwd[$0] ?? []) }
  }

  // Project row: folder glyph + project name (matches the Mac's “项目” list).
  private func projectHeader(_ cwd: String) -> some View {
    HStack(spacing: 10) {
      Image(systemName: "folder").font(.system(size: 15)).foregroundStyle(Palette.ink)
      Text(projectName(cwd)).font(.system(size: 16, weight: .medium)).foregroundStyle(Palette.ink).lineLimit(1)
      Spacer()
    }
    .padding(.top, 12).padding(.bottom, 2)
  }

  // One session row, indented under its project. Tapping OPENS the real
  // conversation (read-only replay) when the session is resumable (has a
  // Provider session id); a pending session is shown dimmed and is not tappable.
  @ViewBuilder private func sessionRow(_ s: G0Transport.RunSessionRef) -> some View {
    let openable = (s.externalSessionId?.isEmpty == false)
    Button {
      guard openable, let ext = s.externalSessionId else { return }
      model.openedSession = OpenedSession(providerId: s.providerId, cwd: s.cwd, externalSessionId: ext, label: s.label)
      model.route = .transcript
    } label: {
      HStack(spacing: 8) {
        Text(s.label.isEmpty ? "(无预览)" : s.label)
          .font(.system(size: 15)).foregroundStyle(openable ? Palette.ink : Palette.muted)
          .lineLimit(1).multilineTextAlignment(.leading)
        Spacer(minLength: 8)
        if !openable { Text("进行中").font(.system(size: 11)).foregroundStyle(Palette.muted) }
        Text(Self.relativeTime(s.ts)).font(.system(size: 11)).foregroundStyle(Palette.muted)
      }
      .padding(.vertical, 9)
      .padding(.leading, 26)
      .frame(maxWidth: .infinity, alignment: .leading)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .disabled(!openable)
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
