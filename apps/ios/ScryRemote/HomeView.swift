import SwiftUI
import RemoteTransport

// Details describe one request, not the next background refresh or pairing.
struct CatalogRefreshDetailsSnapshot: Identifiable {
  let id = UUID()
  let failure: RemoteRunStore.CatalogRefreshFailure
  let lastFullRefresh: Date?
  let address: String?
  let paired: Bool
}

// One projection for local and forwarded rows: all navigation keeps the row's
// immutable scope, including when two hosts expose identical session ids.
struct HomeView: View {
  @EnvironmentObject var model: AppModel
  @EnvironmentObject var run: RemoteRunStore
  @EnvironmentObject var targets: ExecutionTargetCoordinator
  @State private var pinnedExpanded = true
  @State private var refreshToastVisible = false
  @State private var refreshDetails: CatalogRefreshDetailsSnapshot?
  @State private var manualRefreshing = false
  @State private var refreshToastID = 0
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  private var failure: RemoteRunStore.CatalogRefreshFailure? {
    for scope in targets.visibleScopes {
      if let failure = targets.store(for: scope).catalogRefreshFailure { return failure }
    }
    return targets.homeFailure
  }
  private var refreshing: Bool { targets.homeLoading || manualRefreshing }
  private var filtered: [ExecutionTargetCoordinator.HomeSession] {
    let needle = model.query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    return targets.homeSessions.filter {
      needle.isEmpty || [$0.session.label, $0.session.cwd, $0.session.providerId, $0.scope.label]
        .contains { $0.lowercased().contains(needle) }
    }
  }

  var body: some View {
    let rows = filtered
    VStack(spacing: 0) {
      RemoteHeader(title: ConnectionCopy.homeTitle, subtitle: targets.aggregatesHosts ? targets.filterLabel : nil,
                   menuAction: { model.route = .settings }) {
        HStack(spacing: 0) {
          if refreshing {
            ProgressView().frame(width: 44, height: 44).accessibilityLabel(ConnectionCopy.refreshing)
          } else {
            PlainIcon(symbol: "arrow.clockwise", label: ConnectionCopy.refresh) { manualRefresh() }
          }
          MoreMenu {
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
          }
        }
      }
      if let failure { refreshFailure(failure) }
      ScrollView {
        currentTasks
        backgroundSends
        if targets.visibleScopes.contains(where: { if case .unverifiedCache = targets.store(for: $0).catalogEvidence { return true }; return false }), failure == nil {
          Text(ConnectionCopy.unverifiedCache).font(.caption).foregroundStyle(Palette.muted)
            .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 19).padding(.top, 10)
        }
        ForEach(targets.visibleScopes) { scope in liveRuns(scope: scope) }
        if !rows.isEmpty { sessionSections(rows) }
        else if !run.hasConnection { notPairedEmpty }
        else if refreshing { ProgressView(ConnectionCopy.readingSessions).frame(maxWidth: .infinity).padding(.top, 52) }
        else if !model.query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
          EmptyState(title: ConnectionCopy.noMatches, detail: ConnectionCopy.changeSearch).padding(.top, 24)
        } else if failure == nil {
          EmptyState(title: ConnectionCopy.noSessions, detail: ConnectionCopy.createFirstTask).padding(.top, 24)
        }
      }
      .scrollIndicators(.hidden).scrollDismissesKeyboard(.interactively)
      .refreshable { await showManualRefresh() }
      dock
    }
    .background(Palette.surface)
    .overlay(alignment: .top) {
      if refreshToastVisible && failure == nil {
        Text(ConnectionCopy.refreshSuccess).font(.footnote.weight(.semibold))
          .foregroundStyle(Palette.surface).padding(.horizontal, 16).frame(minHeight: 36)
          .background(Palette.ink, in: Capsule()).padding(.top, 64).transition(.opacity)
      }
    }
    .animation(reduceMotion ? nil : .easeInOut(duration: 0.18), value: refreshToastVisible)
    .task(id: refreshToastID) {
      guard refreshToastVisible else { return }
      do { try await Task.sleep(for: .milliseconds(2_600)) } catch { return }
      refreshToastVisible = false
    }
    .onDisappear { refreshToastVisible = false }
    .sheet(item: $refreshDetails) { details in
      CatalogRefreshDetails(failure: details.failure, lastFullRefresh: details.lastFullRefresh,
                            address: details.address, paired: details.paired)
        .presentationDetents([.medium, .large])
        #if DEBUG
        .task {
          if ProcessInfo.processInfo.arguments.contains("-uiResolveRefreshDetails"), run.prepareRefreshDetailsFixture() {
            await targets.refreshHome()
          }
        }
        #endif
    }
    .task { if run.hasConnection { await targets.refreshHome() } }
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
    return CatalogRefreshBanner(failure: failure, lastFullRefresh: lastFullRefresh, refreshing: refreshing,
      onRetry: { if failure.requiresPairing { model.route = .pair } else { manualRefresh() } },
      onDetails: {
        refreshDetails = CatalogRefreshDetailsSnapshot(failure: failure, lastFullRefresh: lastFullRefresh,
                                                       address: address, paired: paired)
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
              Text(ConnectionCopy.returnToTask(scope.label)).font(.subheadline.weight(.semibold))
              Text(store.hasUncertainSubmission ? ConnectionCopy.targetResultUnknown :
                   store.observationInterrupted ? ConnectionCopy.interruptedRun :
                   store.lifecycle == .submitting ? ConnectionCopy.sending : ConnectionCopy.running)
                .font(.caption).foregroundStyle(Palette.muted)
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
                Text(pending.routing.prompt).font(.body).lineLimit(2)
                Text(pending.uncertainty != nil ? ConnectionCopy.targetResultUnknown :
                     pending.failure.map(ConnectionCopy.rejectedMessage) ??
                     ConnectionCopy.rowContext(host: nil, project: projectName(pending.routing.cwd), provider: pending.routing.providerId))
                  .font(.caption).foregroundStyle(pending.failure == nil ? Palette.muted : Palette.negative).lineLimit(2)
              }
              Spacer(minLength: 8)
              if pending.uncertainty != nil {
                Button(ConnectionCopy.reconcileResult) { store.reconcileUncertain(intentId: pending.intentId) }
                  .font(.caption).frame(minHeight: 44)
              } else if pending.failure == nil {
                ProgressView().controlSize(.small).accessibilityLabel(ConnectionCopy.sending)
              } else {
                Button { store.discardRejectedSend(pending.intentId) } label: {
                  Image(systemName: "xmark").font(.footnote.weight(.semibold)).controlIconScale().frame(width: 44, height: 44)
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
        Text(ConnectionCopy.connectMac).font(.subheadline.weight(.semibold)).foregroundStyle(Palette.surface)
          .padding(.horizontal, 22).frame(minHeight: 46).background(Palette.ink, in: Capsule())
      }
    }.padding(.top, 24)
  }

  private struct ProjectKey: Hashable { let scope: ExecutionTargetScope; let cwd: String }
  private struct ProjectGroup: Identifiable {
    let scope: ExecutionTargetScope
    let cwd: String
    let sessions: [ExecutionTargetCoordinator.HomeSession]
    var id: ProjectKey { .init(scope: scope, cwd: cwd) }
  }
  private func groupedByProject(_ rows: [ExecutionTargetCoordinator.HomeSession]) -> [ProjectGroup] {
    var order: [ProjectKey] = []
    var groups: [ProjectKey: [ExecutionTargetCoordinator.HomeSession]] = [:]
    for row in rows {
      let key = ProjectKey(scope: row.scope, cwd: row.session.cwd)
      if groups[key] == nil { order.append(key) }
      groups[key, default: []].append(row)
    }
    return order.compactMap { key in
      guard let rows = groups[key], let first = rows.first else { return nil }
      return ProjectGroup(scope: first.scope, cwd: first.session.cwd, sessions: rows)
    }
  }
  private func sessionSections(_ rows: [ExecutionTargetCoordinator.HomeSession]) -> some View {
    let pinned = rows.filter { $0.session.pinnedAt != nil }.sorted { ($0.session.pinnedAt ?? 0) > ($1.session.pinnedAt ?? 0) }
    let regular = rows.filter { $0.session.pinnedAt == nil }
    return LazyVStack(alignment: .leading, spacing: 0) {
      if !model.query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
        sectionTitle(ConnectionCopy.searchResults)
        ForEach(rows) { sessionRow($0) }
      } else {
        if !pinned.isEmpty {
          Button { withAnimation(.easeInOut(duration: 0.18)) { pinnedExpanded.toggle() } } label: {
            HStack(spacing: 7) {
              Text(ConnectionCopy.pinned).font(.title3.weight(.semibold))
              Image(systemName: "chevron.down").font(.caption2.weight(.semibold)).controlIconScale()
                .rotationEffect(.degrees(pinnedExpanded ? 0 : -90)).foregroundStyle(Palette.muted)
              Spacer()
            }.frame(minHeight: 44).contentShape(Rectangle())
          }.buttonStyle(.plain)
          if pinnedExpanded { ForEach(pinned) { sessionRow($0) } }
        }
        if !regular.isEmpty {
          sectionTitle(ConnectionCopy.projects).padding(.top, pinned.isEmpty ? 4 : 20)
          ForEach(groupedByProject(regular)) { group in
            projectHeader(group)
            ForEach(group.sessions) { sessionRow($0, indent: 20, grouped: true) }
          }
        }
      }
    }.padding(.horizontal, 19).padding(.bottom, 24)
  }
  private func sectionTitle(_ title: String) -> some View {
    Text(title).font(.title3.weight(.semibold)).frame(maxWidth: .infinity, alignment: .leading)
      .padding(.top, 17).padding(.bottom, 7)
  }
  private func projectHeader(_ group: ProjectGroup) -> some View {
    HStack(spacing: 11) {
      Image(systemName: Symbol.folder).font(.title3.weight(.medium)).controlIconScale().frame(width: 25)
      Text(ConnectionCopy.rowContext(host: targets.aggregatesHosts ? group.scope.label : nil,
                                    project: projectName(group.cwd), provider: ""))
        .font(.body.weight(.semibold)).lineLimit(2)
      Spacer()
      Button {
        guard targets.beginNewTask(scope: group.scope) else { return }
        targets.newTaskStore.chooseProject(.init(path: group.cwd, label: projectName(group.cwd)))
        model.route = .newSession
      } label: {
        Image(systemName: Symbol.compose).font(.body.weight(.medium)).controlIconScale().foregroundStyle(Palette.muted)
          .frame(width: 44, height: 44)
      }.buttonStyle(.plain).accessibilityLabel(ConnectionCopy.newTaskInProject(projectName(group.cwd)))
    }.frame(minHeight: 52)
  }
  private func sessionRow(_ row: ExecutionTargetCoordinator.HomeSession, indent: CGFloat = 0,
                          grouped: Bool = false) -> some View {
    let session = row.session
    let store = targets.store(for: row.scope)
    let openable = session.externalSessionId?.isEmpty == false
    return Button {
      guard let external = session.externalSessionId, openable else { return }
      targets.select(row.scope)
      model.open(OpenedSession(providerId: session.providerId, agentProfileId: session.agentProfileId, cwd: session.cwd,
        externalSessionId: external, label: session.label, isActive: session.isActive == true, scope: row.scope.isLocal ? nil : row.scope), run: store)
    } label: {
      HStack(alignment: .top, spacing: 10) {
        if grouped {
          Text(session.label.isEmpty ? ConnectionCopy.noPreview : session.label)
            .font(.body).foregroundStyle(openable ? Palette.ink : Palette.muted).lineLimit(2)
          Spacer(minLength: 8)
          VStack(alignment: .trailing, spacing: 5) {
            Text(session.providerId.uppercased()).font(.caption2.weight(.semibold)).foregroundStyle(Palette.muted)
            sessionState(session: session, store: store, openable: openable)
          }
        } else {
          VStack(alignment: .leading, spacing: 4) {
            Text(session.label.isEmpty ? ConnectionCopy.noPreview : session.label)
              .font(.body).foregroundStyle(openable ? Palette.ink : Palette.muted).lineLimit(2)
            Text(ConnectionCopy.rowContext(host: targets.aggregatesHosts ? row.scope.label : nil,
                                          project: projectName(session.cwd), provider: session.providerId))
              .font(.caption).foregroundStyle(Palette.muted).lineLimit(2)
          }
          Spacer(minLength: 8)
          sessionState(session: session, store: store, openable: openable)
        }
      }.padding(.leading, indent).padding(.vertical, 13).frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
    }.buttonStyle(.plain).disabled(!openable)
  }

  @ViewBuilder private func sessionState(session: G0Transport.RunSessionRef, store: RemoteRunStore,
                                          openable: Bool) -> some View {
    if let live = store.liveRun(providerId: session.providerId, cwd: session.cwd,
                                externalSessionId: session.externalSessionId, agentProfileId: session.agentProfileId) {
      LiveRunBadge(live: live, waiting: store.openLiveQuestion(live) != nil)
    } else if session.isActive == true {
      Text(ConnectionCopy.lastRunning).font(.caption2.weight(.semibold)).foregroundStyle(Palette.muted)
    } else if !openable {
      Text(ConnectionCopy.noSession).font(.caption2).foregroundStyle(Palette.muted)
    }
  }
  @ViewBuilder private func liveRuns(scope: ExecutionTargetScope) -> some View {
    let store = targets.store(for: scope)
    let listed = Set(targets.homeSessions.filter { $0.scope == scope }.compactMap { row -> RemoteRunStore.SessionIdentity? in
      guard let external = row.session.externalSessionId else { return nil }
      return .opened(providerId: row.session.providerId, agentProfileId: row.session.agentProfileId,
                     cwd: row.session.cwd, externalSessionId: external, scope: scope)
    })
    let unlisted = store.liveRuns.filter { live in
      guard let external = live.externalSessionId else { return true }
      return !listed.contains(.opened(providerId: live.providerId, agentProfileId: live.agentProfileId,
                                      cwd: live.cwd, externalSessionId: external, scope: scope))
    }
    if !unlisted.isEmpty {
      VStack(alignment: .leading, spacing: 0) {
        sectionTitle(ConnectionCopy.activeRuns)
        ForEach(unlisted) { live in
          Button {
            guard let external = live.externalSessionId else { return }
            targets.select(scope)
            model.open(OpenedSession(providerId: live.providerId, agentProfileId: live.agentProfileId, cwd: live.cwd,
              externalSessionId: external, label: live.prompt, isActive: true, scope: scope.isLocal ? nil : scope), run: store)
          } label: {
            HStack {
              VStack(alignment: .leading, spacing: 4) {
                Text(live.prompt.isEmpty ? ConnectionCopy.noPreview : live.prompt).font(.body).lineLimit(2)
                Text(ConnectionCopy.rowContext(host: targets.aggregatesHosts ? scope.label : nil,
                                              project: projectName(live.cwd), provider: live.providerId))
                  .font(.caption).foregroundStyle(Palette.muted).lineLimit(2)
              }
              Spacer()
              if live.externalSessionId == nil { Text(ConnectionCopy.starting).font(.caption2).foregroundStyle(Palette.muted) }
              else { LiveRunBadge(live: live, waiting: store.openLiveQuestion(live) != nil) }
            }.padding(.vertical, 12).frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
          }.buttonStyle(.plain).disabled(live.externalSessionId == nil)
        }
      }.padding(.horizontal, 19)
    }
  }
  private var dock: some View {
    HStack(spacing: 9) {
      HStack(spacing: 9) {
        Image(systemName: Symbol.search).font(.subheadline).foregroundStyle(Palette.muted)
        TextField(ConnectionCopy.searchSessions, text: $model.query).font(.body)
          .textInputAutocapitalization(.never).autocorrectionDisabled()
      }.padding(.horizontal, 15).frame(minHeight: 48).glass(cornerRadius: 24)
      CircleButton(symbol: Symbol.plus, label: ConnectionCopy.newTask, filled: true, disabled: !run.hasConnection) {
        if targets.beginNewTask() { model.route = .newSession }
      }
    }.padding(.horizontal, 18).padding(.top, 12).padding(.bottom, 16).background(Palette.surface)
  }
  private func projectName(_ cwd: String) -> String { cwd.split(separator: "/").last.map(String.init) ?? cwd }
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
        Image(systemName: "exclamationmark.circle").font(.subheadline.weight(.medium)).padding(.top, 1)
        VStack(alignment: .leading, spacing: 3) {
          Text(title).font(.footnote.weight(.semibold))
          Text(ConnectionCopy.lastFullRefresh(lastFullRefresh)).font(.caption)
        }
        Spacer(minLength: 4)
      }
      HStack(spacing: 16) {
        Button(failure.requiresPairing ? ConnectionCopy.pairAgain : ConnectionCopy.retry, action: onRetry)
          .font(.caption.weight(.semibold)).frame(minWidth: 44, minHeight: 44).disabled(refreshing)
        Button(ConnectionCopy.details, action: onDetails).font(.caption.weight(.medium))
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
        Text(failure.technicalDetail).font(.caption.monospaced()).foregroundStyle(Palette.muted)
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
    Text(origin + text).font(.caption2.weight(.semibold)).foregroundStyle(color)
  }
}

struct SettingsView: View {
  @EnvironmentObject var model: AppModel
  @EnvironmentObject var run: RemoteRunStore
  @EnvironmentObject var targets: ExecutionTargetCoordinator
  @State private var confirmUnpair = false
  @State private var cacheNotice: String?

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
              .font(.body.weight(.medium))
            Text(ConnectionCopy.localHistoryCacheSummary).font(.footnote).foregroundStyle(Palette.muted)
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
            Text(cacheNotice).font(.footnote).foregroundStyle(Palette.muted)
          }
        } header: {
          Text(ConnectionCopy.localDataSection)
        } footer: {
          Text(ConnectionCopy.localHistoryCachePolicy)
        }
        .listRowBackground(Palette.canvas)

        Section(ConnectionCopy.securitySection) {
          settingRow(Symbol.link, ConnectionCopy.repairPairing, ConnectionCopy.repairPairingDetail) {
            model.route = .pair
          }
          if let error = model.destructiveActionError {
            Label(error, systemImage: "exclamationmark.circle")
              .font(.footnote).foregroundStyle(Palette.warnInk)
          }
          Button(role: .destructive) { confirmUnpair = true } label: {
            Text(ConnectionCopy.clearLocalPairing)
              .font(.body.weight(.medium)).frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
          }
          .disabled(targets.hasPendingWork || targets.recoveryUnavailable || run.historyCacheClearing)
          if targets.recoveryUnavailable {
            Text(ConnectionCopy.targetRecoveryUnavailable).font(.footnote).foregroundStyle(Palette.muted)
          } else if targets.hasPendingWork {
            Text(ConnectionCopy.pendingBeforeUnpair).font(.footnote).foregroundStyle(Palette.muted)
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
        Image(systemName: symbol).font(.body).controlIconScale().frame(width: 22)
        VStack(alignment: .leading, spacing: 3) {
          Text(title).font(.body.weight(.medium))
          Text(detail).font(.footnote).foregroundStyle(Palette.muted).lineLimit(3)
        }
        Spacer(minLength: 8)
        if let trailing { Circle().fill(trailing).frame(width: 7, height: 7) }
        Image(systemName: Symbol.chevron).font(.caption.weight(.semibold)).controlIconScale().foregroundStyle(Palette.faint)
      }
      .padding(.vertical, 4).frame(minHeight: 52).contentShape(Rectangle())
    }
    .buttonStyle(.plain)
  }
}
