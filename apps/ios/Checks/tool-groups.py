#!/usr/bin/env python3
"""Compile the production read-only tool grouping and copy; no Provider/network."""
from pathlib import Path
import argparse
import os
import subprocess
import tempfile

root = Path(__file__).resolve().parents[3]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--source', type=Path, default=root / 'apps/ios/ScryRemote/ConversationTurns.swift')
args = parser.parse_args()
source = args.source.read_text()
models = source[source.index('struct ConversationEntry:'):source.index('struct ConversationChunk:')]
copy = (root / 'apps/ios/ScryRemote/ConversationCopy.swift').read_text()
checks = r'''
struct Line { let kind: String; let text: String }
func entries(_ kinds: [String]) -> [ConversationEntry] {
  ConversationEntry.group(kinds.map { Line(kind: $0, text: "读取 999 个文件 · 42秒") }, kind: \.kind, text: \.text)
}
var count = 0
func check(_ condition: Bool, _ label: String) {
  guard condition else { print("FAIL \(label)"); exit(1) }
  count += 1; print("PASS \(label)")
}
let paired = entries(["tool", "tool_result", "tool", "tool_result"])
let groups = ConversationBlock.group(paired)
check(groups.count == 1 && groups[0].entries.count == 2, "adjacent calls form one group; results do not add calls")
check(groups[0].entries.allSatisfy { $0.result != nil }, "absorbed results retained")
check(ConversationCopy.tools(groups[0].entries.count, truncated: false) == "2 个工具调用", "count uses entries, not numbers in tool text")
let single = ConversationBlock.group(entries(["tool"]))
check(single.count == 1 && single[0].isToolGroup, "single tool still forms a group")
let mixed = ConversationBlock.group(entries(["reasoning", "tool", "output", "tool", "tool_result", "truncated"]))
check(mixed.map(\.id) == [0, 1, 2, 3, 5], "prose and reasoning break groups; stable source IDs")
check(mixed.map(\.isToolGroup) == [false, true, false, true, false], "non-tool evidence stays independent")
let orphan = ConversationBlock.group(entries(["tool_result", "output", "tool_result"]))
check(orphan.count == 3 && orphan.allSatisfy { !$0.isToolGroup }, "orphan results are separate rows, not calls")
let marked = entries(["tool", "truncated"])
check(ConversationBlock.isTruncated(marked, reported: false), "explicit truncation chunk")
check(ConversationBlock.isTruncated(paired, reported: true), "run truncation flag")
check(!ConversationBlock.isTruncated(paired, reported: false), "no inferred truncation")
check(ConversationCopy.tools(2, truncated: true) == "至少 2 个工具调用", "truncated count is a lower bound")
check(ConversationBlock.group([]).isEmpty, "empty output stays empty")
print("\(count) tool-group checks passed")
'''
with tempfile.TemporaryDirectory(prefix='scry-tool-groups-') as temporary:
    directory = Path(temporary)
    main = directory / 'main.swift'
    main.write_text('import Foundation\n' + models + copy + checks)
    binary = directory / 'checks'
    subprocess.run(['xcrun', 'swiftc', str(main), '-o', str(binary)], check=True)
    subprocess.run(['codesign', '--force', '--sign', os.environ.get('SCRY_IOS_CHECK_SIGN_IDENTITY', '-'), str(binary)], check=True)
    subprocess.run([str(binary)], check=True)
