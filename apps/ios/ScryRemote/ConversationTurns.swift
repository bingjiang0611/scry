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

struct ConversationChunk: View {
  let kind: String
  let text: String
  var result: String?
  @State private var expanded = false

  private var lineCount: Int { Self.lines(text) }
  private static func lines(_ value: String) -> Int {
    max(1, value.split(separator: "\n", omittingEmptySubsequences: false).count)
  }

  @ViewBuilder var body: some View {
    switch kind {
    case "reasoning", "tool", "tool_result": evidenceDetail
    case "truncated": truncated
    default: ConversationMarkdownText(source: text)
    }
  }

  private var detailLabel: String {
    switch kind {
    case "reasoning": return "思考过程"
    case "tool_result": return "工具结果 · \(lineCount) 行"
    default: return text
    }
  }

  // A tool payload alone cannot prove success; only the run lifecycle carries
  // a status indicator. Expanding always exposes the supplied evidence.
  private var evidenceDetail: some View {
    VStack(alignment: .leading, spacing: 0) {
      Button { expanded.toggle() } label: {
        HStack(spacing: 10) {
          Image(systemName: kind == "reasoning" ? "sparkle" : "terminal")
            .frame(width: 18)
          Text(detailLabel)
            .font(kind == "tool" ? .system(size: 13, design: .monospaced) : .system(size: 13))
            .lineLimit(1).frame(maxWidth: .infinity, alignment: .leading)
          if let result {
            Text("\(Self.lines(result)) 行").font(.system(size: 11)).monospacedDigit()
          }
          Image(systemName: expanded ? "chevron.down" : Symbol.chevron)
            .font(.system(size: 11, weight: .medium))
        }
        .foregroundStyle(Palette.muted)
        .frame(minHeight: 44).contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .accessibilityIdentifier(kind == "reasoning" ? "reasoning-toggle" : "tool-detail-toggle")
      .accessibilityLabel(kind == "tool" ? "工具调用：\(text)" : detailLabel)
      .accessibilityValue(expanded ? "已展开" : "已折叠")
      if expanded {
        if kind == "reasoning" {
          ConversationMarkdownText(source: text, muted: true).padding(.bottom, 10)
        } else {
          VStack(alignment: .leading, spacing: 8) {
            Text(text).font(.system(size: 13, design: .monospaced))
              .foregroundStyle(Palette.ink).textSelection(.enabled)
            if let result {
              Rectangle().fill(Palette.line).frame(height: 0.5)
              Text(ConnectionCopy.result).font(.system(size: 11, weight: .semibold)).foregroundStyle(Palette.muted)
              Text(result).font(.system(size: 12, design: .monospaced))
                .foregroundStyle(Palette.ink).textSelection(.enabled)
            }
          }
          .frame(maxWidth: .infinity, alignment: .leading)
          .padding(12).background(Palette.canvas, in: RoundedRectangle(cornerRadius: 6))
        }
      }
    }
  }

  private var truncated: some View {
    Label(text, systemImage: "exclamationmark.triangle")
      .font(.system(size: 12))
      .foregroundStyle(Palette.warnInk)
      .padding(.vertical, 8).padding(.horizontal, 10)
      .background(Palette.warnBg, in: RoundedRectangle(cornerRadius: 11, style: .continuous))
  }
}

// MARK: - Turns and session status

// One conversation turn for every source: the Mac's session record, this
// device's follow-up, or a run started elsewhere. The source decides which
// evidence exists, never the layout. A normal finish stays silent; usage and
// run id sit in the prompt's context menu, and a value the host did not send
// says so instead of showing 0 (CLAUDE.md 证据不能说谎).
struct TurnUserBubble: View {
  let text: String
  var attachments: [RemoteRunStore.SentAttachment] = []
  var runId: String?
  var usage: String?
  // The run has not ended, so its usage cannot exist yet.
  var usagePending = false

  var body: some View {
    HStack {
      Spacer(minLength: 40)
      VStack(alignment: .leading, spacing: 8) {
        if !attachments.isEmpty { SentAttachmentList(attachments: attachments) }
        Text(text).font(.system(size: 16)).lineSpacing(3)
      }
      .foregroundStyle(Palette.ink)
      .padding(.vertical, 10).padding(.horizontal, 14)
      .frame(maxWidth: 320, alignment: .leading)
      .background(Palette.message, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
      // Long press opens the menu instead of text selection; copy keeps the prompt reusable.
      .contextMenu {
        #if canImport(UIKit)
        Button { UIPasteboard.general.string = text } label: { Label("复制", systemImage: "doc.on.doc") }
        #endif
        Section("本轮详情") {
          Text("用量 · " + (usage ?? (usagePending ? "运行结束后由 Mac 提供" : "Mac 未提供")))
          Text("Run · " + (runId ?? "未提供"))
        }
      }
    }
  }
}

struct TurnOutputList: View {
  let lines: [RemoteRunStore.OutputLine]
  var body: some View {
    ForEach(ConversationEntry.group(lines, kind: \.kind, text: \.text)) { entry in
      ConversationChunk(kind: entry.kind, text: entry.text, result: entry.result)
    }
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
    case .failed: parts.append("运行失败")
    case .cancelled: parts.append("已停止")
    default: break
    }
    if !hasOutput, [.settled, .failed, .cancelled].contains(lifecycle) { parts.append("未读取到输出") }
    if truncated { parts.append("输出已达上限，内容被截断") }
    guard !parts.isEmpty else { return nil }
    text = parts.joined(separator: " · ")
    failed = lifecycle == .failed
  }

  var body: some View {
    Label(text, systemImage: "exclamationmark.circle")
      .font(.system(size: 12.5, weight: .medium))
      .foregroundStyle(failed ? Palette.negative : Palette.warnInk)
      .frame(maxWidth: .infinity, minHeight: 32, alignment: .leading)
      .accessibilityIdentifier("turn-outcome")
  }
}

// A turn this device already saw end. Same layout as a Mac history turn.
struct CompletedTurnView: View {
  let turn: RemoteRunStore.CompletedLiveTurn
  var body: some View {
    Group {
      TurnUserBubble(text: turn.prompt, attachments: turn.attachments,
                     runId: turn.hostRunId ?? turn.runId, usage: turn.resultSummary)
      TurnOutputList(lines: turn.output)
      if let note = TurnOutcomeNote(lifecycle: turn.lifecycle, hasOutput: !turn.output.isEmpty) { note }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }
}

// The run this store is driving. While it runs, the transcript shows only real
// content; its state is in the status strip.
struct FocusedTurnView: View {
  @Environment(RemoteRunStore.self) var run
  var body: some View {
    Group {
      if let prompt = run.prompt {
        TurnUserBubble(text: prompt, attachments: run.sentAttachments, runId: run.runId,
                       usage: run.resultSummary, usagePending: !run.terminalLifecycleKnown)
      }
      TurnOutputList(lines: run.output)
      if let note = TurnOutcomeNote(lifecycle: run.lifecycle, hasOutput: !run.output.isEmpty, truncated: run.truncated) { note }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
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

struct SessionStatusStrip: View {
  let status: SessionStatusLine

  private var color: Color {
    switch status.tone {
    case .neutral: return Palette.muted
    case .running: return Palette.blue
    case .attention: return Palette.amber
    case .warning: return Palette.warnInk
    }
  }
  private var symbol: String {
    switch status.tone {
    case .attention: return "hand.raised"
    case .warning: return "exclamationmark.circle"
    case .neutral, .running: return "info.circle"
    }
  }

  var body: some View {
    HStack(spacing: 9) {
      if status.busy { ProgressView().controlSize(.mini).tint(color) }
      else { Image(systemName: symbol).font(.system(size: 13, weight: .medium)) }
      Text(status.text).fixedSize(horizontal: false, vertical: true)
        .frame(maxWidth: .infinity, alignment: .leading)
      if let action = status.action {
        Button(action.title, action: action.perform)
          .font(.system(size: 13, weight: .semibold))
          .foregroundStyle(action.destructive ? Palette.negative : color)
          .disabled(action.disabled)
          .frame(minWidth: 44, minHeight: 44)
          .accessibilityIdentifier("session-status-action")
      }
    }
    .font(.system(size: 13, weight: .medium))
    .foregroundStyle(color)
    .padding(.leading, 12).padding(.trailing, status.action == nil ? 12 : 4)
    .frame(minHeight: 44)
    .background(status.tone == .warning ? Palette.warnBg : Palette.canvas,
                in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    .padding(.horizontal, 12).padding(.top, 8)
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("session-runtime-status")
  }
}

// Host-proven live state for one run. "Mac" marks a run the owner started in
// the Mac app, so the phone never implies it started it.
struct LiveRunBadge: View {
  let live: G0Transport.LiveRun
  let waiting: Bool
  var body: some View {
    let origin = live.origin == "mac" ? "Mac · " : ""
    let (text, color): (String, Color) = live.state == "stopping" ? ("停止中", Palette.muted)
      : waiting ? ("等待决定", Palette.amber) : ("运行中", Palette.blue)
    Text(origin + text).font(.system(size: 10, weight: .semibold)).foregroundStyle(color)
  }
}
