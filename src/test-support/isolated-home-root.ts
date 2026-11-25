import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export default function setup(): () => void {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'scry-test-home-')))
  process.env.SCRY_TEST_HOME_ROOT = root
  const warningLog = join(root, 'real-home-warnings.log')
  return () => {
    if (existsSync(warningLog)) {
      const warnings = readFileSync(warningLog, 'utf8').trim()
      if (warnings) console.warn(`\n${warnings}\n`)
    }
    rmSync(root, { recursive: true, force: true })
    delete process.env.SCRY_TEST_HOME_ROOT
  }
}
