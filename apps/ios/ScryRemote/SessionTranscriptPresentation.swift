import SwiftUI
import RemoteTransport

// A session opened from the list: read-only replay of its past turns PLUS a live
// composer to CONTINUE the conversation. A follow-up resumes the SAME Provider
// session (RemoteRunStore.submitFollowUp with resume = the session id), so the
// run keeps the prior context. It stays honest (CLAUDE.md 证据不能说谎): past
// turns are the host's read of real archived content, the live turn shows only
// streamed output (a possibly-incomplete cache) while its REAL lifecycle sits
// in the status strip, and nothing is fabricated. File diffs still live on the Mac.
// Full text stays inline. Parse archived Markdown off the UI actor; the
// conversation virtualizes rows, while each visible reply exposes its full
// height so tail positioning does not stop at a placeholder.
struct HistoryChunkView: View {
  let kind: String
  let text: String
  var result: String?
  @State private var blocks: [ConversationMarkdownBlock]?
  @State private var parsedSource: String?

  @ViewBuilder var body: some View {
    switch kind {
    case "reasoning", "tool", "tool_result", "truncated":
      ConversationChunk(kind: kind, text: text, result: result)
    default:
      Group {
        if let blocks, parsedSource == text {
          ConversationMarkdownText(source: "", parsedBlocks: blocks)
        } else { ProgressView() }
      }
      .task(id: text) {
        let parsed = await ConversationMarkdownParser.parseForReading(text)
        guard !Task.isCancelled else { return }
        blocks = parsed
        parsedSource = text
      }
    }
  }
}

// Browsing another session must not reset an unresolved recovery task. Reuse
// the history implementation and protected cache, but never restore its run.
struct ReadOnlySessionTranscriptView: View {
  @EnvironmentObject var model: AppModel
  @State private var history: RemoteRunStore

  init(owner: RemoteRunStore) {
    _history = State(initialValue: RemoteRunStore(historyFor: owner))
  }

  var body: some View {
    SessionTranscriptView(readOnly: true)
      .environment(history)
      .onChange(of: history.reachable) { if let ok = history.reachable { model.markReachable(ok) } }
      .onChange(of: history.connectionObservation) { _, observation in model.markObservation(observation) }
  }
}

struct HistoryRetryButton: View {
  let title: String
  let action: () -> Void
  var body: some View {
    Button(title, action: action)
      .buttonStyle(.borderedProminent).tint(Palette.accentFill).foregroundStyle(Palette.onAccent)
  }
}

extension SessionTranscriptView {
  @ViewBuilder func historyBody(split blocks: [String: [Int: ConversationSplitPlan]]) -> some View {
    if run.activeSessionIdentity == sessionIdentity, run.historyCapacityLimit {
      HistoryRetryButton(title: ConversationCopy.loadHistory) {
        if let s = session { run.loadCompleteHistory(providerId: s.providerId, cwd: s.cwd, externalSessionId: s.externalSessionId, agentProfileId: s.agentProfileId) }
      }
      .disabled(run.historySyncing)
      .accessibilityHint(ConversationCopy.loadHistoryHint)
    }
    switch run.activeSessionIdentity == sessionIdentity ? run.history : .loading {
    case .idle, .loading:
      // The detached run's live turn is already real content; a skeleton
      // above it would read as "nothing loaded yet".
      if detachedLive == nil { transcriptLoadingState }
    case let .partial(turns), let .loaded(turns):
      if run.historyOlderBefore != nil {
        Button(run.historySyncing ? ConversationCopy.olderHistory : ConversationCopy.loadOlderHistory) {
          olderReadRequest += 1
          if let s = session { run.loadOlderHistory(providerId: s.providerId, cwd: s.cwd, externalSessionId: s.externalSessionId, agentProfileId: s.agentProfileId) }
        }
        .buttonStyle(.bordered)
        .disabled(run.historySyncing)
        .accessibilityHint(ConversationCopy.olderHistoryHint)
      }
      // Snapshot ordinals preserve existing view identity when older pages are
      // prepended. They are presentation positions, not canonical turn IDs.
      let first = run.historyPageOffset
      ForEach(turns.enumerated().flatMap { index, turn in
        // The archive has no resultSummary; do not synthesize a usage footer.
        ConversationTurn(prompt: turn.userText.isEmpty ? nil : turn.userText, runId: turn.runId,
          entries: ConversationEntry.group(turn.items, kind: \.kind, text: \.text), archived: true)
          .withSplitPlans(blocks["history-\(first + index)"] ?? [:])
          .rows(id: first + index)
      }) { $0 }
      ForEach(completedTurns.flatMap { row in
        ConversationTurn.completed(row).withSplitPlans(blocks[row.id] ?? [:]).rows(id: row.id)
      }) { $0 }
    case .empty:
      ForEach(completedTurns.flatMap { row in
        ConversationTurn.completed(row).withSplitPlans(blocks[row.id] ?? [:]).rows(id: row.id)
      }) { $0 }
      Text(ConnectionCopy.noReadableHistory)
        .font(Typography.meta).foregroundStyle(Palette.dim)
        .frame(maxWidth: .infinity, alignment: .leading).padding(.top, 20)
    case .baseUnavailable:
      // The missing record is reported once, in the status strip.
      ForEach(completedTurns.flatMap { row in
        ConversationTurn.completed(row).withSplitPlans(blocks[row.id] ?? [:]).rows(id: row.id)
      }) { $0 }
    case .failed("history_unavailable") where detachedLive != nil:
      // A session this run is creating has no record until the run ends.
      EmptyView()
    case let .failed(reason):
      EmptyState(title: ConversationCopy.failedHistory, detail: ConversationCopy.failedHistoryDetail(reason), symbol: "exclamationmark.triangle")
      HistoryRetryButton(title: ConversationCopy.retryHistory) {
        if let s = session {
          run.loadHistory(providerId: s.providerId, cwd: s.cwd, externalSessionId: s.externalSessionId, force: true, agentProfileId: s.agentProfileId)
        }
      }
      .frame(maxWidth: .infinity)
      DisclosureGroup(ConversationCopy.errorDetails) { Text(reason).font(Typography.meta).textSelection(.enabled) }
        .font(Typography.meta).foregroundStyle(Palette.dim)
      ForEach(completedTurns.flatMap { row in
        ConversationTurn.completed(row).withSplitPlans(blocks[row.id] ?? [:]).rows(id: row.id)
      }) { $0 }
    }
  }

  private var transcriptLoadingState: some View {
    VStack(alignment: .leading, spacing: 22) {
      HStack(spacing: 12) {
        ZStack {
          Circle().fill(Palette.accent.opacity(0.08)).frame(width: 34, height: 34)
          Circle().fill(Palette.border3.opacity(0.5)).frame(width: 12, height: 12)
        }
        VStack(alignment: .leading, spacing: 3) {
          RoundedRectangle(cornerRadius: 4).fill(Palette.border3.opacity(0.6)).frame(width: 150, height: 12)
          RoundedRectangle(cornerRadius: 4).fill(Palette.border3.opacity(0.35)).frame(width: 105, height: 10)
        }
      }
      .padding(.vertical, 12).padding(.horizontal, 13)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(Palette.panel2.opacity(0.82), in: RoundedRectangle(cornerRadius: 14, style: .continuous))

      VStack(alignment: .leading, spacing: 18) {
        HStack {
          Spacer(minLength: 72)
          RoundedRectangle(cornerRadius: 17, style: .continuous)
            .fill(Palette.panel2)
            .frame(height: 58)
        }
        VStack(alignment: .leading, spacing: 10) {
          RoundedRectangle(cornerRadius: 4).fill(Palette.border3).frame(width: 174, height: 10)
          RoundedRectangle(cornerRadius: 4).fill(Palette.border3).frame(maxWidth: .infinity).frame(height: 10)
          RoundedRectangle(cornerRadius: 4).fill(Palette.border3).frame(width: 236, height: 10)
        }
      }
      .accessibilityHidden(true)
      .opacity(0.72)
    }
    .padding(.top, 8)
    .frame(maxWidth: .infinity, alignment: .leading)
  }

}

struct HistoryEvidenceDetails: View {
  let status: String
  let lastChecked: Date?
  let refreshError: String?
  let storageNotice: String?
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    NavigationStack {
      List {
        Section(ConnectionCopy.historyStatus) {
          Text(status)
          Text(lastChecked.map(ConnectionCopy.historyLastCheckedText) ?? ConnectionCopy.historyNotChecked)
            .font(Typography.meta).foregroundStyle(Palette.dim)
        }
        if let refreshError {
          Section(ConnectionCopy.historySyncIssue) {
            Text(refreshError).font(Typography.meta).textSelection(.enabled)
          }
        }
        if let storageNotice {
          Section(ConnectionCopy.historyStorageIssue) {
            Text(storageNotice).font(Typography.meta).textSelection(.enabled)
          }
        }
      }
      .navigationTitle(ConnectionCopy.historyDetailsTitle)
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .confirmationAction) {
          Button(ConnectionCopy.done) { dismiss() }
        }
      }
    }
  }
}

extension SessionTranscriptView {
  var historyIssue: SessionStatusLine? {
    guard run.activeSessionIdentity == sessionIdentity else { return nil }
    // The exact reason stays in the header menu (历史状态); the paced
    // refresh keeps retrying while this error stands (historyIsWatched).
    let details = SessionStatusLine.Action(title: ConnectionCopy.details, perform: { showHistoryDetails = true })
    if historyReadyForDisplay || run.history == .baseUnavailable, run.historyRefreshError != nil {
      return .init(text: run.history == .baseUnavailable ? ConnectionCopy.historyUnavailable
                                                          : ConnectionCopy.historySyncFailed,
                   tone: .warning, busy: true, action: details)
    }
    if run.historyStorageNotice != nil {
      return .init(text: ConnectionCopy.historyStorageLimited, tone: .warning, action: details)
    }
    if case .partial = run.history {
      return .init(text: ConnectionCopy.historyPartial, tone: .warning, action: details)
    }
    if run.historyFromCache {
      return .init(text: run.historySyncing ? ConnectionCopy.historyCheckingCache : ConnectionCopy.historyFromCache,
                   busy: run.historySyncing, action: details)
    }
    guard run.history == .baseUnavailable else { return nil }
    if run.historySyncing { return .init(text: ConnectionCopy.historyReading, busy: true) }
    return .init(text: ConnectionCopy.historyEarlierUnavailable,
                 action: .init(title: ConnectionCopy.retry, perform: {
                   if let s = session { run.loadHistory(providerId: s.providerId, cwd: s.cwd, externalSessionId: s.externalSessionId, force: true, agentProfileId: s.agentProfileId) }
                 }))
  }

  var historyStatus: String {
    if run.historyNativeUnavailable { return ConnectionCopy.historyNativeUnavailable }
    if let source = run.historyPageSource, run.historyOlderBefore != nil {
      return ConnectionCopy.historyRecentComplete(source)
    }
    if case .partial = run.history { return ConnectionCopy.historyPartial }
    if run.historyFromCache { return ConnectionCopy.historyFromCache }
    if run.historySyncing { return ConnectionCopy.historyReading }
    if run.historyFetchedAt != nil { return ConnectionCopy.historyVerified }
    return ConnectionCopy.historyStateUnavailable
  }
}
