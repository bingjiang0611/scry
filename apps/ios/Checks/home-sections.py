#!/usr/bin/env python3
"""Run the production R2 read-only projection with typed catalog/evidence fixtures.

No store/network is mocked into a successful run: Activity evidence is supplied
explicitly. Xcode/device tests cover the actual store-to-view adapter separately.
"""
from pathlib import Path
import argparse
import os
import subprocess
import tempfile

root = Path(__file__).resolve().parents[3]
parser = argparse.ArgumentParser()
parser.add_argument('--source', type=Path, default=root / 'apps/ios/ScryRemote/HomeSessions.swift')
parser.add_argument('--copy-source', type=Path, default=root / 'apps/ios/ScryRemote/HomeCopy.swift')
args = parser.parse_args()
source = args.source.read_text()
projection = source[source.index('struct HomeSessionCatalog:'):source.index('struct HomeSessions:')]
copy = args.copy_source.read_text()
fixture = r'''
import Foundation

enum ConnectionCopy {}
enum HomeTab { case projects, activity }
struct ExecutionTargetScope: Equatable { let id: String; let label: String }
struct Session: Equatable {
  let label: String; let cwd: String; let providerId: String
  let ts: Double; let pinnedAt: Double?; let isActive: Bool
}
enum ExecutionTargetCoordinator {
  struct HomeSession: Equatable, Identifiable {
    let id: String; let session: Session; let scope: ExecutionTargetScope
  }
}
'''
checks = r'''
typealias Row = ExecutionTargetCoordinator.HomeSession
func row(_ id: String, host: String = "host-a", label: String = "Task", cwd: String = "/repo",
         provider: String = "codex", pin: Double? = nil, active: Bool = false, ts: Double = 1) -> Row {
  Row(id: id, session: Session(label: label, cwd: cwd, providerId: provider, ts: ts, pinnedAt: pin, isActive: active),
      scope: .init(id: host, label: "Mac \(host)"))
}
var count = 0
func check(_ value: Bool, _ name: String) {
  guard value else { print("FAIL \(name)"); exit(1) }
  count += 1; print("PASS \(name)")
}
let rows = [row("wait", pin: 2), row("run"), row("old-active", active: true),
            row("ended", ts: 999999), row("pin", pin: 4), row("forwarded", host: "host-b")]
let evidence: [String: HomeSessionCatalog.Activity] = ["wait": .waiting, "run": .running, "ended": .completed]
let catalog = HomeSessionCatalog(rows: rows, query: "", activity: { evidence[$0.id] })
check(catalog.waiting.map(\.id) == ["wait"], "only live question in needs-reply")
check(catalog.running.map(\.id) == ["run"], "no historical active or timestamp inference")
check(catalog.completed.map(\.id) == ["ended"], "only the host-persisted outcome lands in completed")
check(Set(catalog.waiting.map(\.id)).isDisjoint(with: catalog.running.map(\.id)), "waiting is not repeated in running")
check(Set(catalog.completed.map(\.id)).isDisjoint(with: catalog.waiting.map(\.id) + catalog.running.map(\.id)),
      "a live run outranks an earlier ending, so no row is in two activity sections")
check(catalog.pinned.map(\.id) == ["pin", "wait"], "pinned newest first, including waiting")
check(catalog.projects.count == 2, "same cwd on two hosts remains two projects")
check(Set(catalog.projects.map(\.id)).count == 2, "project identity includes scope")
let projectIDs = catalog.projects.flatMap { $0.sessions.map(\.id) }
check(Set(projectIDs).isDisjoint(with: catalog.pinned.map(\.id)), "pinned rows are not duplicated under projects")
check(projectIDs.contains("old-active") && projectIDs.contains("ended"), "historical rows remain accessible in projects")
check(catalog.defaultTab == .activity, "live evidence defaults to activity")
let quiet = HomeSessionCatalog(rows: rows, query: "", activity: { $0.id == "ended" ? .completed : nil })
check(quiet.defaultTab == .projects && quiet.waiting.isEmpty && quiet.running.isEmpty, "no live evidence defaults to projects, even with completions")
check(quiet.completed.map(\.id) == ["ended"], "completions alone fill only their own section")
let searchRows = [row("title", label: "Needle"), row("cwd", cwd: "/NEEDLE"),
                  row("provider", provider: "needle"), row("host", host: "needle"), row("miss")]
let search = HomeSessionCatalog(rows: searchRows, query: "  NEEDLE \n", activity: { _ in .running })
check(search.rows.map(\.id) == ["title", "cwd", "provider", "host"], "search title/cwd/provider/host case-insensitively")
check(search.running.map(\.id) == search.rows.map(\.id), "search filters activity too")
let searchCompleted = HomeSessionCatalog(rows: searchRows, query: "NEEDLE", activity: { _ in .completed })
check(searchCompleted.completed.map(\.id) == searchCompleted.rows.map(\.id), "search filters the completed section too")
let large = HomeSessionCatalog(rows: (0..<45).map { row("\($0)") }, query: "", activity: { _ in .waiting })
check(large.waiting.count == 45, "projection retains overflow for explicit UI count")
check(ConnectionCopy.sectionCompleted == "已完成", "completed section title comes from the copy module")
// Expected values follow Mac relTime: choose the unit before rounding.
// In particular, 23.6 hours stays 24h, and 6.9 days stays 7d.
let now = 1_800_000_000_000.0
let timeCases: [(Double, String)] = [
  (-60, "1m"), (0, "1m"), (59 * 60, "59m"), (59.5 * 60, "60m"),
  (3_600, "1h"), (23.6 * 3_600, "24h"), (24 * 3_600, "1d"),
  (6.9 * 86_400, "7d"), (7 * 86_400, "1w"), (29 * 86_400, "4w"),
  (30 * 86_400, "1mo"), (45 * 86_400, "2mo")
]
for (seconds, expected) in timeCases {
  check(ConnectionCopy.relTime(now - seconds * 1_000, now: now) == expected,
        "relTime \(seconds)s → \(expected)")
}
print("\(count) R2 projection/time checks passed")
'''

# The live-run priority lives in the view's `candidate`, outside the extracted
# projection, so assert its source order directly: a session with a live run must
# be classified before its persisted ending is consulted, otherwise the same
# session would sit in 进行中 and 已完成 at once.
candidate = source[source.index('private var candidate: HomeSessionCatalog {')
                  :source.index('private var catalog: HomeSessionCatalog { displayed')]
live_probe = candidate.index('store.liveRun(')
ending_probe = candidate.index('turnOutcome == .completed')
assert live_probe < ending_probe, 'candidate must consult liveRun before the persisted outcome'
assert candidate.count('turnOutcome == .completed') == 1, 'completion is decided in exactly one place'
assert '.waiting : .running' in candidate[live_probe:ending_probe], 'a live run still splits into waiting/running'
with tempfile.TemporaryDirectory(prefix='scry-home-sections-') as tmp:
    tmp = Path(tmp)
    main = tmp / 'main.swift'
    main.write_text(fixture + projection + copy + checks)
    binary = tmp / 'home-sections'
    subprocess.run(['xcrun', 'swiftc', str(main), '-o', str(binary)], check=True)
    subprocess.run(['codesign', '--force', '--sign', os.environ.get('SCRY_IOS_CHECK_SIGN_IDENTITY', '-'), str(binary)], check=True)
    subprocess.run([str(binary)], check=True)
