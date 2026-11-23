import { appendFileSync, mkdirSync, mkdtempSync, realpathSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect } from 'vitest'
import { applyOutcome, evaluateGuard, snapshotTree } from './real-home-guard'


const realHome = process.env.HOME?.trim() || homedir()
const guardDir = process.env.SCRY_TEST_GUARD_DIR?.trim() || join(realHome, '.scry')
const strict = Boolean(process.env.CI)

const before = snapshotTree(guardDir)

const runRoot = process.env.SCRY_TEST_HOME_ROOT?.trim() || mkdtempSync(join(tmpdir(), 'scry-test-home-'))
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
  applyOutcome(outcome, {
    guardDir,
    testPath: expect.getState().testPath ?? '<unknown test file>',
    warn: (message) => appendFileSync(warningLog, `${message}\n\n`)
  })
})
