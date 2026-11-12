import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// The Linux daemon mode smoke (B4-S S0-7) lives in the gated `packaged-linux` job. Kept
// apart from pr-workflow.test.ts, which covers the job list and the Check summary.
const { load } = createRequire(import.meta.url)('js-yaml') as { load: (text: string) => unknown }
interface Step {
  name?: string
  if?: string
  'continue-on-error'?: boolean
  run?: string
}
interface Job {
  'runs-on'?: string
  'continue-on-error'?: boolean
  steps: Step[]
}
const root = resolve(import.meta.dirname, '..')
const ci = load(readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8')) as { jobs: Record<string, Job> }
const step = (job: Job, name: string) => {
  const found = job.steps.find(candidate => candidate.name === name)
  if (!found) throw new Error(`Missing workflow step: ${name}`)
  return found
}

describe('Linux daemon mode smoke in CI', () => {
  it('runs in the gated job with the Chromium sandbox kept on', () => {
    const job = ci.jobs['packaged-linux']
    expect(job['runs-on']).toBe('ubuntu-latest')
    expect(job['continue-on-error']).toBeUndefined()
    const names = job.steps.map(candidate => candidate.name)
    const helper = step(job, 'Enable the Chromium setuid sandbox helper')
    const config = step(job, 'Daemon entry configuration smoke')
    const smoke = step(job, 'Daemon mode smoke in the real Electron')
    // The runner restricts unprivileged user namespaces, so the setuid helper must be
    // in place before the first Electron window opens.
    expect(names.indexOf(helper.name)).toBeLessThan(names.indexOf(smoke.name))
    expect(helper.run).toContain('sudo chown root:root "${sandbox}"')
    expect(helper.run).toContain('sudo chmod 4755 "${sandbox}"')
    expect(config.run).toBe('node scripts/daemon-config-smoke.mjs')
    expect(smoke.run).toBe("xvfb-run --auto-servernum --server-args='-screen 0 1280x800x24' node scripts/daemon-mode-smoke.mjs")
    for (const required of [helper, config, smoke]) {
      expect(required.if).toBeUndefined()
      expect(required['continue-on-error']).toBeUndefined()
    }
    for (const candidate of job.steps) {
      expect(candidate.run ?? '').not.toMatch(/--no-sandbox|--disable-gpu|ELECTRON_DISABLE_SANDBOX|apparmor_restrict_unprivileged_userns/)
    }
  })
})
