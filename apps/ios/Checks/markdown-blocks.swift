@main enum MarkdownBlockChecks {
  static func main() {
    var checks = 0
    func expect(_ condition: Bool, _ label: String) {
      precondition(condition, label)
      checks += 1
      print("PASS \(label)")
    }
    typealias Block = ConversationMarkdownBlock
    typealias Table = ConversationMarkdownTable
    let paragraph = Block(id: 0, kind: .paragraph, text: "Hello")
    expect(paragraph == Block(id: 0, kind: .paragraph, text: "Hello"), "unchanged block is equal")
    expect(paragraph != Block(id: 1, kind: .paragraph, text: "Hello"), "identity changes invalidate")
    expect(paragraph != Block(id: 0, kind: .paragraph, text: "Hello world"), "tail text invalidates")
    expect(paragraph != Block(id: 0, kind: .heading(1), text: "Hello"), "Markdown kind invalidates")

    let pairs: [(Block.Kind, Block.Kind)] = [
      (.heading(1), .heading(2)),
      (.ordered("1."), .ordered("2.")),
      (.code(nil), .code("swift")),
      (.code("swift"), .code("json")),
      (.quote, .unordered),
      (.divider, .paragraph),
      (.table(Table(headers: ["A"], alignments: [.left], rows: [["1"]])),
       .table(Table(headers: ["B"], alignments: [.left], rows: [["1"]]))),
      (.table(Table(headers: ["A"], alignments: [.left], rows: [["1"]])),
       .table(Table(headers: ["A"], alignments: [.right], rows: [["1"]]))),
      (.table(Table(headers: ["A"], alignments: [.left], rows: [["1"]])),
       .table(Table(headers: ["A"], alignments: [.left], rows: [["2"]])))
    ]
    for (index, pair) in pairs.enumerated() {
      // Keep text identical: equality must compare every associated payload,
      // not merely source text or id (table.text normally changes as well).
      expect(Block(id: 0, kind: pair.0, text: "same") != Block(id: 0, kind: pair.1, text: "same"),
             "kind payload \(index) invalidates")
    }

    let first = ConversationMarkdownParser.parse("done\n\ntail")
    let next = ConversationMarkdownParser.parse("done\n\ntail grows 🌿")
    expect(first[0] == next[0], "completed prefix remains equal")
    expect(first[1] != next[1], "open tail remains live")
    let openCode = ConversationMarkdownParser.parse("```swift\nlet x = 1")
    let closedCode = ConversationMarkdownParser.parse("```swift\nlet x = 1\n```")
    expect(openCode == closedCode, "closing a fence preserves identical rendered content")
    let moreCode = ConversationMarkdownParser.parse("```swift\nlet x = 1\nprint(x)")
    expect(openCode != moreCode, "open fenced block still updates")
    let table = ConversationMarkdownParser.parse("A | B\n--- | ---\n1 | 2")
    let moreTable = ConversationMarkdownParser.parse("A | B\n--- | ---\n1 | 2\n3 | 4")
    expect(table != moreTable, "growing table still updates")

    let paragraphs = (1...600).map { String(format: "Line %04d: fixed streamed paragraph for batch F observation.", $0) }
    let source = paragraphs.joined(separator: "\n\n") + "\n\n"
    let blocks = ConversationMarkdownParser.parse(source)
    expect(blocks.count == 600, "all 600 paragraphs remain present")
    expect(blocks.map(\.text) == paragraphs, "every paragraph is intact and ordered")
    expect(blocks.map(\.id) == Array(0..<600), "stable complete block identities")
    let unicode = ConversationMarkdownParser.parse("中文 👩🏽‍💻\r\n\r\n尾部 e\u{301}")
    expect(unicode.map(\.text) == ["中文 👩🏽‍💻", "尾部 e\u{301}"], "Unicode and CRLF content survive")
    print("\(checks) Markdown block checks passed")
  }
}
