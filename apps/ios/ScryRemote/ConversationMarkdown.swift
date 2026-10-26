import SwiftUI

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

  // Splitting runs in a background task, never while a body evaluates. The cache
  // is keyed by entry identity and versioned by the exact source, so a hit can
  // only ever return blocks parsed from that same text. Bounds are dual: at most
  // 64 entries and 2,000,000 characters of retained source (≈4 MB of UTF-16),
  // dropped oldest-first. Long transcripts therefore cannot pin memory, and a
  // streaming entry replaces its own slot instead of growing the cache.
  final class BlockCache: @unchecked Sendable {
    struct Entry { let version: String; let blocks: [ConversationMarkdownBlock] }
    private let lock = NSLock()
    private var storage: [String: Entry] = [:]
    private var order: [String] = []
    private var characters = 0
    static let maxEntries = 64
    static let maxCharacters = 2_000_000

    func blocks(forKey key: String, version: String) -> [ConversationMarkdownBlock]? {
      lock.lock(); defer { lock.unlock() }
      guard let hit = storage[key], hit.version == version else { return nil }
      return hit.blocks
    }

    func store(_ blocks: [ConversationMarkdownBlock], forKey key: String, version: String) {
      lock.lock(); defer { lock.unlock() }
      if let old = storage[key] {
        characters -= old.version.count
        order.removeAll { $0 == key }
      }
      storage[key] = Entry(version: version, blocks: blocks)
      order.append(key)
      characters += version.count
      while order.count > Self.maxEntries || characters > Self.maxCharacters, let oldest = order.first {
        order.removeFirst()
        if let dropped = storage.removeValue(forKey: oldest) { characters -= dropped.version.count }
      }
    }
  }

  static let blockCache = BlockCache()

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
  var font: Font = Typography.reply
  var weight: Font.Weight = .regular
  var alignment: TextAlignment = .leading

  private var rendered: AttributedString {
    var value = (try? AttributedString(markdown: source,
      options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace,
                     failurePolicy: .returnPartiallyParsedIfPossible))) ?? AttributedString(source)
    for run in value.runs where run.inlinePresentationIntent?.contains(.code) == true {
      value[run.range].font = Typography.mono
      value[run.range].backgroundColor = Palette.subtle
    }
    return value
  }

  var body: some View {
    Text(rendered).font(font.weight(weight))
      .foregroundStyle(muted ? Palette.dim : Palette.fg)
      .lineSpacing(Typography.replyLineSpacing).textSelection(.enabled)
      .tint(Palette.accentText).multilineTextAlignment(alignment)
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
      .background(Palette.bg)
      .overlay(Rectangle().strokeBorder(Palette.border3))
    }
    .accessibilityIdentifier("markdown-table")
  }

  private func tableRow(_ cells: [String], header: Bool) -> some View {
    HStack(alignment: .top, spacing: 0) {
      ForEach(cells.indices, id: \.self) { column in
        ConversationMarkdownInline(source: cells[column], muted: muted,
                                   weight: header ? .semibold : .regular,
                                   alignment: textAlignment(table.alignments[column]))
          .monospacedDigit()
          .padding(12)
          .frame(width: columnWidth, alignment: .topLeading)
          .fixedSize(horizontal: false, vertical: true)
      }
    }
    .background(header ? Palette.border3.opacity(0.35) : Color.clear)
    .overlay(alignment: .bottom) { Rectangle().fill(Palette.border3).frame(height: 0.5) }
  }

  private func textAlignment(_ alignment: ConversationMarkdownTable.Alignment) -> TextAlignment {
    switch alignment {
    case .left: return .leading
    case .center: return .center
    case .right: return .trailing
    }
  }
}

// Splitting long prose into block rows: candidates are selected here, parsing
// happens in a background task, and the reader body only ever looks up an
// already-parsed dictionary by entry index.
struct ConversationMarkdownSplitCandidate: Sendable {
  let index: Int
  let text: String
}

enum ConversationMarkdownSplitter {
  static let minimumCharacters = 600

  /// Entry indices that are prose long enough to be worth splitting. Touches
  /// text only to hand it to the parser; it never hashes or compares it.
  static func candidates(entries: [(index: Int, kind: String, text: String)]) -> [ConversationMarkdownSplitCandidate] {
    entries.compactMap { entry in
      guard !["reasoning", "tool", "tool_result", "truncated"].contains(entry.kind),
            entry.text.count > minimumCharacters else { return nil }
      return ConversationMarkdownSplitCandidate(index: entry.index, text: entry.text)
    }
  }

  static func cacheKey(turnID: String, index: Int) -> String { "\(turnID)#\(index)" }

  /// Blocks already parsed from exactly this text.
  static func ready(turnID: String, candidate: ConversationMarkdownSplitCandidate) -> [ConversationMarkdownBlock]? {
    guard let blocks = ConversationMarkdownParser.blockCache.blocks(forKey: cacheKey(turnID: turnID, index: candidate.index),
                                                                   version: candidate.text),
          blocks.count > 1 else { return nil }
    return blocks
  }

  /// Parse outside the main actor and cache by identity + exact version.
  static func parse(turnID: String, candidate: ConversationMarkdownSplitCandidate) async -> [ConversationMarkdownBlock]? {
    if let ready = ready(turnID: turnID, candidate: candidate) { return ready }
    let blocks = await ConversationMarkdownParser.parseForReading(candidate.text)
    guard !Task.isCancelled else { return nil }
    guard blocks.count > 1 else { return nil }
    ConversationMarkdownParser.blockCache.store(blocks, forKey: cacheKey(turnID: turnID, index: candidate.index),
                                               version: candidate.text)
    return blocks
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
