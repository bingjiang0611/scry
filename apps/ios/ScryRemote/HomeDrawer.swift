import SwiftUI
import RemoteTransport

enum DrawerTab: String, CaseIterable, Identifiable {
  case recent, projects, tools
  var id: String { rawValue }
  var label: String {
    switch self {
    case .recent: return ConnectionCopy.tabRecent
    case .projects: return ConnectionCopy.tabProjects
    case .tools: return ConnectionCopy.tabTools
    }
  }
}

// The drawer carries the Mac sidebar's session surface: search, needs-you,
// pinned, recent, projects, plus the entry points that used to sit in the home
// list. Everything it shows comes from the host catalog already in memory.
struct HomeDrawer: View {
  @EnvironmentObject var model: AppModel
  @EnvironmentObject var run: RemoteRunStore
  @EnvironmentObject var targets: ExecutionTargetCoordinator
  @Binding var tab: DrawerTab
  @Binding var expandedProjects: Set<String>
  let onClose: () -> Void
  let onOpen: (ExecutionTargetCoordinator.HomeSession) -> Void
  let onNewTask: (ExecutionTargetScope, String?) -> Void
  let onRowAction: (ExecutionTargetCoordinator.HomeSession, SessionRowAction) -> Void
  let onOpenTool: (ToolKind) -> Void

  @State private var showAllRecent = false

  private var needle: String {
    model.query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
  }

  private var rows: [ExecutionTargetCoordinator.HomeSession] {
    guard !needle.isEmpty else { return targets.homeSessions }
    return targets.homeSessions.filter {
      [$0.session.label, $0.session.cwd, $0.session.providerId, $0.scope.label]
        .contains { $0.lowercased().contains(needle) }
    }
  }

  // A session that is waiting for a decision is listed once, in Needs-you, and
  // removed from the other sections instead of appearing twice.
  private var waiting: [ExecutionTargetCoordinator.HomeSession] {
    rows.filter { row in
      guard let live = targets.store(for: row.scope).liveRun(
        providerId: row.session.providerId, cwd: row.session.cwd,
        externalSessionId: row.session.externalSessionId, agentProfileId: row.session.agentProfileId) else { return false }
      return targets.store(for: row.scope).openLiveQuestion(live) != nil
    }
  }
  private var rest: [ExecutionTargetCoordinator.HomeSession] {
    let waitingIds = Set(waiting.map(\.id))
    return rows.filter { !waitingIds.contains($0.id) }
  }
  private var pinned: [ExecutionTargetCoordinator.HomeSession] {
    rest.filter { $0.session.pinnedAt != nil }.sorted { ($0.session.pinnedAt ?? 0) > ($1.session.pinnedAt ?? 0) }
  }
  private var recent: [ExecutionTargetCoordinator.HomeSession] { rest.filter { $0.session.pinnedAt == nil } }

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      header
      searchField
      tabs
      ScrollView {
        VStack(alignment: .leading, spacing: 0) {
          switch tab {
          case .recent: recentTab
          case .projects: projectsTab
          case .tools: toolsTab
          }
        }
        .padding(.horizontal, 16).padding(.bottom, 20)
      }
      .scrollIndicators(.hidden)
      .scrollDismissesKeyboard(.interactively)
      footer
    }
    .background(Palette.canvas)
    .clipShape(UnevenRoundedRectangle(bottomTrailingRadius: 26, topTrailingRadius: 26))
    .overlay(alignment: .bottom) { provenance }
  }

  private var header: some View {
    HStack(spacing: 8) {
      Text(ConnectionCopy.homeTitle).font(.system(size: 22, weight: .bold)).foregroundStyle(Palette.ink)
      Spacer()
      Button(action: onClose) {
        Image(systemName: Symbol.menu).font(.system(size: 16, weight: .medium))
          .foregroundStyle(Palette.ink).frame(width: 44, height: 44).contentShape(Rectangle())
      }
      .buttonStyle(.plain).accessibilityLabel(ConnectionCopy.drawerClose)
    }
    .padding(.horizontal, 16).padding(.top, 10)
  }

  private var searchField: some View {
    HStack(spacing: 9) {
      Image(systemName: Symbol.search).font(.system(size: 14)).foregroundStyle(Palette.muted)
      TextField(ConnectionCopy.searchSessions, text: $model.query).font(.system(size: 15))
        .textInputAutocapitalization(.never).autocorrectionDisabled()
      if !model.query.isEmpty {
        Button { model.query = "" } label: {
          Image(systemName: "xmark.circle.fill").font(.system(size: 14)).foregroundStyle(Palette.faint)
            .frame(width: 32, height: 44)
        }.buttonStyle(.plain).accessibilityLabel(ConnectionCopy.clearSearch)
      }
    }
    .padding(.horizontal, 12).frame(minHeight: 44)
    .background(Palette.surface, in: RoundedRectangle(cornerRadius: 12))
    .padding(.horizontal, 16).padding(.top, 8)
  }

  private var tabs: some View {
    HStack(spacing: 6) {
      ForEach(DrawerTab.allCases) { item in
        Button { tab = item } label: {
          Text(item.label).font(.system(size: 13, weight: .semibold))
            .foregroundStyle(tab == item ? Palette.ink : Palette.muted)
            .padding(.horizontal, 12).frame(minHeight: 34)
            .background(tab == item ? Palette.message : Color.clear, in: Capsule())
        }.buttonStyle(.plain)
      }
      Spacer(minLength: 0)
    }
    .padding(.horizontal, 16).padding(.top, 12).padding(.bottom, 4)
  }

  @ViewBuilder private var recentTab: some View {
    if rows.isEmpty { emptyRecent } else if !needle.isEmpty { searchResults } else {
      if !waiting.isEmpty {
        section(ConnectionCopy.sectionNeedsYou)
        ForEach(waiting) { row in rowView(row) }
      }
      if !pinned.isEmpty {
        section(ConnectionCopy.sectionPinned)
        ForEach(pinned) { row in rowView(row) }
      }
      if !recent.isEmpty {
        section(ConnectionCopy.tabRecent)
        ForEach(showAllRecent ? recent : Array(recent.prefix(6))) { row in rowView(row) }
        if recent.count > 6 && !showAllRecent {
          Button { showAllRecent = true } label: {
            Text(ConnectionCopy.seeAll).font(.system(size: 13, weight: .medium)).foregroundStyle(Palette.blue)
              .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading).contentShape(Rectangle())
          }.buttonStyle(.plain)
        }
      }
    }
  }

  @ViewBuilder private var searchResults: some View {
    section(ConnectionCopy.searchResults)
    ForEach(rows) { row in rowView(row) }
  }

  @ViewBuilder private var projectsTab: some View {
    let groups = projectGroups()
    if groups.isEmpty { emptyRecent } else {
      ForEach(groups, id: \.cwd) { group in
        projectSection(group)
      }
    }
  }

  private struct ProjectGroup {
    let scope: ExecutionTargetScope
    let cwd: String
    let sessions: [ExecutionTargetCoordinator.HomeSession]
  }

  private func projectGroups() -> [ProjectGroup] {
    var order: [String] = []
    var buckets: [String: [ExecutionTargetCoordinator.HomeSession]] = [:]
    for row in rows where row.session.pinnedAt == nil {
      let key = row.scope.id + "\u{1f}" + row.session.cwd
      if buckets[key] == nil { order.append(key) }
      buckets[key, default: []].append(row)
    }
    return order.compactMap { key in
      guard let sessions = buckets[key], let first = sessions.first else { return nil }
      return ProjectGroup(scope: first.scope, cwd: first.session.cwd, sessions: sessions)
    }
  }

  private func projectSection(_ group: ProjectGroup) -> some View {
    let key = group.scope.id + "\u{1f}" + group.cwd
    let expanded = expandedProjects.contains(key)
    return VStack(alignment: .leading, spacing: 0) {
      HStack(spacing: 10) {
        Button {
          if expanded { expandedProjects.remove(key) } else { expandedProjects.insert(key) }
        } label: {
          HStack(spacing: 9) {
            Image(systemName: expanded ? "chevron.down" : Symbol.chevron)
              .font(.system(size: 11, weight: .semibold)).foregroundStyle(Palette.muted).frame(width: 14)
            Text(projectName(group.cwd)).font(.system(size: 14.5, weight: .semibold)).foregroundStyle(Palette.ink)
              .lineLimit(1)
            Text("\(group.sessions.count)").font(.system(size: 11)).foregroundStyle(Palette.faint)
            Spacer(minLength: 0)
          }
          .frame(minHeight: 48).contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        Button { onNewTask(group.scope, group.cwd) } label: {
          Image(systemName: Symbol.compose).font(.system(size: 15, weight: .medium))
            .foregroundStyle(Palette.muted).frame(width: 44, height: 44)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(ConnectionCopy.newTaskInProject(projectName(group.cwd)))
      }
      if expanded {
        ForEach(group.sessions) { row in rowView(row, indent: 14) }
      }
    }
    .overlay(alignment: .bottom) { Rectangle().fill(Palette.line).frame(height: 1) }
  }

  // P3 replaces the unavailable markers with the three read-only panels.
  private var toolsTab: some View {
    VStack(alignment: .leading, spacing: 0) {
      section(ConnectionCopy.tabTools)
      // P3 wires the three read-only panels. Until the host op exists, the rows
      // say so instead of opening an empty screen or a Mac-only action.
      ForEach(ToolKind.allCases) { kind in
        ToolRowView(kind: kind) { onOpenTool(kind) }
      }
      Text(ConnectionCopy.toolsNote).font(.system(size: 11)).foregroundStyle(Palette.faint)
        .padding(.top, 10)
    }
  }

  private var footer: some View {
    VStack(spacing: 0) {
      Rectangle().fill(Palette.line).frame(height: 1)
      HStack(spacing: 10) {
        Button { onNewTask(targets.newTaskScope, nil) } label: {
          HStack(spacing: 7) {
            Image(systemName: Symbol.compose).font(.system(size: 14, weight: .semibold))
            Text(ConnectionCopy.newSession).font(.system(size: 14, weight: .semibold))
          }
          .foregroundStyle(Palette.surface).padding(.horizontal, 16).frame(minHeight: 44)
          .background(Palette.blue, in: Capsule())
        }
        .buttonStyle(.plain)
        Spacer(minLength: 0)
        Button { onClose(); model.route = .settings } label: {
          Image(systemName: Symbol.gear).font(.system(size: 17)).foregroundStyle(Palette.muted)
            .frame(width: 44, height: 44)
        }
        .buttonStyle(.plain).accessibilityLabel(ConnectionCopy.settings)
      }
      .padding(.horizontal, 16).padding(.vertical, 8)
    }
    .padding(.bottom, 18)
  }

  private var provenance: some View {
    Text(ConnectionCopy.panelProvenance(targets.filterLabel, readAt: readStamp))
      .font(.system(size: 10)).foregroundStyle(Palette.faint)
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(.horizontal, 16).padding(.bottom, 4)
      .allowsHitTesting(false)
  }

  private var readStamp: String? {
    targets.lastFullRefresh?.formatted(date: .omitted, time: .shortened)
  }

  private func rowView(_ row: ExecutionTargetCoordinator.HomeSession, indent: CGFloat = 0) -> some View {
    SessionRowView(row: row, showsContext: true, aggregatesHosts: targets.aggregatesHosts,
                   onOpen: { onOpen(row) }, onAction: { onRowAction(row, $0) }, indent: indent)
      .overlay(alignment: .bottom) { Rectangle().fill(Palette.line).frame(height: 1) }
  }

  private func section(_ title: String) -> some View {
    Text(title).font(.system(size: 11, weight: .bold)).tracking(0.6).foregroundStyle(Palette.muted)
      .frame(maxWidth: .infinity, alignment: .leading).padding(.top, 16).padding(.bottom, 4)
  }

  private var emptyRecent: some View {
    VStack(alignment: .leading, spacing: 5) {
      Text(ConnectionCopy.noRecent).font(.system(size: 15, weight: .semibold)).foregroundStyle(Palette.ink)
      Text(ConnectionCopy.noRecentDetail).font(.system(size: 12)).foregroundStyle(Palette.muted)
    }
    .frame(maxWidth: .infinity, alignment: .leading).padding(.top, 28)
  }

  private func projectName(_ cwd: String) -> String {
    cwd.split(separator: "/").last.map(String.init) ?? cwd
  }
}

extension ToolKind {
  var symbol: String {
    switch self {
    case .analytics: return Symbol.chart
    case .llmPerformance: return Symbol.gaugeSpeed
    case .mcpTrust: return Symbol.plug
    }
  }
}

struct ToolRowView: View {
  let kind: ToolKind
  var available = true
  let onOpen: () -> Void

  var body: some View {
    Button(action: onOpen) {
      HStack(spacing: 12) {
        Image(systemName: kind.symbol).font(.system(size: 16)).foregroundStyle(Palette.muted).frame(width: 22)
        VStack(alignment: .leading, spacing: 2) {
          Text(kind.title).font(.system(size: 15)).foregroundStyle(available ? Palette.ink : Palette.muted)
          if !available {
            Text(ConnectionCopy.toolNotOnPhone).font(.system(size: 10.5)).foregroundStyle(Palette.faint)
          }
        }
        Spacer(minLength: 0)
        if available {
          Image(systemName: Symbol.chevron).font(.system(size: 11, weight: .semibold)).foregroundStyle(Palette.faint)
        }
      }
      .frame(minHeight: 52).contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .disabled(!available)
    .overlay(alignment: .bottom) { Rectangle().fill(Palette.line).frame(height: 1) }
  }
}
