import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  compareVersions,
  consumeUpdateNotice,
  isCompatibleAutoUpdate,
  isUpdateDue,
  npmPrefixFromEntry,
  runBackgroundUpdate,
  shouldScheduleAutoUpdate
} from './update'

describe('CLI auto update', () => {
  const tempDirs: string[] = []

  afterEach(async () => {
    vi.unstubAllEnvs()
    await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })))
  })

  it('only auto-updates within a compatible release line', () => {
    expect(compareVersions('0.2.13', '0.2.12')).toBeGreaterThan(0)
    expect(isCompatibleAutoUpdate('0.2.12', '0.2.13')).toBe(true)
    expect(isCompatibleAutoUpdate('0.2.12', '0.3.0')).toBe(false)
    expect(isCompatibleAutoUpdate('1.4.0', '1.5.0')).toBe(true)
    expect(isCompatibleAutoUpdate('1.4.0', '2.0.0')).toBe(false)
  })

  it('does not schedule updates for bundled, managed, recorder, CI or non-interactive runs', () => {
    const base = { command: 'doctor', noUpdateCheck: false, stderrIsTTY: true }
    expect(shouldScheduleAutoUpdate({ ...base, env: {} })).toBe(true)
    expect(shouldScheduleAutoUpdate({ ...base, env: { SCRY_CLI_BUNDLED: '1' } })).toBe(false)
    expect(shouldScheduleAutoUpdate({ ...base, env: { SCRY_RECORDER_MANAGED: '1' } })).toBe(false)
    expect(shouldScheduleAutoUpdate({ ...base, env: { CI: 'true' } })).toBe(false)
    expect(shouldScheduleAutoUpdate({ ...base, command: 'recorder', action: 'hook', env: {} })).toBe(false)
    expect(shouldScheduleAutoUpdate({ ...base, command: 'recorder', action: 'serve', env: {} })).toBe(false)
    expect(shouldScheduleAutoUpdate({ ...base, command: 'recorder', action: 'status', env: {} })).toBe(true)
    expect(shouldScheduleAutoUpdate({ ...base, stderrIsTTY: false, env: {} })).toBe(false)
    expect(shouldScheduleAutoUpdate({ ...base, noUpdateCheck: true, env: {} })).toBe(false)
  })

  it('backs off longer after successful checks than failed checks', () => {
    const now = Date.parse('2026-08-05T12:00:00Z')
    expect(isUpdateDue(null, now)).toBe(true)
    expect(isUpdateDue({ checkedAt: '2026-08-05T05:00:00Z', status: 'error' }, now)).toBe(true)
    expect(isUpdateDue({ checkedAt: '2026-08-05T05:00:00Z', status: 'current' }, now)).toBe(false)
  })

  it('derives the prefix from an npm global symlink only', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scry-update-'))
    tempDirs.push(root)
    const entry = join(root, 'lib/node_modules/@ali/scry-turn-recorder/dist/cli/scry.js')
    const link = join(root, 'bin/scry')
    await mkdir(join(root, 'bin'), { recursive: true })
    await mkdir(join(entry, '..'), { recursive: true })
    await writeFile(entry, '#!/usr/bin/env node\n')
    await symlink(entry, link)
    expect(npmPrefixFromEntry(link)).toBe(await realpath(root))
    expect(npmPrefixFromEntry(import.meta.filename)).toBeNull()
  })

  it('installs an exact version and marks a background update as already notified', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scry-update-'))
    tempDirs.push(root)
    const entry = join(root, 'lib/node_modules/@ali/scry-turn-recorder/dist/cli/scry.js')
    const npm = join(root, 'mock-npm.mjs')
    const npmLog = join(root, 'npm.log')
    const state = join(root, 'state.json')
    await mkdir(join(entry, '..'), { recursive: true })
    await writeFile(entry, '#!/usr/bin/env node\nprocess.stdout.write("0.2.12\\n")\n')
    await writeFile(npm, `#!/usr/bin/env node
import { appendFileSync, writeFileSync } from 'node:fs'
appendFileSync(process.env.MOCK_NPM_LOG, JSON.stringify(process.argv.slice(2)) + '\\n')
if (process.argv[2] === 'view') process.stdout.write(JSON.stringify('0.2.13'))
else writeFileSync(process.env.MOCK_SCRY_ENTRY, '#!/usr/bin/env node\\nprocess.stdout.write("0.2.13\\\\n")\\n')
`)
    await chmod(npm, 0o755)

    vi.stubEnv('SCRY_NPM_PATH', npm)
    vi.stubEnv('SCRY_CLI_UPDATE_STATE_PATH', state)
    vi.stubEnv('MOCK_SCRY_ENTRY', entry)
    vi.stubEnv('MOCK_NPM_LOG', npmLog)
    await expect(runBackgroundUpdate('0.2.12', entry)).resolves.toMatchObject({ status: 'updated', latestVersion: '0.2.13' })
    expect(await readFile(npmLog, 'utf8')).toContain('@ali/scry-turn-recorder@~0.2.12')
    const saved = JSON.parse(await readFile(state, 'utf8')) as { updatedAt?: string; notifiedAt?: string }
    expect(saved.notifiedAt).toBe(saved.updatedAt)
  })

  it('shows an update notice once and never injects it into the bundled CLI', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scry-update-'))
    tempDirs.push(root)
    const state = join(root, 'state.json')
    await writeFile(state, JSON.stringify({
      status: 'updated',
      updatedAt: '2026-08-05T12:00:00Z',
      updatedFrom: '0.2.12',
      updatedTo: '0.2.13'
    }))
    const env = { SCRY_CLI_UPDATE_STATE_PATH: state }
    await expect(consumeUpdateNotice({ ...env, SCRY_CLI_BUNDLED: '1' })).resolves.toBeNull()
    await expect(consumeUpdateNotice(env)).resolves.toBe('Scry CLI 已自动更新：0.2.12 → 0.2.13')
    await expect(consumeUpdateNotice(env)).resolves.toBeNull()
  })
})
