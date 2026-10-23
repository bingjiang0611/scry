#!/usr/bin/env python3
"""Generate a preview-only physical-device fixture from an immutable Git revision.

Does not build, install, launch, sign, change app data, or select a device. The
caller must explicitly authorize a bundle id and use iCTRL for phone replay.
Both revisions receive exactly the same injected instrumentation and workload.
"""
from pathlib import Path
import argparse
import re
import subprocess

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--revision', required=True)
parser.add_argument('--output', type=Path, required=True)
args = parser.parse_args()
root = Path(__file__).resolve().parents[3]
revision = subprocess.check_output(['git', 'rev-parse', args.revision + '^{commit}'], cwd=root, text=True).strip()
assert not args.output.exists(), 'Use a fresh fixture directory; never overwrite a source tree'
args.output.mkdir(parents=True)
archive = subprocess.Popen(['git', 'archive', revision, 'apps/ios'], cwd=root, stdout=subprocess.PIPE)
subprocess.run(['tar', '-x', '-C', str(args.output)], stdin=archive.stdout, check=True)
archive.stdout.close()
assert archive.wait() == 0
package_parent = args.output / 'experiments/remote-g0'
package_parent.mkdir(parents=True)
(package_parent / 'swift').symlink_to(root / 'experiments/remote-g0/swift', target_is_directory=True)
# Transport is not the variable in this experiment. Reject a revision if sharing
# the package would silently compare different source/contracts.
subprocess.run(['git', 'diff', '--exit-code', revision, '--', 'experiments/remote-g0/swift'], cwd=root, check=True)
source = args.output / 'apps/ios/ScryRemote'
for path in source.glob('*.swift'):
    content = path.read_text().replace('ProcessInfo.processInfo.arguments', 'BatchFDevice.arguments')
    if path.name in ('AppModel.swift', 'RemoteRunStore.swift'):
        content = content.replace('connections: RemoteConnectionStore = RemoteConnectionStore()',
                                  'connections: RemoteConnectionStore = RemoteConnectionStore(defaults: BatchFDevice.defaults)')
        content = content.replace('historyDisk: RemoteHistoryCache = RemoteHistoryCache()',
                                  'historyDisk: RemoteHistoryCache = RemoteHistoryCache(directory: BatchFDevice.stateDirectory.appendingPathComponent("history"))')
        content, changes = re.subn(r'stateDirectory: URL\? = FileManager.default.urls\(for: \.applicationSupportDirectory, in: \.userDomainMask\)\.first\?\.appendingPathComponent\("ScryRemote", isDirectory: true\)',
                                  'stateDirectory: URL? = BatchFDevice.stateDirectory', content)
        assert changes == 1, (path, changes)
    path.write_text(content)

app = source / 'ScryRemoteApp.swift'
content = app.read_text()
assert content.count('    RemoteSelfTest.runIfRequested()') == 1
content = content.replace('    RemoteSelfTest.runIfRequested()', '    BatchFDevice.prepareSelfTestLog()\n    RemoteSelfTest.runIfRequested()')
line = next(line for line in content.splitlines() if 'RootView().environmentObject(model)' in line)
content = content.replace(line, line + '\n        .onAppear { BatchFDevice.model = model }\n        .overlay(alignment: .topTrailing) { BatchFDevice.controls }')
app.write_text(content)

# Count real production body evaluations, not synthetic dependency callbacks.
for file, names in {
    'ScryRemoteApp.swift': ['RootView'],
    'ChatView.swift': ['ChatView'],
    'Components.swift': ['FocusedTurnView', 'ConversationMarkdownText', 'ConversationMarkdownInline'],
    'HomeView.swift': ['HomeView', 'SettingsView'],
    'HomeComposer.swift': ['HomeComposer'],
}.items():
    path = source / file
    content = path.read_text()
    for name in names:
        start = content.index('struct ' + name + ': View')
        body = content.index('  var body: some View {', start)
        position = body + len('  var body: some View {')
        content = content[:position] + '\n    let _ = BatchFDevice.count("' + name + '")' + content[position:]
    path.write_text(content)

store = source / 'RemoteRunStore.swift'
store.write_text(store.read_text() + '\n' + Path(__file__).with_suffix('.swift').read_text() +
                 '\nprivate let batchFRevision = "' + revision + '"\n')
print('Fixture:', args.output)
print('Revision:', revision)
print('Config: Documents/batch-f-preview.json (array of existing DEBUG arguments)')
print('Results: Documents/batch-f-selftest.log / batch-f-stream.json')
print('UI preview is mandatory; self-test retains normal admission. Preferences and state are isolated in both modes.')
