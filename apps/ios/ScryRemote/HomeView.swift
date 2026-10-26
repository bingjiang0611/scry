import SwiftUI
import RemoteTransport

// One projection for local and forwarded rows: all navigation keeps the row's
// immutable scope, including when two hosts expose identical session ids.
struct HomeView: View {
  @EnvironmentObject var model: AppModel
  @Environment(RemoteRunStore.self) var run
  @Environment(ExecutionTargetCoordinator.self) var targets
  @StateObject private var actions = SessionActionCenter()
  @State private var expandedProjects: Set<String> = []
  @GestureState private var touchingSessions = false
  @State private var refreshToastVisible = false
  @State private var refreshDetails: CatalogRefreshDetailsSnapshot?
  @State private var manualRefreshing = false
  @State private var refreshToastID = 0
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  private var failure: RemoteRunStore.CatalogRefreshFailure? {
    targets.refreshIssues.first?.failure ?? targets.homeFailure
  }
  private var refreshing: Bool { targets.homeLoading || manualRefreshing }

  var body: some View {
    mainColumn
    .background(Palette.sidebar)
    .overlay(alignment: .top) {
      if refreshToastVisible && failure == nil {
        Text(ConnectionCopy.refreshSuccess).font(Typography.meta.weight(.semibold))
          .foregroundStyle(Palette.main).padding(.horizontal, 16).frame(minHeight: 36)
          .background(Palette.fg, in: Capsule()).padding(.top, 64).transition(Motion.fade)
      }
    }
    .overlay(alignment: .bottom) {
      if let toast = actions.toast {
        SessionActionToast(toast: toast,
                           onUndo: { actions.undoArchive(run: targets.localStore) },
                           onDismiss: { actions.dismissToast() })
      }
    }
    .animation(reduceMotion ? nil : Motion.animation(.select, reduceMotion: false), value: refreshToastVisible)
    .task(id: refreshToastID) {
      guard refreshToastVisible else { return }
      do { try await Task.sleep(for: .milliseconds(2_600)) } catch { return }
      refreshToastVisible = false
    }
    .onDisappear { refreshToastVisible = false; targets.setHomeVisible(false) }
    .sheet(item: $refreshDetails) { details in
      CatalogRefreshDetails(failure: details.failure, lastFullRefresh: details.lastFullRefresh,
                            address: details.address, paired: details.paired, issues: details.issues)
        .presentationDetents([.medium, .large])
        #if DEBUG
        .task {
          if ProcessInfo.processInfo.arguments.contains("-uiResolveRefreshDetails"), run.prepareRefreshDetailsFixture() {
            await targets.refreshHome()
          }
        }
        #endif
    }
    .alert(ConnectionCopy.renameTitle, isPresented: renamePresented) {
      TextField(ConnectionCopy.renameField, text: $actions.renameText)
      Button(ConnectionCopy.save) { actions.confirmRename(run: targets.localStore) }
      Button(ConnectionCopy.cancel, role: .cancel) { actions.renameTarget = nil }
    }
    .confirmationDialog(ConnectionCopy.archivedRunningConfirmTitle, isPresented: archiveConfirmPresented, titleVisibility: .visible) {
      Button(ConnectionCopy.actionArchiveAndStop, role: .destructive) { actions.confirmArchive(run: targets.localStore) }
      Button(ConnectionCopy.cancel, role: .cancel) { actions.archiveTarget = nil }
    } message: {
      Text(ConnectionCopy.archivedRunningConfirmBody)
    }
    .confirmationDialog(ConnectionCopy.deleteConfirmTitle, isPresented: deleteConfirmPresented, titleVisibility: .visible) {
      Button(ConnectionCopy.actionDelete, role: .destructive) { actions.confirmDelete(run: targets.localStore) }
      Button(ConnectionCopy.cancel, role: .cancel) { actions.deleteTarget = nil }
    } message: {
      Text(ConnectionCopy.deleteConfirmBody)
    }
    .alert(ConnectionCopy.sessionActionFailedTitle, isPresented: failurePresented) {
      Button(ConnectionCopy.ok) { actions.failure = nil }
    } message: {
      Text(actions.failure ?? "")
    }
    .task {
      targets.setHomeVisible(true)
      if run.hasConnection {
        await targets.refreshHome()
        targets.newTaskStore.loadProjects()
        targets.newTaskStore.loadProviders()
        if !targets.homeSessions.isEmpty { await targets.localStore.refreshArchived() }
      }
    }
  }

  private var mainColumn: some View {
    VStack(spacing: 0) {
      header
      searchField
      ScrollView {
        VStack(spacing: 0) {
          if let failure { refreshFailure(failure) }
          currentTasks
          backgroundSends
          if targets.visibleScopes.contains(where: { if case .unverifiedCache = targets.store(for: $0).catalogEvidence { return true }; return false }), failure == nil {
            Text(ConnectionCopy.unverifiedCache).font(Typography.meta).foregroundStyle(Palette.dim)
              .frame(maxWidth: .infinity, alignment: .leading).padding(12)
              .background(Palette.panel2, in: RoundedRectangle(cornerRadius: 12))
              .padding(.horizontal, 16).padding(.top, 8)
          }
          if !run.hasConnection { notPairedEmpty }
          HomeSessions(expandedProjects: $expandedProjects, touching: touchingSessions,
                       onOpen: open, onNewTask: newTask, onRowAction: handle,
                       onOpenTool: { model.route = .toolPanel($0) })
          if run.hasConnection && targets.homeSessions.isEmpty && refreshing {
            ProgressView(ConnectionCopy.readingSessions).frame(maxWidth: .infinity).padding(.top, 32)
          }
        }
      }
      .scrollIndicators(.hidden).scrollDismissesKeyboard(.interactively)
      .refreshable { await showManualRefresh() }
      // Observe the scroll surface itself; a child DragGesture steals its pan.
      .simultaneousGesture(DragGesture(minimumDistance: 0).updating($touchingSessions) { _, value, _ in value = true })
      HomeComposer()
    }
  }

  private var searchField: some View {
    HStack(spacing: 9) {
      Image(systemName: Symbol.search).font(Typography.reply).foregroundStyle(Palette.dim)
      TextField(ConnectionCopy.searchSessions, text: $model.query).font(Typography.rowTitle)
        .textInputAutocapitalization(.never).autocorrectionDisabled()
        .accessibilityIdentifier("home-search")
      if !model.query.isEmpty {
        Button { model.query = "" } label: {
          Image(systemName: "xmark.circle.fill").font(Typography.reply).foregroundStyle(Palette.dim2)
            .frame(width: 44, height: 44)
        }.buttonStyle(.plain).accessibilityLabel(ConnectionCopy.clearSearch)
      }
    }
    .padding(.leading, 12).frame(minHeight: 38)
    .background(Palette.subtle, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
    .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(Palette.border3))
    .padding(.horizontal, 16).padding(.vertical, 6)
  }

  private var header: some View {
    HStack(spacing: 0) {
      Menu {
        Button { targets.selectFilter(.all) } label: {
          Label(ConnectionCopy.allHosts, systemImage: targets.homeFilter == .all ? Symbol.check : Symbol.laptop)
        }
        ForEach(targets.targetScopes) { target in
          Button { targets.selectFilter(.target(target)) } label: {
            Label(target.label, systemImage: targets.homeFilter == .target(target) ? Symbol.check : Symbol.laptop)
          }
        }
        Divider()
        Button { model.route = .pair } label: { Label(ConnectionCopy.connectMac, systemImage: Symbol.link) }
        Button { model.route = .settings } label: { Label(ConnectionCopy.settings, systemImage: Symbol.gear) }
      } label: {
        hostChip
      }
      .accessibilityLabel(ConnectionCopy.filterHosts)
      Spacer(minLength: 4)
      PlainIcon(symbol: Symbol.gear, label: ConnectionCopy.settings) { model.route = .settings }
    }
    .padding(.horizontal, 16).frame(minHeight: 48)
  }

  private var hostChip: some View {
    HStack(spacing: 7) {
      if refreshing {
        ProgressView().controlSize(.mini).accessibilityLabel(ConnectionCopy.refreshing)
      } else {
        Circle().fill(run.hasConnection ? Palette.ok : Palette.dim2).frame(width: 7, height: 7).accessibilityHidden(true)
      }
      Text(targets.filterLabel).font(Typography.headerTitle).lineLimit(1)
      Image(systemName: Symbol.chevrons).font(Typography.meta).foregroundStyle(Palette.dim)
    }
    .foregroundStyle(Palette.fg)
    .padding(.horizontal, 14).frame(minHeight: 36)
    .background(Palette.panel2, in: Capsule())
    .frame(minHeight: 44).contentShape(Rectangle())
  }

  private func newTask(_ scope: ExecutionTargetScope, _ cwd: String?) {
    guard targets.beginNewTask(scope: scope) else { return }
    if let cwd { targets.newTaskStore.chooseProject(.init(path: cwd, label: projectName(cwd))) }
    model.composerDraft(for: .newTask(scope)).wrappedValue = .init()
  }

  private var renamePresented: Binding<Bool> {
    Binding(get: { actions.renameTarget != nil }, set: { if !$0 { actions.renameTarget = nil } })
  }
  private var archiveConfirmPresented: Binding<Bool> {
    Binding(get: { actions.archiveTarget != nil }, set: { if !$0 { actions.archiveTarget = nil } })
  }
  private var deleteConfirmPresented: Binding<Bool> {
    Binding(get: { actions.deleteTarget != nil }, set: { if !$0 { actions.deleteTarget = nil } })
  }
  private var failurePresented: Binding<Bool> {
    Binding(get: { actions.failure != nil }, set: { if !$0 { actions.failure = nil } })
  }

  private func open(_ row: ExecutionTargetCoordinator.HomeSession) {
    guard let external = row.session.externalSessionId, !external.isEmpty else { return }
    targets.select(row.scope)
    model.open(OpenedSession(providerId: row.session.providerId, agentProfileId: row.session.agentProfileId,
      cwd: row.session.cwd, externalSessionId: external, label: row.session.label,
      isActive: row.session.isActive == true, scope: row.scope.isLocal ? nil : row.scope),
      run: targets.store(for: row.scope))
  }

  private func handle(_ row: ExecutionTargetCoordinator.HomeSession, _ action: SessionRowAction) {
    actions.dispatch(action, session: row.session, run: targets.store(for: row.scope))
  }

  private func manualRefresh() { Task { await showManualRefresh() } }
  @MainActor private func showManualRefresh() async {
    guard !manualRefreshing else { return }
    manualRefreshing = true; refreshToastVisible = false
    defer { manualRefreshing = false }
    // SwiftUI can cancel its refreshable task as the refreshed view is rebuilt.
    // The coordinator's committed result, not that UI task, proves refresh success.
    guard await targets.refreshHome() else { return }
    refreshToastID += 1; refreshToastVisible = true
  }
  private func refreshFailure(_ failure: RemoteRunStore.CatalogRefreshFailure) -> some View {
    let lastFullRefresh = targets.lastFullRefresh
    let address = run.hostLabel
    let paired = run.hasConnection
    let issues = targets.refreshIssues
    return CatalogRefreshBanner(failure: failure, lastFullRefresh: lastFullRefresh, refreshing: refreshing,
      summary: issues.first?.summary,
      onRetry: { if failure.requiresPairing { model.route = .pair } else { manualRefresh() } },
      onDetails: {
        refreshDetails = CatalogRefreshDetailsSnapshot(failure: failure, lastFullRefresh: lastFullRefresh,
                                                       address: address, paired: paired, issues: issues)
      })
  }

  private var currentTasks: some View {
    ForEach(targets.pendingScopes) { scope in
      let store = targets.store(for: scope)
      if store.hasUnresolvedRun {
        Button { targets.select(scope); model.route = .chat } label: {
          HStack {
            Image(systemName: store.observationInterrupted ? "wifi.exclamationmark" : "bubble.left.and.bubble.right")
            VStack(alignment: .leading, spacing: 3) {
              Text(ConnectionCopy.returnToTask(scope.label)).font(Typography.rowTitle.weight(.semibold))
              Text(store.hasUncertainSubmission ? ConnectionCopy.targetResultUnknown :
                   store.observationInterrupted ? ConnectionCopy.interruptedRun :
                   store.lifecycle == .submitting ? ConnectionCopy.sending : ConnectionCopy.running)
                .font(Typography.meta).foregroundStyle(Palette.dim)
            }
            Spacer()
            Image(systemName: "chevron.right")
          }.padding(14).background(Palette.panel2, in: RoundedRectangle(cornerRadius: 12))
        }.buttonStyle(.plain).padding(.horizontal, 16).padding(.vertical, 8)
      }
    }
  }

  private var backgroundSends: some View {
    ForEach(targets.targetScopes) { scope in
      let store = targets.store(for: scope)
      if !store.backgroundSends.isEmpty {
        VStack(alignment: .leading, spacing: 0) {
          sectionTitle(ConnectionCopy.pendingMessages(scope.label))
          ForEach(store.backgroundSends) { pending in
            HStack(alignment: .top, spacing: 10) {
              VStack(alignment: .leading, spacing: 4) {
                Text(pending.routing.prompt).font(Typography.rowTitle).lineLimit(2)
                Text(pending.uncertainty != nil ? ConnectionCopy.targetResultUnknown :
                     pending.failure.map(ConnectionCopy.rejectedMessage) ??
                     ConnectionCopy.rowContext(host: nil, project: projectName(pending.routing.cwd), provider: pending.routing.providerId))
                  .font(Typography.meta).foregroundStyle(pending.failure == nil ? Palette.dim : Palette.bad).lineLimit(2)
              }
              Spacer(minLength: 8)
              if pending.uncertainty != nil {
                Button(ConnectionCopy.reconcileResult) { store.reconcileUncertain(intentId: pending.intentId) }
                  .font(.caption).frame(minHeight: 44)
              } else if pending.failure == nil {
                ProgressView().controlSize(.small).accessibilityLabel(ConnectionCopy.sending)
              } else {
                Button { store.discardRejectedSend(pending.intentId) } label: {
                  Image(systemName: "xmark").font(Typography.meta.weight(.semibold)).frame(width: 44, height: 44)
                }.buttonStyle(.plain).foregroundStyle(Palette.dim).accessibilityLabel(ConnectionCopy.remove)
              }
            }.padding(.vertical, 12)
          }
        }.padding(12).background(Palette.panel2, in: RoundedRectangle(cornerRadius: 12))
          .padding(.horizontal, 16).padding(.vertical, 8)
      }
    }
  }

  private var notPairedEmpty: some View {
    VStack(spacing: 0) {
      EmptyState(title: ConnectionCopy.noMac, detail: ConnectionCopy.pairInstructions, symbol: Symbol.laptop)
      Button { model.route = .pair } label: {
        Text(ConnectionCopy.connectMac).font(Typography.rowTitle.weight(.semibold)).foregroundStyle(Palette.main)
          .padding(.horizontal, 22).frame(minHeight: 46).background(Palette.fg, in: Capsule())
      }
    }.padding(.top, 24)
  }

  private func sectionTitle(_ title: String) -> some View {
    Text(title).font(Typography.meta.weight(.semibold)).tracking(0.6).foregroundStyle(Palette.dim)
      .frame(maxWidth: .infinity, alignment: .leading).padding(.top, 18).padding(.bottom, 2)
  }

  private func projectName(_ cwd: String) -> String { cwd.split(separator: "/").last.map(String.init) ?? cwd }
}
