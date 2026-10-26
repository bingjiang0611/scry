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
  /// UTF-16 offset of this block's first line in the parsed (CRLF-normalised)
  /// source. The live reader uses it to render "everything from here to the
  /// current end" as one tail row while a newer parse is still running.
  var start: Int = 0
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
    // Running start offset for each source line, so every block can report where
    // it begins without searching the text again.
    var lineStarts: [Int] = []
    var cursor = 0
    for line in lines { lineStarts.append(cursor); cursor += line.utf16.count + 1 }
    var blockStart = 0

    func append(_ kind: ConversationMarkdownBlock.Kind, _ text: String) {
      guard !text.isEmpty || { if case .divider = kind { return true }; return false }() else { return }
      blocks.append(.init(id: blocks.count, kind: kind, text: text, start: blockStart))
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
        blockStart = lineStarts[min(lineIndex - 1, lineStarts.count - 1)]
        let fence = String(trimmed.prefix(3))
        codeFence = fence
        let language = trimmed.dropFirst(3).trimmingCharacters(in: .whitespaces)
        codeLanguage = language.isEmpty ? nil : language
        continue
      }
      guard !trimmed.isEmpty else { continue }
      blockStart = lineStarts[min(lineIndex - 1, lineStarts.count - 1)]

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

struct ConversationMarkdownInline: View {
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

struct ConversationMarkdownTableView: View {
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
  let token: String
}

enum ConversationMarkdownSplitter {
  static let minimumCharacters = 600

  /// Entry indices that are prose long enough to be worth splitting. Touches
  /// text only to hand it to the parser; it never hashes or compares it.
  static func candidates(entries: [(index: Int, kind: String, text: String, token: String)]) -> [ConversationMarkdownSplitCandidate] {
    entries.compactMap { entry in
      guard !["reasoning", "tool", "tool_result", "truncated"].contains(entry.kind),
            entry.text.count > minimumCharacters else { return nil }
      return ConversationMarkdownSplitCandidate(index: entry.index, text: entry.text, token: entry.token)
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
  static func parse(turnID: String, candidate: ConversationMarkdownSplitCandidate) async -> ConversationSplitPlan? {
    var blocks = ready(turnID: turnID, candidate: candidate)
    if blocks == nil { blocks = await ConversationMarkdownParser.parseForReading(candidate.text) }
    guard let blocks else { return nil }
    guard !Task.isCancelled, blocks.count > 1 else { return nil }
    ConversationMarkdownParser.blockCache.store(blocks, forKey: cacheKey(turnID: turnID, index: candidate.index),
                                               version: candidate.text)
    return ConversationSplitPlan(token: candidate.token, blocks: blocks,
                                 sourceLength: candidate.text.utf16.count,
                                 tailStart: blocks[blocks.count - 1].start,
                                 crlfFree: !candidate.text.contains("\r\n"))
  }
}

/// A parsed split plus the cheap facts the reader needs to decide, in O(1), what
/// it may render while the text is still growing.
struct ConversationSplitPlan: Sendable {
  /// `OutputLine.id` of the entry's last line plus that line's UTF-16 length at
  /// parse time (archived turns use `historyRevision` + entry index instead).
  let token: String
  let blocks: [ConversationMarkdownBlock]
  /// UTF-16 length of the parsed source and of everything before the last block.
  let sourceLength: Int
  let tailStart: Int
  /// Offsets are only comparable when the source had no CRLF, because the parser
  /// normalises line endings before recording them.
  let crlfFree: Bool
}

/// What one long-prose entry should render as right now.
enum ConversationSplitRender {
  case single
  case blocks([ConversationMarkdownBlock])
  /// Stable prefix blocks plus one tail row taken from the CURRENT text, so a
  /// coalesced (append-only) chunk can never leave old text on screen.
  case prefixTail(prefix: [ConversationMarkdownBlock], tailStart: Int)
}

extension ConversationSplitPlan {
  /// O(1) token comparison and an O(tail) slice that always starts in the current
  /// text. A token match means the parse is current and may render as blocks.
  func render(source: String, token currentToken: String) -> ConversationSplitRender {
    guard blocks.count > 1 else { return .single }
    if token == currentToken { return .blocks(blocks) }
    guard crlfFree else { return .single }
    let current = source.utf16.count
    guard current >= sourceLength else { return .single }
    let prefix = Array(blocks.dropLast())
    return .prefixTail(prefix: prefix, tailStart: tailStart)
  }
}
