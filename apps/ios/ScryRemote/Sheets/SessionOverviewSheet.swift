import SwiftUI
import UIKit

// A display projection, not a session ledger: no aggregation or output parsing.
struct SessionOverviewTurn {
  let prompt: String?
  var running = false
  var resultSummary: String?

  @MainActor static func completed(_ turn: RemoteRunStore.CompletedLiveTurn) -> Self {
    .init(prompt: turn.prompt, resultSummary: turn.resultSummary)
  }

  @MainActor static func focused(_ run: RemoteRunStore) -> Self {
    .init(prompt: run.prompt, running: run.lifecycle == .running,
          resultSummary: run.terminalLifecycleKnown ? run.resultSummary : nil)
  }
}

struct SessionOverviewSheet: View {
  let externalSessionId: String?
  let provider: String?
  let host: String?
  let cwd: String?
  let turns: [SessionOverviewTurn]
  @State private var copiedID: String?
  @State private var showFiles = false

  var body: some View {
    VStack(spacing: 0) {
      SheetHeader(title: SheetCopy.overviewTitle, subtitle: SheetCopy.overviewSource)
      Rectangle().fill(Palette.border3).frame(height: 1)
      ScrollView {
        LazyVStack(alignment: .leading, spacing: 18) {
          Text(SheetCopy.sessionInfo).font(Typography.groupLabel).foregroundStyle(Palette.dim2)
          VStack(spacing: 0) {
            HStack(spacing: 10) {
              Text(SheetCopy.sessionID).font(Typography.meta).foregroundStyle(Palette.dim2)
              Spacer(minLength: 0)
              Text(externalSessionId ?? SheetCopy.noSession).font(Typography.mono)
                .lineLimit(1).truncationMode(.middle).accessibilityIdentifier("overview-session-id")
              if let externalSessionId {
                Button {
                  UIPasteboard.general.string = externalSessionId
                  copiedID = externalSessionId
                } label: {
                  Text(copiedID == externalSessionId ? SheetCopy.copied : ConversationCopy.copy)
                    .font(Typography.meta).foregroundStyle(Palette.fg)
                    .frame(minWidth: 44, minHeight: 44).contentShape(Rectangle())
                }
                .buttonStyle(.plain).accessibilityIdentifier("overview-copy-id")
              }
            }
            .padding(.horizontal, 12).frame(minHeight: 44)
            infoDivider
            infoRow(SheetCopy.provider, value: provider)
            infoDivider
            infoRow(SheetCopy.host, value: host)
            infoDivider
            infoRow(SheetCopy.directory, value: cwd, monospaced: true)
          }
          .foregroundStyle(Palette.fg)
          .background(Palette.panel2, in: RoundedRectangle(cornerRadius: 12))
          .overlay(RoundedRectangle(cornerRadius: 12).stroke(Palette.border3, lineWidth: 1))
          Text(SheetCopy.usageUnavailable).font(Typography.meta).foregroundStyle(Palette.dim2)
          HStack(spacing: 12) {
            Text(SheetCopy.turns).font(Typography.groupLabel).foregroundStyle(Palette.fg)
            Rectangle().fill(Palette.border2).frame(height: 1)
          }
          // These are positions in the available list, not inferred host turn IDs.
          ForEach(Array(turns.enumerated()), id: \.offset) { index, turn in
            HStack(spacing: 10) {
              Text(String(index + 1)).font(Typography.mono).foregroundStyle(Palette.dim2)
              Text(turn.prompt ?? SheetCopy.notProvided).font(Typography.rowTitle)
                .foregroundStyle(Palette.fg).lineLimit(1)
              Spacer(minLength: 0)
              if turn.running {
                RunningRing(color: Palette.accent)
              } else if let summary = turn.resultSummary {
                Text(summary).font(Typography.meta).foregroundStyle(Palette.dim2).lineLimit(1)
                  .frame(maxWidth: 150, alignment: .trailing).layoutPriority(1)
              }
            }
            .frame(minHeight: 44).accessibilityElement(children: .combine)
            .accessibilityIdentifier("overview-turn-\(index)")
          }
        }
        .padding(16)
      }
      VStack(spacing: 8) {
        Button { showFiles = true } label: {
          Label(SheetCopy.workspace, systemImage: Symbol.folder)
            .font(Typography.rowTitle.weight(.medium)).foregroundStyle(Palette.fg)
            .frame(maxWidth: .infinity, minHeight: 48)
            .background(Palette.panel, in: RoundedRectangle(cornerRadius: 14))
            .overlay(RoundedRectangle(cornerRadius: 14).stroke(Palette.border2, lineWidth: 1))
        }
        .buttonStyle(.plain).disabled(cwd == nil).accessibilityIdentifier("overview-files")
        Text(SheetCopy.workspaceScope).font(Typography.meta).foregroundStyle(Palette.dim2)
      }
      .padding(16)
    }
    .background(Palette.main)
    .presentationBackground(Palette.main)
    .presentationDetents([.medium, .large])
    .presentationDragIndicator(.visible)
    .sheet(isPresented: $showFiles) {
      if let cwd { WorkspaceBrowserView(cwd: cwd).id(cwd) }
    }
  }

  private var infoDivider: some View {
    Rectangle().fill(Palette.border3).frame(height: 1).padding(.horizontal, 12)
  }

  private func infoRow(_ title: String, value: String?, monospaced: Bool = false) -> some View {
    HStack(spacing: 12) {
      Text(title).font(Typography.meta).foregroundStyle(Palette.dim2)
      Spacer(minLength: 0)
      Text(value ?? SheetCopy.notProvided).font(monospaced ? Typography.mono : Typography.reply)
        .lineLimit(1).truncationMode(monospaced ? .head : .tail)
    }
    .padding(.horizontal, 12).frame(minHeight: 44)
  }
}

extension SessionTranscriptView {
  var overview: some View {
    // Reuse the reader's session boundary. A stale history snapshot is not this session's evidence.
    let historyTurns: [SessionOverviewTurn] = switch run.activeSessionIdentity == sessionIdentity ? run.history : .loading {
    case let .loaded(turns), let .partial(turns): turns.map { .init(prompt: $0.userText) }
    default: []
    }
    let focused: [SessionOverviewTurn] = run.prompt != nil && !run.liveTurnInHistory ? [.focused(run)] : []
    let detached: [SessionOverviewTurn] = detachedLive.map { [.init(prompt: $0.prompt, running: $0.state == "running")] } ?? []
    return SessionOverviewSheet(externalSessionId: session?.externalSessionId,
      provider: session.map { ConnectionCopy.providerLabel($0.providerId) },
      host: session.map { ($0.scope ?? model.targetCoordinator.selectedScope).label }, cwd: session?.cwd,
      turns: historyTurns + completedTurns.map(SessionOverviewTurn.completed) + focused + detached)
  }
}
