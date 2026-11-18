import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { electronDevLayout } from '../packaged-app-layout.mjs'

// Control: `--app` that is not a current packaged layout must fail before any App is
// launched (no daemon step, no renderer step), exit non-zero and still clean up.
const root = resolve(import.meta.dirname, '..', '..')
const temps = []
afterEach(() => { for (const path of temps.splice(0)) rmSync(path, { recursive: true, force: true }) })

function smoke(args) {
  const logDir = realpathSync(mkdtempSync(join(tmpdir(), 'scry-smoke-cli-test-')))
  temps.push(logDir)
  const run = spawnSync(process.execPath, ['scripts/daemon-mode-smoke.mjs', ...args, '--log', join(logDir, 'smoke.log')], {
    cwd: root, encoding: 'utf8', timeout: 60_000,
    // Nothing here may reach a display or a real Provider: the run must stop at the preflight.
    env: { ...process.env, DISPLAY: '', WAYLAND_DISPLAY: '' }
  })
  return { status: run.status, result: JSON.parse(run.stdout.trim().split('\n').at(-1)) }
}

describe('daemon-mode smoke --app fails closed', () => {
  it('refuses a missing executable without launching anything', () => {
    const { status, result } = smoke(['--app', join(root, 'dist', 'does-not-exist', 'scry')])
    expect(status).toBe(2)
    expect(result.target).toBe('packaged')
    expect(result.steps.packagedArtifact.ok).toBe(false)
    expect(result.steps.packagedArtifact.detail).toContain('app_executable_missing')
    expect(Object.keys(result.steps)).toEqual(['packagedArtifact', 'daemonStopped'])
    expect(result.steps.daemonStopped).toMatchObject({ ok: true, holder: { verdict: 'no-lock' }, remaining: [] })
    expect(result.cleanup).toBe(true)
  }, 60_000)

  it('refuses the development Electron binary as a packaged app', () => {
    const dev = join(root, electronDevLayout().executable)
    if (!existsSync(dev)) throw new Error(`control needs the dev Electron binary: ${dev}`)
    const { status, result } = smoke(['--app', dev])
    expect(status).toBe(2)
    expect(result.steps.packagedArtifact.detail).toContain('app_executable_not_packaged_layout')
    expect(result.steps.daemonAnswered).toBeUndefined()
  }, 60_000)

  it('refuses --app without a value instead of falling back to the source build', () => {
    const run = spawnSync(process.execPath, ['scripts/daemon-mode-smoke.mjs', '--app'], { cwd: root, encoding: 'utf8', timeout: 60_000 })
    expect(run.status).toBe(2)
    expect(JSON.parse(run.stdout.trim())).toMatchObject({ error: 'arguments: argument_value_missing', argument: '--app' })
  }, 60_000)
})
