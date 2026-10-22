import SwiftUI
import RemoteTransport

// Details describe one request, not the next background refresh or pairing.
struct CatalogRefreshDetailsSnapshot: Identifiable {
  let id = UUID()
  let failure: RemoteRunStore.CatalogRefreshFailure
  let lastFullRefresh: Date?
  let address: String?
  let paired: Bool
  var issues: [ExecutionTargetCoordinator.RefreshIssue] = []
}

// One projection for local and forwarded rows: all navigation keeps the row's
// immutable scope, including when two hosts expose identical session ids.
struct HomeView: View {
  @EnvironmentObject var model: AppModel
  @EnvironmentObject var run: RemoteRunStore
  @EnvironmentObject var targets: ExecutionTargetCoordinator
  @StateObject private var actions = SessionActionCenter()
  @State private var drawerOpen = false
  @State private var drawerTab: DrawerTab = .recent
  @State private var expandedProjects: Set<String> = []
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
    ZStack(alignment: .leading) {
      mainColumn
      if drawerOpen {
        Color.black.opacity(0.54).ignoresSafeArea()
          .onTapGesture { closeDrawer() }
          .accessibilityLabel(ConnectionCopy.drawerClose)
          .accessibilityAddTraits(.isButton)
          .transition(.opacity)
        drawer
      }
    }
    .background(Palette.surface)
    .overlay(alignment: .top) {
      if refreshToastVisible && failure == nil {
        Text(ConnectionCopy.refreshSuccess).font(.system(size: 13, weight: .semibold))
          .foregroundStyle(Palette.surface).padding(.horizontal, 16).frame(minHeight: 36)
          .background(Palette.ink, in: Capsule()).padding(.top, 64).transition(.opacity)
      }
    }
    .overlay(alignment: .bottom) {
      if let toast = actions.toast {
        SessionActionToast(toast: toast,
                           onUndo: { actions.undoArchive(run: targets.localStore) },
                           onDismiss: { actions.dismissToast() })
      }
    }
    .animation(reduceMotion ? nil : .easeInOut(duration: 0.18), value: refreshToastVisible)
    .animation(reduceMotion ? nil : .easeOut(duration: 0.24), value: drawerOpen)
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
      }
    }
  }

  private var mainColumn: some View {
    VStack(spacing: 0) {
      header
      ScrollView {
        if let failure { refreshFailure(failure) }
        currentTasks
        backgroundSends
        if targets.visibleScopes.contains(where: { if case .unverifiedCache = targets.store(for: $0).catalogEvidence { return true }; return false }), failure == nil {
          Text(ConnectionCopy.unverifiedCache).font(.system(size: 12)).foregroundStyle(Palette.muted)
            .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 19).padding(.top, 10)
        }
        peek
        if !run.hasConnection { notPairedEmpty }
        else if targets.homeSessions.isEmpty && refreshing {
          ProgressView(ConnectionCopy.readingSessions).frame(maxWidth: .infinity).padding(.top, 52)
        }
      }
      .scrollIndicators(.hidden).scrollDismissesKeyboard(.interactively)
      .refreshable { await showManualRefresh() }
      HomeComposer()
    }
  }

  private var header: some View {
    HStack(spacing: 0) {
      Button { openDrawer() } label: {
        Image(systemName: Symbol.menu).font(.system(size: 17, weight: .medium)).foregroundStyle(Palette.ink)
          .frame(width: 44, height: 44).contentShape(Rectangle())
      }
      .buttonStyle(.plain).accessibilityLabel(ConnectionCopy.drawerOpen)
      Spacer(minLength: 4)
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
      if refreshing {
        ProgressView().frame(width: 44, height: 44).accessibilityLabel(ConnectionCopy.refreshing)
      } else {
        PlainIcon(symbol: "arrow.clockwise", label: ConnectionCopy.refresh) { manualRefresh() }
      }
    }
    .padding(.horizontal, 8).padding(.top, 6).padding(.bottom, 4)
  }

  private var hostChip: some View {
    HStack(spacing: 7) {
      Circle().fill(run.hasConnection ? Palette.green : Palette.faint).frame(width: 7, height: 7)
      Text(targets.filterLabel).font(.system(size: 14, weight: .semibold)).lineLimit(1)
      Image(systemName: Symbol.chevrons).font(.system(size: 9, weight: .semibold)).foregroundStyle(Palette.muted)
    }
    .foregroundStyle(Palette.ink)
    .padding(.horizontal, 14).frame(minHeight: 36)
    .background(Palette.message, in: Capsule())
  }

  private var peek: some View {
    let rows = targets.homeSessions
    let waiting = rows.filter { row in
      guard let live = targets.store(for: row.scope).liveRun(
        providerId: row.session.providerId, cwd: row.session.cwd,
        externalSessionId: row.session.externalSessionId, agentProfileId: row.session.agentProfileId) else { return false }
      return targets.store(for: row.scope).openLiveQuestion(live) != nil
    }
    let waitingIds = Set(waiting.map(\.id))
    let recent = rows.filter { !waitingIds.contains($0.id) && $0.session.pinnedAt == nil }.prefix(3)
    return VStack(alignment: .leading, spacing: 0) {
      if !waiting.isEmpty {
        sectionTitle(ConnectionCopy.sectionNeedsYou)
        ForEach(waiting.prefix(2)) { row in
          SessionRowView(row: row, showsContext: true, aggregatesHosts: targets.aggregatesHosts,
                         onOpen: { open(row) }, onAction: { handle(row, $0) })
        }
      }
      if !recent.isEmpty {
        sectionTitle(ConnectionCopy.tabRecent)
        ForEach(Array(recent)) { row in
          SessionRowView(row: row, showsContext: true, aggregatesHosts: targets.aggregatesHosts,
                         onOpen: { open(row) }, onAction: { handle(row, $0) })
        }
        Button { openDrawer() } label: {
          Text(ConnectionCopy.seeAll).font(.system(size: 13, weight: .medium)).foregroundStyle(Palette.blue)
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading).contentShape(Rectangle())
        }.buttonStyle(.plain)
      } else if rows.isEmpty && !refreshing && run.hasConnection {
        EmptyState(title: ConnectionCopy.noRecent, detail: ConnectionCopy.noRecentDetail).padding(.top, 20)
      }
    }
    .padding(.horizontal, 19)
  }

  private var drawer: some View {
    HomeDrawer(tab: $drawerTab, expandedProjects: $expandedProjects,
               onClose: { closeDrawer() },
               onOpen: { row in closeDrawer(); open(row) },
               onNewTask: { scope, cwd in
                 closeDrawer()
                 guard targets.beginNewTask(scope: scope) else { return }
                 if let cwd { targets.newTaskStore.chooseProject(.init(path: cwd, label: projectName(cwd))) }
                 model.composerDraft(for: .newTask(scope)).wrappedValue = .init()
               },
               onRowAction: { row, action in handle(row, action) })
      .frame(width: drawerWidth)
      .frame(maxHeight: .infinity)
      .transition(.move(edge: .leading))
      .gesture(DragGesture(minimumDistance: 18).onEnded { value in
        if value.translation.width < -70 { closeDrawer() }
      })
  }

  private var drawerWidth: CGFloat {
    min(320, UIScreen.main.bounds.width * 0.84)
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

  private func openDrawer() {
    drawerOpen = true
    if run.hasConnection { Task { await targets.refreshHome() } }
    if !targets.homeSessions.isEmpty { _ = Task { await targets.localStore.refreshArchived() } }
  }
  private func closeDrawer() { drawerOpen = false }

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
    guard await targets.refreshHome(), !Task.isCancelled else { return }
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
              Text(ConnectionCopy.returnToTask(scope.label)).font(.system(size: 14, weight: .semibold))
              Text(store.hasUncertainSubmission ? ConnectionCopy.targetResultUnknown :
                   store.observationInterrupted ? ConnectionCopy.interruptedRun :
                   store.lifecycle == .submitting ? ConnectionCopy.sending : ConnectionCopy.running)
                .font(.system(size: 12)).foregroundStyle(Palette.muted)
            }
            Spacer()
            Image(systemName: "chevron.right")
          }.padding(14).background(Palette.noticeBg, in: RoundedRectangle(cornerRadius: 12))
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
                Text(pending.routing.prompt).font(.system(size: 15.5)).lineLimit(2)
                Text(pending.uncertainty != nil ? ConnectionCopy.targetResultUnknown :
                     pending.failure.map(ConnectionCopy.rejectedMessage) ??
                     ConnectionCopy.rowContext(host: nil, project: projectName(pending.routing.cwd), provider: pending.routing.providerId))
                  .font(.system(size: 11.5)).foregroundStyle(pending.failure == nil ? Palette.muted : Palette.negative).lineLimit(2)
              }
              Spacer(minLength: 8)
              if pending.uncertainty != nil {
                Button(ConnectionCopy.reconcileResult) { store.reconcileUncertain(intentId: pending.intentId) }
                  .font(.caption).frame(minHeight: 44)
              } else if pending.failure == nil {
                ProgressView().controlSize(.small).accessibilityLabel(ConnectionCopy.sending)
              } else {
                Button { store.discardRejectedSend(pending.intentId) } label: {
                  Image(systemName: "xmark").font(.system(size: 13, weight: .semibold)).frame(width: 44, height: 44)
                }.buttonStyle(.plain).foregroundStyle(Palette.muted).accessibilityLabel(ConnectionCopy.remove)
              }
            }.padding(.vertical, 12)
          }
        }.padding(.horizontal, 19)
      }
    }
  }

  private var notPairedEmpty: some View {
    VStack(spacing: 0) {
      EmptyState(title: ConnectionCopy.noMac, detail: ConnectionCopy.pairInstructions, symbol: Symbol.laptop)
      Button { model.route = .pair } label: {
        Text(ConnectionCopy.connectMac).font(.system(size: 15, weight: .semibold)).foregroundStyle(Palette.surface)
          .padding(.horizontal, 22).frame(minHeight: 46).background(Palette.ink, in: Capsule())
      }
    }.padding(.top, 24)
  }

  private func sectionTitle(_ title: String) -> some View {
    Text(title).font(.system(size: 11, weight: .bold)).tracking(0.6).foregroundStyle(Palette.muted)
      .frame(maxWidth: .infinity, alignment: .leading).padding(.top, 18).padding(.bottom, 2)
  }

  private func projectName(_ cwd: String) -> String { cwd.split(separator: "/").last.map(String.init) ?? cwd }
}

private struct CatalogRefreshBanner: View {
  let failure: RemoteRunStore.CatalogRefreshFailure
  let lastFullRefresh: Date?
  let refreshing: Bool
  var summary: String? = nil
  let onRetry: () -> Void
  let onDetails: () -> Void

  private var title: String { summary ?? failure.summary }

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
  var issues: [ExecutionTargetCoordinator.RefreshIssue] = []
  #if DEBUG
  @EnvironmentObject private var targets: ExecutionTargetCoordinator
  #endif
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
        Text(issues.isEmpty ? failure.technicalDetail : issues.map(\.diagnostic).joined(separator: "\n\n"))
          .font(.caption.monospaced()).foregroundStyle(Palette.muted)
          .textSelection(.enabled).padding(.top, 8)
      }
      Spacer()
    }.padding(20)
    #if DEBUG
    .accessibilityIdentifier(targets.lastFullRefresh == lastFullRefresh
      ? "catalog-refresh-details" : "catalog-refresh-details-updated")
    #endif
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
  @EnvironmentObject var targets: ExecutionTargetCoordinator
  @State private var confirmUnpair = false
  @State private var cacheNotice: String?
  @State private var showArchived = false

  var body: some View {
    VStack(spacing: 0) {
      RemoteHeader(title: ConnectionCopy.settings, backAction: { model.goBack() }) {
        Color.clear.frame(width: 44, height: 44)
      }
      List {
        Section(ConnectionCopy.connectionSection) {
          settingRow(Symbol.laptop, ConnectionCopy.pairedMac, model.statusText(),
                     trailing: model.link.isConnected ? Palette.green : Palette.faint) {
            model.route = .pair
          }
        }
        .listRowBackground(Palette.canvas)

        Section {
          VStack(alignment: .leading, spacing: 4) {
            Label(ConnectionCopy.localHistoryCache, systemImage: "internaldrive")
              .font(.system(size: 14.5, weight: .medium))
            Text(ConnectionCopy.localHistoryCacheSummary).font(.system(size: 11)).foregroundStyle(Palette.muted)
          }
          .padding(.vertical, 5)
          Button(run.historyCacheClearing ? ConnectionCopy.clearingHistoryCache : ConnectionCopy.clearHistoryCache) {
            Task {
              do {
                try await run.clearHistoryCache()
                cacheNotice = ConnectionCopy.historyCacheCleared
              } catch {
                cacheNotice = ConnectionCopy.historyCacheClearFailed(error.localizedDescription)
              }
            }
          }
          .disabled(run.historyCacheClearing).frame(minHeight: 44)
          if let cacheNotice {
            Text(cacheNotice).font(.caption).foregroundStyle(Palette.muted)
          }
        } header: {
          Text(ConnectionCopy.localDataSection)
        } footer: {
          Text(ConnectionCopy.localHistoryCachePolicy)
        }
        .listRowBackground(Palette.canvas)

        Section {
          Button { showArchived = true } label: {
            HStack(spacing: 12) {
              Image(systemName: Symbol.archive).font(.system(size: 17)).frame(width: 22)
              VStack(alignment: .leading, spacing: 3) {
                Text(ConnectionCopy.archivedSessions).font(.system(size: 14.5, weight: .medium))
                Text(ConnectionCopy.archivedSessionsDetail).font(.system(size: 11)).foregroundStyle(Palette.muted)
              }
              Spacer(minLength: 8)
              Image(systemName: Symbol.chevron).font(.system(size: 11, weight: .semibold)).foregroundStyle(Palette.faint)
            }
            .padding(.vertical, 4).frame(minHeight: 52).contentShape(Rectangle())
          }
          .buttonStyle(.plain).disabled(!run.hasConnection)
        } header: {
          Text(ConnectionCopy.tabRecent)
        } footer: {
          Text(ConnectionCopy.archivedPolicy)
        }
        .listRowBackground(Palette.canvas)

        Section(ConnectionCopy.securitySection) {
          settingRow(Symbol.link, ConnectionCopy.repairPairing, ConnectionCopy.repairPairingDetail) {
            model.route = .pair
          }
          if let error = model.destructiveActionError {
            Label(error, systemImage: "exclamationmark.circle")
              .font(.system(size: 12)).foregroundStyle(Palette.warnInk)
          }
          Button(role: .destructive) { confirmUnpair = true } label: {
            Text(ConnectionCopy.clearLocalPairing)
              .font(.system(size: 14, weight: .medium)).frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
          }
          .disabled(targets.hasPendingWork || targets.recoveryUnavailable || run.historyCacheClearing)
          if targets.recoveryUnavailable {
            Text(ConnectionCopy.targetRecoveryUnavailable).font(.caption).foregroundStyle(Palette.muted)
          } else if targets.hasPendingWork {
            Text(ConnectionCopy.pendingBeforeUnpair).font(.caption).foregroundStyle(Palette.muted)
          }
        }
        .listRowBackground(Palette.canvas)
      }
      .listStyle(.insetGrouped)
      .scrollContentBackground(.hidden)
      .listSectionSpacing(20)
      .tint(Palette.blue)
    }
    .background(Palette.surface)
    .sheet(isPresented: $showArchived) { ArchivedSessionsView().environmentObject(run) }
    .confirmationDialog(ConnectionCopy.clearPairingTitle, isPresented: $confirmUnpair, titleVisibility: .visible) {
      Button(ConnectionCopy.clearPairingAction, role: .destructive) { Task { await model.destructiveUnpair(runStore: run) } }
      Button(ConnectionCopy.cancel, role: .cancel) {}
    } message: {
      Text(ConnectionCopy.clearPairingMessage)
    }
  }

  private func settingRow(_ symbol: String, _ title: String, _ detail: String, trailing: Color? = nil,
                          action: @escaping () -> Void) -> some View {
    Button(action: action) {
      HStack(spacing: 12) {
        Image(systemName: symbol).font(.system(size: 17)).frame(width: 22)
        VStack(alignment: .leading, spacing: 3) {
          Text(title).font(.system(size: 14.5, weight: .medium))
          Text(detail).font(.system(size: 11)).foregroundStyle(Palette.muted).lineLimit(3)
        }
        Spacer(minLength: 8)
        if let trailing { Circle().fill(trailing).frame(width: 7, height: 7) }
        Image(systemName: Symbol.chevron).font(.system(size: 11, weight: .semibold)).foregroundStyle(Palette.faint)
      }
      .padding(.vertical, 4).frame(minHeight: 52).contentShape(Rectangle())
    }
    .buttonStyle(.plain)
  }
}
