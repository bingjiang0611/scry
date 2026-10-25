import SwiftUI
import RemoteTransport

/// A compact, progressive-disclosure renderer shared by live and archived turns.
/// Long tool payloads and chain-of-thought-like reasoning stay available without
/// overwhelming the answer; assistant Markdown is rendered instead of exposing syntax.
// One rendered output row. A tool call absorbs the tool_result that directly
// follows it, like the Mac timeline. Content and order are unchanged; a result
// without an observed call stays its own row.
struct ConversationEntry: Identifiable, Equatable {
  let id: Int
  let kind: String
  let text: String
  var result: String?

  // A live row's seq advances when deltas coalesce. Use its position within
  // the append-only turn, like archive rendering, so SwiftUI keeps its subtree.
  static func group<T>(_ items: [T], kind: (T) -> String, text: (T) -> String) -> [ConversationEntry] {
    var entries: [ConversationEntry] = []
    for (index, item) in items.enumerated() {
      let itemKind = kind(item)
      if itemKind == "tool_result", let last = entries.last, last.kind == "tool", last.result == nil {
        entries[entries.count - 1].result = text(item)
        continue
      }
      entries.append(ConversationEntry(id: index, kind: itemKind, text: text(item)))
    }
    return entries
  }
}

// A second, read-only projection: tool_result is already absorbed by Entry.
// An orphan result remains an independent row and never increases call count.
struct ConversationBlock: Identifiable, Equatable {
  let entries: [ConversationEntry]
  var id: Int { entries[0].id }
  var isToolGroup: Bool { entries[0].kind == "tool" }
  static func isTruncated(_ entries: [ConversationEntry], reported: Bool) -> Bool {
    reported || entries.contains { $0.kind == "truncated" }
  }

  static func group(_ entries: [ConversationEntry]) -> [ConversationBlock] {
    var blocks: [ConversationBlock] = []
    var tools: [ConversationEntry] = []
    for entry in entries {
      if entry.kind == "tool" { tools.append(entry) }
      else {
        if !tools.isEmpty { blocks.append(.init(entries: tools)); tools = [] }
        blocks.append(.init(entries: [entry]))
      }
    }
    if !tools.isEmpty { blocks.append(.init(entries: tools)) }
    return blocks
  }
}

struct ConversationChunk: View {
  let kind: String
  let text: String
  var result: String?
  @State private var expanded = false

  @ViewBuilder var body: some View {
    switch kind {
    case "reasoning", "tool", "tool_result": evidenceDetail
    case "truncated":
      Label(text, systemImage: "exclamationmark.triangle")
        .font(Typography.meta).foregroundStyle(Palette.warn)
        .padding(.vertical, 8).padding(.horizontal, 10)
        .background(Palette.warn.opacity(0.12), in: RoundedRectangle(cornerRadius: 12))
    default: ConversationMarkdownText(source: text)
    }
  }

  private var detailLabel: String {
    kind == "reasoning" ? ConversationCopy.reasoning : kind == "tool_result" ? ConversationCopy.toolResult : text
  }

  private var evidenceDetail: some View {
    VStack(alignment: .leading, spacing: 0) {
      Button { expanded.toggle() } label: {
        HStack(spacing: 8) {
          Image(systemName: Symbol.chevron).font(Typography.meta)
            .rotationEffect(.degrees(expanded ? 90 : 0))
          Text(detailLabel).font(kind == "tool" ? Typography.mono : Typography.meta)
            .lineLimit(1).frame(maxWidth: .infinity, alignment: .leading)
        }
        .foregroundStyle(Palette.dim2).frame(minHeight: 44).contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .accessibilityIdentifier(kind == "reasoning" ? "reasoning-toggle" : "tool-detail-toggle")
      .accessibilityLabel(kind == "tool" ? ConversationCopy.tool(text) : detailLabel)
      .accessibilityValue(expanded ? ConversationCopy.expanded : ConversationCopy.collapsed)
      if expanded {
        if kind == "reasoning" {
          ConversationMarkdownText(source: text, muted: true).padding(.bottom, 10).transition(.opacity)
        } else {
          VStack(alignment: .leading, spacing: 8) {
            Text(text).font(Typography.mono).foregroundStyle(Palette.fg).textSelection(.enabled)
            if let result {
              Rectangle().fill(Palette.border3).frame(height: 1)
              Text(ConnectionCopy.result).font(Typography.meta).foregroundStyle(Palette.dim2)
              Text(result).font(Typography.mono).foregroundStyle(Palette.fg).textSelection(.enabled)
            }
          }
          .frame(maxWidth: .infinity, alignment: .leading)
          .padding(.bottom, 12).transition(.opacity)
        }
      }
    }
    .conversationDisclosure(expanded)
  }
}

struct ConversationToolGroup: View {
  let entries: [ConversationEntry]
  let truncated: Bool
  @State private var expanded = false
  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      Button { expanded.toggle() } label: {
        HStack(spacing: 8) {
          Image(systemName: Symbol.chevron).rotationEffect(.degrees(expanded ? 90 : 0))
          Text(ConversationCopy.tools(entries.count, truncated: truncated))
          Spacer(minLength: 0)
        }.font(Typography.meta).foregroundStyle(Palette.dim2)
          .frame(minHeight: 44).contentShape(Rectangle())
      }
      .buttonStyle(.plain).accessibilityIdentifier("tool-group-toggle")
      .accessibilityValue(expanded ? ConversationCopy.expanded : ConversationCopy.collapsed)
      if expanded {
        VStack(alignment: .leading, spacing: 0) {
          ForEach(entries) { entry in
            ConversationChunk(kind: entry.kind, text: entry.text, result: entry.result)
          }
        }
        .padding(.horizontal, 10)
        .background(Palette.panel2, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(Palette.border3))
        .transition(.opacity)
      }
    }.conversationDisclosure(expanded)
  }
}

private struct ConversationDisclosure: ViewModifier {
  let expanded: Bool
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  func body(content: Content) -> some View {
    let reduceMotion = reduceMotion
    return content
      .animation(reduceMotion ? nil : Motion.animation(expanded ? .disclosureOpen : .disclosureClose, reduceMotion: false), value: expanded)
      .keyframeAnimator(initialValue: 1.0, trigger: expanded) { view, opacity in
        view.opacity(reduceMotion ? opacity : 1)
      } keyframes: { _ in
        MoveKeyframe(0)
        LinearKeyframe(1, duration: 0.12)
      }
  }
}

extension View {
  func conversationDisclosure(_ expanded: Bool) -> some View { modifier(ConversationDisclosure(expanded: expanded)) }
}

// MARK: - Turns and session status

// All sources use the same turn shell; only the evidence and reading strategy differ.
private struct ConversationProviderKey: EnvironmentKey { static let defaultValue = "" }
extension EnvironmentValues {
  var conversationProvider: String {
    get { self[ConversationProviderKey.self] }
    set { self[ConversationProviderKey.self] = newValue }
  }
}

@MainActor
struct ConversationTurn {
  var prompt: String?
  var attachments: [RemoteRunStore.SentAttachment] = []
  var runId: String?
  var running = false
  var resultSummary: String?
  var usagePending = false
  let entries: [ConversationEntry]
  var truncated = false
  var archived = false
  var outcome: TurnOutcomeNote?
  var notice: String?

  fileprivate enum Row: Identifiable {
    enum ID: Hashable { case prompt, provider, block(Int), outcome, notice, usage }
    case prompt(String), provider, block(ConversationBlock), outcome(TurnOutcomeNote), notice(String), usage(String)
    var id: ID {
      switch self {
      case .prompt: return .prompt
      case .provider: return .provider
      case let .block(block): return .block(block.id)
      case .outcome: return .outcome
      case .notice: return .notice
      case .usage: return .usage
      }
    }
  }

  private var rows: [Row] {
    var rows: [Row] = []
    if let prompt { rows.append(.prompt(prompt)) }
    rows.append(.provider)
    rows += ConversationBlock.group(entries).map(Row.block)
    if let outcome { rows.append(.outcome(outcome)) }
    if let notice { rows.append(.notice(notice)) }
    if !running, let resultSummary { rows.append(.usage(resultSummary)) }
    return rows
  }

  // Give the lazy reader one identified element per presentation row. A whole
  // tall turn or a variable-size nested Group hides committed message heights.
  func rows<ID: Hashable>(id: ID) -> [ConversationTurnRow<ID>] {
    let content = rows
    let cut = ConversationBlock.isTruncated(entries, reported: truncated)
    return content.enumerated().map { index, row in
      ConversationTurnRow(id: .init(turn: id, row: row.id), turn: self, row: row,
        truncated: cut, last: index == content.count - 1)
    }
  }

  @ViewBuilder fileprivate func rowView(_ row: Row, truncated: Bool, provider: String, reduceMotion: Bool) -> some View {
    switch row {
    case let .prompt(text):
      TurnUserBubble(text: text, attachments: attachments, runId: runId,
                     usage: resultSummary, usagePending: usagePending).padding(.bottom, 18)
    case .provider:
      HStack(spacing: 7) {
        if running { RunningRing(size: 11, color: Palette.accent) }
        else { Circle().fill(Palette.dim2).frame(width: 6, height: 6) }
        Text(provider).font(Typography.meta).foregroundStyle(Palette.dim2)
      }
    case let .block(block):
      blockView(block, truncated: truncated).conversationFlowBlock()
        .transition(archived ? .identity : Motion.transition(.streamIn, reduceMotion: reduceMotion)
          .animation(Motion.animation(.streamIn, reduceMotion: reduceMotion)))
    case let .outcome(note): note.conversationFlowBlock()
    case let .notice(text): Text(text).font(Typography.meta).foregroundStyle(Palette.dim).conversationFlowBlock()
    case let .usage(text):
      VStack(spacing: 8) {
        Rectangle().fill(Palette.border3).frame(height: 1)
        Text(text).font(Typography.meta).foregroundStyle(Palette.dim2)
          .frame(maxWidth: .infinity, alignment: .trailing)
      }.padding(.top, 12)
    }
  }

  @ViewBuilder private func blockView(_ block: ConversationBlock, truncated: Bool) -> some View {
    let entry = block.entries[0]
    if block.isToolGroup {
      ConversationToolGroup(entries: block.entries, truncated: truncated)
    } else if archived {
      HistoryChunkView(kind: entry.kind, text: entry.text, result: entry.result)
    } else {
      ConversationChunk(kind: entry.kind, text: entry.text, result: entry.result)
    }
  }
}

struct ConversationTurnRow<TurnID: Hashable>: View, Identifiable {
  struct ID: Hashable {
    let turn: TurnID
    fileprivate let row: ConversationTurn.Row.ID
  }
  let id: ID
  fileprivate let turn: ConversationTurn
  fileprivate let row: ConversationTurn.Row
  fileprivate let truncated: Bool
  fileprivate let last: Bool
  @Environment(\.conversationProvider) private var provider
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  var body: some View {
    turn.rowView(row, truncated: truncated, provider: provider, reduceMotion: reduceMotion)
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(.bottom, last ? 34 : 0)
  }
}

private extension View {
  func conversationFlowBlock() -> some View {
    self.frame(maxWidth: .infinity, alignment: .leading)
      .padding(.leading, 20).padding(.top, 12)
      .overlay(alignment: .leading) { Rectangle().fill(Palette.border3).frame(width: 1).offset(x: 3) }
  }
}

struct TurnUserBubble: View {
  let text: String
  var attachments: [RemoteRunStore.SentAttachment] = []
  var runId: String?
  var usage: String?
  var usagePending = false
  @Environment(\.colorScheme) private var colorScheme

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      if !attachments.isEmpty { SentAttachmentList(attachments: attachments) }
      Text(text).font(Typography.bubble).lineSpacing(3)
    }
    .foregroundStyle(Palette.fg)
    .padding(.vertical, 10).padding(.horizontal, 14)
    .background(Palette.panel2, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
    .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous)
      .strokeBorder(colorScheme == .light ? Palette.border3 : .clear))
    .shadow(color: .black.opacity(colorScheme == .dark ? 0.30 : 0.06), radius: 2, y: 1)
    .contextMenu {
      #if canImport(UIKit)
      Button { UIPasteboard.general.string = text } label: { Label(ConversationCopy.copy, systemImage: "doc.on.doc") }
      #endif
      Section(ConversationCopy.details) {
        Text(ConversationCopy.usage(usage, pending: usagePending))
        Text(ConversationCopy.runID(runId))
      }
    }
    // The reader has 16pt content padding on each side. Keep the native
    // container measurement instead of inventing an unspecified Layout width.
    .containerRelativeFrame(.horizontal, alignment: .trailing) { width, _ in (width - 32) * 0.85 }
    .frame(maxWidth: .infinity, alignment: .trailing)
  }
}

// The only per-turn status: an ending that was not a normal finish, or output
// the host cut short. Progress belongs to the session status strip.
struct TurnOutcomeNote: View {
  let text: String
  let failed: Bool

  init?(lifecycle: RemoteRunStore.Lifecycle, hasOutput: Bool, truncated: Bool = false) {
    var parts: [String] = []
    switch lifecycle {
    case .failed: parts.append(ConversationCopy.failed)
    case .cancelled: parts.append(ConversationCopy.cancelled)
    default: break
    }
    if !hasOutput, [.settled, .failed, .cancelled].contains(lifecycle) { parts.append(ConversationCopy.noOutput) }
    if truncated { parts.append(ConversationCopy.truncated) }
    guard !parts.isEmpty else { return nil }
    text = parts.joined(separator: " · ")
    failed = lifecycle == .failed
  }

  var body: some View {
    Label(text, systemImage: "exclamationmark.circle")
      .font(Typography.meta.weight(.medium))
      .foregroundStyle(failed ? Palette.bad : Palette.warn)
      .frame(maxWidth: .infinity, minHeight: 32, alignment: .leading)
      .accessibilityIdentifier("turn-outcome")
  }
}

// The source decides which evidence exists; the renderer never invents it.
extension ConversationTurn {
  static func completed(_ turn: RemoteRunStore.CompletedLiveTurn) -> Self {
    Self(prompt: turn.prompt, attachments: turn.attachments,
      runId: turn.hostRunId ?? turn.runId, resultSummary: turn.resultSummary,
      entries: ConversationEntry.group(turn.output, kind: \.kind, text: \.text),
      outcome: TurnOutcomeNote(lifecycle: turn.lifecycle, hasOutput: !turn.output.isEmpty))
  }

  static func focused(_ run: RemoteRunStore) -> Self {
    Self(prompt: run.prompt, attachments: run.sentAttachments, runId: run.runId,
      running: run.lifecycle == .running, resultSummary: run.terminalLifecycleKnown ? run.resultSummary : nil,
      usagePending: !run.terminalLifecycleKnown,
      entries: ConversationEntry.group(run.output, kind: \.kind, text: \.text), truncated: run.truncated,
      outcome: TurnOutcomeNote(lifecycle: run.lifecycle, hasOutput: !run.output.isEmpty, truncated: run.truncated))
  }
}

// What is happening in this session right now, in one line above the composer.
// Screens pick the single most urgent state, so the same run state never
// appears twice on screen.
struct SessionStatusLine {
  enum Tone { case neutral, running, attention, warning }
  struct Action {
    let title: String
    var destructive = false
    var disabled = false
    let perform: () -> Void
  }
  let text: String
  var tone: Tone = .neutral
  var busy = false
  var action: Action?

  static let offline = SessionStatusLine(text: "未连接 Mac，暂时无法发送", tone: .warning)

  // The focused run, in the order the user must act on it. `recorded` and
  // `dispatched` are not execution, so they read “等待开始”, not “运行中”.
  @MainActor static func focusedRun(_ run: RemoteRunStore, onAnswer: @escaping () -> Void,
                         onStop: @escaping () -> Void) -> SessionStatusLine? {
    if !run.pendingQuestions.isEmpty {
      return .init(text: "需要你决定", tone: .attention, action: .init(title: "回答", perform: onAnswer))
    }
    if run.hasUncertainSubmission {
      return .init(text: ConnectionCopy.targetResultUnknown, tone: .warning,
                   action: .init(title: ConnectionCopy.reconcileResult, perform: { run.reconcileUncertain() }))
    }
    let stopAction: Action? = run.canStop && !run.stopRequested
      ? .init(title: "停止", destructive: true, disabled: run.stopRequesting, perform: onStop) : nil
    if run.observationReconnecting {
      return .init(text: "连接中断，正在重连", tone: .warning, busy: true, action: stopAction)
    }
    if run.observationInterrupted {
      let fallback = run.terminalLifecycleKnown ? "运行已结束，输出同步中断" : "同步中断，运行状态未知"
      return .init(text: run.submitError ?? fallback, tone: .warning,
                   action: .init(title: "重新连接", perform: { run.retryObservation() }))
    }
    if let error = run.stopError { return .init(text: error, tone: .warning, action: stopAction) }
    if let error = run.submitError { return .init(text: error, tone: .warning, action: stopAction) }
    if run.canStop {
      if run.stopRequested { return .init(text: "正在停止，等待 Agent 实际结束", busy: true) }
      return .init(text: run.lifecycle == .running ? "运行中" : "等待开始", tone: .running, busy: true,
                   action: .init(title: "停止", destructive: true, disabled: run.stopRequesting, perform: onStop))
    }
    if run.lifecycle == .submitting { return .init(text: "发送中", busy: true) }
    return nil
  }
}
