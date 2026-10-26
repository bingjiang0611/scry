import SwiftUI

struct SettingsView: View {
  @EnvironmentObject var model: AppModel
  @Environment(RemoteRunStore.self) var run
  @Environment(ExecutionTargetCoordinator.self) var targets
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
                     trailing: model.link.isConnected ? Palette.ok : Palette.dim2) {
            model.route = .pair
          }
        }
        .listRowBackground(Palette.panel2)

        Section {
          VStack(alignment: .leading, spacing: 4) {
            Label(ConnectionCopy.localHistoryCache, systemImage: "internaldrive")
              .font(.system(size: 14.5, weight: .medium))
            Text(ConnectionCopy.localHistoryCacheSummary).font(.system(size: 11)).foregroundStyle(Palette.dim)
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
            Text(cacheNotice).font(.caption).foregroundStyle(Palette.dim)
          }
        } header: {
          Text(ConnectionCopy.localDataSection)
        } footer: {
          Text(ConnectionCopy.localHistoryCachePolicy)
        }
        .listRowBackground(Palette.panel2)

        Section {
          Button { showArchived = true } label: {
            HStack(spacing: 12) {
              Image(systemName: Symbol.archive).font(.system(size: 17)).frame(width: 22)
              VStack(alignment: .leading, spacing: 3) {
                Text(ConnectionCopy.archivedSessions).font(.system(size: 14.5, weight: .medium))
                Text(ConnectionCopy.archivedSessionsDetail).font(.system(size: 11)).foregroundStyle(Palette.dim)
              }
              Spacer(minLength: 8)
              Image(systemName: Symbol.chevron).font(.system(size: 11, weight: .semibold)).foregroundStyle(Palette.dim2)
            }
            .padding(.vertical, 4).frame(minHeight: 52).contentShape(Rectangle())
          }
          .buttonStyle(.plain).disabled(!run.hasConnection)
        } header: {
          Text(ConnectionCopy.tabRecent)
        } footer: {
          Text(ConnectionCopy.archivedPolicy)
        }
        .listRowBackground(Palette.panel2)

        Section(ConnectionCopy.securitySection) {
          settingRow(Symbol.link, ConnectionCopy.repairPairing, ConnectionCopy.repairPairingDetail) {
            model.route = .pair
          }
          if let error = model.destructiveActionError {
            Label(error, systemImage: "exclamationmark.circle")
              .font(.system(size: 12)).foregroundStyle(Palette.warn)
          }
          Button(role: .destructive) { confirmUnpair = true } label: {
            Text(ConnectionCopy.clearLocalPairing)
              .font(.system(size: 14, weight: .medium)).frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
          }
          .disabled(targets.hasPendingWork || targets.recoveryUnavailable || run.historyCacheClearing)
          if targets.recoveryUnavailable {
            Text(ConnectionCopy.targetRecoveryUnavailable).font(.caption).foregroundStyle(Palette.dim)
          } else if targets.hasPendingWork {
            Text(ConnectionCopy.pendingBeforeUnpair).font(.caption).foregroundStyle(Palette.dim)
          }
        }
        .listRowBackground(Palette.panel2)
      }
      .listStyle(.insetGrouped)
      .scrollContentBackground(.hidden)
      .listSectionSpacing(20)
      .tint(Palette.accent)
    }
    .background(Palette.main)
    .sheet(isPresented: $showArchived) { ArchivedSessionsView().environment(run) }
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
          Text(detail).font(.system(size: 11)).foregroundStyle(Palette.dim).lineLimit(3)
        }
        Spacer(minLength: 8)
        if let trailing { Circle().fill(trailing).frame(width: 7, height: 7) }
        Image(systemName: Symbol.chevron).font(.system(size: 11, weight: .semibold)).foregroundStyle(Palette.dim2)
      }
      .padding(.vertical, 4).frame(minHeight: 52).contentShape(Rectangle())
    }
    .buttonStyle(.plain)
  }
}
