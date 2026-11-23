import { appendFileSync, mkdirSync, mkdtempSync, realpathSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect } from 'vitest'
import { applyOutcome, evaluateGuard, snapshotTree } from './real-home-guard'

// Two things happen for every Vitest file, before the test module is evaluated:
//
// 1. HOME and SCRY_GRANT_DIR point at a private temporary directory. Recorder grants, the CLI
//    update state and Provider config discovery all derive their paths from HOME, so a test that
//    simply inherits the environment used to write into the developer's real ~/.scry/grants and
//    disturb whatever else that machine was doing. A test that needs to assert where things land
//    still passes its own explicit env; an explicit env without HOME keeps working because
//    homedir() reads process.env.HOME at call time.
// 2. The real ~/.scry is snapshotted before and after the file. A change that a test run can be
//    held responsible for fails the file; a change this machine made on its own (a real session,
//    another checkout, the agent that runs the suite) is reported once at the end of the run.
//    CI fails on any change, because nothing else shares the runner.

/** The user's real home, read before this file's isolation is applied. */
const realHome = process.env.HOME?.trim() || homedir()
/**
 * Only paths under one directory are watched: ~/.pi holds thousands of session files and
 * stat-ing them per test file would cost more than the isolation is worth. The override exists so
 * the guard's own tests can point it at a fixture instead of the user's data directory.
 */
const guardDir = process.env.SCRY_TEST_GUARD_DIR?.trim() || join(realHome, '.scry')
/** GitHub Actions and every other CI set CI; a local run never fails on someone else's writes. */
const strict = Boolean(process.env.CI)

const before = snapshotTree(guardDir)

const runRoot = process.env.SCRY_TEST_HOME_ROOT?.trim() || mkdtempSync(join(tmpdir(), 'scry-test-home-'))
// realpath: a test that compares an isolated path with a resolved one must see one spelling.
const isolatedHome = realpathSync(mkdtempSync(join(runRoot, 'home-')))
const isolatedGrants = join(isolatedHome, '.scry', 'grants')
mkdirSync(isolatedGrants, { recursive: true })
process.env.HOME = isolatedHome
process.env.SCRY_GRANT_DIR = isolatedGrants

const warningLog = join(runRoot, 'real-home-warnings.log')

afterAll(() => {
  const outcome = evaluateGuard({
    guardDir,
    before,
    after: snapshotTree(guardDir),
    temporaryRoots: [runRoot, tmpdir()],
    strict
  })
  if (outcome.warnings.length === 0 && outcome.failures.length === 0) return
  // Parallel workers cannot print one summary themselves; each appends, globalSetup prints once.
  applyOutcome(outcome, {
    guardDir,
    testPath: expect.getState().testPath ?? '<unknown test file>',
    warn: (message) => appendFileSync(warningLog, `${message}\n\n`)
  })
})
