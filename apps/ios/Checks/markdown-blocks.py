#!/usr/bin/env python3
"""Check the production row projection and complete Markdown without a simulator.

The live grouping call is extracted too: --source accepts the frozen before
fixture for a negative control, rather than testing a duplicate identity rule.
SwiftUI body counts and physical UI replay remain necessary integration checks.
"""
from pathlib import Path
import argparse
import re
import subprocess
import tempfile

root = Path(__file__).resolve().parents[3]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--source', type=Path, help='Frozen combined Components.swift fixture for a negative control')
args = parser.parse_args()
source = (args.source or root / 'apps/ios/ScryRemote/ConversationMarkdown.swift').read_text()
turns = (args.source or root / 'apps/ios/ScryRemote/ConversationTurns.swift').read_text()
models = source[source.index('struct ConversationMarkdownTable:'):source.index('private struct ConversationMarkdownInline:')]
projection = turns[turns.index('struct ConversationEntry:'):turns.index('struct ConversationChunk:')]
calls = re.findall(r'ForEach\((ConversationEntry\.group\(lines,.*\))\) \{ entry in', turns)
assert len(calls) == 1
call = 'func grouped(_ lines: [FixtureLine]) -> [ConversationEntry] { ' + calls[0] + ' }'
fixture = Path(__file__).with_suffix('.swift').read_text()
with tempfile.TemporaryDirectory(prefix='scry-markdown-blocks-') as temporary:
    directory = Path(temporary)
    program = directory / 'MarkdownBlocks.swift'
    executable = directory / 'checks'
    program.write_text('import Foundation\n' + models + '\n' + projection + '\n' + call + '\n' + fixture)
    subprocess.run(['xcrun', 'swiftc', '-swift-version', '5', '-parse-as-library', str(program), '-o', str(executable)], check=True)
    subprocess.run([str(executable)], check=True)
