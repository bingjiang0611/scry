#!/usr/bin/env python3
"""Check production Markdown parsing/value equality without an iOS simulator.

This does not prove SwiftUI layout behavior. The physical stream600 body counter
and UI replay are the integration checks for the Equatable View boundary.
"""
from pathlib import Path
import subprocess
import tempfile

root = Path(__file__).resolve().parents[3]
source = (root / 'apps/ios/ScryRemote/Components.swift').read_text()
models = source[source.index('struct ConversationMarkdownTable:'):source.index('private struct ConversationMarkdownInline:')]
fixture = Path(__file__).with_suffix('.swift').read_text()
with tempfile.TemporaryDirectory(prefix='scry-markdown-blocks-') as temporary:
    directory = Path(temporary)
    program = directory / 'MarkdownBlocks.swift'
    executable = directory / 'checks'
    program.write_text('import Foundation\n' + models + '\n' + fixture)
    subprocess.run(['xcrun', 'swiftc', '-swift-version', '5', '-parse-as-library', str(program), '-o', str(executable)], check=True)
    subprocess.run([str(executable)], check=True)
