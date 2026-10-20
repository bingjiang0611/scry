#!/usr/bin/env python3
"""Check the production task-id expression; real SwiftUI behavior needs a phone replay."""
from pathlib import Path
import re
import subprocess
import tempfile

view = Path(__file__).resolve().parents[1] / 'ScryRemote/NewSessionView.swift'
source = view.read_text()
match = re.search(
    r'\.task\(id: (.+?)\) \{ if paired \{ run\.loadProjects\(\); run\.loadProviders\(\) \} \}',
    source,
)
assert match is not None, 'Locate the real initial metadata task, including its guarded body'
expression = match.group(1)

# Execute the exact production identity expression. The tiny field containers
# avoid UIKit/network/credentials; this does not simulate SwiftUI's runtime.
check = '''import Foundation
struct Scope { let id: String }
struct Targets { let newTaskScope: Scope }
func metadataKey(_ id: String, _ paired: Bool) -> String? {
  let targets = Targets(newTaskScope: Scope(id: id))
  return EXPRESSION
}
let checks: [(String, Bool)] = [
  ("unavailableHasNoLoadableTarget", metadataKey("mac2", false) == nil),
  ("readyKeepsTargetIdentity", metadataKey("mac2", true) == "mac2"),
  ("sameTargetBecomingReadyChangesTaskIdentity", metadataKey("mac2", false) != metadataKey("mac2", true)),
  ("readyTargetBecomingUnavailableChangesTaskIdentity", metadataKey("mac2", true) != metadataKey("mac2", false)),
  ("readyTargetSwitchChangesTaskIdentity", metadataKey("mac1", true) != metadataKey("mac2", true)),
  ("unavailableTargetSwitchDoesNotScheduleMetadata", metadataKey("mac1", false) == metadataKey("mac2", false)),
  ("unchangedReadyTargetDoesNotRestartTask", metadataKey("mac2", true) == metadataKey("mac2", true))
]
for (name, passed) in checks {
  print("\\(passed ? \"PASS\" : \"FAIL\") metadata-task.\\(name)")
}
let failures = checks.filter { !$0.1 }.count
print("Metadata task-key checks: \\(checks.count), failures: \\(failures)")
exit(failures == 0 ? 0 : 1)
'''.replace('EXPRESSION', expression)

with tempfile.TemporaryDirectory(prefix='scry-metadata-key-') as directory:
    script = Path(directory) / 'checks.swift'
    script.write_text(check)
    raise SystemExit(subprocess.run(['xcrun', 'swift', '-swift-version', '5', str(script)]).returncode)
