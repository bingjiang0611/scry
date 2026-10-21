import SwiftUI
import PhotosUI
import UniformTypeIdentifiers
import RemoteTransport
#if canImport(UIKit)
import UIKit
#endif

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
        .font(filled ? .title3.weight(.medium) : .body.weight(.medium))
        .controlIconScale()
        .frame(width: filled ? 46 : 44, height: filled ? 46 : 44)
        .foregroundStyle(filled ? Palette.surface : Palette.ink)
        .background(filled ? AnyShapeStyle(Palette.blue) : AnyShapeStyle(Color.clear), in: Circle())
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
        .font(.body.weight(.medium))
        .controlIconScale()
        .frame(width: 44, height: 44)
    }
    .accessibilityLabel(label)
  }
}

struct PlainIcon: View {
  let symbol: String
  let label: String
  var tint: Color = Palette.ink
  var disabled = false
  let action: () -> Void
  var body: some View {
    Button(action: action) {
      Image(systemName: symbol)
        .font(.body.weight(.medium))
        .controlIconScale()
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
        .font(.footnote.weight(.medium)).padding(.top, 1)
      Text(text).font(.footnote).frame(maxWidth: .infinity, alignment: .leading)
    }
    .foregroundStyle(warning ? Palette.warnInk : Palette.noticeInk)
    .padding(.vertical, 10).padding(.horizontal, 12)
    .background(warning ? Palette.warnBg : Palette.noticeBg, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    .padding(.horizontal, 16).padding(.bottom, 9)
  }
}

struct EmptyState: View {
  let title: String
  let detail: String
  var symbol: String = "bubble.left.and.bubble.right"
  var body: some View {
    VStack(spacing: 10) {
      Image(systemName: symbol).font(.title.weight(.light)).foregroundStyle(Palette.faint)
      Text(title).font(.headline).multilineTextAlignment(.center)
      Text(detail).font(.footnote).foregroundStyle(Palette.muted).multilineTextAlignment(.center)
    }
    .frame(maxWidth: .infinity)
    .padding(.vertical, 54).padding(.horizontal, 26)
  }
}

struct StatusDot: View {
  let link: HostLink
  var body: some View { Circle().fill(color).frame(width: 7, height: 7) }
  private var color: Color {
    switch link {
    case .connected: return Palette.green
    case .pairing: return Palette.amber
    case .notPaired, .offline: return Palette.faint
    }
  }
}

struct RemoteHeader<Right: View>: View {
  let title: String
  var subtitle: String?
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
        Text(title).font(.headline).lineLimit(titleLineLimit)
          .fixedSize(horizontal: false, vertical: true)
        if let subtitle {
          HStack(spacing: 5) {
            if let link { StatusDot(link: link) }
            Text(subtitle).lineLimit(titleLineLimit == 1 ? 1 : 2)
          }
          .font(.caption).foregroundStyle(Palette.muted)
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      right()
        .frame(minWidth: 44, minHeight: 44)
    }
    .padding(.horizontal, 10).padding(.vertical, 6)
    .frame(minHeight: 56)
    .background(Palette.surface)
    .overlay(alignment: .bottom) { Rectangle().fill(Palette.line.opacity(0.7)).frame(height: 0.5) }
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

// A shared reader policy: streamed output follows the bottom until the reader
// scrolls up. New chunks must not steal their reading position.
struct ConversationScrollView<Content: View>: View {
  let revision: String
  var stopFollowingRequest: Int = 0
  var followLatestRequest: Int = 0
  var onFollowingChange: (Bool) -> Void = { _ in }
  @ViewBuilder let content: () -> Content
  @State private var following = true
  @State private var browsingOlder = false

  var body: some View {
    GeometryReader { viewport in
      ScrollViewReader { proxy in
        ScrollView {
          LazyVStack(alignment: .leading, spacing: 18) {
            content()
            Color.clear.frame(height: 1).id("bottom")
              .background(GeometryReader { geometry in
                Color.clear.preference(key: ConversationBottom.self,
                  value: geometry.frame(in: .named("conversation-scroll")).maxY)
              })
          }
          .padding(.horizontal, 18).padding(.top, 14).padding(.bottom, 10)
          .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { _ in
            // Read the committed lazy-layout height, not a background reader's
            // placeholder size, then scroll after the new layout is installed.
            DispatchQueue.main.async {
              if following { proxy.scrollTo("bottom", anchor: .bottom) }
            }
          }
        }
        .coordinateSpace(name: "conversation-scroll")
        .defaultScrollAnchor(following ? .bottom : nil)
        .accessibilityIdentifier("conversation-scroll")
        .scrollIndicators(.hidden)
        .scrollDismissesKeyboard(.interactively)
        .simultaneousGesture(DragGesture().onChanged { value in
          if value.translation.height > 8 { following = false }
          if value.translation.height < -8 { browsingOlder = false }
        })
        .onPreferenceChange(ConversationBottom.self) { bottom in
          if !browsingOlder && bottom > 0 && bottom <= viewport.size.height + 30 { following = true }
        }
        .onAppear {
          browsingOlder = false
          following = true
          DispatchQueue.main.async { proxy.scrollTo("bottom", anchor: .bottom) }
        }
        .onChange(of: following, initial: true) { _, value in onFollowingChange(value) }
        .onChange(of: stopFollowingRequest) { browsingOlder = true; following = false }
        .onChange(of: followLatestRequest) {
          browsingOlder = false
          following = true
          proxy.scrollTo("bottom", anchor: .bottom)
        }
        .onChange(of: revision) {
          if following { proxy.scrollTo("bottom", anchor: .bottom) }
        }
        .onChange(of: viewport.size.height) {
          if following { proxy.scrollTo("bottom", anchor: .bottom) }
        }
        .overlay(alignment: .bottomTrailing) {
          if !following {
            Button {
              browsingOlder = false
              following = true
              withAnimation(.easeOut(duration: 0.18)) { proxy.scrollTo("bottom", anchor: .bottom) }
            } label: {
              Label(ConnectionCopy.returnToLatest, systemImage: "arrow.down")
                .font(.subheadline.weight(.semibold)).padding(.horizontal, 14).frame(minHeight: 44)
                .background(Palette.surface, in: Capsule())
                .overlay(Capsule().stroke(Palette.line))
            }
            .buttonStyle(.plain).padding(12)
          }
        }
      }
    }
  }
}

private struct ConversationBottom: PreferenceKey {
  static var defaultValue: CGFloat = .infinity
  static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = nextValue() }
}

// MARK: - Conversation content

struct ConversationMarkdownTable: Sendable {
  enum Alignment: Sendable {
    case left, center, right
  }

  let headers: [String]
  let alignments: [Alignment]
  let rows: [[String]]
}

struct ConversationMarkdownBlock: Identifiable, Sendable {
  enum Kind: Sendable {
    case paragraph
    case heading(Int)
    case unordered
    case ordered(String)
    case quote
    case code(String?)
    case table(ConversationMarkdownTable)
    case divider
  }

  let id: Int
  let kind: Kind
  let text: String
}

/// SwiftUI's single `Text(AttributedString(markdown:))` keeps inline emphasis,
/// but flattens most block structure (notably lists and paragraph rhythm). Agent
/// answers then become one dense wall of text. This small block parser preserves
/// the Markdown structures that matter in a conversation without using WebKit.
enum ConversationMarkdownParser {
  @concurrent static func parseForReading(_ source: String) async -> [ConversationMarkdownBlock] {
    parse(source)
  }

  static func parse(_ source: String) -> [ConversationMarkdownBlock] {
    let lines = source.replacingOccurrences(of: "\r\n", with: "\n").components(separatedBy: "\n")
    var blocks: [ConversationMarkdownBlock] = []
    var codeLines: [String] = []
    var codeFence: String?
    var codeLanguage: String?

    func append(_ kind: ConversationMarkdownBlock.Kind, _ text: String) {
      guard !text.isEmpty || { if case .divider = kind { return true }; return false }() else { return }
      blocks.append(.init(id: blocks.count, kind: kind, text: text))
    }

    var lineIndex = 0
    while lineIndex < lines.count {
      let rawLine = lines[lineIndex]
      lineIndex += 1
      let trimmed = rawLine.trimmingCharacters(in: .whitespaces)

      if let fence = codeFence {
        if trimmed.hasPrefix(fence) {
          append(.code(codeLanguage), codeLines.joined(separator: "\n"))
          codeLines = []; codeFence = nil; codeLanguage = nil
        } else {
          codeLines.append(rawLine)
        }
        continue
      }

      if trimmed.hasPrefix("```") || trimmed.hasPrefix("~~~") {
        let fence = String(trimmed.prefix(3))
        codeFence = fence
        let language = trimmed.dropFirst(3).trimmingCharacters(in: .whitespaces)
        codeLanguage = language.isEmpty ? nil : language
        continue
      }
      guard !trimmed.isEmpty else { continue }

      if lineIndex < lines.count, !startsBlock(trimmed),
         let headers = tableCells(trimmed), !headers.isEmpty,
         let alignments = tableAlignments(tableCells(lines[lineIndex]) ?? [lines[lineIndex].trimmingCharacters(in: .whitespaces)]),
         alignments.count == headers.count {
        var tableLines = [rawLine, lines[lineIndex]]
        var rows: [[String]] = []
        lineIndex += 1
        while lineIndex < lines.count {
          let row = lines[lineIndex].trimmingCharacters(in: .whitespaces)
          guard !row.isEmpty, !startsBlock(row) else { break }
          let cells = tableCells(row) ?? [row]
          // GFM pads short rows and ignores cells beyond the header width.
          rows.append(Array(cells.prefix(headers.count)) + Array(repeating: "", count: max(0, headers.count - cells.count)))
          tableLines.append(lines[lineIndex])
          lineIndex += 1
        }
        append(.table(.init(headers: headers, alignments: alignments, rows: rows)), tableLines.joined(separator: "\n"))
        continue
      }

      let hashes = trimmed.prefix { $0 == "#" }.count
      if hashes > 0, hashes <= 6, trimmed.dropFirst(hashes).first == " " {
        append(.heading(hashes), String(trimmed.dropFirst(hashes + 1)))
        continue
      }

      if isDivider(trimmed) { append(.divider, ""); continue }

      if trimmed.hasPrefix(">") {
        append(.quote, String(trimmed.dropFirst()).trimmingCharacters(in: .whitespaces))
        continue
      }

      if let item = unorderedItem(trimmed) {
        append(.unordered, item)
        continue
      }

      if let ordered = orderedItem(trimmed) {
        append(.ordered(ordered.marker), ordered.text)
        continue
      }

      // Provider output is not column-wrapped, so a source newline is normally
      // an intentional paragraph boundary. Keeping it as a block gives links,
      // summaries and short result sections the same scan rhythm as desktop AC.
      append(.paragraph, trimmed)
    }

    if codeFence != nil { append(.code(codeLanguage), codeLines.joined(separator: "\n")) }
    if blocks.isEmpty, !source.isEmpty { append(.paragraph, source) }
    return blocks
  }

  // Split only unescaped pipes. GFM also requires pipes inside code spans to
  // be escaped; removing that escape here keeps inline code's visible text exact.
  private static func tableCells(_ line: String) -> [String]? {
    var cells: [String] = []
    var cell = ""
    var characters = line.trimmingCharacters(in: .whitespaces).makeIterator()
    while let character = characters.next() {
      if character == "\\", let next = characters.next() {
        cell.append(next == "|" ? "" : "\\")
        cell.append(next)
      } else if character == "|" {
        cells.append(cell.trimmingCharacters(in: .whitespaces))
        cell = ""
      } else {
        cell.append(character)
      }
    }
    guard !cells.isEmpty else { return nil }
    cells.append(cell.trimmingCharacters(in: .whitespaces))
    if cells.first == "" { cells.removeFirst() }
    if cells.last == "" { cells.removeLast() }
    return cells
  }

  private static func tableAlignments(_ cells: [String]) -> [ConversationMarkdownTable.Alignment]? {
    var alignments: [ConversationMarkdownTable.Alignment] = []
    for cell in cells {
      var dashes = cell[...]
      if dashes.first == ":" { dashes = dashes.dropFirst() }
      if dashes.last == ":" { dashes = dashes.dropLast() }
      guard !dashes.isEmpty, dashes.allSatisfy({ $0 == "-" }) else { return nil }
      alignments.append(cell.hasSuffix(":") ? (cell.hasPrefix(":") ? .center : .right) : .left)
    }
    return alignments
  }

  private static func startsBlock(_ line: String) -> Bool {
    let hashes = line.prefix { $0 == "#" }.count
    return line.hasPrefix("```") || line.hasPrefix("~~~") || line.hasPrefix(">") ||
      isDivider(line) || unorderedItem(line) != nil || orderedItem(line) != nil ||
      (hashes > 0 && hashes <= 6 && line.dropFirst(hashes).first == " ")
  }

  private static func unorderedItem(_ line: String) -> String? {
    for prefix in ["- ", "* ", "+ "] where line.hasPrefix(prefix) {
      let value = String(line.dropFirst(2))
      if value.hasPrefix("[ ] ") { return "☐ " + value.dropFirst(4) }
      if value.lowercased().hasPrefix("[x] ") { return "☑ " + value.dropFirst(4) }
      return value
    }
    return nil
  }

  private static func orderedItem(_ line: String) -> (marker: String, text: String)? {
    let digits = line.prefix { $0.isNumber }
    guard !digits.isEmpty else { return nil }
    let rest = line.dropFirst(digits.count)
    guard rest.hasPrefix(". ") || rest.hasPrefix(") ") else { return nil }
    return (String(digits) + ".", String(rest.dropFirst(2)))
  }

  private static func isDivider(_ line: String) -> Bool {
    let compact = line.replacingOccurrences(of: " ", with: "")
    guard compact.count >= 3, let first = compact.first, first == "-" || first == "*" || first == "_" else { return false }
    return compact.allSatisfy { $0 == first }
  }
}

private struct ConversationMarkdownInline: View {
  let source: String
  var muted = false
  var font: Font = .body
  var alignment: TextAlignment = .leading

  private var rendered: AttributedString {
    (try? AttributedString(
      markdown: source,
      options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace,
                     failurePolicy: .returnPartiallyParsedIfPossible)
    )) ?? AttributedString(source)
  }

  var body: some View {
    Text(rendered)
      .font(font)
      .foregroundStyle(muted ? Palette.muted : Palette.ink)
      .lineSpacing(muted ? 3 : 5)
      .textSelection(.enabled)
      .tint(Palette.blue)
      .multilineTextAlignment(alignment)
      .frame(maxWidth: .infinity, alignment: alignment == .trailing ? .trailing : alignment == .center ? .center : .leading)
  }
}

private struct ConversationMarkdownTableView: View {
  let table: ConversationMarkdownTable
  let muted: Bool
  // Keep prose cells readable on a phone; wide tables scroll rather than
  // compressing every column to fit the conversation's viewport.
  private let columnWidth: CGFloat = 220

  var body: some View {
    ScrollView(.horizontal) {
      VStack(alignment: .leading, spacing: 0) {
        tableRow(table.headers, header: true)
        ForEach(table.rows.indices, id: \.self) { index in
          tableRow(table.rows[index], header: false)
        }
      }
      .background(Palette.canvas)
      .overlay(Rectangle().strokeBorder(Palette.line))
    }
    .accessibilityIdentifier("markdown-table")
  }

  private func tableRow(_ cells: [String], header: Bool) -> some View {
    HStack(alignment: .top, spacing: 0) {
      ForEach(cells.indices, id: \.self) { column in
        ConversationMarkdownInline(source: cells[column], muted: muted,
                                   font: (muted ? Font.footnote : .body).weight(header ? .semibold : .regular),
                                   alignment: textAlignment(table.alignments[column]))
          .monospacedDigit()
          .padding(12)
          .frame(width: columnWidth, alignment: .topLeading)
          .fixedSize(horizontal: false, vertical: true)
      }
    }
    .background(header ? Palette.line.opacity(0.35) : Color.clear)
    .overlay(alignment: .bottom) { Rectangle().fill(Palette.line).frame(height: 0.5) }
  }

  private func textAlignment(_ alignment: ConversationMarkdownTable.Alignment) -> TextAlignment {
    switch alignment {
    case .left: return .leading
    case .center: return .center
    case .right: return .trailing
    }
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
    VStack(alignment: .leading, spacing: muted ? 8 : 11) {
      ForEach(blocks) { block in
        blockView(block)
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }

  @ViewBuilder private func blockView(_ block: ConversationMarkdownBlock) -> some View {
    switch block.kind {
    case .paragraph:
      ConversationMarkdownInline(source: block.text, muted: muted, font: muted ? .footnote : .body)
    case let .heading(level):
      ConversationMarkdownInline(source: block.text, muted: muted, font: headingFont(level))
        .padding(.top, level <= 2 ? 4 : 1)
    case .unordered:
      HStack(alignment: .firstTextBaseline, spacing: 9) {
        Text("•").font((muted ? Font.footnote : .body).weight(.bold)).foregroundStyle(Palette.blue)
          .frame(width: 10, alignment: .center)
        ConversationMarkdownInline(source: block.text, muted: muted, font: muted ? .footnote : .body)
      }
    case let .ordered(marker):
      HStack(alignment: .firstTextBaseline, spacing: 9) {
        Text(marker).font((muted ? Font.footnote : .subheadline).weight(.semibold)).foregroundStyle(Palette.blue)
          .frame(minWidth: 22, alignment: .trailing)
        ConversationMarkdownInline(source: block.text, muted: muted, font: muted ? .footnote : .body)
      }
    case .quote:
      HStack(alignment: .top, spacing: 10) {
        RoundedRectangle(cornerRadius: 1.5).fill(Palette.blue.opacity(0.55)).frame(width: 3)
        ConversationMarkdownInline(source: block.text, muted: true, font: muted ? .footnote : .subheadline)
      }
      .padding(.vertical, 2)
    case let .code(language):
      VStack(alignment: .leading, spacing: 0) {
        if let language {
          Text(language.uppercased()).font(.caption2.weight(.semibold))
            .foregroundStyle(Palette.muted).padding(.horizontal, 12).padding(.top, 9).padding(.bottom, 4)
        }
        ScrollView(.horizontal, showsIndicators: false) {
          Text(verbatim: block.text)
            .font(.footnote.monospaced())
            .foregroundStyle(Palette.ink)
            .textSelection(.enabled)
            .padding(.horizontal, 12).padding(.vertical, language == nil ? 11 : 7)
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(Palette.canvas, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
      .overlay(RoundedRectangle(cornerRadius: 6, style: .continuous).strokeBorder(Palette.line.opacity(0.8)))
    case let .table(table):
      ConversationMarkdownTableView(table: table, muted: muted)
    case .divider:
      Rectangle().fill(Palette.line).frame(height: 0.5).padding(.vertical, 3)
    }
  }

  private func headingFont(_ level: Int) -> Font {
    switch level {
    case 1: return muted ? .headline.bold() : .title2.bold()
    case 2: return muted ? .headline.bold() : .title3.bold()
    case 3: return (muted ? Font.subheadline : .headline).weight(.semibold)
    default: return (muted ? Font.footnote : .body).weight(.semibold)
    }
  }
}

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

  static func group<T>(_ items: [T], id: (Int, T) -> Int, kind: (T) -> String, text: (T) -> String) -> [ConversationEntry] {
    var entries: [ConversationEntry] = []
    for (index, item) in items.enumerated() {
      let itemKind = kind(item)
      if itemKind == "tool_result", let last = entries.last, last.kind == "tool", last.result == nil {
        entries[entries.count - 1].result = text(item)
        continue
      }
      entries.append(ConversationEntry(id: id(index, item), kind: itemKind, text: text(item)))
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
            .controlIconScale().frame(width: 18)
          Text(detailLabel)
            .font(kind == "tool" ? .footnote.monospaced() : .footnote)
            .lineLimit(1).frame(maxWidth: .infinity, alignment: .leading)
          if let result {
            Text("\(Self.lines(result)) 行").font(.caption).monospacedDigit()
          }
          Image(systemName: expanded ? "chevron.down" : Symbol.chevron)
            .font(.caption.weight(.medium)).controlIconScale()
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
            Text(text).font(.footnote.monospaced())
              .foregroundStyle(Palette.ink).textSelection(.enabled)
            if let result {
              Rectangle().fill(Palette.line).frame(height: 0.5)
              Text(ConnectionCopy.result).font(.caption.weight(.semibold)).foregroundStyle(Palette.muted)
              Text(result).font(.caption.monospaced())
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
      .font(.caption)
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
        Text(text).font(.body).lineSpacing(3)
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
    ForEach(ConversationEntry.group(lines, id: { $1.id }, kind: \.kind, text: \.text)) { entry in
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
      .font(.footnote.weight(.medium))
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
  @EnvironmentObject var run: RemoteRunStore
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
      else { Image(systemName: symbol).font(.footnote.weight(.medium)).controlIconScale() }
      Text(status.text).fixedSize(horizontal: false, vertical: true)
        .frame(maxWidth: .infinity, alignment: .leading)
      if let action = status.action {
        Button(action.title, action: action.perform)
          .font(.footnote.weight(.semibold))
          .foregroundStyle(action.destructive ? Palette.negative : color)
          .disabled(action.disabled)
          .frame(minWidth: 44, minHeight: 44)
          .accessibilityIdentifier("session-status-action")
      }
    }
    .font(.footnote.weight(.medium))
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

// MARK: - Attachments and composer

struct DraftAttachment: Identifiable, Equatable {
  enum Kind { case image, text }
  let id = UUID()
  let kind: Kind
  let name: String
  let mimeType: String
  let data: Data

  var wireValue: RemoteRunClient.Attachment {
    .init(kind: kind == .image ? .image : .text, name: name, mimeType: mimeType,
          dataBase64: data.base64EncodedString(), size: data.count)
  }

  var detail: String {
    let value = ByteCountFormatter.string(fromByteCount: Int64(data.count), countStyle: .file)
    return kind == .image ? "图片 · \(value)" : "文本文件 · \(value)"
  }

  // Mirrors the host limits in src/main/remote/host-controller.ts.
  static let maxCount = 4
  static let maxEachBytes = 512 * 1024
  static let maxTotalBytes = 700 * 1024

  // Each image gets an even share of the budget still free for the images
  // left in this batch. A fixed per-image target let the first two or three
  // photos consume the whole 700 KB and the rest were rejected.
  static func imageBudget(usedBytes: Int, remainingImages: Int) -> Int {
    min(maxEachBytes, max(0, maxTotalBytes - usedBytes) / max(1, remainingImages))
  }

  #if canImport(UIKit)
  // Lowers quality first, then resolution, until the JPEG fits `maxBytes`.
  // The renderer scale is pinned to 1: the default screen scale (3x) used to
  // triple the pixel dimensions and inflate every photo.
  static func compactJPEG(_ data: Data, maxBytes: Int) -> Data? {
    guard maxBytes > 0, let source = UIImage(data: data) else { return nil }
    let format = UIGraphicsImageRendererFormat.default()
    format.scale = 1
    for maxSide: CGFloat in [1600, 1280, 1024, 768] {
      let scale = min(1, maxSide / max(source.size.width, source.size.height))
      let size = CGSize(width: max(1, (source.size.width * scale).rounded()),
                        height: max(1, (source.size.height * scale).rounded()))
      let image = UIGraphicsImageRenderer(size: size, format: format).image { _ in
        source.draw(in: CGRect(origin: .zero, size: size))
      }
      for quality in [0.72, 0.58, 0.44, 0.32] {
        if let out = image.jpegData(compressionQuality: quality), out.count <= maxBytes { return out }
      }
    }
    return nil
  }
  #else
  static func compactJPEG(_ data: Data, maxBytes: Int) -> Data? { nil }
  #endif
}

struct AttachmentPreviewItem: Identifiable {
  let id = UUID()
  let name: String
  let data: Data
}

#if canImport(UIKit)
struct AttachmentThumbnail: View {
  let data: Data
  let side: CGFloat
  // Decoded once per view identity instead of on every body evaluation.
  @State private var image: UIImage?

  var body: some View {
    ZStack {
      Palette.canvas
      if let image {
        Image(uiImage: image).resizable().scaledToFill()
      } else {
        Image(systemName: Symbol.photo).foregroundStyle(Palette.muted)
      }
    }
    .frame(width: side, height: side)
    .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
    .task(id: data) { image = UIImage(data: data)?.preparingThumbnail(of: CGSize(width: side * 3, height: side * 3)) }
  }
}

// Full-screen view of the exact bytes staged or sent; pinch to zoom, double-tap to reset.
struct AttachmentImagePreview: View {
  let item: AttachmentPreviewItem
  // Decoded once; the body re-evaluates on every pinch frame.
  private let image: UIImage?
  @Environment(\.dismiss) private var dismiss
  @State private var scale: CGFloat = 1
  @State private var baseScale: CGFloat = 1

  init(item: AttachmentPreviewItem) {
    self.item = item
    image = UIImage(data: item.data)
  }

  var body: some View {
    ZStack(alignment: .topTrailing) {
      Color.black.ignoresSafeArea()
      if let image {
        Image(uiImage: image).resizable().scaledToFit()
          .scaleEffect(scale)
          .gesture(MagnifyGesture()
            .onChanged { scale = min(5, max(1, baseScale * $0.magnification)) }
            .onEnded { _ in baseScale = scale })
          .onTapGesture(count: 2) { withAnimation { scale = 1; baseScale = 1 } }
          .frame(maxWidth: .infinity, maxHeight: .infinity)
          .accessibilityLabel(item.name)
      } else {
        Text("无法显示该图片").foregroundStyle(Palette.muted).frame(maxWidth: .infinity, maxHeight: .infinity)
      }
      Button { dismiss() } label: {
        Image(systemName: "xmark").font(.subheadline.weight(.semibold)).controlIconScale().foregroundStyle(.white)
          .frame(width: 40, height: 40).background(.ultraThinMaterial, in: Circle())
      }
      .accessibilityLabel("关闭预览").padding(16)
    }
  }
}
#endif

// Attachments inside a sent user bubble: tappable image thumbnails plus
// file labels. Images without retained bytes (e.g. history) fall back to a label.
struct SentAttachmentList: View {
  let attachments: [RemoteRunStore.SentAttachment]
  @State private var previewing: AttachmentPreviewItem?

  var body: some View {
    let images = attachments.filter { $0.imageData != nil }
    let others = attachments.filter { $0.imageData == nil }
    VStack(alignment: .leading, spacing: 8) {
      #if canImport(UIKit)
      if !images.isEmpty {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 64, maximum: 96), spacing: 6)], alignment: .leading, spacing: 6) {
          ForEach(images) { item in
            if let data = item.imageData {
              Button { previewing = AttachmentPreviewItem(name: item.name, data: data) } label: {
                AttachmentThumbnail(data: data, side: 64)
              }
              .buttonStyle(.plain).accessibilityLabel("查看 \(item.name)")
            }
          }
        }
      }
      #endif
      ForEach(others) { item in
        Label(item.name, systemImage: item.kind == .image ? Symbol.photo : Symbol.file)
          .font(.caption.weight(.medium)).lineLimit(1)
      }
    }
    #if canImport(UIKit)
    .fullScreenCover(item: $previewing) { AttachmentImagePreview(item: $0) }
    #endif
  }
}

struct MessageComposer: View {
  @Binding var text: String
  @Binding var attachments: [DraftAttachment]
  let placeholder: String
  var disabled = false
  var sendDisabled = false
  var contextLabel: String?
  var onContext: (() -> Void)?
  var contextLocked = false
  var modelOptions: [G0Transport.RunModelOption] = []
  var selectedModelId: String?
  var onModel: ((String?) -> Void)?
  var effortOptions: [G0Transport.RunControlOption] = []
  var selectedEffort: String?
  var onEffort: ((String?) -> Void)?
  var permissionOptions: [G0Transport.RunControlOption] = []
  var selectedPermission = "default"
  var onPermission: ((String) -> Void)?
  var slashCommands: [G0Transport.RunCommandRef] = []
  var slashCommandsLoading = false
  var slashCommandsReason: String?
  var onRefreshSlashCommands: (() -> Void)?
  let onSend: () -> Void

  @State private var showPhotos = false
  @State private var showFiles = false
  @State private var photoItems: [PhotosPickerItem] = []
  @State private var attachmentError: String?
  @State private var previewing: AttachmentPreviewItem?
  @FocusState private var inputFocused: Bool

  private let maxCount = DraftAttachment.maxCount
  private let maxEachBytes = DraftAttachment.maxEachBytes
  private let maxTotalBytes = DraftAttachment.maxTotalBytes

  private var slashToken: String? {
    guard text.hasPrefix("/") else { return nil }
    let value = String(text.dropFirst())
    guard !value.contains(where: { $0.isWhitespace }) else { return nil }
    return value.lowercased()
  }

  private var slashMatches: [G0Transport.RunCommandRef] {
    guard let token = slashToken else { return [] }
    let matches = slashCommands.filter {
      token.isEmpty || $0.name.lowercased().hasPrefix(token) || $0.description.localizedCaseInsensitiveContains(token)
    }
    return Array(matches.prefix(8))
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      if slashToken != nil && !disabled { slashMenu.padding(.bottom, 8) }
      if !attachments.isEmpty {
        ScrollView(.horizontal, showsIndicators: false) {
          HStack(spacing: 7) { ForEach(attachments) { attachmentChip($0) } }
        }
      }
      TextField(placeholder, text: $text, axis: .vertical)
        .font(.body).lineLimit(1...6).disabled(disabled)
        .focused($inputFocused)
        .accessibilityIdentifier("message-input")
        .padding(.horizontal, 4).padding(.top, 12).padding(.bottom, 4)
      HStack(spacing: 6) {
        attachmentPermissionMenu
        Spacer(minLength: 0)
        if inputFocused {
          PlainIcon(symbol: "keyboard.chevron.compact.down", label: "收起键盘") { inputFocused = false }
        }
        // Stop lives in the session status strip, so send never changes meaning.
        Button(action: onSend) {
          Image(systemName: Symbol.send)
            .font(.subheadline.weight(.bold)).controlIconScale()
            .foregroundStyle(disabled || sendDisabled ? Palette.muted : Palette.surface)
            .frame(width: 32, height: 32)
            .background(disabled || sendDisabled ? Palette.muted.opacity(0.35) : Palette.ink, in: Circle())
            .frame(minWidth: 44, minHeight: 44).contentShape(Rectangle())
        }
        .buttonStyle(.plain).disabled(disabled || sendDisabled)
        .accessibilityLabel("发送")
      }
      if contextLabel != nil || !modelOptions.isEmpty || !effortOptions.isEmpty {
        Rectangle().fill(Palette.line).frame(height: 0.5)
        ScrollView(.horizontal, showsIndicators: false) {
          HStack(spacing: 12) {
            if let contextLabel { contextControl(contextLabel) }
            if !modelOptions.isEmpty || !effortOptions.isEmpty { modelEffortControl }
          }
        }
      }
      if let attachmentError {
        Text(attachmentError).font(.caption).foregroundStyle(Palette.negative)
      }
    }
    .padding(.horizontal, 4)
    .background(Palette.surface)
    .photosPicker(isPresented: $showPhotos, selection: $photoItems, maxSelectionCount: max(1, maxCount - attachments.count), matching: .images)
    .fileImporter(isPresented: $showFiles,
                  allowedContentTypes: [.image, .text, .sourceCode, .json, .xml],
                  allowsMultipleSelection: true) { result in
      if case let .success(urls) = result { importFiles(urls) }
      else if case let .failure(error) = result { attachmentError = error.localizedDescription }
    }
    .onChange(of: photoItems) { _, items in
      guard !items.isEmpty else { return }
      Task { await importPhotos(items); photoItems = [] }
    }
    .fullScreenCover(item: $previewing) { AttachmentImagePreview(item: $0) }
  }

  private var slashMenu: some View {
    VStack(alignment: .leading, spacing: 0) {
      HStack {
        Text(ConnectionCopy.slashCommands).font(.caption.weight(.semibold)).foregroundStyle(Palette.muted)
        Spacer()
        if slashCommandsLoading { ProgressView().controlSize(.mini) }
        if let onRefreshSlashCommands {
          Button(action: onRefreshSlashCommands) {
            Image(systemName: "arrow.clockwise").font(.caption.weight(.semibold)).controlIconScale()
          }
          .buttonStyle(.plain).accessibilityLabel(ConnectionCopy.refreshSlashCommands)
        }
      }
      .padding(.horizontal, 11).padding(.vertical, 8)

      if !slashMatches.isEmpty {
        ForEach(slashMatches) { command in
          Button {
            text = "/\(command.name) "
          } label: {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
              Text("/\(command.name)")
                .font(.footnote.monospaced().weight(.semibold))
                .foregroundStyle(Palette.blue)
              VStack(alignment: .leading, spacing: 2) {
                if !command.description.isEmpty {
                  Text(command.description).font(.footnote).foregroundStyle(Palette.ink).lineLimit(2)
                }
                if let hint = command.argumentHint, !hint.isEmpty {
                  Text(hint).font(.caption.monospaced()).foregroundStyle(Palette.muted)
                }
              }
              Spacer(minLength: 0)
            }
            .padding(.horizontal, 11).padding(.vertical, 8)
            .contentShape(Rectangle())
          }
          .buttonStyle(.plain)
          if command.id != slashMatches.last?.id { Rectangle().fill(Palette.line.opacity(0.7)).frame(height: 0.5) }
        }
      } else if !slashCommandsLoading {
        Text(slashCommandsReason ?? (slashCommands.isEmpty ? ConnectionCopy.noProviderCommands : ConnectionCopy.noMatchingCommands))
          .font(.caption).foregroundStyle(Palette.muted)
          .padding(.horizontal, 11).padding(.bottom, 10)
      }
    }
    .background(Palette.surface, in: RoundedRectangle(cornerRadius: 13, style: .continuous))
    .overlay(RoundedRectangle(cornerRadius: 13, style: .continuous).strokeBorder(Palette.line))
  }

  private var attachmentPermissionMenu: some View {
    Menu {
      Section("附件") {
        Button { showPhotos = true } label: { Label("照片图库", systemImage: Symbol.photo) }
        Button { showFiles = true } label: { Label("文本或代码文件", systemImage: Symbol.file) }
      }
      if !permissionOptions.isEmpty {
        Section("权限 · \(permissionLabel)") {
          if permissionOptions.count == 1 {
            Button {} label: { Label("已由 Mac 锁定为\(permissionLabel)", systemImage: "lock.fill") }
              .disabled(true)
          } else {
            ForEach(permissionOptions, id: \.id) { option in
              Button { onPermission?(option.id) } label: {
                Label(option.label, systemImage: selectedPermission == option.id ? Symbol.check : Symbol.shield)
              }
            }
          }
        }
      }
    } label: {
      Image(systemName: Symbol.plus)
        .font(.title2).controlIconScale()
        .foregroundStyle(Palette.ink)
        .frame(width: 44, height: 44)
        .contentShape(Rectangle())
    }
    .buttonStyle(.plain).disabled(disabled)
    .accessibilityLabel("添加附件与权限，当前\(permissionLabel)")
  }

  @ViewBuilder private func contextControl(_ label: String) -> some View {
    if let onContext, !contextLocked {
      Button(action: onContext) { controlCapsule(label, symbol: "cpu") }
        .buttonStyle(.plain).disabled(disabled)
        .accessibilityLabel("Agent：\(label)")
    } else {
      controlCapsule(label, symbol: contextLocked ? "lock.fill" : "cpu")
        .accessibilityLabel("已锁定 Agent：\(label)")
    }
  }

  private var modelEffortControl: some View {
    Menu {
      if !modelOptions.isEmpty {
        Section("模型") {
          Button { onModel?(nil) } label: {
            Label("自动模型", systemImage: selectedModelId == nil ? Symbol.check : "wand.and.stars")
          }
          ForEach(modelOptions, id: \.selectionId) { option in
            Button { onModel?(option.selectionId) } label: {
              Label(option.label, systemImage: selectedModelId == option.selectionId ? Symbol.check : "cpu")
            }
          }
        }
      }
      if !effortOptions.isEmpty {
        Section("推理强度") {
          Button { onEffort?(nil) } label: {
            Label("默认", systemImage: selectedEffort == nil ? Symbol.check : "brain")
          }
          ForEach(effortOptions, id: \.id) { option in
            Button { onEffort?(option.id) } label: {
              Label(option.label, systemImage: selectedEffort == option.id ? Symbol.check : "brain")
            }
          }
        }
      }
    } label: {
      HStack(spacing: 4) {
        Text(modelLabel).lineLimit(1)
        if !effortOptions.isEmpty { Text(effortLabel).foregroundStyle(Palette.faint) }
        Image(systemName: "chevron.down").font(.caption2.weight(.bold)).controlIconScale()
      }
      .font(.caption).foregroundStyle(Palette.muted)
      .frame(minHeight: 44).contentShape(Rectangle())
    }
    .buttonStyle(.plain).disabled(disabled)
    .accessibilityLabel("模型 \(modelLabel)，推理强度 \(effortLabel)")
  }

  private func controlCapsule(_ label: String, symbol: String) -> some View {
    Label(label, systemImage: symbol).font(.caption)
      .foregroundStyle(Palette.muted).lineLimit(1)
      .frame(minHeight: 44)
  }

  private var permissionLabel: String {
    permissionOptions.first(where: { $0.id == selectedPermission })?.label ?? "默认审批"
  }

  private var modelLabel: String {
    guard let selectedModelId else { return "自动模型" }
    return modelOptions.first(where: { $0.selectionId == selectedModelId })?.label ?? selectedModelId
  }

  private var effortLabel: String {
    effortOptions.first(where: { $0.id == selectedEffort })?.label ?? "默认"
  }

  private func attachmentChip(_ item: DraftAttachment) -> some View {
    HStack(spacing: 7) {
      Button {
        if item.kind == .image { previewing = AttachmentPreviewItem(name: item.name, data: item.data) }
      } label: {
        HStack(spacing: 7) {
          if item.kind == .image {
            AttachmentThumbnail(data: item.data, side: 30)
          } else {
            Image(systemName: Symbol.file)
          }
          VStack(alignment: .leading, spacing: 1) {
            Text(item.name).font(.caption.weight(.medium)).lineLimit(1)
            Text(item.detail).font(.caption2).foregroundStyle(Palette.muted)
          }
        }
      }
      .buttonStyle(.plain).disabled(item.kind != .image)
      .accessibilityLabel(item.kind == .image ? ConnectionCopy.viewAttachment(item.name) : item.name)
      Button { attachments.removeAll { $0.id == item.id } } label: {
        Image(systemName: "xmark").font(.caption2.weight(.bold)).controlIconScale().frame(width: 22, height: 22)
      }
      .buttonStyle(.plain).accessibilityLabel(ConnectionCopy.removeAttachment(item.name))
    }
    .padding(.leading, 9).padding(.trailing, 4).frame(minHeight: 39)
    .background(Palette.canvas, in: RoundedRectangle(cornerRadius: 11, style: .continuous))
  }

  // Errors are only set, never cleared, by an individual item, so a later
  // successful item in the same batch cannot hide an earlier rejection.
  @MainActor private func append(_ item: DraftAttachment) {
    guard attachments.count < maxCount else { attachmentError = "附件最多 4 项"; return }
    guard !item.name.isEmpty && item.name.count <= 160 else { attachmentError = "附件名称过长"; return }
    guard item.data.count <= maxEachBytes else { attachmentError = "\(item.name) 超过 512 KB；请压缩后重试"; return }
    guard usedBytes + item.data.count <= maxTotalBytes else {
      attachmentError = "附件总大小不能超过 700 KB"; return
    }
    attachments.append(item)
  }

  private var usedBytes: Int { attachments.reduce(0) { $0 + $1.data.count } }

  private func imageBudget(remainingImages: Int) -> Int {
    DraftAttachment.imageBudget(usedBytes: usedBytes, remainingImages: remainingImages)
  }

  @MainActor private func importPhotos(_ items: [PhotosPickerItem]) async {
    attachmentError = nil
    let selected = Array(items.prefix(maxCount - attachments.count))
    if selected.count < items.count { attachmentError = "附件最多 4 项，已忽略多余图片" }
    var loaded: [Data] = []
    for item in selected {
      do {
        guard let data = try await item.loadTransferable(type: Data.self) else { attachmentError = "无法读取所选图片"; continue }
        loaded.append(data)
      } catch { attachmentError = "图片读取失败：\(error.localizedDescription)" }
    }
    for (index, data) in loaded.enumerated() {
      guard let jpeg = DraftAttachment.compactJPEG(data, maxBytes: imageBudget(remainingImages: loaded.count - index)) else {
        attachmentError = "无法把所选图片压缩到剩余附件额度内"; continue
      }
      append(.init(kind: .image, name: "photo-\(attachments.count + 1).jpg", mimeType: "image/jpeg", data: jpeg))
    }
  }

  @MainActor private func importFiles(_ urls: [URL]) {
    attachmentError = nil
    let selected = Array(urls.prefix(maxCount - attachments.count))
    if selected.count < urls.count { attachmentError = "附件最多 4 项，已忽略多余文件" }
    // Only used to split the size budget; the scoped read below stays authoritative.
    var remainingImages = selected.filter { UTType(filenameExtension: $0.pathExtension)?.conforms(to: .image) == true }.count
    for url in selected {
      let scoped = url.startAccessingSecurityScopedResource()
      defer { if scoped { url.stopAccessingSecurityScopedResource() } }
      do {
        let values = try url.resourceValues(forKeys: [.contentTypeKey, .fileSizeKey])
        let type = values.contentType
        let sourceLimit = type?.conforms(to: .image) == true ? 24 * 1024 * 1024 : maxEachBytes
        if let size = values.fileSize, size > sourceLimit {
          attachmentError = "\(url.lastPathComponent) 过大；图片原文件需小于 24 MB，文本需小于 512 KB"; continue
        }
        let data = try Data(contentsOf: url, options: [.mappedIfSafe])
        if type?.conforms(to: .image) == true {
          let budget = imageBudget(remainingImages: remainingImages)
          remainingImages -= 1
          guard let jpeg = DraftAttachment.compactJPEG(data, maxBytes: budget) else {
            attachmentError = "无法把 \(url.lastPathComponent) 压缩到剩余附件额度内"; continue
          }
          append(.init(kind: .image, name: url.deletingPathExtension().lastPathComponent + ".jpg", mimeType: "image/jpeg", data: jpeg))
        } else {
          guard String(data: data, encoding: .utf8) != nil else {
            attachmentError = "\(url.lastPathComponent) 不是可读取的 UTF-8 文本文件"; continue
          }
          append(.init(kind: .text, name: url.lastPathComponent, mimeType: "text/plain", data: data))
        }
      } catch { attachmentError = "文件读取失败：\(error.localizedDescription)" }
    }
  }
}
