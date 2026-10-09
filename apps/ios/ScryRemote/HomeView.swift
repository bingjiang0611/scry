import SwiftUI
import RemoteTransport

// v5 · Codex Refined home. A flat, searchable conversation list avoids the old
// project-header duplication; project + Provider remain visible as metadata.
struct HomeView: View {
  @EnvironmentObject var model: AppModel
  @EnvironmentObject var run: RemoteRunStore
  @State private var pinnedExpanded = true
  @State private var showActiveRun = false

  var body: some View {
    VStack(spacing: 0) {
      RemoteHeader(title: "远程", subtitle: hostCaption, link: model.link,
                   menuAction: { model.route = .settings }) {
        Menu {
          Button { run.loadSessions(force: true) } label: { Label("刷新会话", systemImage: "arrow.clockwise") }
          Button { model.route = .pair } label: { Label("连接 Mac", systemImage: Symbol.link) }
          Button { model.route = .settings } label: { Label("设置", systemImage: Symbol.gear) }
        } label: {
          Image(systemName: Symbol.more).font(.system(size: 17, weight: .medium)).frame(width: 44, height: 44)
        }
        .accessibilityLabel("更多选项")
      }
      if !model.link.isConnected { Notice(text: offlineText) }
      if run.hasUnresolvedRun {
        Button { model.route = .chat } label: {
          HStack {
            Image(systemName: run.observationInterrupted ? "wifi.exclamationmark" : "bubble.left.and.bubble.right")
            VStack(alignment: .leading, spacing: 3) {
              Text(run.retryAvailable ? "核对上次提交" : "返回当前任务").font(.system(size: 14, weight: .semibold))
              Text(run.observationInterrupted ? "观察中断，点击恢复；主机可能仍在运行" : "任务尚未收敛，保留原会话继续查看")
                .font(.system(size: 12)).foregroundStyle(Palette.muted)
            }
            Spacer()
            Image(systemName: "chevron.right")
          }.padding(14).background(Palette.noticeBg, in: RoundedRectangle(cornerRadius: 12))
        }.buttonStyle(.plain).padding(.horizontal, 16).padding(.vertical, 8)
      }
      content
      dock
    }
    .background(Palette.surface)
    .onAppear {
      if run.hasConnection { run.loadSessions(); run.loadProjects() }
    }
    .alert("当前任务尚未结束", isPresented: $showActiveRun) {
      Button("返回当前任务") { model.route = .chat }
      Button("留在列表", role: .cancel) {}
    } message: {
      Text("先核对当前任务结果，再切换会话。本次提交标识和草稿会保留，不会重复执行。")
    }
  }

  @ViewBuilder private var content: some View {
    ScrollView {
      switch run.catalog {
      case .idle, .loading:
        if !run.hasConnection { notPairedEmpty }
        else { ProgressView("正在读取会话…").frame(maxWidth: .infinity).padding(.top, 52) }
      case let .loaded(list):
        let filtered = filteredSessions(list)
        if filtered.isEmpty {
          EmptyState(title: "没有匹配的会话", detail: "试试其他关键词。", symbol: Symbol.search).padding(.top, 24)
        } else if model.query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
          sessionSections(filtered)
        } else {
          VStack(alignment: .leading, spacing: 0) {
            sectionTitle("搜索结果")
            ForEach(filtered, id: \.sessionId) { sessionRow($0, showsMetadata: true) }
          }
          .padding(.horizontal, 19)
        }
      case .empty:
        EmptyState(title: "主机还没有会话", detail: "点击右下角，从 iPhone 发起第一项任务。")
          .padding(.top, 24)
      case let .failed(reason):
        VStack(spacing: 4) {
          EmptyState(title: "无法读取会话", detail: reason, symbol: "exclamationmark.triangle")
          Button("重新读取") { run.loadSessions(force: true) }.font(.system(size: 14, weight: .medium))
        }.padding(.top, 18)
      }
    }
    .scrollIndicators(.hidden)
    .scrollDismissesKeyboard(.interactively)
  }

  private var notPairedEmpty: some View {
    VStack(spacing: 0) {
      EmptyState(title: "还没有连接 Mac", detail: "在 Mac 的 Scry 中打开“连接 iPhone”，然后扫描配对码。", symbol: Symbol.laptop)
      Button { model.route = .pair } label: {
        Text("连接 Mac").font(.system(size: 15, weight: .semibold)).foregroundStyle(Palette.surface)
          .padding(.horizontal, 22).frame(minHeight: 46)
          .background(Palette.ink, in: Capsule())
      }
    }.padding(.top, 24)
  }

  private func filteredSessions(_ list: [G0Transport.RunSessionRef]) -> [G0Transport.RunSessionRef] {
    let needle = model.query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    guard !needle.isEmpty else { return list }
    return list.filter {
      $0.label.lowercased().contains(needle) || $0.cwd.lowercased().contains(needle) || $0.providerId.lowercased().contains(needle)
    }
  }

  private struct ProjectGroup { let cwd: String; let sessions: [G0Transport.RunSessionRef] }

  private func sessionSections(_ list: [G0Transport.RunSessionRef]) -> some View {
    let pinned = list.filter { $0.pinnedAt != nil }
    let regular = list.filter { $0.pinnedAt == nil }
    return LazyVStack(alignment: .leading, spacing: 0) {
      if !pinned.isEmpty {
        Button { withAnimation(.easeInOut(duration: 0.18)) { pinnedExpanded.toggle() } } label: {
          HStack(spacing: 7) {
            Text("已置顶").font(.system(size: 18, weight: .semibold))
            Image(systemName: "chevron.down").font(.system(size: 10, weight: .semibold))
              .rotationEffect(.degrees(pinnedExpanded ? 0 : -90)).foregroundStyle(Palette.muted)
            Spacer()
          }
          .frame(minHeight: 44).contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        if pinnedExpanded {
          ForEach(pinned.sorted { ($0.pinnedAt ?? 0) > ($1.pinnedAt ?? 0) }, id: \.sessionId) {
            sessionRow($0, showsMetadata: false)
          }
        }
      }

      if !regular.isEmpty {
        sectionTitle("项目").padding(.top, pinned.isEmpty ? 4 : 20)
        ForEach(groupedByProject(regular), id: \.cwd) { group in
          projectHeader(group.cwd)
          ForEach(group.sessions, id: \.sessionId) { sessionRow($0, showsMetadata: false, indent: 26) }
        }
      }
    }
    .padding(.horizontal, 19).padding(.bottom, 24)
  }

  private func sectionTitle(_ title: String) -> some View {
    Text(title).font(.system(size: 18, weight: .semibold)).frame(maxWidth: .infinity, alignment: .leading)
      .padding(.top, 17).padding(.bottom, 7)
  }

  private func groupedByProject(_ list: [G0Transport.RunSessionRef]) -> [ProjectGroup] {
    var order: [String] = []
    var groups: [String: [G0Transport.RunSessionRef]] = [:]
    for session in list {
      if groups[session.cwd] == nil { order.append(session.cwd); groups[session.cwd] = [] }
      groups[session.cwd]?.append(session)
    }
    return order.map { ProjectGroup(cwd: $0, sessions: groups[$0] ?? []) }
  }

  private func projectHeader(_ cwd: String) -> some View {
    HStack(spacing: 11) {
      Image(systemName: Symbol.folder).font(.system(size: 19, weight: .medium)).frame(width: 25)
      Text(projectName(cwd)).font(.system(size: 16, weight: .semibold)).lineLimit(1)
      Spacer()
      Button {
        guard !run.hasUnresolvedRun else { showActiveRun = true; return }
        if case let .loaded(projects) = run.projects, let project = projects.first(where: { $0.path == cwd }) {
          run.chooseProject(project)
        }
        model.route = .newSession
      } label: {
        Image(systemName: Symbol.compose).font(.system(size: 17, weight: .medium)).foregroundStyle(Palette.muted)
          .frame(width: 44, height: 44)
      }
      .buttonStyle(.plain).accessibilityLabel("在 \(projectName(cwd)) 中新建任务")
    }
    .frame(minHeight: 52)
  }

  @ViewBuilder private func sessionRow(_ session: G0Transport.RunSessionRef, showsMetadata: Bool, indent: CGFloat = 0) -> some View {
    let openable = session.externalSessionId?.isEmpty == false
    Button {
      guard openable, let external = session.externalSessionId else { return }
      if run.hasUnresolvedRun {
        let identity = RemoteRunStore.SessionIdentity.opened(providerId: session.providerId, cwd: session.cwd, externalSessionId: external)
        guard identity == run.activeSessionIdentity else { showActiveRun = true; return }
      }
      model.openedSession = OpenedSession(providerId: session.providerId, agentProfileId: session.agentProfileId,
                                          cwd: session.cwd, externalSessionId: external, label: session.label,
                                          isActive: session.isActive == true)
      model.route = .transcript
    } label: {
      HStack(alignment: .top, spacing: 10) {
        VStack(alignment: .leading, spacing: 4) {
          Text(session.label.isEmpty ? "(无预览)" : session.label)
            .font(.system(size: 15.5, weight: .regular)).foregroundStyle(openable ? Palette.ink : Palette.muted)
            .lineLimit(1)
          if showsMetadata {
            Text("\(projectName(session.cwd)) · \(session.providerId.uppercased())")
              .font(.system(size: 11.5)).foregroundStyle(Palette.muted).lineLimit(1)
          }
        }
        Spacer(minLength: 8)
        if session.isActive == true {
          Text("运行中").font(.system(size: 10, weight: .semibold)).foregroundStyle(Palette.blue)
        } else if !openable {
          Text("准备中").font(.system(size: 10)).foregroundStyle(Palette.amber)
        }
      }
      .padding(.leading, indent).padding(.vertical, showsMetadata ? 12 : 13)
      .frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
    }
    .buttonStyle(.plain).disabled(!openable)
  }

  private var dock: some View {
    HStack(spacing: 9) {
      HStack(spacing: 9) {
        Image(systemName: Symbol.search).font(.system(size: 15)).foregroundStyle(Palette.muted)
        TextField("搜索会话", text: $model.query).font(.system(size: 15))
          .textInputAutocapitalization(.never).autocorrectionDisabled()
      }
      .padding(.horizontal, 15).frame(height: 48).glass(cornerRadius: 24)
      CircleButton(symbol: Symbol.plus, label: "新任务", filled: true, disabled: !run.hasConnection) {
        guard !run.hasUnresolvedRun else { showActiveRun = true; return }
        model.route = .newSession
      }
    }
    .padding(.horizontal, 18).padding(.top, 12).padding(.bottom, 16)
    .background(Palette.surface)
  }

  private var hostCaption: String {
    switch model.link {
    case .notPaired: return "未连接"
    case .pairing: return "正在配对"
    case .offline: return "已配对 · 尚未验证可达"
    case .connected: return "Mac 已连接"
    }
  }
  private var offlineText: String {
    switch model.link {
    case .notPaired: return "尚未连接 Mac；浏览可用，但发送和审批已停用。"
    case .pairing: return "正在等待 Mac 确认，尚未授予权限。"
    case .offline: return "已配对，但尚未验证主机可达；刷新或发送时会尝试连接。"
    case .connected: return ""
    }
  }
  private func projectName(_ cwd: String) -> String { cwd.split(separator: "/").last.map(String.init) ?? cwd }
  private static func relativeTime(_ ms: Double) -> String {
    let seconds = Date().timeIntervalSince1970 - ms / 1000
    if seconds < 60 { return "刚刚" }
    if seconds < 3600 { return "\(Int(seconds / 60))m" }
    if seconds < 86400 { return "\(Int(seconds / 3600))h" }
    return "\(Int(seconds / 86400))d"
  }
}

struct SettingsView: View {
  @EnvironmentObject var model: AppModel
  @EnvironmentObject var run: RemoteRunStore
  @State private var confirmUnpair = false
  @State private var cacheNotice: String?

  var body: some View {
    VStack(spacing: 0) {
      RemoteHeader(title: "设置", backAction: { model.goBack() }) {
        Color.clear.frame(width: 44, height: 44)
      }
      ScrollView {
        VStack(spacing: 24) {
          settingsSection("连接") {
            settingRow(Symbol.laptop, "已配对的 Mac", model.statusText(), trailing: model.link.isConnected ? Palette.green : Palette.faint) {
              model.route = .pair
            }
          }
          settingsSection("远程体验") {
            settingRow(Symbol.shield, "默认权限", "由每次任务的 Provider 设置决定") {}
          }
          settingsSection("安全") {
            settingRow(Symbol.link, "重新配对", "替换此设备的远程授权") { model.route = .pair }
          }
          Button("退出登录（保留本机配对）") { model.signOut() }
            .font(.system(size: 14, weight: .medium)).frame(maxWidth: .infinity, minHeight: 44)
            .foregroundStyle(Palette.muted)
          if let error = model.destructiveActionError { Notice(text: error, warning: true) }
          Text("已读会话缓存到手机（最多 64 MB / 20 个会话），受 iOS 数据保护且不备份。退出登录保留缓存；清除配对会删除缓存。")
            .font(.caption).foregroundStyle(Palette.muted)
          Button(run.historyCacheClearing ? "正在清除缓存…" : "清除本机会话缓存") {
            Task {
              do { try await run.clearHistoryCache(); cacheNotice = "本地历史缓存已清除，不影响主机会话和未发送草稿。" }
              catch { cacheNotice = "缓存清除失败：\(error.localizedDescription)" }
            }
          }.disabled(run.historyCacheClearing).frame(minHeight: 44)
          if let cacheNotice { Text(cacheNotice).font(.caption).foregroundStyle(Palette.muted) }
          Button(role: .destructive) { confirmUnpair = true } label: {
            Text("退出并清除本机配对").font(.system(size: 14, weight: .medium)).frame(maxWidth: .infinity, minHeight: 48)
          }
          .buttonStyle(.plain).foregroundStyle(Palette.negative)
          .disabled(run.hasUnresolvedRun || run.historyCacheClearing)
          if run.hasUnresolvedRun { Text("请先核对当前任务，再清除配对。清除配对不会停止 Mac 上的运行。")
            .font(.caption).foregroundStyle(Palette.muted) }
        }
        .padding(16)
      }
    }
    .background(Palette.surface)
    .confirmationDialog("清除此 iPhone 的配对？", isPresented: $confirmUnpair, titleVisibility: .visible) {
      Button("清除配对", role: .destructive) { Task { await model.destructiveUnpair(runStore: run) } }
      Button("取消", role: .cancel) {}
    } message: {
      Text("将删除本机凭据、草稿和历史缓存。再次连接需要在 Mac 上重新授权；不会停止 Mac 上正在运行的任务。")
    }
  }

  private func settingsSection<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
    VStack(alignment: .leading, spacing: 7) {
      Text(title).font(.system(size: 12, weight: .medium)).foregroundStyle(Palette.muted).padding(.leading, 5)
      VStack(spacing: 0) { content() }.background(Palette.canvas, in: RoundedRectangle(cornerRadius: 15, style: .continuous))
    }
  }

  private func settingRow(_ symbol: String, _ title: String, _ detail: String, trailing: Color? = nil,
                          action: @escaping () -> Void) -> some View {
    Button(action: action) {
      HStack(spacing: 12) {
        Image(systemName: symbol).font(.system(size: 17)).frame(width: 22)
        VStack(alignment: .leading, spacing: 3) {
          Text(title).font(.system(size: 14.5, weight: .medium))
          Text(detail).font(.system(size: 11)).foregroundStyle(Palette.muted).lineLimit(2)
        }
        Spacer()
        if let trailing { Circle().fill(trailing).frame(width: 7, height: 7) }
        Image(systemName: Symbol.chevron).font(.system(size: 11, weight: .semibold)).foregroundStyle(Palette.faint)
      }
      .padding(.horizontal, 13).frame(minHeight: 61).contentShape(Rectangle())
    }
    .buttonStyle(.plain)
  }
}
