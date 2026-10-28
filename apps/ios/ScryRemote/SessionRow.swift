import SwiftUI
import RemoteTransport

// Shared home row. The state column reads live evidence; catalog activity is
// explicitly historical. Context-menu actions retain the row's immutable scope.
struct SessionRowView: View {
  let row: ExecutionTargetCoordinator.HomeSession
  var activityOnly = false
  // A finished turn reported by the host, not a live or merely inactive session.
  // SPEC 4 gives it a dimmer title and the 44pt row height of a historical entry.
  var completed = false
  var showsProject = false
  let onOpen: () -> Void
  let onAction: (SessionRowAction) -> Void
  var indent: CGFloat = 0

  @Environment(ExecutionTargetCoordinator.self) private var targets

  private var session: G0Transport.RunSessionRef { row.session }
  private var store: RemoteRunStore { targets.store(for: row.scope) }
  private var openable: Bool { session.externalSessionId?.isEmpty == false }

  var body: some View {
    Button(action: onOpen) {
      HStack(spacing: 10) {
        Image(systemName: ProviderSymbol.name(session.providerId)).resizable().scaledToFit()
          .foregroundStyle(Palette.provider(session.providerId))
          .frame(width: 16, height: 16).accessibilityLabel(ConnectionCopy.providerLabel(session.providerId))
        Text(session.label.isEmpty ? ConnectionCopy.noPreview : session.label)
          .font(Typography.rowTitle).foregroundStyle(openable && !completed ? Palette.fg : Palette.dim)
          .lineLimit(1).frame(maxWidth: .infinity, alignment: .leading)
        stateBadge
        if showsProject {
          Text(projectName(session.cwd)).font(Typography.meta).foregroundStyle(Palette.dim2)
            .lineLimit(1).frame(width: 70, alignment: .trailing)
        }
      }
      .padding(.leading, indent).frame(minHeight: completed ? 44 : 48)
      .frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
    }
    .buttonStyle(HomeRowButtonStyle())
    .disabled(!openable)
    .contextMenu {
      rowActions
    }
    .accessibilityHint(openable ? "" : ConnectionCopy.noHostSession)
  }

  @ViewBuilder private var stateBadge: some View {
    if let live = store.liveRun(providerId: session.providerId, cwd: session.cwd,
                                externalSessionId: session.externalSessionId, agentProfileId: session.agentProfileId) {
      if store.openLiveQuestion(live) != nil {
        Text(ConnectionCopy.homeWaiting).font(Typography.meta.weight(.semibold)).foregroundStyle(Palette.warnText)
          .padding(.horizontal, 6).padding(.vertical, 3)
          .background(Palette.warn.opacity(0.12), in: RoundedRectangle(cornerRadius: 6))
      } else {
        RunningRing()
      }
    } else if !activityOnly {
      if session.isActive == true {
        Text(ConnectionCopy.lastRunning).font(Typography.meta).foregroundStyle(Palette.dim2)
      } else if !openable {
        Text(ConnectionCopy.noSession).font(Typography.meta).foregroundStyle(Palette.dim2)
      } else if !showsProject {
        Text(ConnectionCopy.relTime(session.ts))
          .font(Typography.meta).foregroundStyle(Palette.dim2).lineLimit(1)
      }
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

enum ProviderSymbol {
  static func name(_ id: String) -> String {
    switch id {
    case "claude": return "sun.max"
    case "codex": return "chevron.left.forwardslash.chevron.right"
    case "qoder": return "q.circle"
    case "opencode": return "terminal"
    case "pi": return "p.circle"
    default: return "cpu"
    }
  }
}

struct RunningRing: View {
  var size: CGFloat = 14
  var color: Color = Palette.dim
  var body: some View {
    TimelineView(.animation) { context in
      Circle().trim(from: 0, to: 0.75).stroke(color, style: StrokeStyle(lineWidth: 1.5, lineCap: .round))
        .rotationEffect(.degrees(context.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 0.9) / 0.9 * 360))
    }
    .frame(width: size, height: size).accessibilityLabel(ConnectionCopy.running)
  }
}

struct HomeRowButtonStyle: ButtonStyle {
  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .contentShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
      .background(configuration.isPressed ? Palette.hover : .clear,
                  in: RoundedRectangle(cornerRadius: 10, style: .continuous))
  }
}

enum SessionRowAction: Equatable {
  case pin(Bool)
  case rename
  // `running` decides whether the confirmation says the run will be stopped.
  case archive(Bool)
}

// Archived sessions keep their restore/delete controls in the existing sheet.
struct ArchivedSessionRowView: View {
  let session: G0Transport.RunSessionRef
  let onRestore: () -> Void
  let onDelete: () -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      Text(session.label.isEmpty ? ConnectionCopy.noPreview : session.label)
        .font(.system(size: 15.5)).foregroundStyle(Palette.fg).lineLimit(2)
      Text(ConnectionCopy.rowContext(host: nil,
                                     project: session.cwd.split(separator: "/").last.map(String.init) ?? session.cwd,
                                     provider: session.providerId))
        .font(.system(size: 11.5)).foregroundStyle(Palette.dim).lineLimit(1)
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
