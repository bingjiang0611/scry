import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// One private HOME root per Vitest run, removed after the last test file. Created here rather
// than in the setup file so a run leaves exactly one temporary directory behind instead of one
// per test file; forked workers inherit the variable when they spawn, after this hook ran.
// realpath, because macOS TMPDIR is a symlink and a test that compares this home against a
// resolved path must see one spelling.
// See user-home-isolation.ts for why every file needs its own HOME.
export default function setup(): () => void {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'scry-test-home-')))
  process.env.SCRY_TEST_HOME_ROOT = root
  const warningLog = join(root, 'real-home-warnings.log')
  return () => {
    // Warnings are collected per test file and printed once, after the last file: the run must
    // show them without turning them into a failure nobody can attribute.
    if (existsSync(warningLog)) {
      const warnings = readFileSync(warningLog, 'utf8').trim()
      if (warnings) console.warn(`\n${warnings}\n`)
    }
    rmSync(root, { recursive: true, force: true })
    delete process.env.SCRY_TEST_HOME_ROOT
  }
}
