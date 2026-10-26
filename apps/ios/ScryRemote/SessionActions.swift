import SwiftUI
import RemoteTransport

// Row actions are host actions. This center holds only the in-flight request and
// the host's answer: a row is never shown as pinned/renamed/archived until the
// Mac applied it and the catalog was re-read.
@MainActor
final class SessionActionCenter: ObservableObject {
  struct Target: Identifiable {
    let id = UUID()
    let session: G0Transport.RunSessionRef
    var running = false
  }
  struct Toast: Equatable, Identifiable {
    let id: Int
    let text: String
    var undoable = false
  }

  @Published var renameTarget: Target?
  @Published var renameText = ""
  @Published var archiveTarget: Target?
  @Published var deleteTarget: Target?
  @Published var toast: Toast?
  @Published var failure: String?
  @Published private(set) var busy = false

  private var toastID = 0
  private var undoSession: G0Transport.RunSessionRef?

  func dispatch(_ action: SessionRowAction, session: G0Transport.RunSessionRef, run: RemoteRunStore) {
    switch action {
    case let .pin(pinned):
      Task { await apply(run) { await run.setPinned(session, pinned: pinned) } success: {
        self.show(ConnectionCopy.sessionActionApplied(pinned ? ConnectionCopy.actionPin : ConnectionCopy.actionUnpin))
      } }
    case .rename:
      renameText = session.label
      renameTarget = Target(session: session)
    case let .archive(running):
      if running {
        archiveTarget = Target(session: session, running: true)
      } else {
        Task { await setArchived(session, true, run: run) }
      }
    }
  }

  func confirmArchive(run: RemoteRunStore) {
    guard let target = archiveTarget else { return }
    archiveTarget = nil
    Task { await setArchived(target.session, true, run: run) }
  }

  func confirmRename(run: RemoteRunStore) {
    guard let target = renameTarget else { return }
    renameTarget = nil
    let title = renameText
    Task {
      await apply(run) { await run.renameSession(target.session, title: title) } success: {
        self.show(ConnectionCopy.sessionActionApplied(ConnectionCopy.actionRename))
      }
    }
  }

  func confirmDelete(run: RemoteRunStore) {
    guard let target = deleteTarget else { return }
    deleteTarget = nil
    Task {
      await apply(run) { await run.deleteArchivedSession(target.session) } success: {
        self.show(ConnectionCopy.actionDelete, undoable: false)
      }
    }
  }

  func restore(_ session: G0Transport.RunSessionRef, run: RemoteRunStore) {
    Task { await setArchived(session, false, run: run, message: ConnectionCopy.restoredToast) }
  }

  func undoArchive(run: RemoteRunStore) {
    guard let session = undoSession else { return }
    undoSession = nil
    toast = nil
    Task { await setArchived(session, false, run: run, message: ConnectionCopy.restoredToast) }
  }

  func dismissToast() {
    toast = nil
    undoSession = nil
  }

  private func setArchived(_ session: G0Transport.RunSessionRef, _ archived: Bool, run: RemoteRunStore,
                           message: String? = nil) async {
    await apply(run) { await run.setArchived(session, archived: archived) } success: {
      self.undoSession = archived ? session : nil
      self.show(message ?? (archived ? ConnectionCopy.archivedToast : ConnectionCopy.restoredToast), undoable: archived)
    }
  }

  private func apply(_ run: RemoteRunStore, _ operation: () async -> String?, success: () -> Void) async {
    guard !busy else { return }
    busy = true
    failure = nil
    let message = await operation()
    busy = false
    if let message { failure = ConnectionCopy.sessionActionFailed(message) } else { success() }
  }

  private func show(_ text: String, undoable: Bool = false) {
    toastID += 1
    let id = toastID
    toast = Toast(id: id, text: text, undoable: undoable)
    Task { [weak self] in
      try? await Task.sleep(for: .seconds(5))
      guard let self, self.toast?.id == id else { return }
      self.toast = nil
      self.undoSession = nil
    }
  }
}

struct SessionActionToast: View {
  let toast: SessionActionCenter.Toast
  let onUndo: () -> Void
  let onDismiss: () -> Void

  var body: some View {
    HStack(spacing: 12) {
      Text(toast.text).font(.system(size: 13, weight: .semibold)).foregroundStyle(Palette.main)
      if toast.undoable {
        Button(ConnectionCopy.undo, action: onUndo).font(.system(size: 13, weight: .semibold))
          .foregroundStyle(Palette.main).frame(minHeight: 44)
      }
      Button(action: onDismiss) {
        Image(systemName: "xmark").font(.system(size: 12, weight: .semibold))
          .foregroundStyle(Palette.main.opacity(0.7)).frame(width: 34, height: 44)
      }
      .buttonStyle(.plain).accessibilityLabel(ConnectionCopy.cancel)
    }
    .padding(.horizontal, 16).padding(.vertical, 2)
    .background(Palette.fg, in: Capsule())
    .padding(.bottom, 12)
  }
}
