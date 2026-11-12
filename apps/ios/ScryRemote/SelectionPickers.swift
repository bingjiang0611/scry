import SwiftUI
import RemoteTransport

// Project and Provider pickers are shared by the new-task screen and the home
// composer. Both read only host-authorized data; the phone never invents a
// folder or a provider the Mac did not offer.
struct SelectionSheet<Content: View>: View {
  let title: String
  let subtitle: String
  let onRefresh: () -> Void
  @ViewBuilder let content: () -> Content
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    NavigationStack {
      ScrollView { content().padding(.horizontal, 16).padding(.top, 8) }
        .navigationTitle(title).navigationBarTitleDisplayMode(.inline)
        .toolbar {
          ToolbarItem(placement: .cancellationAction) { Button(ConnectionCopy.cancel) { dismiss() } }
          ToolbarItem(placement: .primaryAction) { Button(ConnectionCopy.refresh, action: onRefresh) }
        }
        .safeAreaInset(edge: .top) {
          Text(subtitle).font(.system(size: 11)).foregroundStyle(Palette.dim)
            .frame(maxWidth: .infinity).padding(.vertical, 8).background(Palette.panel2)
        }
    }
    .presentationDetents([.medium, .large]).presentationDragIndicator(.visible)
  }
}

struct FolderBrowseRow: View {
  let ref: G0Transport.RunProjectRef
  let selected: Bool
  let onOpen: () -> Void
  var transition: Namespace.ID?

  var body: some View {
    Button(action: onOpen) {
      HStack(spacing: 12) {
        Image(systemName: Symbol.folder).font(.system(size: 16)).foregroundStyle(Palette.dim).frame(width: 22)
        VStack(alignment: .leading, spacing: 3) {
          Text(ref.label).font(.system(size: 16, weight: .medium)).foregroundStyle(Palette.fg).lineLimit(2)
            .directoryTitle(ref.path, in: transition)
          Text(ref.path).font(.system(size: 11)).foregroundStyle(Palette.dim).lineLimit(2)
        }
        Spacer()
        if selected { Image(systemName: Symbol.check).font(.system(size: 14, weight: .semibold)).foregroundStyle(Palette.accent) }
        Image(systemName: Symbol.chevron).font(.system(size: 12, weight: .semibold)).foregroundStyle(Palette.dim2)
      }
      .frame(minHeight: 58).contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .overlay(alignment: .bottom) { Rectangle().fill(Palette.border).frame(height: 1) }
  }
}

struct SelectionRow: View {
  let title: String
  let detail: String
  let selected: Bool
  let action: () -> Void
  var body: some View {
    Button(action: action) {
      HStack(spacing: 12) {
        VStack(alignment: .leading, spacing: 3) {
          Text(title).font(.system(size: 16, weight: .medium)).foregroundStyle(Palette.fg)
          Text(detail).font(.system(size: 11)).foregroundStyle(Palette.dim).lineLimit(2)
        }
        Spacer()
        if selected { Image(systemName: Symbol.check).font(.system(size: 15, weight: .semibold)).foregroundStyle(Palette.accent) }
      }
      .frame(minHeight: 56).contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .overlay(alignment: .bottom) { Rectangle().fill(Palette.border).frame(height: 1) }
  }
}

struct ProjectPickerSheet: View {
  @Environment(RemoteRunStore.self) var run
  @Environment(\.dismiss) private var dismiss
  let onChoose: (G0Transport.RunProjectRef) -> Void
  @Namespace private var directoryTransition
  @State private var pendingDirectory: G0Transport.RunProjectRef?
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  private func browse(_ directory: G0Transport.RunProjectRef?) {
    withAnimation(Motion.animation(.page, reduceMotion: reduceMotion)) {
      pendingDirectory = directory
      run.loadDirectories(path: directory?.path)
    }
  }

  var body: some View {
    SelectionSheet(title: ConnectionCopy.chooseFolderTitle, subtitle: ConnectionCopy.chooseFolderSubtitle, onRefresh: {
      if case let .loaded(listing) = run.directories { browse(listing.current) }
      else { browse(nil) }
    }) {
      switch run.directories {
      case .idle, .loading:
        VStack(alignment: .leading, spacing: 0) {
          if let pendingDirectory {
            // Requested directory, not a successful listing. Match the real
            // heading's inset; selection stays unavailable until the host replies.
            Color.clear.frame(height: 44).accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 4) {
              Text(pendingDirectory.label).font(.system(size: 19, weight: .semibold)).foregroundStyle(Palette.fg)
                .directoryTitle(pendingDirectory.path, in: directoryTransition)
              Text(pendingDirectory.path).font(.system(size: 11)).foregroundStyle(Palette.dim).lineLimit(3)
            }.padding(.vertical, 12)
          }
          ProgressView(ConnectionCopy.readingFolders).frame(maxWidth: .infinity).padding(.top, 40)
        }
      case let .loaded(listing):
        VStack(alignment: .leading, spacing: 0) {
          if let current = listing.current {
            Button { browse(listing.parent) } label: {
              HStack(spacing: 9) {
                Image(systemName: "chevron.left").font(.system(size: 12, weight: .semibold))
                Text(listing.parent?.label ?? ConnectionCopy.authorizedProjects).font(.system(size: 14, weight: .medium))
                  .foregroundStyle(Palette.accentText)
                  .directoryTitle(listing.parent?.path, in: directoryTransition)
                Spacer()
              }
              .foregroundStyle(Palette.accent).frame(minHeight: 44).contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            VStack(alignment: .leading, spacing: 4) {
              Text(current.label).font(.system(size: 19, weight: .semibold)).foregroundStyle(Palette.fg)
                .directoryTitle(current.path, in: directoryTransition)
              Text(current.path).font(.system(size: 11)).foregroundStyle(Palette.dim).lineLimit(3)
              Button {
                onChoose(current)
                dismiss()
              } label: {
                Text(ConnectionCopy.chooseThisFolder).font(.system(size: 15, weight: .medium))
                  .foregroundStyle(Palette.fg).frame(maxWidth: .infinity, minHeight: 44)
                  .background(Palette.main, in: RoundedRectangle(cornerRadius: 6))
                  .overlay(RoundedRectangle(cornerRadius: 6).stroke(Palette.border))
                  .contentShape(Rectangle())
              }
              .buttonStyle(.plain).padding(.top, 8)
            }
            .frame(maxWidth: .infinity, alignment: .leading).padding(.vertical, 12)

            Text(ConnectionCopy.subfolders).font(.system(size: 11, weight: .semibold)).foregroundStyle(Palette.dim)
              .padding(.top, 8).padding(.bottom, 4)
            if listing.directories.isEmpty {
              Text(ConnectionCopy.noSubfolders).font(.system(size: 14)).foregroundStyle(Palette.dim).padding(.vertical, 18)
            } else {
              ForEach(listing.directories, id: \.path) { ref in
                FolderBrowseRow(ref: ref, selected: run.chosen?.path == ref.path,
                                onOpen: { browse(ref) }, transition: directoryTransition)
              }
            }
          } else if listing.directories.isEmpty {
            EmptyState(title: ConnectionCopy.noAuthorizedProjects, detail: ConnectionCopy.noAuthorizedProjectsDetail,
                       symbol: Symbol.folder)
          } else {
            ForEach(listing.directories, id: \.path) { ref in
              FolderBrowseRow(ref: ref, selected: run.chosen?.path == ref.path,
                              onOpen: { browse(ref) }, transition: directoryTransition)
            }
          }
        }
      case let .failed(reason):
        EmptyState(title: ConnectionCopy.foldersUnreadable, detail: reason, symbol: "exclamationmark.triangle")
      }
    }
  }
}

private struct DirectoryTitle: ViewModifier {
  let path: String?
  let namespace: Namespace.ID?
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  @ViewBuilder func body(content: Content) -> some View {
    if let path, let namespace, !reduceMotion {
      content.matchedGeometryEffect(id: path, in: namespace).transition(Motion.none)
    } else { content }
  }
}

private extension View {
  func directoryTitle(_ path: String?, in namespace: Namespace.ID?) -> some View {
    modifier(DirectoryTitle(path: path, namespace: namespace))
  }
}

struct ProviderPickerSheet: View {
  @Environment(RemoteRunStore.self) var run
  @Environment(\.dismiss) private var dismiss
  let onChoose: (G0Transport.RunProviderRef) -> Void

  var body: some View {
    SelectionSheet(title: ConnectionCopy.chooseProviderTitle, subtitle: ConnectionCopy.chooseProviderSubtitle,
                   onRefresh: { run.loadProviders(force: true) }) {
      switch run.providers {
      case .idle, .loading:
        ProgressView(ConnectionCopy.readingProviders).frame(maxWidth: .infinity).padding(.top, 40)
      case let .loaded(list):
        VStack(spacing: 0) {
          ForEach(list, id: \.selectionId) { ref in
            SelectionRow(title: ref.label,
                         detail: [ref.id.uppercased(), ref.agentProfileId].compactMap { $0 }.joined(separator: " · "),
                         selected: run.chosenProvider?.id == ref.id && run.chosenProvider?.agentProfileId == ref.agentProfileId) {
              onChoose(ref)
              dismiss()
            }
          }
        }
      case .empty:
        EmptyState(title: ConnectionCopy.noProviders, detail: ConnectionCopy.noProvidersDetail, symbol: Symbol.agent)
      case let .failed(reason):
        EmptyState(title: ConnectionCopy.providersUnreadable, detail: reason, symbol: "exclamationmark.triangle")
      }
    }
  }
}

extension G0Transport.RunProviderRef {
  // Multiple profiles share a provider ID; SwiftUI row identity must not.
  var selectionId: String { id + "\u{1f}" + (agentProfileId ?? "") }
}
