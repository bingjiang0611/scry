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
  static let sidebar = "sidebar.left"
  static let bubble = "bubble.left"
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

/// Placeholder rows at the real row size while a list is read for the first time,
/// instead of one spinner in the middle of an empty page. The shapes come from
/// `.redacted(reason: .placeholder)` over sample text shorter than real titles, so
/// they follow system placeholder styling and Dynamic Type. They appear after the
/// shared 300 ms delay (the space is reserved from the start, so nothing moves), and
/// VoiceOver reads one label instead of the shapes.
struct PlaceholderRows: View {
  let label: String
  var count = 6
  var rowHeight: CGFloat = 48
  var icon = true
  var detail = false
  var horizontalPadding: CGFloat = 16
  @State private var visible = false

  private static let titles = ["会话标题占位", "较长一些的会话标题占位", "短标题", "另一条会话标题", "标题占位文字", "中等长度标题"]
  private static let details = ["路径占位", "较长的说明占位文字", "说明占位"]

  var body: some View {
    VStack(spacing: 0) {
      ForEach(0..<count, id: \.self) { index in
        HStack(spacing: 10) {
          if icon { RoundedRectangle(cornerRadius: 4, style: .continuous).frame(width: 16, height: 16) }
          VStack(alignment: .leading, spacing: 3) {
            Text(Self.titles[index % Self.titles.count]).font(Typography.rowTitle)
            if detail { Text(Self.details[index % Self.details.count]).font(Typography.meta) }
          }
          Spacer(minLength: 0)
        }
        .frame(minHeight: rowHeight).padding(.horizontal, horizontalPadding)
      }
    }
    .foregroundStyle(Palette.dim2)
    .redacted(reason: .placeholder)
    .opacity(visible ? 1 : 0)
    .task {
      try? await Task.sleep(for: .milliseconds(300))
      visible = true
    }
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(label)
  }
}

struct EmptyState: View {
  enum Size { case page, card, row, menu }
  struct Action {
    let label: String
    var primary = false
    var refresh = false
    var busy = false
    var disabled = false
    let perform: () -> Void
  }

  let title: String
  var detail: String? = nil
  var symbol: String? = "bubble.left.and.bubble.right"
  var size: Size = .page
  var picture: AnyView? = nil
  var action: Action? = nil
  var alternate: Action? = nil
  var announce = false
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var appeared = false

  var body: some View {
    Group {
      switch size {
      case .page:
        VStack(spacing: 0) {
          Spacer(minLength: 0)
          VStack(spacing: 10) {
            artwork
            Text(title).font(Typography.headerTitle).accessibilityAddTraits(.isHeader)
            if let detail { Text(detail).font(Typography.meta).foregroundStyle(Palette.dim) }
            if action != nil || alternate != nil {
              ViewThatFits(in: .horizontal) {
                HStack(spacing: 8) { buttons }
                VStack(spacing: 8) { buttons }
              }
            }
          }
          Spacer(minLength: 0)
          Spacer(minLength: 0)
        }
        .multilineTextAlignment(.center)
        .frame(maxWidth: .infinity)
        .padding(.horizontal, 26).padding(.vertical, 24)
      case .card, .row, .menu:
        HStack(spacing: 8) {
          if size == .card, picture != nil || symbol != nil {
            artwork.frame(width: 40, height: 40)
              .background(Palette.panel2, in: RoundedRectangle(cornerRadius: 8))
          }
          Text(title).font(Typography.meta).foregroundStyle(Palette.dim2)
            .frame(maxWidth: .infinity, alignment: .leading)
          if size != .menu, let action { button(action, quiet: true) }
        }
        .frame(minHeight: size == .menu ? nil : 44)
      }
    }
    .opacity(appeared ? 1 : 0)
    .offset(y: appeared || reduceMotion ? 0 : 6)
    .onAppear { withAnimation(.easeOut(duration: reduceMotion ? 0.15 : 0.3)) { appeared = true } }
    .onChange(of: title, initial: true) { _, title in
      if announce { AccessibilityNotification.Announcement(title).post() }
    }
    .transition(.opacity.animation(.easeOut(duration: 0.18)))
  }

  @ViewBuilder private var artwork: some View {
    Group {
      if let picture { picture }
      else if let symbol {
        Image(systemName: symbol)
          .symbolRenderingMode(.hierarchical)
          .font(.system(size: size == .page ? 48 : 22, weight: .light))
          .foregroundStyle(Palette.dim2)
      }
    }
    .accessibilityHidden(true)
  }

  @ViewBuilder private var buttons: some View {
    if let action { button(action) }
    if let alternate { button(alternate, quiet: true) }
  }

  private func button(_ action: Action, quiet: Bool = false) -> some View {
    Button {
      if !action.busy { action.perform() }
    } label: {
      HStack(spacing: 6) {
        if action.refresh {
          Image(systemName: "arrow.clockwise")
            .rotationEffect(.degrees(action.busy && !reduceMotion ? 360 : 0))
            .animation(action.busy && !reduceMotion ? .linear(duration: 0.8).repeatForever(autoreverses: false) : nil, value: action.busy)
            .accessibilityHidden(true)
        }
        Text(action.label)
      }
      .font(Typography.meta.weight(.semibold))
      .foregroundStyle(action.primary && !quiet ? Palette.onAccent : Palette.fg)
      .padding(.horizontal, 12).frame(minHeight: 44)
      .background(action.primary && !quiet ? AnyShapeStyle(Palette.accentFill) : AnyShapeStyle(quiet ? Color.clear : Palette.panel2), in: Capsule())
    }
    .buttonStyle(.plain)
    .disabled(action.disabled || action.busy)
  }
}

// Small, non-interactive views of the real panels. The locked view uses sample
// shapes only; it never takes project names or anything from protected content.
struct EmptyStatePreview: View {
  enum Scene { case conversation, lockedProjects, lockedFile }
  let scene: Scene

  var body: some View {
    ZStack(alignment: .topLeading) {
      Color.clear
      switch scene {
      case .conversation:
        card(62, 22, 42, 15) { bar(34, title: true) }
        card(75, 31, 17, 43) { bar(42, title: true); bar(48) }
      case .lockedProjects, .lockedFile:
        card(65, 58, 22, 16) {
          bar(34, title: true)
          if scene == .lockedProjects {
            bar(42); bar(36); bar(31)
          } else {
            RoundedRectangle(cornerRadius: 4).fill(Palette.dim2.opacity(0.14)).frame(width: 42, height: 21)
          }
        }
        card(29, 29, 75, 45) {
          Image(systemName: "lock").font(.system(size: 14)).foregroundStyle(Palette.dim2)
        }
      }
    }
    .frame(width: 120, height: 90)
    .accessibilityHidden(true)
  }

  private func card<Content: View>(_ width: CGFloat, _ height: CGFloat, _ x: CGFloat, _ y: CGFloat,
                                    @ViewBuilder content: () -> Content) -> some View {
    VStack(alignment: .leading, spacing: 4, content: content)
      .frame(width: width, height: height)
      .background(Palette.panel2, in: RoundedRectangle(cornerRadius: 10))
      .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Palette.border, lineWidth: 1))
      .shadow(color: .black.opacity(0.06), radius: 3, y: 2)
      .offset(x: x, y: y)
  }

  private func bar(_ width: CGFloat, title: Bool = false) -> some View {
    Capsule().fill(Palette.dim2.opacity(title ? 0.52 : 0.28)).frame(width: width, height: title ? 5 : 4)
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
  var transitionIdentity: RemoteRunStore.SessionIdentity?
  @Environment(\.conversationTransition) private var transition
  @AccessibilityFocusState private var titleFocused: Bool
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
          .conversationElement(transitionIdentity.map(ConversationTransition.Element.sessionTitle), source: false)
          .accessibilityAddTraits(.isHeader)
          .accessibilityFocused($titleFocused)
          .onAppear {
            if let transitionIdentity, transition?.state.focusDestination == .session(transitionIdentity) { titleFocused = true }
          }
        if let subtitle {
          HStack(spacing: 5) {
            if let providerId {
              Image(systemName: ProviderSymbol.name(providerId)).foregroundStyle(Palette.provider(providerId))
                .conversationElement(transitionIdentity.map(ConversationTransition.Element.sessionProvider), source: false)
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
        .conversationArrival()
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
        .submittedElement(.submittedText)
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
