struct FixtureLine {
  let id: Int
  let kind: String
  let text: String
}

@main enum MarkdownBlockChecks {
  static func main() {
    var checks = 0
    func expect(_ condition: Bool, _ label: String) {
      if !condition { print("FAIL \(label)"); exit(1) }
      checks += 1
      print("PASS \(label)")
    }
    let before = [FixtureLine(id: 10001, kind: "output", text: "first")]
    let after = [FixtureLine(id: 10002, kind: "output", text: "first second")]
    expect(grouped(before)[0].id == grouped(after)[0].id, "coalescing preserves live display identity")
    expect(grouped(after)[0].text == "first second", "stable identity does not freeze text")
    expect(before[0].id == 10001 && after[0].id == 10002, "canonical sequence stays unchanged")
    let tool = [FixtureLine(id: 9, kind: "tool", text: "call")]
    let result = tool + [FixtureLine(id: 10, kind: "tool_result", text: "complete result")]
    expect(grouped(tool)[0].id == grouped(result)[0].id, "tool result preserves call identity")
    expect(grouped(result).count == 1 && grouped(result)[0].result == "complete result", "tool result is retained")
    let mixed = result + [FixtureLine(id: 11, kind: "output", text: "answer")]
    expect(grouped(mixed).map(\.id) == [0, 2], "ordinals remain unique after grouping")
    expect(grouped(mixed).map(\.text) == ["call", "answer"], "grouping preserves content and order")
    let orphan = grouped([FixtureLine(id: 4, kind: "tool_result", text: "orphan")])
    expect(orphan[0].kind == "tool_result" && orphan[0].text == "orphan", "orphan result is not dropped")
    let reasoning = [FixtureLine(id: 1, kind: "reasoning", text: "a")]
    let grownReasoning = [FixtureLine(id: 2, kind: "reasoning", text: "ab")]
    expect(grouped(reasoning)[0].id == grouped(grownReasoning)[0].id, "reasoning coalesces without rekeying")

    let paragraphs = (1...600).map { String(format: "Line %04d: fixed streamed paragraph for batch F observation.", $0) }
    var source = ""
    for (index, paragraph) in paragraphs.enumerated() {
      source += paragraph + "\n\n"
      let entries = grouped([FixtureLine(id: 10001 + index, kind: "output", text: source)])
      guard entries.count == 1, entries[0].id == 0, entries[0].text == source else {
        print("FAIL complete stream projection at \(index + 1)"); exit(1)
      }
    }
    expect(true, "all 600 canonical revisions keep identity and full source")
    let blocks = ConversationMarkdownParser.parse(source)
    expect(blocks.count == 600, "all 600 paragraphs remain present")
    expect(blocks.map(\.text) == paragraphs, "every paragraph is intact and ordered")
    expect(blocks.map(\.id) == Array(0..<600), "complete Markdown block identities")
    let open = ConversationMarkdownParser.parse("done\n\ntail")
    let grown = ConversationMarkdownParser.parse("done\n\ntail grows 🌿")
    expect(open[0].text == grown[0].text && grown[1].text == "tail grows 🌿", "tail text continues to update")
    let code = ConversationMarkdownParser.parse("```swift\nlet x = 1\nprint(x)")
    expect(code[0].text == "let x = 1\nprint(x)", "open fenced block remains complete")
    let table = ConversationMarkdownParser.parse("A | B\n--- | ---\n1 | 2\n3 | 4")
    if case let .table(value) = table[0].kind {
      expect(value.rows == [["1", "2"], ["3", "4"]], "growing Markdown table retains every row")
    } else { print("FAIL table kind"); exit(1) }
    let unicode = ConversationMarkdownParser.parse("中文 👩🏽‍💻\r\n\r\n尾部 e\u{301}")
    expect(unicode.map(\.text) == ["中文 👩🏽‍💻", "尾部 e\u{301}"], "Unicode and CRLF content survive")
    print("\(checks) conversation identity/Markdown checks passed")
  }
}
