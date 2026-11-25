import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  readUsageLimitResumeSwitch,
  usageLimitResumePath,
  writeUsageLimitResumeSwitch
} from './background-service-actions'

let dirs: string[] = []
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  dirs = []
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'scry-usage-limit-switch-'))
  dirs.push(dir)
  return dir
}

describe('usage limit resume switch', () => {
  it('is off until the user turns it on, and round-trips both ways', () => {
    const dir = tempDir()
    // Nothing written yet: the default must never spend quota.
    expect(readUsageLimitResumeSwitch(dir)).toBe(false)
    writeUsageLimitResumeSwitch(dir, true)
    expect(readUsageLimitResumeSwitch(dir)).toBe(true)
    writeUsageLimitResumeSwitch(dir, false)
    expect(readUsageLimitResumeSwitch(dir)).toBe(false)
  })

  it('writes a private file a reader can trust', () => {
    const dir = tempDir()
    writeUsageLimitResumeSwitch(dir, true)
    expect(statSync(usageLimitResumePath(dir)).mode & 0o777).toBe(0o600)
    expect(JSON.parse(readFileSync(usageLimitResumePath(dir), 'utf8'))).toEqual({ enabled: true })
  })

  it('treats a corrupt or shapeless file as off instead of guessing', () => {
    const dir = tempDir()
    writeFileSync(usageLimitResumePath(dir), '{"enabled":')
    expect(readUsageLimitResumeSwitch(dir)).toBe(false)
    writeFileSync(usageLimitResumePath(dir), '[]')
    expect(readUsageLimitResumeSwitch(dir)).toBe(false)
    writeFileSync(usageLimitResumePath(dir), '{"enabled":"yes"}')
    expect(readUsageLimitResumeSwitch(dir)).toBe(false)
  })
})
