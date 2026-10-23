import { access, chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
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
  autoUpdateAllowedByEnv,
  runIdleAutoUpdate,
  shouldScheduleAutoUpdate,
  upgradeCli
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
    // 0.x 跨 minor 现在也自动更新：破坏性发布改为升 major。
    expect(isCompatibleAutoUpdate('0.2.32', '0.3.0')).toBe(true)
    expect(isCompatibleAutoUpdate('1.4.0', '1.5.0')).toBe(true)
    expect(isCompatibleAutoUpdate('1.4.0', '2.0.0')).toBe(false)
    expect(isCompatibleAutoUpdate('0.9.9', '1.0.0')).toBe(false)
    // 迁移链：存量 0.2.31 客户端用旧规则也接受 0.2.32，装上之后才拿到新规则。
    expect(isCompatibleAutoUpdate('0.2.31', '0.2.32')).toBe(true)
  })

  it('does not schedule updates for bundled, managed, recorder, CI or non-interactive runs', () => {
    const base = { command: 'doctor', noUpdateCheck: false, stderrIsTTY: true }
    // 默认开：未设置该变量时也会调度。
    expect(shouldScheduleAutoUpdate({ ...base, env: {} })).toBe(true)
    expect(shouldScheduleAutoUpdate({ ...base, env: { SCRY_AUTO_UPDATE: '1' } })).toBe(true)
    expect(shouldScheduleAutoUpdate({ ...base, env: { SCRY_AUTO_UPDATE: '0' } })).toBe(false)
    expect(shouldScheduleAutoUpdate({ ...base, env: { SCRY_CLI_BUNDLED: '1' } })).toBe(false)
    expect(shouldScheduleAutoUpdate({ ...base, env: { SCRY_RECORDER_MANAGED: '1' } })).toBe(false)
    expect(shouldScheduleAutoUpdate({ ...base, env: { CI: 'true' } })).toBe(false)
    expect(shouldScheduleAutoUpdate({ ...base, env: { SCRY_NO_UPDATE_CHECK: '1' } })).toBe(false)
    expect(shouldScheduleAutoUpdate({ ...base, command: 'recorder', action: 'hook', env: {} })).toBe(false)
    expect(shouldScheduleAutoUpdate({ ...base, command: 'recorder', action: 'serve', env: {} })).toBe(false)
    expect(shouldScheduleAutoUpdate({ ...base, command: 'recorder', action: 'status', env: {} })).toBe(true)
    expect(shouldScheduleAutoUpdate({ ...base, stderrIsTTY: false, env: {} })).toBe(false)
    expect(shouldScheduleAutoUpdate({ ...base, noUpdateCheck: true, env: {} })).toBe(false)
  })

  it('idle 更新走同一套 env 门，且不因为交互条件而放宽', async () => {
    // 与 shouldScheduleAutoUpdate 共用 autoUpdateAllowedByEnv，不是第二套策略。
    expect(autoUpdateAllowedByEnv({})).toBe(true)
    expect(autoUpdateAllowedByEnv({ SCRY_AUTO_UPDATE: '1' })).toBe(true)
    expect(autoUpdateAllowedByEnv({ SCRY_AUTO_UPDATE: '0' })).toBe(false)
    expect(autoUpdateAllowedByEnv({ SCRY_AUTO_UPDATE: 'false' })).toBe(false)
    expect(autoUpdateAllowedByEnv({ SCRY_RECORDER_MANAGED: '1' })).toBe(false)
    expect(autoUpdateAllowedByEnv({ SCRY_CLI_BUNDLED: '1' })).toBe(false)
    expect(autoUpdateAllowedByEnv({ SCRY_UPDATE_CHILD: '1' })).toBe(false)
    expect(autoUpdateAllowedByEnv({ CI: 'true' })).toBe(false)
    expect(autoUpdateAllowedByEnv({ SCRY_NO_UPDATE_CHECK: '1' })).toBe(false)

    // 显式关闭时 idle 触发器不做任何网络访问，也不写状态。
    const root = await mkdtemp(join(tmpdir(), 'scry-idle-update-'))
    tempDirs.push(root)
    vi.stubEnv('SCRY_CLI_UPDATE_STATE_PATH', join(root, 'state.json'))
    await expect(runIdleAutoUpdate('0.2.32', undefined, { SCRY_AUTO_UPDATE: '0' })).resolves.toBeNull()
    await expect(access(join(root, 'state.json'))).rejects.toMatchObject({ code: 'ENOENT' })
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
    const entry = join(root, 'lib/node_modules/scry-turn-recorder/dist/cli/scry.js')
    const link = join(root, 'bin/scry')
    await mkdir(join(root, 'bin'), { recursive: true })
    await mkdir(join(entry, '..'), { recursive: true })
    await writeFile(entry, '#!/usr/bin/env node\n')
    await symlink(entry, link)
    expect(npmPrefixFromEntry(link)).toBe(await realpath(root))
    expect(npmPrefixFromEntry(import.meta.filename)).toBeNull()
  })

  it('foreground upgrade installs an exact version with lifecycle scripts disabled', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scry-update-'))
    tempDirs.push(root)
    const entry = join(root, 'lib/node_modules/scry-turn-recorder/dist/cli/scry.js')
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
    await expect(upgradeCli({ currentVersion: '0.2.12', entryPath: entry, allowBreaking: true })).resolves.toMatchObject({
      status: 'updated', latestVersion: '0.2.13'
    })
    const npmCalls = await readFile(npmLog, 'utf8')
    expect(npmCalls).toContain('scry-turn-recorder@0.2.13')
    expect(npmCalls).toContain('--ignore-scripts')
    const saved = JSON.parse(await readFile(state, 'utf8')) as { updatedAt?: string; notifiedAt?: string }
    expect(saved.notifiedAt).toBe(saved.updatedAt)
  }, 15_000)

  it('只在显式配置 registry 时才固定它，仓库不内置任何部署方地址', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scry-update-'))
    tempDirs.push(root)
    const npm = join(root, 'mock-npm.mjs')
    const npmLog = join(root, 'npm.log')
    await writeFile(npm, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs'
appendFileSync(process.env.MOCK_NPM_LOG, JSON.stringify(process.argv.slice(2)) + '\\n')
if (process.argv[2] === 'view') process.stdout.write(JSON.stringify('0.2.12'))
`)
    await chmod(npm, 0o755)

    const base = {
      PATH: process.env.PATH ?? '',
      SCRY_NPM_PATH: npm,
      SCRY_CLI_UPDATE_STATE_PATH: join(root, 'state.json'),
      MOCK_NPM_LOG: npmLog
    }
    // 未设置时交由本机 npm 配置决定 registry，不再带上任何硬编码地址。
    await expect(upgradeCli({ currentVersion: '0.2.12', checkOnly: true, env: { ...base } })).resolves.toMatchObject({
      status: 'current'
    })
    await expect(upgradeCli({
      currentVersion: '0.2.12',
      checkOnly: true,
      env: { ...base, SCRY_CLI_REGISTRY: 'https://registry.example.com' }
    })).resolves.toMatchObject({ status: 'current' })
    // 非 HTTPS 的 registry 直接拒绝，不发 npm 请求。
    await expect(upgradeCli({
      currentVersion: '0.2.12',
      checkOnly: true,
      env: { ...base, SCRY_CLI_REGISTRY: 'http://registry.example.com' }
    })).resolves.toMatchObject({ status: 'error', message: 'Scry CLI registry must use HTTPS' })

    const calls = (await readFile(npmLog, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as string[])
    expect(calls).toHaveLength(2)
    expect(calls[0]).not.toContain('--registry')
    expect(calls[1]).toContain('--registry')
    expect(calls[1]).toContain('https://registry.example.com')
  }, 15_000)

  it('后台任务安装同 major 的更新，包括跨 minor，并把结果留给一次性提示', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scry-update-'))
    tempDirs.push(root)
    const entry = join(root, 'lib/node_modules/scry-turn-recorder/dist/cli/scry.js')
    const npm = join(root, 'mock-npm.mjs')
    const npmLog = join(root, 'npm.log')
    const state = join(root, 'state.json')
    await mkdir(join(entry, '..'), { recursive: true })
    await writeFile(entry, '#!/usr/bin/env node\nprocess.stdout.write("0.2.32\\n")\n')
    await writeFile(npm, `#!/usr/bin/env node
import { appendFileSync, writeFileSync } from 'node:fs'
appendFileSync(process.env.MOCK_NPM_LOG, JSON.stringify(process.argv.slice(2)) + '\\n')
if (process.argv[2] === 'view') process.stdout.write(JSON.stringify('0.3.0'))
else writeFileSync(process.env.MOCK_SCRY_ENTRY, '#!/usr/bin/env node\\nprocess.stdout.write("0.3.0\\\\n")\\n')
`)
    await chmod(npm, 0o755)
    vi.stubEnv('SCRY_NPM_PATH', npm)
    vi.stubEnv('SCRY_CLI_UPDATE_STATE_PATH', state)
    vi.stubEnv('MOCK_SCRY_ENTRY', entry)
    vi.stubEnv('MOCK_NPM_LOG', npmLog)

    await expect(runBackgroundUpdate('0.2.32', entry)).resolves.toMatchObject({
      status: 'updated', latestVersion: '0.3.0'
    })
    const calls = (await readFile(npmLog, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as string[])
    // 查询范围必须能看见下一个 minor：`~` 与 npm 的 `^` 对 0.x 都做不到。
    expect(calls[0].join(' ')).toContain('>=0.2.32 <1.0.0')
    expect(calls.some((call) => call[0] === 'install' && call.includes('--ignore-scripts'))).toBe(true)
    const saved = JSON.parse(await readFile(state, 'utf8')) as { updatedFrom?: string; updatedTo?: string }
    expect([saved.updatedFrom, saved.updatedTo]).toEqual(['0.2.32', '0.3.0'])
  }, 15_000)

  it('后台任务不会跨 major 安装，只报告可用', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scry-update-'))
    tempDirs.push(root)
    const entry = join(root, 'lib/node_modules/scry-turn-recorder/dist/cli/scry.js')
    const npm = join(root, 'mock-npm.mjs')
    const npmLog = join(root, 'npm.log')
    await mkdir(join(entry, '..'), { recursive: true })
    await writeFile(entry, '#!/usr/bin/env node\nprocess.stdout.write("0.2.32\\n")\n')
    await writeFile(npm, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs'
appendFileSync(process.env.MOCK_NPM_LOG, JSON.stringify(process.argv.slice(2)) + '\\n')
process.stdout.write(JSON.stringify('1.0.0'))
`)
    await chmod(npm, 0o755)
    vi.stubEnv('SCRY_NPM_PATH', npm)
    vi.stubEnv('SCRY_CLI_UPDATE_STATE_PATH', join(root, 'state.json'))
    vi.stubEnv('MOCK_NPM_LOG', npmLog)

    await expect(runBackgroundUpdate('0.2.32', entry)).resolves.toMatchObject({
      status: 'update_available', latestVersion: '1.0.0', compatibleAutoUpdate: false
    })
    const calls = (await readFile(npmLog, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as string[])
    expect(calls.every((call) => call[0] === 'view')).toBe(true)
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
    // 默认开意味着没人 opt-in 过，所以证明"确实装了"的这一行同时要给出关闭方法。
    await expect(consumeUpdateNotice(env)).resolves.toBe(
      'Scry CLI 已自动更新：0.2.12 → 0.2.13（关闭：SCRY_AUTO_UPDATE=0）'
    )
    await expect(consumeUpdateNotice(env)).resolves.toBeNull()
  })
})
