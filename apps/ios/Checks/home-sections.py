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
args = parser.parse_args()
source = args.source.read_text()
projection = source[source.index('struct HomeSessionCatalog:'):source.index('struct HomeSessions:')]
fixture = r'''
import Foundation

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
let evidence: [String: HomeSessionCatalog.Activity] = ["wait": .waiting, "run": .running]
let catalog = HomeSessionCatalog(rows: rows, query: "", activity: { evidence[$0.id] })
check(catalog.waiting.map(\.id) == ["wait"], "only live question in needs-reply")
check(catalog.running.map(\.id) == ["run"], "no historical active or timestamp inference")
check(Set(catalog.waiting.map(\.id)).isDisjoint(with: catalog.running.map(\.id)), "waiting is not repeated in running")
check(catalog.pinned.map(\.id) == ["pin", "wait"], "pinned newest first, including waiting")
check(catalog.projects.count == 2, "same cwd on two hosts remains two projects")
check(Set(catalog.projects.map(\.id)).count == 2, "project identity includes scope")
let projectIDs = catalog.projects.flatMap { $0.sessions.map(\.id) }
check(Set(projectIDs).isDisjoint(with: catalog.pinned.map(\.id)), "pinned rows are not duplicated under projects")
check(projectIDs.contains("old-active") && projectIDs.contains("ended"), "historical rows remain accessible in projects")
check(catalog.defaultTab == .activity, "live evidence defaults to activity")
let quiet = HomeSessionCatalog(rows: rows, query: "", activity: { _ in nil })
check(quiet.defaultTab == .projects && quiet.waiting.isEmpty && quiet.running.isEmpty, "no live evidence defaults to projects")
let searchRows = [row("title", label: "Needle"), row("cwd", cwd: "/NEEDLE"),
                  row("provider", provider: "needle"), row("host", host: "needle"), row("miss")]
let search = HomeSessionCatalog(rows: searchRows, query: "  NEEDLE \n", activity: { _ in .running })
check(search.rows.map(\.id) == ["title", "cwd", "provider", "host"], "search title/cwd/provider/host case-insensitively")
check(search.running.map(\.id) == search.rows.map(\.id), "search filters activity too")
let large = HomeSessionCatalog(rows: (0..<45).map { row("\($0)") }, query: "", activity: { _ in .waiting })
check(large.waiting.count == 45, "projection retains overflow for explicit UI count")
print("\(count) R2 projection checks passed")
'''
with tempfile.TemporaryDirectory(prefix='scry-home-sections-') as tmp:
    tmp = Path(tmp)
    main = tmp / 'main.swift'
    main.write_text(fixture + projection + checks)
    binary = tmp / 'home-sections'
    subprocess.run(['xcrun', 'swiftc', str(main), '-o', str(binary)], check=True)
    subprocess.run(['codesign', '--force', '--sign', os.environ.get('SCRY_IOS_CHECK_SIGN_IDENTITY', '-'), str(binary)], check=True)
    subprocess.run([str(binary)], check=True)
