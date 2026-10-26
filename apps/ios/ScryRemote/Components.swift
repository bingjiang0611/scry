import SwiftUI
import RemoteTransport

// MARK: - Symbols

enum Symbol {
  static let menu = "line.3.horizontal"
  static let more = "ellipsis"
  static let laptop = "laptopcomputer"
  static let folder = "folder"
  static let branch = "arrow.triangle.branch"
  static let compose = "square.and.pencil"
  static let search = "magnifyingglass"
  static let plus = "plus"
  static let shield = "checkmark.shield"
  static let gauge = "gauge.with.dots.needle.33percent"
  static let send = "arrow.up"
  static let back = "chevron.left"
  static let agent = "cpu"
  static let file = "doc.text"
  static let photo = "photo"
  static let bell = "bell"
  static let chevrons = "chevron.up.chevron.down"
  static let chevron = "chevron.right"
  static let check = "checkmark"
  static let gear = "gearshape"
  static let link = "link"
  static let pin = "pin"
  static let archive = "archivebox"
  static let tray = "tray.full"
  static let chart = "chart.bar"
  static let gaugeSpeed = "speedometer"
  static let plug = "powerplug"
  static let hand = "hand.raised"
}

// MARK: - Core controls

struct CircleButton: View {
  let symbol: String
  let label: String
  var filled = false
  var disabled = false
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      Image(systemName: symbol)
        .font(Typography.reply.weight(.medium))
        .frame(width: filled ? 46 : 44, height: filled ? 46 : 44)
        .foregroundStyle(filled ? Palette.onAccent : Palette.fg)
        .background(filled ? AnyShapeStyle(Palette.accentFill) : AnyShapeStyle(Color.clear), in: Circle())
        .contentShape(Circle())
    }
    .buttonStyle(.plain)
    .disabled(disabled)
    .opacity(disabled ? 0.34 : 1)
    .accessibilityLabel(label)
  }
}

/// Header overflow actions keep their native menu behavior and 44pt label area.
struct MoreMenu<Content: View>: View {
  var label = ConnectionCopy.more
  @ViewBuilder var content: () -> Content

  var body: some View {
    Menu(content: content) {
      Image(systemName: Symbol.more)
        .font(Typography.reply.weight(.medium))
        .frame(width: 44, height: 44)
    }
    .accessibilityLabel(label)
  }
}

struct PlainIcon: View {
  let symbol: String
  let label: String
  var tint: Color = Palette.fg
  var disabled = false
  let action: () -> Void
  var body: some View {
    Button(action: action) {
      Image(systemName: symbol)
        .font(Typography.reply.weight(.medium))
        .frame(minWidth: 44, minHeight: 44)
        .foregroundStyle(tint)
        .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .disabled(disabled)
    .opacity(disabled ? 0.34 : 1)
    .accessibilityLabel(label)
  }
}

struct Notice: View {
  let text: String
  var warning = false
  var body: some View {
    HStack(alignment: .top, spacing: 8) {
      Image(systemName: warning ? "exclamationmark.circle" : "info.circle")
        .font(Typography.meta.weight(.medium)).padding(.top, 1)
      Text(text).font(Typography.meta).foregroundStyle(warning ? Palette.warnText : Palette.dim)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
    .foregroundStyle(warning ? Palette.warn : Palette.dim)
    .padding(.vertical, 10).padding(.horizontal, 12)
    .background(warning ? Palette.warn.opacity(0.12) : Palette.panel2, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    .padding(.horizontal, 16).padding(.bottom, 9)
  }
}

struct EmptyState: View {
  let title: String
  let detail: String
  var symbol: String = "bubble.left.and.bubble.right"
  var body: some View {
    VStack(spacing: 10) {
      Image(systemName: symbol).font(.title.weight(.light)).foregroundStyle(Palette.dim2)
      Text(title).font(Typography.headerTitle).multilineTextAlignment(.center)
      Text(detail).font(Typography.meta).foregroundStyle(Palette.dim).multilineTextAlignment(.center)
    }
    .frame(maxWidth: .infinity)
    .padding(.vertical, 54).padding(.horizontal, 26)
  }
}

struct StatusDot: View {
  let link: HostLink
  var body: some View { Circle().fill(color).frame(width: 7, height: 7).accessibilityHidden(true) }
  private var color: Color {
    switch link {
    case .connected: return Palette.ok
    case .pairing: return Palette.warn
    case .notPaired, .offline: return Palette.dim2
    }
  }
}

struct RemoteHeader<Right: View>: View {
  let title: String
  var subtitle: String?
  var providerId: String?
  var link: HostLink?
  var titleLineLimit = 1
  var backAction: (() -> Void)?
  var menuAction: (() -> Void)?
  @ViewBuilder let right: () -> Right

  var body: some View {
    HStack(spacing: 10) {
      CircleButton(symbol: backAction == nil ? Symbol.menu : Symbol.back,
                   label: backAction == nil ? ConnectionCopy.openMenu : ConnectionCopy.back) {
        if let backAction { backAction() } else { menuAction?() }
      }
      VStack(alignment: .leading, spacing: 3) {
        Text(title).font(Typography.headerTitle).lineLimit(titleLineLimit)
          .fixedSize(horizontal: false, vertical: true)
        if let subtitle {
          HStack(spacing: 5) {
            if let providerId {
              Image(systemName: ProviderSymbol.name(providerId)).foregroundStyle(Palette.provider(providerId))
            }
            else if let link { StatusDot(link: link) }
            Text(subtitle).lineLimit(1)
          }
          .font(Typography.meta).foregroundStyle(Palette.dim2)
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      right()
        .frame(minWidth: 44, minHeight: 44)
    }
    .padding(.horizontal, 10)
    .frame(minHeight: 56)
    .background(Palette.main)
    .overlay(alignment: .bottom) { Rectangle().fill(Palette.border3).frame(height: 1) }
    .zIndex(2)
  }
}

extension RemoteHeader where Right == EmptyView {
  init(title: String, subtitle: String? = nil, link: HostLink? = nil, titleLineLimit: Int = 1,
       backAction: (() -> Void)? = nil, menuAction: (() -> Void)? = nil) {
    self.title = title; self.subtitle = subtitle; self.link = link; self.titleLineLimit = titleLineLimit
    self.backAction = backAction; self.menuAction = menuAction
    self.right = { EmptyView() }
  }
}

struct SessionStatusStrip: View {
  let status: SessionStatusLine

  private var color: Color {
    switch status.tone {
    case .neutral: return Palette.dim
    case .running: return Palette.accent
    case .attention: return Palette.warn
    case .warning: return Palette.warn
    }
  }
  private var textColor: Color {
    switch status.tone {
    case .neutral: return Palette.dim
    case .running: return Palette.accentText
    case .attention, .warning: return Palette.warnText
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
      if status.tone == .running { RunningRing(color: color).accessibilityHidden(true) }
      else if status.busy { ProgressView().controlSize(.mini).tint(color) }
      else { Image(systemName: symbol).font(Typography.meta.weight(.medium)) }
      Text(status.text).foregroundStyle(textColor).fixedSize(horizontal: false, vertical: true)
        .frame(maxWidth: .infinity, alignment: .leading)
      if let action = status.action {
        Button(action: action.perform) {
          Text(action.title).font(Typography.meta.weight(.semibold))
            .frame(minWidth: 44, minHeight: 44).contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(action.destructive ? Palette.bad : textColor)
        .disabled(action.disabled)
        .accessibilityIdentifier("session-status-action")
      }
    }
    .font(Typography.meta.weight(.medium))
    .foregroundStyle(color)
    .padding(.horizontal, 12)
    .frame(minHeight: 44)
    .background(status.tone == .running ? Palette.accentSoft : (status.tone == .warning || status.tone == .attention) ? Palette.warn.opacity(0.12) : Palette.panel2,
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
    let color = live.state == "stopping" ? Palette.dim : waiting ? Palette.warnText : Palette.accentText
    Text(ConversationCopy.liveState(mac: live.origin == "mac", stopping: live.state == "stopping", waiting: waiting))
      .font(Typography.meta.weight(.semibold)).foregroundStyle(color)
  }
}

struct ConversationMarkdownText: View {
  let source: String
  var muted = false
  var parsedBlocks: [ConversationMarkdownBlock]? = nil

  private var blocks: [ConversationMarkdownBlock] { parsedBlocks ?? ConversationMarkdownParser.parse(source) }

  var body: some View {
    // The outer conversation already virtualizes rows. Its tail needs a
    // message's full height; a second lazy stack can leave a long live reply's
    // tail viewport empty even after the outer scroll reaches its bottom.
    VStack(alignment: .leading, spacing: 12) {
      ForEach(blocks) { block in
        blockView(block)
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }

  @ViewBuilder private func blockView(_ block: ConversationMarkdownBlock) -> some View {
    switch block.kind {
    case .paragraph:
      ConversationMarkdownInline(source: block.text, muted: muted)
    case let .heading(level):
      ConversationMarkdownInline(source: block.text, muted: muted,
                                 font: headingFont(level), weight: level <= 2 ? .bold : .semibold)
        .padding(.top, level <= 2 ? 4 : 1)
    case .unordered:
      HStack(alignment: .firstTextBaseline, spacing: 9) {
        Text("•").font(Typography.reply.weight(.bold)).foregroundStyle(Palette.accent)
          .frame(width: 10, alignment: .center)
        ConversationMarkdownInline(source: block.text, muted: muted)
      }
    case let .ordered(marker):
      HStack(alignment: .firstTextBaseline, spacing: 9) {
        Text(marker).font(Typography.reply.weight(.semibold)).foregroundStyle(Palette.accentText)
          .frame(minWidth: 22, alignment: .trailing)
        ConversationMarkdownInline(source: block.text, muted: muted)
      }
    case .quote:
      HStack(alignment: .top, spacing: 10) {
        RoundedRectangle(cornerRadius: 1.5).fill(Palette.accent.opacity(0.55)).frame(width: 3)
        ConversationMarkdownInline(source: block.text, muted: true)
      }
      .padding(.vertical, 2)
    case let .code(language):
      VStack(alignment: .leading, spacing: 0) {
        if let language {
          Text(language.uppercased()).font(Typography.meta.weight(.semibold))
            .foregroundStyle(Palette.dim).padding(.horizontal, 12).padding(.top, 9).padding(.bottom, 4)
        }
        ScrollView(.horizontal, showsIndicators: false) {
          Text(verbatim: block.text)
            .font(Typography.codeBlock)
            .foregroundStyle(Palette.fg)
            .textSelection(.enabled)
            .padding(.horizontal, 12).padding(.vertical, language == nil ? 11 : 7)
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(Palette.bg, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
      .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(Palette.border3))
    case let .table(table):
      ConversationMarkdownTableView(table: table, muted: muted)
    case .divider:
      Rectangle().fill(Palette.border3).frame(height: 0.5).padding(.vertical, 3)
    }
  }

  private func headingFont(_ level: Int) -> Font {
    switch level {
    case 1: return muted ? .headline : .title2
    case 2: return muted ? .headline : .title3
    case 3: return muted ? .callout : .headline
    default: return muted ? .subheadline : Typography.reply
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
      .foregroundStyle(failed ? Palette.bad : Palette.warnText)
      .frame(maxWidth: .infinity, minHeight: 32, alignment: .leading)
      .accessibilityIdentifier("turn-outcome")
  }
}

extension View {
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
