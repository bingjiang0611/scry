import SwiftUI
import RemoteTransport

// Archived sessions are read from the host on demand. Restore is reversible;
// permanent delete asks first and reports what the Mac actually removed.
struct ArchivedSessionsView: View {
  @EnvironmentObject var run: RemoteRunStore
  @StateObject private var actions = SessionActionCenter()
  @Environment(\.dismiss) private var dismiss
  @State private var confirmDelete: G0Transport.RunSessionRef?

  private var rows: [G0Transport.RunSessionRef] {
    if case let .loaded(list) = run.archivedCatalog { return list }
    return []
  }

  var body: some View {
    VStack(spacing: 0) {
      header
      ScrollView {
        VStack(alignment: .leading, spacing: 0) {
          provenance
          if let failure = run.archivedFailure {
            Notice(text: "\(ConnectionCopy.panelLoadFailed)：\(failure)", warning: true)
              .padding(.top, 10)
          }
          switch run.archivedCatalog {
          case .idle, .loading:
            ProgressView(ConnectionCopy.readingSessions).frame(maxWidth: .infinity).padding(.top, 44)
          case .failed:
            EmptyState(title: ConnectionCopy.archivedEmpty, detail: ConnectionCopy.archivedPolicy, symbol: Symbol.archive)
              .padding(.top, 24)
          case .empty:
            EmptyState(title: ConnectionCopy.archivedEmpty, detail: ConnectionCopy.archivedPolicy, symbol: Symbol.archive)
              .padding(.top, 24)
          case let .loaded(list):
            ForEach(list, id: \.sessionId) { session in
              ArchivedSessionRowView(session: session,
                                     onRestore: { actions.restore(session, run: run) },
                                     onDelete: { confirmDelete = session })
                .overlay(alignment: .bottom) { Rectangle().fill(Palette.line).frame(height: 1) }
            }
            Text(ConnectionCopy.archivedPolicy).font(.system(size: 11)).foregroundStyle(Palette.faint)
              .padding(.top, 12)
          }
        }
        .padding(.horizontal, 19).padding(.bottom, 24)
      }
      .scrollIndicators(.hidden)
      .refreshable { _ = await run.refreshArchived() }
    }
    .background(Palette.surface)
    .task { _ = await run.refreshArchived() }
    .confirmationDialog(ConnectionCopy.deleteConfirmTitle, isPresented: deletePresented, titleVisibility: .visible) {
      Button(ConnectionCopy.actionDelete, role: .destructive) {
        if let session = confirmDelete {
          actions.deleteTarget = .init(session: session)
          actions.confirmDelete(run: run)
        }
        confirmDelete = nil
      }
      Button(ConnectionCopy.cancel, role: .cancel) { confirmDelete = nil }
    } message: {
      Text(ConnectionCopy.deleteConfirmBody)
    }
    .overlay(alignment: .bottom) {
      if let toast = actions.toast {
        SessionActionToast(toast: toast, onUndo: { actions.undoArchive(run: run) },
                           onDismiss: { actions.dismissToast() })
      }
    }
    .alert(ConnectionCopy.sessionActionFailedTitle, isPresented: failurePresented) {
      Button(ConnectionCopy.ok) { actions.failure = nil }
    } message: {
      Text(actions.failure ?? "")
    }
  }

  private var deletePresented: Binding<Bool> {
    Binding(get: { confirmDelete != nil }, set: { if !$0 { confirmDelete = nil } })
  }
  private var failurePresented: Binding<Bool> {
    Binding(get: { actions.failure != nil }, set: { if !$0 { actions.failure = nil } })
  }

  private var header: some View {
    RemoteHeader(title: ConnectionCopy.archivedSessions, backAction: { dismiss() }) {
      if run.archivedLoading {
        ProgressView().frame(width: 44, height: 44)
      } else {
        PlainIcon(symbol: "arrow.clockwise", label: ConnectionCopy.toolRefresh) {
          Task { _ = await run.refreshArchived() }
        }
      }
    }
  }

  private var provenance: some View {
    Text(ConnectionCopy.provenance(run.hostLabel ?? ConnectionCopy.unconnected, run.archivedFetchedAt?.formatted(date: .omitted, time: .shortened)
                                   ?? ConnectionCopy.archivedFetchedNone))
      .font(.system(size: 11)).foregroundStyle(Palette.faint)
      .frame(maxWidth: .infinity, alignment: .leading).padding(.top, 8)
  }
}
