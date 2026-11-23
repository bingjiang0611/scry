import { lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync } from 'node:fs'
import type { Dirent } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterAll, expect } from 'vitest'

// Two things happen for every Vitest file, before the test module is evaluated:
//
// 1. HOME and SCRY_GRANT_DIR point at a private temporary directory. Recorder grants, the CLI
//    update state and Provider config discovery all derive their paths from HOME, so a test that
//    simply inherits the environment used to write into the developer's real ~/.scry/grants and
//    disturb whatever else that machine was doing. A test that needs to assert where things land
//    still passes its own explicit env; an explicit env without HOME keeps working because
//    homedir() reads process.env.HOME at call time.
// 2. The real ~/.scry is snapshotted before and after the file, and any new, changed or removed
//    entry fails the file that caused it. The redirect in step 1 makes a violation rare, so this
//    check exists to catch code that bypasses HOME entirely (a hardcoded path, a cached value, an
//    explicit env built from the real home) instead of silently rewriting user data again.

/** The user's real home, read before this file's isolation is applied. */
const realHome = process.env.HOME?.trim() || homedir()
/** Only paths under one directory are watched: ~/.pi holds thousands of session files and
 *  stat-ing them per test file would cost more than the isolation is worth. */
const guarded = join(realHome, '.scry')

interface Entry {
  kind: 'file' | 'dir' | 'other'
  size: number
  mtimeMs: number
}

function snapshot(root: string): Map<string, Entry> {
  const entries = new Map<string, Entry>()
  const walk = (directory: string): void => {
    let children: Dirent[]
    try {
      children = readdirSync(directory, { withFileTypes: true })
    } catch {
      return // A missing guarded directory means "no user data", not a failure.
    }
    for (const child of children) {
      const path = join(directory, child.name)
      const key = relative(root, path)
      // lstat, not stat: a symlink swap is a change even when its target is untouched.
      const info = lstatSync(path, { throwIfNoEntry: false })
      if (!info) continue
      const kind = info.isDirectory() ? 'dir' : info.isFile() ? 'file' : 'other'
      entries.set(key, { kind, size: info.size, mtimeMs: info.mtimeMs })
      if (kind === 'dir') walk(path)
    }
  }
  walk(root)
  return entries
}

function differences(before: Map<string, Entry>, after: Map<string, Entry>): string[] {
  const changed: string[] = []
  for (const [key, entry] of after) {
    const previous = before.get(key)
    if (!previous) changed.push(`added    ${key}`)
    else if (previous.kind !== entry.kind || previous.size !== entry.size || previous.mtimeMs !== entry.mtimeMs) {
      changed.push(`modified ${key}`)
    }
  }
  for (const key of before.keys()) if (!after.has(key)) changed.push(`removed  ${key}`)
  return changed.sort()
}

const before = snapshot(guarded)

const runRoot = process.env.SCRY_TEST_HOME_ROOT?.trim() || mkdtempSync(join(tmpdir(), 'scry-test-home-'))
// realpath: a test that compares an isolated path with a resolved one must see one spelling.
const isolatedHome = realpathSync(mkdtempSync(join(runRoot, 'home-')))
const isolatedGrants = join(isolatedHome, '.scry', 'grants')
mkdirSync(isolatedGrants, { recursive: true })
process.env.HOME = isolatedHome
process.env.SCRY_GRANT_DIR = isolatedGrants

afterAll(() => {
  const changed = differences(before, snapshot(guarded))
  if (changed.length === 0) return
  const testPath = expect.getState().testPath ?? '<unknown test file>'
  throw new Error([
    `${testPath} changed the real ${guarded} while it ran:`,
    ...changed.map((line) => `  ${line}`),
    'Tests must write under their temporary workspace, HOME or userData. Pass an explicit env',
    '(HOME and SCRY_GRANT_DIR) instead of building one from the real user home.'
  ].join('\n'))
})
