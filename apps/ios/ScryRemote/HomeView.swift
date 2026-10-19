import SwiftUI
import RemoteTransport

// v5 · Codex Refined home. A flat, searchable conversation list avoids the old
// project-header duplication; project + Provider remain visible as metadata.
struct HomeView: View {
  @EnvironmentObject var model: AppModel
  @EnvironmentObject var run: RemoteRunStore
  @State private var pinnedExpanded = true
  @State private var refreshToastVisible = false
  @State private var showingRefreshDetails = false
  @State private var manualRefreshing = false
  @State private var refreshToastID = 0
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  var body: some View {
    VStack(spacing: 0) {
      RemoteHeader(title: ConnectionCopy.homeTitle, menuAction: { model.route = .settings }) {
        HStack(spacing: 0) {
          if run.catalogRefreshInFlight {
            ProgressView().frame(width: 44, height: 44).accessibilityLabel(ConnectionCopy.refreshing)
          } else {
            PlainIcon(symbol: "arrow.clockwise", label: ConnectionCopy.refresh) { manualRefresh() }
          }
          Menu {
            Button { model.route = .pair } label: { Label(ConnectionCopy.connectMac, systemImage: Symbol.link) }
            Button { model.route = .settings } label: { Label(ConnectionCopy.settings, systemImage: Symbol.gear) }
          } label: {
            Image(systemName: Symbol.more).font(.system(size: 17, weight: .medium)).frame(width: 44, height: 44)
          }
          .accessibilityLabel(ConnectionCopy.more)
        }
      }
      if let failure = run.catalogRefreshFailure, run.catalog.hasVisibleValue {
        refreshFailure(failure)
      }
      if run.hasUnresolvedRun {
        Button { model.route = .chat } label: {
          HStack {
            Image(systemName: run.observationInterrupted ? "wifi.exclamationmark" : "bubble.left.and.bubble.right")
            VStack(alignment: .leading, spacing: 3) {
              Text("返回当前任务").font(.system(size: 14, weight: .semibold))
              Text(run.lifecycle == .submitting ? "发送中…" : run.observationInterrupted ? "观察中断，点击恢复；主机可能仍在运行" : "任务进行中")
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
    .overlay(alignment: .top) {
      if refreshToastVisible && run.catalogRefreshFailure == nil {
        Text(ConnectionCopy.refreshSuccess).font(.system(size: 13, weight: .semibold))
          .foregroundStyle(Palette.surface).padding(.horizontal, 16).frame(height: 36)
          .background(Palette.ink, in: Capsule()).padding(.top, 64)
          .transition(.opacity)
      }
    }
    .animation(reduceMotion ? nil : .easeInOut(duration: 0.18), value: refreshToastVisible)
    .task(id: refreshToastID) {
      guard refreshToastVisible else { return }
      do { try await Task.sleep(for: .milliseconds(2_600)) }
      catch { return }
      refreshToastVisible = false
    }
    .onDisappear { refreshToastVisible = false }
    .sheet(isPresented: $showingRefreshDetails) {
      if let failure = run.catalogRefreshFailure {
        CatalogRefreshDetails(failure: failure, lastFullRefresh: run.catalogVerifiedAt,
                              address: run.hostLabel, paired: run.hasConnection)
          .presentationDetents([.medium, .large])
      }
    }
    .onAppear {
      if run.hasConnection { run.loadSessions(); run.loadProjects() }
    }
  }

  private func manualRefresh() {
    Task { await showManualRefresh() }
  }

  @MainActor private func showManualRefresh() async {
    guard !manualRefreshing else { return }
    manualRefreshing = true
    refreshToastVisible = false
    defer { manualRefreshing = false }
    guard await run.refreshSessions(), !Task.isCancelled else { return }
    refreshToastID += 1
    refreshToastVisible = true
  }

  private func refreshFailure(_ failure: RemoteRunStore.CatalogRefreshFailure) -> some View {
    CatalogRefreshBanner(failure: failure, lastFullRefresh: run.catalogVerifiedAt,
                         refreshing: run.catalogRefreshInFlight,
                         onRetry: { if failure.requiresPairing { model.route = .pair } else { manualRefresh() } },
                         onDetails: { showingRefreshDetails = true })
  }

  @ViewBuilder private var content: some View {
    ScrollView {
      backgroundSendsSection
      if case .unverifiedCache = run.catalogEvidence, run.catalogRefreshFailure == nil {
        Text(ConnectionCopy.unverifiedCache).font(.system(size: 12)).foregroundStyle(Palette.muted)
          .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 19).padding(.top, 10)
      }
      switch run.catalog {
      case .idle, .loading:
        if !run.hasConnection { notPairedEmpty }
        else { ProgressView("正在读取会话…").frame(maxWidth: .infinity).padding(.top, 52) }
      case let .loaded(list):
        let filtered = filteredSessions(list)
        liveRunsSection(list)
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
        if !run.hasConnection { notPairedEmpty }
        else { refreshFailure(run.catalogRefreshFailure ?? .transport(reason)).padding(.top, 18) }
      }
    }
    .scrollIndicators(.hidden)
    .scrollDismissesKeyboard(.interactively)
    .refreshable { await showManualRefresh() }
  }

  // Live runs whose session is not in the list yet (just started, or archived
  // on the Mac). Rows already in the list carry their own live badge.
  @ViewBuilder private func liveRunsSection(_ list: [G0Transport.RunSessionRef]) -> some View {
    let listed = Set(list.compactMap { session in session.externalSessionId.map { "\(session.providerId)\u{0}\(session.cwd)\u{0}\($0)" } })
    let unlisted = run.liveRuns.filter { live in
      live.externalSessionId.map { !listed.contains("\(live.providerId)\u{0}\(live.cwd)\u{0}\($0)") } ?? true
    }
    if !unlisted.isEmpty {
      VStack(alignment: .leading, spacing: 0) {
        sectionTitle("进行中")
        ForEach(unlisted) { live in
          Button {
            guard let external = live.externalSessionId else { return }
            model.open(OpenedSession(providerId: live.providerId, agentProfileId: live.agentProfileId, cwd: live.cwd,
                                     externalSessionId: external, label: live.prompt, isActive: true), run: run)
          } label: {
            HStack(alignment: .top, spacing: 10) {
              VStack(alignment: .leading, spacing: 4) {
                Text(live.prompt.isEmpty ? "(无预览)" : live.prompt).font(.system(size: 15.5)).lineLimit(1)
                Text("\(projectName(live.cwd)) · \(live.providerId.uppercased())")
                  .font(.system(size: 11.5)).foregroundStyle(Palette.muted).lineLimit(1)
              }
              Spacer(minLength: 8)
              if live.externalSessionId == nil {
                Text("启动中").font(.system(size: 10)).foregroundStyle(Palette.muted)
              } else {
                LiveRunBadge(live: live, waiting: run.openLiveQuestion(live) != nil)
              }
            }
            .padding(.vertical, 12).frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
          }
          .buttonStyle(.plain).disabled(live.externalSessionId == nil)
        }
      }
      .padding(.horizontal, 19)
    }
  }

  // Messages left while still sending. They resend on their own and become
  // live runs once the Mac records them; only a Mac rejection can be dismissed.
  @ViewBuilder private var backgroundSendsSection: some View {
    if !run.backgroundSends.isEmpty {
      VStack(alignment: .leading, spacing: 0) {
        sectionTitle("发送中")
        ForEach(run.backgroundSends) { pending in
          HStack(alignment: .top, spacing: 10) {
            VStack(alignment: .leading, spacing: 4) {
              Text(pending.routing.prompt).font(.system(size: 15.5)).lineLimit(1)
              Text(pending.failure.map { "Mac 拒绝了这条消息（\($0)），未执行" }
                   ?? "\(projectName(pending.routing.cwd)) · \(pending.routing.providerId.uppercased())")
                .font(.system(size: 11.5)).foregroundStyle(pending.failure == nil ? Palette.muted : Palette.negative).lineLimit(2)
            }
            Spacer(minLength: 8)
            if pending.failure == nil {
              ProgressView().controlSize(.small).accessibilityLabel("发送中")
            } else {
              Button { run.discardRejectedSend(pending.intentId) } label: {
                Image(systemName: "xmark").font(.system(size: 13, weight: .semibold)).frame(width: 44, height: 44)
              }.buttonStyle(.plain).foregroundStyle(Palette.muted).accessibilityLabel("移除")
            }
          }
          .padding(.vertical, 12)
        }
      }
      .padding(.horizontal, 19)
    }
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
        // A finished run's state (including its error) belongs to that session;
        // a running one stays on the Mac and in the live-run list.
        guard run.detachFocusedRun() else { return }
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
      model.open(OpenedSession(providerId: session.providerId, agentProfileId: session.agentProfileId,
                               cwd: session.cwd, externalSessionId: external, label: session.label,
                               isActive: session.isActive == true), run: run)
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
        if let live = run.liveRun(providerId: session.providerId, cwd: session.cwd, externalSessionId: session.externalSessionId) {
          LiveRunBadge(live: live, waiting: run.openLiveQuestion(live) != nil)
        } else if session.isActive == true {
          Text(ConnectionCopy.lastRunning).font(.system(size: 10, weight: .semibold)).foregroundStyle(Palette.muted)
        } else if !openable {
          // No Provider session id and not running on the Mac: nothing to open.
          // It may have failed before starting; "preparing" would be a guess.
          Text("未建立会话").font(.system(size: 10)).foregroundStyle(Palette.muted)
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
        guard run.detachFocusedRun() else { return }
        model.route = .newSession
      }
    }
    .padding(.horizontal, 18).padding(.top, 12).padding(.bottom, 16)
    .background(Palette.surface)
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

private struct CatalogRefreshBanner: View {
  let failure: RemoteRunStore.CatalogRefreshFailure
  let lastFullRefresh: Date?
  let refreshing: Bool
  let onRetry: () -> Void
  let onDetails: () -> Void

  private var title: String { failure.summary }

  var body: some View {
    VStack(alignment: .leading, spacing: 7) {
      HStack(alignment: .top, spacing: 8) {
        Image(systemName: "exclamationmark.circle").font(.system(size: 14, weight: .medium)).padding(.top, 1)
        VStack(alignment: .leading, spacing: 3) {
          Text(title).font(.system(size: 13, weight: .semibold))
          Text(ConnectionCopy.lastFullRefresh(lastFullRefresh)).font(.system(size: 11))
        }
        Spacer(minLength: 4)
      }
      HStack(spacing: 16) {
        Button(failure.requiresPairing ? ConnectionCopy.pairAgain : ConnectionCopy.retry, action: onRetry)
          .font(.system(size: 12, weight: .semibold)).frame(minWidth: 44, minHeight: 44).disabled(refreshing)
        Button(ConnectionCopy.details, action: onDetails).font(.system(size: 12, weight: .medium))
          .frame(minWidth: 44, minHeight: 44)
      }
    }
    .foregroundStyle(Palette.warnInk).padding(12)
    .background(Palette.warnBg, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    .padding(.horizontal, 16).padding(.vertical, 8)
  }
}

private struct CatalogRefreshDetails: View {
  let failure: RemoteRunStore.CatalogRefreshFailure
  let lastFullRefresh: Date?
  let address: String?
  let paired: Bool
  @Environment(\.dismiss) private var dismiss
  @State private var technicalExpanded = false

  var body: some View {
    VStack(alignment: .leading, spacing: 18) {
      HStack {
        Text(ConnectionCopy.detailsTitle).font(.title3.weight(.semibold))
        Spacer()
        Button(ConnectionCopy.done) { dismiss() }.frame(minWidth: 44, minHeight: 44)
      }
      LabeledContent(ConnectionCopy.pairing, value: paired ? ConnectionCopy.pairingSaved : ConnectionCopy.pairingAbsent)
      LabeledContent(ConnectionCopy.connectionAddress, value: address ?? ConnectionCopy.unavailableAddress)
      LabeledContent(ConnectionCopy.listRequest, value: failure.summary)
      Text(ConnectionCopy.lastFullRefresh(lastFullRefresh)).font(.caption).foregroundStyle(Palette.muted)
      DisclosureGroup(ConnectionCopy.technicalDetails, isExpanded: $technicalExpanded) {
        Text(failure.technicalDetail).font(.caption.monospaced()).foregroundStyle(Palette.muted)
          .textSelection(.enabled).padding(.top, 8)
      }
      Spacer()
    }.padding(20)
  }

}

// Host-proven live state for one run. "Mac" marks a run the owner started in
// the Mac app, so the phone never implies it started it.
struct LiveRunBadge: View {
  let live: G0Transport.LiveRun
  let waiting: Bool
  var body: some View {
    let origin = live.origin == "mac" ? "Mac · " : ""
    let (text, color): (String, Color) = live.state == "stopping" ? ("停止中", Palette.muted)
      : waiting ? ("等待决定", Palette.amber) : ("运行中", Palette.blue)
    Text(origin + text).font(.system(size: 10, weight: .semibold)).foregroundStyle(color)
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
          settingsSection("安全") {
            settingRow(Symbol.link, "重新配对", "替换此设备的远程授权") { model.route = .pair }
          }
          if let error = model.destructiveActionError { Notice(text: error, warning: true) }
          Text("已读会话缓存到手机（最多 64 MB / 20 个会话），受 iOS 数据保护且不备份。关闭 App 保留缓存；清除配对会删除缓存。")
            .font(.caption).foregroundStyle(Palette.muted)
          Button(run.historyCacheClearing ? "正在清除缓存…" : "清除本机会话缓存") {
            Task {
              do { try await run.clearHistoryCache(); cacheNotice = "本地历史缓存已清除，不影响主机会话和未发送草稿。" }
              catch { cacheNotice = "缓存清除失败：\(error.localizedDescription)" }
            }
          }.disabled(run.historyCacheClearing).frame(minHeight: 44)
          if let cacheNotice { Text(cacheNotice).font(.caption).foregroundStyle(Palette.muted) }
          Button(role: .destructive) { confirmUnpair = true } label: {
            Text("清除本机配对").font(.system(size: 14, weight: .medium)).frame(maxWidth: .infinity, minHeight: 48)
          }
          .buttonStyle(.plain).foregroundStyle(Palette.negative)
          .disabled(run.hasUnresolvedRun || run.hasUnsentMessages || run.historyCacheClearing)
          if run.hasUnresolvedRun || run.hasUnsentMessages { Text("仍有消息在发送或任务未结束，完成后再清除配对。清除配对不会停止 Mac 上的运行。")
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
