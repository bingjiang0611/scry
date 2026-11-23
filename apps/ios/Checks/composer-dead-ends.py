#!/usr/bin/env python3
"""Guard the three composer dead-ends found on a phone.

These are source contracts, not SwiftUI behavior: the folder sheet must ask for
its first listing, a blocked send must state why and offer a recovery that can
actually succeed, and the model list must have a bounded viewport so it scrolls.
Behavior evidence lives in the B4-S report (simulator A/B + paired-device replay).
"""
from pathlib import Path
import re
import sys

root = Path(__file__).resolve().parents[1] / 'ScryRemote'
pickers = (root / 'SelectionPickers.swift').read_text()
composer = (root / 'MessageComposer.swift').read_text()
transcript = (root / 'SessionTranscriptView.swift').read_text()
chat = (root / 'ChatView.swift').read_text()
popover = (root / 'Sheets/ModelEffortPopover.swift').read_text()
store = (root / 'RunStore/RemoteRunStoreProviderControls.swift').read_text()
preview = (root / 'RunStore/RemoteRunStorePreview.swift').read_text()
preview_providers = preview.split('let availableProviders = [', 1)[1].split('providers = .loaded(availableProviders)', 1)[0]

def at(source: str, needle: str) -> int:
    return source.find(needle)


checks: list[tuple[str, bool]] = []

# 1. Both pickers issue the first read themselves; a spinner without a request is
#    what pinned the sheet on “读取文件夹…” forever.
for file_name, source, call in (('folders', pickers, 'run.loadDirectories()'), ('providers', pickers, 'run.loadProviders()')):
    checks.append((
        f'{file_name}-idle-starts-the-read',
        re.search(r'case \.idle:\n(?:.|\n){0,400}?\.task \{ [^\n]*' + re.escape(call), source) is not None,
    ))
checks.append(('idle-and-loading-are-distinct-states',
               'case .idle, .loading:\n        ProgressView(ConnectionCopy.readingFolders)' not in pickers))

# 2. A stopped send says why, and the reason is not masked by a history notice.
checks.append(('no-model-claim-while-loading', 'if providerControlsLoading { return nil }' in store))
checks.append(('composer-renders-the-block-reason', 'accessibilityIdentifier("send-blocked-reason")' in composer))
checks.append(('composer-names-the-block-reason', 'sendBlockReason.map(ConnectionCopy.sendBlocked)' in composer))
checks.append(('composer-sentence-is-framed', 'Text(ConnectionCopy.sendBlocked(sendBlockReason))' in composer))
checks.append(('transcript-passes-the-block-reason', 'sendBlockReason: runBusy || run.controlsReady ? nil' in transcript))
checks.append(('arrow-follows-real-readiness', 'sendDisabled: runBusy || !run.controlsReady ||' in transcript))
checks.append(('chat-passes-the-block-reason', 'sendBlockReason: runBusy || run.chosen == nil || run.controlsReady ? nil' in chat))
status_start = at(transcript, 'private var status: SessionStatusLine?')
reload_start = at(transcript, 'private func reloadProviders')
transcript_notice = transcript[status_start:reload_start] if min(status_start, reload_start) >= 0 else ''
blocking = at(transcript_notice, '!run.controlsReady')
history = at(transcript_notice, 'if let history = historyIssue')
checks.append(('blocking-reason-outranks-history-notice', blocking >= 0 and history >= 0 and blocking < history))
checks.append(('recovery-is-explicit-not-a-refresh', 'private func applyRestoredDefaults()' in transcript
               and 'run.useProviderDefaultsForRestoredControls() { return }\n    reloadProviders()' not in transcript.replace('private func applyRestoredDefaults() {\n    if run.useProviderDefaultsForRestoredControls() { return }', '')))
checks.append(('recovery-resets-invalid-restored-controls',
               'func useProviderDefaultsForRestoredControls() -> Bool' in store
               and 'guard !restoredControlErrors.isEmpty else { return false }' in store
               and 'useProviderDefaultsForRestoredControls()' in transcript))
checks.append(('recovery-label-is-explicit', 'static let useProviderDefaults = "使用默认设置"' in (root / 'ConnectionCopy.swift').read_text()))

# 3. The model list scrolls inside a bounded viewport instead of being laid out
#    at full content height and clipped by the popover.
checks.append(('model-list-has-bounded-height', re.search(r'\.frame\(height: modelListHeight\)', popover) is not None))
checks.append(('model-list-has-no-fixed-ideal-height', '.fixedSize(horizontal: false, vertical: true)' not in popover))
checks.append(('effort-list-has-bounded-height', '.frame(height: effortListHeight)' in popover))
checks.append(('model-rows-are-not-lazy', 'LazyVStack(spacing: 2)' not in popover))

# The preview demonstrates model choices with plain synthetic IDs and labels.
preview_ids = re.findall(r'modelId: "([^"]+)"', preview_providers)
preview_models = re.findall(r'RunModelOption\(id: "([^"]+)"[^\n]+?label: "([^"]+)"', preview_providers)
checks.append(('preview-default-models-are-placeholders',
               len(preview_ids) == 3 and all(re.fullmatch(r'example-model-[a-d]', value) for value in preview_ids)))
checks.append(('preview-model-options-are-placeholders',
               len(preview_models) == 4 and all(re.fullmatch(r'example-model-[a-d]', key)
                                                and re.fullmatch(r'示例模型 [A-D]', label)
                                                for key, label in preview_models)))

failures = [name for name, passed in checks if not passed]
for name, passed in checks:
    print(f'{"PASS" if passed else "FAIL"} composer-dead-ends.{name}')
print(f'Composer dead-end checks: {len(checks)}, failures: {len(failures)}')
sys.exit(1 if failures else 0)
