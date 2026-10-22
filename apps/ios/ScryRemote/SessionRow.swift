import SwiftUI
import RemoteTransport

// One row projection for the home peek and the drawer list. Row actions are the
// host's session actions; a local optimistic state is never shown, so the row
// always describes what the Mac last confirmed.
struct SessionRowView: View {
  let row: ExecutionTargetCoordinator.HomeSession
  let showsContext: Bool
  let aggregatesHosts: Bool
  let onOpen: () -> Void
  let onAction: (SessionRowAction) -> Void
  var indent: CGFloat = 0

  @EnvironmentObject private var targets: ExecutionTargetCoordinator

  private var session: G0Transport.RunSessionRef { row.session }
  private var store: RemoteRunStore { targets.store(for: row.scope) }
  private var openable: Bool { session.externalSessionId?.isEmpty == false }

  var body: some View {
    Button(action: onOpen) {
      HStack(alignment: .top, spacing: 10) {
        VStack(alignment: .leading, spacing: 4) {
          Text(session.label.isEmpty ? ConnectionCopy.noPreview : session.label)
            .font(.system(size: 15.5)).foregroundStyle(openable ? Palette.ink : Palette.muted)
            .lineLimit(2).multilineTextAlignment(.leading)
          if showsContext {
            Text(ConnectionCopy.rowContext(host: aggregatesHosts ? row.scope.label : nil,
                                           project: projectName(session.cwd), provider: session.providerId))
              .font(.system(size: 11.5)).foregroundStyle(Palette.muted).lineLimit(1)
          }
        }
        Spacer(minLength: 8)
        stateBadge
      }
      .padding(.leading, indent).padding(.vertical, 12)
      .frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .disabled(!openable)
    .contextMenu {
      rowActions
    }
    .accessibilityHint(openable ? "" : ConnectionCopy.noHostSession)
  }

  @ViewBuilder private var stateBadge: some View {
    if let live = store.liveRun(providerId: session.providerId, cwd: session.cwd,
                                externalSessionId: session.externalSessionId, agentProfileId: session.agentProfileId) {
      LiveRunBadge(live: live, waiting: store.openLiveQuestion(live) != nil)
    } else if session.isActive == true {
      Text(ConnectionCopy.lastRunning).font(.system(size: 10, weight: .semibold)).foregroundStyle(Palette.muted)
    } else if !openable {
      Text(ConnectionCopy.noSession).font(.system(size: 10)).foregroundStyle(Palette.muted)
    }
  }

  @ViewBuilder private var rowActions: some View {
    if openable {
      Button { onAction(.pin(session.pinnedAt == nil)) } label: {
        Label(session.pinnedAt == nil ? ConnectionCopy.actionPin : ConnectionCopy.actionUnpin, systemImage: Symbol.pin)
      }
      Button { onAction(.rename) } label: { Label(ConnectionCopy.actionRename, systemImage: Symbol.compose) }
      Button(role: .destructive) {
        onAction(.archive(store.liveRun(providerId: session.providerId, cwd: session.cwd,
                                        externalSessionId: session.externalSessionId,
                                        agentProfileId: session.agentProfileId) != nil))
      } label: {
        Label(isRunning ? ConnectionCopy.actionArchiveAndStop : ConnectionCopy.actionArchive,
              systemImage: Symbol.archive)
      }
    } else {
      Text(ConnectionCopy.noHostSession)
    }
  }

  private var isRunning: Bool {
    store.liveRun(providerId: session.providerId, cwd: session.cwd,
                  externalSessionId: session.externalSessionId, agentProfileId: session.agentProfileId) != nil
  }

  private func projectName(_ cwd: String) -> String {
    cwd.split(separator: "/").last.map(String.init) ?? cwd
  }
}

enum SessionRowAction: Equatable {
  case pin(Bool)
  case rename
  // `running` decides whether the confirmation says the run will be stopped.
  case archive(Bool)
}

// The drawer shows the same row for an archived session, with restore/delete.
struct ArchivedSessionRowView: View {
  let session: G0Transport.RunSessionRef
  let onRestore: () -> Void
  let onDelete: () -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      Text(session.label.isEmpty ? ConnectionCopy.noPreview : session.label)
        .font(.system(size: 15.5)).foregroundStyle(Palette.ink).lineLimit(2)
      Text(ConnectionCopy.rowContext(host: nil,
                                     project: session.cwd.split(separator: "/").last.map(String.init) ?? session.cwd,
                                     provider: session.providerId))
        .font(.system(size: 11.5)).foregroundStyle(Palette.muted).lineLimit(1)
      HStack(spacing: 16) {
        Button(ConnectionCopy.actionRestore, action: onRestore)
          .font(.system(size: 13, weight: .semibold)).frame(minHeight: 44)
        Button(ConnectionCopy.actionDelete, role: .destructive, action: onDelete)
          .font(.system(size: 13, weight: .semibold)).frame(minHeight: 44)
      }
    }
    .padding(.vertical, 8).frame(maxWidth: .infinity, alignment: .leading)
  }
}
