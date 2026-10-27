import SwiftUI
import RemoteTransport

enum HomeTab: String, CaseIterable, Identifiable {
  case projects, activity
  var id: String { rawValue }
  var label: String { self == .projects ? ConnectionCopy.tabProjects : ConnectionCopy.tabActivity }
}

// Read-only projection. Only live evidence can put a session in Activity; neither
// the catalog's isActive flag nor a timestamp is evidence of a current/outcome state.
struct HomeSessionCatalog: Equatable {
  typealias Row = ExecutionTargetCoordinator.HomeSession
  enum Activity { case waiting, running }
  struct Project: Identifiable, Equatable {
    let scope: ExecutionTargetScope
    let cwd: String
    let sessions: [Row]
    var id: String { scope.id + "\u{1f}" + cwd }
  }
  let rows: [Row]
  let waiting: [Row]
  let running: [Row]
  let pinned: [Row]
  let projects: [Project]

  init(rows: [Row], query: String, activity: (Row) -> Activity?) {
    let needle = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    self.rows = rows.filter {
      needle.isEmpty || [$0.session.label, $0.session.cwd, $0.session.providerId, $0.scope.label]
        .contains { $0.lowercased().contains(needle) }
    }
    var waiting: [Row] = []
    var running: [Row] = []
    for row in self.rows {
      switch activity(row) {
      case .waiting: waiting.append(row)
      case .running: running.append(row)
      case nil: break
      }
    }
    self.waiting = waiting
    self.running = running
    pinned = self.rows.filter { $0.session.pinnedAt != nil }
      .sorted { ($0.session.pinnedAt ?? 0) > ($1.session.pinnedAt ?? 0) }
    var order: [String] = []
    var buckets: [String: [Row]] = [:]
    for row in self.rows where row.session.pinnedAt == nil {
      let key = row.scope.id + "\u{1f}" + row.session.cwd
      if buckets[key] == nil { order.append(key) }
      buckets[key, default: []].append(row)
    }
    projects = order.compactMap { key in
      guard let sessions = buckets[key], let first = sessions.first else { return nil }
      return Project(scope: first.scope, cwd: first.session.cwd, sessions: sessions)
    }
  }

  var defaultTab: HomeTab { waiting.isEmpty && running.isEmpty ? .projects : .activity }
}

struct HomeSessions: View {
  @EnvironmentObject private var model: AppModel
  @Environment(ExecutionTargetCoordinator.self) private var targets
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @Binding var expandedProjects: Set<String>
  let touching: Bool
  let onOpen: (HomeSessionCatalog.Row) -> Void
  let onNewTask: (ExecutionTargetScope, String?) -> Void
  let onRowAction: (HomeSessionCatalog.Row, SessionRowAction) -> Void
  let onOpenTool: (ToolKind) -> Void
  @SceneStorage("home-tab") private var selectedTab = ""
  @State private var defaultTab: HomeTab = .activity
  @State private var defaultResolved = false
  @Namespace private var tabUnderline
  @Namespace private var activityRows
  @State private var displayed: HomeSessionCatalog?
  @State private var seenRows: Set<RemoteRunStore.SessionIdentity> = []
  @State private var initialEntranceFinished = false

  private var candidate: HomeSessionCatalog {
    HomeSessionCatalog(rows: targets.homeSessions, query: model.query) { row in
      let store = targets.store(for: row.scope)
      guard let live = store.liveRun(providerId: row.session.providerId, cwd: row.session.cwd,
        externalSessionId: row.session.externalSessionId, agentProfileId: row.session.agentProfileId) else { return nil }
      return store.openLiveQuestion(live) != nil ? .waiting : .running
    }
  }
  private var catalog: HomeSessionCatalog { displayed ?? candidate }
  private var tab: HomeTab { HomeTab(rawValue: selectedTab) ?? defaultTab }

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      tabs
      Group {
        switch tab {
        case .activity: activity
        case .projects: projects
        }
      }
      .transition(Motion.fade)
      .homeContentFade(trigger: tab, reduceMotion: reduceMotion)
      // Freshness lives once, in the drawer's footer, next to the settings entry.
    }
    .padding(.horizontal, 16).padding(.bottom, 16)
    .onAppear {
      displayed = candidate
      if selectedTab.isEmpty && model.query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
        defaultTab = candidate.defaultTab
        defaultResolved = !candidate.rows.isEmpty
      }
    }
    .task { initialEntranceFinished = true }
    .onChange(of: candidate) { _, next in
      if !touching { displayed = next; resolveDefault(next) }
    }
    .onChange(of: touching) { _, down in
      if !down { displayed = candidate; resolveDefault(candidate) }
    }
  }

  private func resolveDefault(_ next: HomeSessionCatalog) {
    // The first catalog may arrive after the view. Resolve once, never switch
    // tabs on later run-state changes, a search edit, or while a finger is down.
    guard selectedTab.isEmpty, !defaultResolved, !next.rows.isEmpty,
          model.query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
    defaultTab = next.defaultTab
    defaultResolved = true
  }

  private var tabs: some View {
    HStack(spacing: 16) {
      ForEach(HomeTab.allCases) { item in
        Button {
          withAnimation(reduceMotion ? nil : Motion.animation(.tab, reduceMotion: false)) { selectedTab = item.rawValue }
        } label: {
          Text(item.label).font(Typography.rowTitle.weight(.medium))
            .foregroundStyle(tab == item ? Palette.fg : Palette.dim2)
            .frame(minWidth: 44, minHeight: 44).contentShape(Rectangle())
            .overlay(alignment: .bottom) {
              if tab == item {
                if reduceMotion {
                  Rectangle().fill(Palette.fg).frame(height: 2).transition(Motion.fade)
                } else {
                  Rectangle().fill(Palette.fg).frame(height: 2)
                    .matchedGeometryEffect(id: "home-tab-underline", in: tabUnderline)
                }
              }
            }
        }
        .buttonStyle(.plain).accessibilityIdentifier("home-tab-\(item.rawValue)")
        .accessibilityAddTraits(tab == item ? .isSelected : [])
      }
      Spacer(minLength: 0)
    }
    .padding(.bottom, 12)
  }

  private var activity: some View {
    LazyVStack(alignment: .leading, spacing: 0) {
      if catalog.waiting.isEmpty && catalog.running.isEmpty {
        Text(ConnectionCopy.activityEmpty).font(Typography.rowTitle).foregroundStyle(Palette.dim)
          .frame(maxWidth: .infinity, alignment: .leading).padding(.vertical, 24)
      }
      activitySection(ConnectionCopy.homeNeedsReply, rows: catalog.waiting)
      activitySection(ConnectionCopy.sectionRunning, rows: catalog.running)
    }
    .animation(reduceMotion ? nil : Motion.animation(.tab, reduceMotion: false), value: catalog.waiting.map(\.id))
    .animation(reduceMotion ? nil : Motion.animation(.tab, reduceMotion: false), value: catalog.running.map(\.id))
    .homeContentFade(trigger: catalog.waiting.map(\.id) + catalog.running.map(\.id), reduceMotion: reduceMotion)
  }

  @ViewBuilder private func activitySection(_ title: String, rows: [HomeSessionCatalog.Row]) -> some View {
    if !rows.isEmpty {
      section(title)
      ForEach(Array(rows.prefix(40).enumerated()), id: \.element.id) { index, row in
        sessionRow(row, index: index, activity: true)
          .matchedGeometryEffect(id: row.id, in: activityRows, properties: reduceMotion ? [] : .position)
      }
      if rows.count > 40 {
        Text(ConnectionCopy.activityOverflow(rows.count - 40)).font(Typography.meta).foregroundStyle(Palette.dim)
          .padding(.vertical, 8)
      }
    }
  }

  private var projects: some View {
    LazyVStack(alignment: .leading, spacing: 0) {
      if !catalog.pinned.isEmpty {
        section(ConnectionCopy.sectionPinned, directory: true)
        ForEach(Array(catalog.pinned.enumerated()), id: \.element.id) { index, row in
          sessionRow(row, index: index, pinned: true)
        }
      }
      section(ConnectionCopy.tabProjects, directory: true)
      if catalog.rows.isEmpty {
        Text(ConnectionCopy.noRecent).font(Typography.rowTitle).foregroundStyle(Palette.dim).padding(.vertical, 16)
      }
      ForEach(catalog.projects) { project in projectSection(project) }
      Button { onNewTask(targets.newTaskScope, nil) } label: {
        Label(ConnectionCopy.newSession, systemImage: Symbol.compose).font(Typography.rowTitle)
          .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
      }.buttonStyle(HomeRowButtonStyle()).foregroundStyle(Palette.fg)
      section(ConnectionCopy.tabTools)
      LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 8) {
        ForEach(ToolKind.allCases) { kind in ToolRowView(kind: kind) { onOpenTool(kind) } }
      }
      Text(ConnectionCopy.toolsNote).font(Typography.meta).foregroundStyle(Palette.dim2).padding(.top, 10)
    }
  }

  private func projectSection(_ project: HomeSessionCatalog.Project) -> some View {
    let expanded = expandedProjects.contains(project.id)
    return VStack(alignment: .leading, spacing: 0) {
      HStack(spacing: 0) {
        Button {
          withAnimation(reduceMotion ? nil : Motion.animation(expanded ? .disclosureClose : .disclosureOpen, reduceMotion: false)) {
            if expanded { expandedProjects.remove(project.id) } else { expandedProjects.insert(project.id) }
          }
        } label: {
          HStack(spacing: 8) {
            Image(systemName: Symbol.chevron).font(Typography.meta)
              .rotationEffect(.degrees(expanded ? 90 : 0))
              .animation(reduceMotion ? nil : Motion.animation(expanded ? .disclosureOpen : .disclosureClose, reduceMotion: false), value: expanded)
            Image(systemName: Symbol.folder).font(Typography.rowTitle)
            Text(projectName(project.cwd)).font(Typography.headerTitle).foregroundStyle(Palette.fg).lineLimit(1)
            if targets.aggregatesHosts {
              Text(project.scope.label).font(Typography.meta).foregroundStyle(Palette.dim2).lineLimit(1)
            }
            Text(project.sessions.count, format: .number).font(Typography.meta)
            Spacer(minLength: 0)
          }
          .foregroundStyle(Palette.dim2).frame(minHeight: 44).contentShape(Rectangle())
        }
        .buttonStyle(HomeRowButtonStyle()).accessibilityValue(expanded ? ConnectionCopy.expanded : ConnectionCopy.collapsed)
        .accessibilityIdentifier("home-project-\(projectName(project.cwd))")
        Button { onNewTask(project.scope, project.cwd) } label: {
          Image(systemName: Symbol.plus).font(Typography.rowTitle).foregroundStyle(Palette.dim)
            .frame(width: 44, height: 44)
        }.buttonStyle(HomeRowButtonStyle()).accessibilityLabel(ConnectionCopy.newTaskInProject(projectName(project.cwd)))
      }
      if expanded {
        ForEach(project.sessions) { row in sessionRow(row, indent: 18) }
          .transition(Motion.fade)
      }
    }
    .homeContentFade(trigger: expanded, reduceMotion: reduceMotion)
  }

  private func sessionRow(_ row: HomeSessionCatalog.Row, index: Int = 0, activity: Bool = false,
                          pinned: Bool = false, indent: CGFloat = 0) -> some View {
    SessionRowView(row: row, activityOnly: activity, showsProject: pinned,
                   onOpen: { onOpen(row) }, onAction: { onRowAction(row, $0) }, indent: indent)
      .listRowEntrance(index: index, enabled: !initialEntranceFinished && index < 10 && !seenRows.contains(row.id))
      .onAppear { seenRows.insert(row.id) }
  }

  private func section(_ title: String, directory: Bool = false) -> some View {
    HStack(spacing: 10) {
      Text(title).font(Typography.groupLabel).foregroundStyle(directory ? Palette.dim2 : Palette.fg)
      Rectangle().fill(directory ? Palette.border3 : Palette.border2).frame(height: 1)
    }.padding(.top, 12).padding(.bottom, 4)
  }
  private func projectName(_ cwd: String) -> String { cwd.split(separator: "/").last.map(String.init) ?? cwd }
}

private extension View {
  // Replace geometry immediately under Reduce Motion, then fade the replacement.
  // No shared layout transaction means surrounding rows never slide or resize.
  func homeContentFade<Value: Equatable>(trigger: Value, reduceMotion: Bool) -> some View {
    keyframeAnimator(initialValue: 1.0, trigger: trigger) { content, opacity in
      content.opacity(opacity)
    } keyframes: { _ in
      MoveKeyframe(reduceMotion ? 0 : 1)
      LinearKeyframe(1, duration: Motion.reducedDuration)
    }
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
      HStack(spacing: 9) {
        Image(systemName: kind.symbol).font(Typography.rowTitle).foregroundStyle(Palette.dim)
        VStack(alignment: .leading, spacing: 2) {
          Text(kind.title).font(Typography.rowTitle).foregroundStyle(available ? Palette.fg : Palette.dim)
          if !available { Text(ConnectionCopy.toolNotOnPhone).font(Typography.meta).foregroundStyle(Palette.dim2) }
        }
        Spacer(minLength: 0)
      }
      .padding(.horizontal, 12).frame(maxWidth: .infinity, minHeight: 44)
      .background(Palette.subtle, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
      .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(Palette.border3))
    }.buttonStyle(HomeRowButtonStyle()).disabled(!available)
  }
}
