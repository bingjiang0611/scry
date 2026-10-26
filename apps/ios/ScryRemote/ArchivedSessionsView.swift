import SwiftUI
import RemoteTransport

// Archived sessions are read from the host on demand. Restore is reversible;
// permanent delete asks first and reports what the Mac actually removed.
struct ArchivedSessionsView: View {
  @Environment(RemoteRunStore.self) var run
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
          if let failure = actions.failure {
            HStack(alignment: .top, spacing: 10) {
              Notice(text: "\(ConnectionCopy.sessionActionFailedTitle)：\(failure)", warning: true)
              Button(ConnectionCopy.ok) { actions.failure = nil }
                .font(.system(size: 12, weight: .semibold)).frame(minHeight: 44)
            }.padding(.top, 10)
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
                .overlay(alignment: .bottom) { Rectangle().fill(Palette.border).frame(height: 1) }
            }
            Text(ConnectionCopy.archivedPolicy).font(.system(size: 11)).foregroundStyle(Palette.dim2)
              .padding(.top, 12)
          }
        }
        .padding(.horizontal, 19).padding(.bottom, 24)
      }
      .scrollIndicators(.hidden)
      .refreshable { _ = await run.refreshArchived() }
    }
    .background(Palette.main)
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
  }

  private var deletePresented: Binding<Bool> {
    Binding(get: { confirmDelete != nil }, set: { if !$0 { confirmDelete = nil } })
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
    Text(ConnectionCopy.panelProvenance(run.scopeLabel,
                                        readAt: run.archivedFetchedAt?.formatted(date: .omitted, time: .shortened)))
      .font(.system(size: 11)).foregroundStyle(Palette.dim2)
      .frame(maxWidth: .infinity, alignment: .leading).padding(.top, 8)
  }
}
