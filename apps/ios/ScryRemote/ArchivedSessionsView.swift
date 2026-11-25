import SwiftUI
import RemoteTransport

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
          if run.archivedFailure != nil, !rows.isEmpty {
            Notice(text: ConnectionCopy.archivedRefreshFailed, warning: true)
              .padding(.top, 10)
          }
          if let failure = actions.failure {
            HStack(alignment: .top, spacing: 10) {
              Notice(text: "\(ConnectionCopy.sessionActionFailedTitle)：\(failure)", warning: true)
              Button(ConnectionCopy.ok) { actions.failure = nil }
                .font(.system(size: 12, weight: .semibold)).frame(minHeight: 44)
            }.padding(.top, 10)
          }
          if rows.isEmpty {
            archivePlaceholder
          } else {
            ForEach(rows, id: \.sessionId) { session in
              ArchivedSessionRowView(session: session,
                                     onRestore: { actions.restore(session, run: run) },
                                     onDelete: { confirmDelete = session })
                .overlay(alignment: .bottom) { Rectangle().fill(Palette.border).frame(height: 1) }
            }
          }
          if run.archivedFailure == nil, !run.archivedLoading {
            switch run.archivedCatalog {
            case .empty, .loaded:
              Text(ConnectionCopy.archivedPolicy).font(.system(size: 11)).foregroundStyle(Palette.dim2)
                .padding(.top, 12)
            default: EmptyView()
            }
          }
        }
        .padding(.horizontal, 19).padding(.bottom, 24)
      }
      .scrollIndicators(.hidden)
      .refreshable { _ = await run.refreshArchived() }
    }
    .background(Palette.main)
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

  @ViewBuilder private var archivePlaceholder: some View {
    if run.archivedFailure != nil || retrying {
      EmptyState(title: ConnectionCopy.archivedReadFailed,
                 detail: ConnectionCopy.archivedReadFailedDetail,
                 symbol: "exclamationmark.triangle",
                 action: .init(label: ConnectionCopy.archivedReadAgain, refresh: true,
                               busy: retrying || run.archivedLoading, perform: retryArchive))
        .frame(minHeight: 240)
    } else {
      switch run.archivedCatalog {
      case .empty where !run.archivedLoading:
        EmptyState(title: ConnectionCopy.archivedEmpty, detail: ConnectionCopy.archivedEmptyDetail, symbol: Symbol.archive)
          .frame(minHeight: 240)
      default:
        PlaceholderRows(label: ConnectionCopy.readingSessions, count: 5, rowHeight: 48)
      }
    }
  }

  @State private var retrying = false

  private func retryArchive() {
    retrying = true
    Task {
      _ = await run.refreshArchived()
      retrying = false
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
