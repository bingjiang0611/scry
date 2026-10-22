#!/usr/bin/env python3
"""Run the native store/cache checks on macOS; no simulator, phone or credentials."""
from pathlib import Path
import os
import subprocess
import tempfile
import shlex
import argparse

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--check', choices=['catalog-refresh', 'observation'], default='catalog-refresh')
parser.add_argument('--require-isolation', action='store_true')
args = parser.parse_args()
check = args.check

root = Path(__file__).resolve().parents[3]
package = root / 'experiments/remote-g0/swift'
subprocess.run(['swift', 'build', '--package-path', str(package), '--product', 'scry-remote-probe', '-j', '4'], check=True)
build = Path(subprocess.check_output(['swift', 'build', '--package-path', str(package), '--show-bin-path'], text=True).strip())
link_files = shlex.split((build / 'scry-remote-probe.product/Objects.LinkFileList').read_text())
objects = [file for file in link_files if '/RemoteProbe.build/' not in file and not file.endswith('/RemoteProbe.o')]
module_maps = list(build.glob('*.build/module.modulemap'))
for path in [
    'swift-nio/Sources/CNIOWindows/include/module.modulemap',
    'swift-nio-ssl/Sources/CNIOBoringSSL/include/module.modulemap',
    'swift-crypto/Sources/CCryptoBoringSSL/include/module.modulemap',
    'swift-crypto/Sources/CCryptoBoringSSLShims/include/module.modulemap',
    'swift-system/Sources/CSystem/include/module.modulemap',
    'swift-atomics/Sources/_AtomicsShims/include/module.modulemap',
]:
    module_maps.append(package / '.build/checkouts' / path)
sources = ['RemoteRunStore', 'RemoteRunClient', 'RemoteHistoryCache', 'RemoteConnection',
           'RemoteKeychain', 'RemotePairingClient', 'PairingCode', 'AppModel', 'ConnectionCopy',
           'ExecutionTargetCoordinator']
with tempfile.TemporaryDirectory(prefix='scry-catalog-binary-') as temporary:
    executable = Path(temporary) / 'catalog-refresh-checks'
    command = ['xcrun', 'swiftc', '-D', 'DEBUG', '-swift-version', '5', '-parse-as-library',
               '-I', str(build / 'Modules')]
    if args.require_isolation:
        command += ['-D', 'REQUIRE_ISOLATION']
    for module_map in module_maps:
        assert module_map.is_file(), module_map
        command += ['-Xcc', '-fmodule-map-file=' + str(module_map)]
    # Unrelated existing self-tests reference two view models from the large
    # UIKit components file. Compile those exact declarations, not stand-ins.
    components = (root / 'apps/ios/ScryRemote/Components.swift').read_text()
    view_models = Path(temporary) / 'ReferencedViewModels.swift'
    view_models.write_text('import SwiftUI\n' +
        components[components.index('struct TurnOutcomeNote:'):components.index('// A turn this device already')] +
        components[components.index('struct SessionStatusLine {'):components.index('struct SessionStatusStrip:')])
    home = (root / 'apps/ios/ScryRemote/HomeView.swift').read_text()
    details_snapshot = Path(temporary) / 'CatalogRefreshDetailsSnapshot.swift'
    details_snapshot.write_text('import Foundation\n' +
        home[home.index('struct CatalogRefreshDetailsSnapshot:'):home.index('// One projection')])
    command += [str(details_snapshot)]
    for source in sources:
        source_path = root / 'apps/ios/ScryRemote' / (source + '.swift')
        if check == 'observation' and source == 'RemoteRunStore':
            store_source = source_path.read_text()
            fixture = Path(temporary) / 'ObservationStore.swift'
            fixture.write_text(store_source + '\n' + Path(__file__).with_name('observation.swift').read_text())
            command += [str(fixture)]
            if 'class RemoteRunStore: ObservableObject' in store_source:
                command += ['-D', 'LEGACY_OBSERVATION']
        else:
            command += [str(source_path)]
    command += [str(root / 'apps/ios/ScryRemote/Theme.swift'), str(view_models)]
    if check == 'catalog-refresh':
        command += [str(Path(__file__).with_suffix('.swift'))]
    command += [*objects, '-o', str(executable)]
    compiled = subprocess.run(command, cwd=root)
    if compiled.returncode:
        raise SystemExit(compiled.returncode)
    # Managed Macs may reject linker-only ad-hoc signatures. Use an explicitly
    # supplied local development identity; signing/verification must succeed.
    identity = os.environ.get('SCRY_IOS_CHECK_SIGN_IDENTITY', '-')
    subprocess.run(['codesign', '--force', '--sign', identity, str(executable)], check=True)
    subprocess.run(['codesign', '--verify', '--strict', str(executable)], check=True)
    raise SystemExit(subprocess.run([str(executable), '-catalogRefreshChecks'], cwd=root).returncode)
