#!/usr/bin/env python3
"""Read-only check: a streaming (coalesced) entry never renders stale text.

Compiles the real `ConversationSplitPlan.render` decision and the real
`ConversationTurn.splitToken` from the app sources, then replays a coalesce:
same OutputLine id, unchanged output count, longer text.
"""
import re
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "ScryRemote/ConversationMarkdown.swift"
TURNS = ROOT / "ScryRemote/ConversationTurns.swift"


def slice_between(text: str, start: str, end: str) -> str:
    begin = text.index(start)
    stop = text.index(end, begin)
    return text[begin:stop]


def production_sources(path: Path) -> tuple[str, str]:
    # The plan, its render decision and the render extension sit at the end of the
    # parser file, after the splitter that produces them.
    text = path.read_text()
    plan = text[text.index("struct ConversationSplitPlan: Sendable {"):]
    token = re.search(r"  static func splitToken\(lineID: Int, text: String\) -> String \{[^\n]*\}", TURNS.read_text())
    assert token, "splitToken not found"
    return plan, "enum ConversationTurn {\n" + token.group(0).replace("  static func", "  static func") + "\n}"


HARNESS = r'''
import Foundation

struct ConversationMarkdownBlock: Sendable {
  let id: Int
  let text: String
  let start: Int
}

PLAN

TOKEN

func plan(_ text: String, lineID: Int) -> ConversationSplitPlan {
  let blocks = [
    ConversationMarkdownBlock(id: 0, text: "第一段", start: 0),
    ConversationMarkdownBlock(id: 1, text: "第二段", start: 4),
  ]
  return ConversationSplitPlan(token: ConversationTurn.splitToken(lineID: lineID, text: text),
    blocks: blocks, sourceLength: text.utf16.count, tailStart: blocks[1].start, crlfFree: true)
}

func fail(_ message: String) -> Never {
  print("FAIL \(message)"); exit(1)
}

var checks = 0
let parsed = "第一段\n\n第二段"
// 1. Token match: the parsed split renders as blocks.
let fresh = plan(parsed, lineID: 7)
if case .blocks = fresh.render(source: parsed, token: ConversationTurn.splitToken(lineID: 7, text: parsed)) {
  checks += 1
} else { fail("fresh plan did not render as blocks") }

// 2. Coalesce: same line id and count, longer text. The plan is stale, so the
//    entry must render a stable prefix plus a tail taken from CURRENT text.
let grown = parsed + "\n\n第三段还在增长"
let staleToken = ConversationTurn.splitToken(lineID: 7, text: grown)
guard case let .prefixTail(prefix, tailStart) = fresh.render(source: grown, token: staleToken) else {
  fail("stale plan did not fall back to prefix + tail")
}
let tail = String(decoding: grown.utf16.dropFirst(tailStart), as: UTF16.self)
if prefix.map(\.id) != [0] { fail("prefix blocks changed: \(prefix.map(\.id))") }
if prefix.map(\.text).joined() + tail != "第一段" + String(decoding: grown.utf16.dropFirst(4), as: UTF16.self) {
  fail("displayed text is not the current text")
}
if !tail.contains("第三段还在增长") { fail("tail is not the current text: \(tail)") }
if tail.contains("第二段") == false { fail("tail dropped the growing block start") }
checks += 2

// 3. Replaced (not prefix-extended) or shortened text must drop the split.
if case .single = fresh.render(source: "完全不同的正文", token: ConversationTurn.splitToken(lineID: 7, text: "完全不同的正文")) {
  checks += 1
} else { fail("replaced text still used the old split") }

// 4. The token changes on every streamed chunk (count is not enough on its own).
if ConversationTurn.splitToken(lineID: 7, text: parsed) == ConversationTurn.splitToken(lineID: 7, text: grown) {
  fail("token did not change when the text grew")
}
checks += 1

print("PASS \(checks) split-versioning checks")
'''


def main() -> int:
    source = SOURCE
    if "--source" in sys.argv:
        source = Path(sys.argv[sys.argv.index("--source") + 1])
    plan, token = production_sources(source)
    harness = HARNESS.replace("PLAN", plan).replace("TOKEN", token)
    with tempfile.TemporaryDirectory() as tmp:
        script = Path(tmp) / "split-versioning.swift"
        script.write_text(harness)
        result = subprocess.run(["xcrun", "swift", "-swift-version", "6", str(script)],
                                capture_output=True, text=True)
    print(result.stdout.strip() or result.stderr.strip())
    return result.returncode


if __name__ == "__main__":
    sys.exit(main())
