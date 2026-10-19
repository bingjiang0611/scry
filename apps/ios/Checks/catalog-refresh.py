#!/usr/bin/env python3
"""Run the native store/cache checks on macOS; no simulator, phone or credentials."""
from pathlib import Path
import subprocess
import tempfile
import shlex

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
           'RemoteKeychain', 'RemotePairingClient', 'PairingCode', 'AppModel', 'ConnectionCopy']
with tempfile.TemporaryDirectory(prefix='scry-catalog-binary-') as temporary:
    executable = Path(temporary) / 'catalog-refresh-checks'
    command = ['xcrun', 'swiftc', '-D', 'DEBUG', '-swift-version', '5', '-parse-as-library',
               '-I', str(build / 'Modules')]
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
    command += [str(root / 'apps/ios/ScryRemote' / (source + '.swift')) for source in sources]
    command += [str(root / 'apps/ios/ScryRemote/Theme.swift'), str(view_models),
                str(Path(__file__).with_suffix('.swift')), *objects, '-o', str(executable)]
    compiled = subprocess.run(command, cwd=root)
    if compiled.returncode:
        raise SystemExit(compiled.returncode)
    raise SystemExit(subprocess.run([str(executable), '-catalogRefreshChecks'], cwd=root).returncode)
