import { mkdir, readFile, stat, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { runScryCli } from './scry.js'
import { collectSupportBundle } from './support-bundle.js'
import { captureStdout, workspace } from './scry.test-fixture.js'

const faults = vi.hoisted(() => ({ openPath: '' }))
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, open: (...args: Parameters<typeof actual.open>) => {
    if (args[0] === faults.openPath) return Promise.reject(Object.assign(new Error('fixture cannot read log'), { code: 'EACCES' }))
    return actual.open(...args)
  } }
})
afterEach(() => { faults.openPath = '' })

async function userLogPath(): Promise<string> {
  const dir = join(process.env.XDG_STATE_HOME || join(process.env.HOME!, '.local/state'), 'scry')
  await mkdir(dir, { recursive: true })
  return join(dir, 'hook-skip.log')
}

async function doctor(root: string) {
  const stdout = captureStdout()
  const code = await runScryCli(['doctor', '--workspace', root, '--json'])
  const report = JSON.parse(stdout.text()) as {
    userHookSkips?: unknown
    checks: Array<{ id: string; status: string; detail: string }>
  }
  return { code, report, check: report.checks.find(check => check.id === 'hook.userBridgeSkips') }
}

it('keeps user-global bridge failures separate from workspace counts in doctor and support bundles', async () => {
  const root = await workspace()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-25T12:00:00Z'))
  const path = await userLogPath()
  await writeFile(`${path}.1`, '2026-10-24T10:00:00Z\tcodex\tStop\tbridge_not_found\t0\n')
  await writeFile(path, '2026-10-25T11:00:00Z\tqoder\tStop\tbridge_not_found\t0\n' +
    '2026-10-25T11:00:00Z\tqoder\tStop\tcli_failed\t1\n')
  await mkdir(join(root, '.scry/logs'), { recursive: true })
  await writeFile(join(root, '.scry/logs/hook-skip.log'), '2026-10-25T11:00:00Z\tcodex\tStop\tcli_failed\t1\n')
  const expected = { status: 'available', source: ['user_global_hook_skip_log'], value: {
    count: 2, recentCount: 1, lastAt: '2026-10-25T11:00:00Z', scope: 'retained_log_window', truncated: false,
    reason: 'bridge_not_found', workspaceAttribution: 'unknown'
  } }
  const result = await doctor(root)
  expect(result.code).toBe(5)
  expect(result.report.userHookSkips).toMatchObject(expected)
  expect(result.check).toMatchObject({ status: 'warn', detail: expect.stringContaining('workspace unknown') })
  expect(await collectSupportBundle(root)).toMatchObject({ hookSkips: { count: 1 }, userHookSkips: expected })
})

it('uses HOME when XDG state is empty, keeps unknown clocks actionable, and does not blame this workspace', async () => {
  const root = await workspace()
  vi.stubEnv('XDG_STATE_HOME', '')
  await writeFile(await userLogPath(), 'PRIVATE_UNPARSEABLE_CLOCK\tclaude\tStop\tbridge_not_found\t0\n')
  const result = await doctor(root)
  expect(result.code).toBe(0)
  expect(result.report.userHookSkips).toMatchObject({ status: 'available', value: {
    count: 1, recentCount: 1, lastAt: null, workspaceAttribution: 'unknown'
  } })
  expect(result.check?.status).toBe('warn')
  const bundle = await collectSupportBundle(root)
  expect(bundle).toMatchObject({ userHookSkips: { value: { count: 1, recentCount: 1, lastAt: null } } })
  expect(JSON.stringify(bundle)).not.toContain('PRIVATE_UNPARSEABLE_CLOCK')
})

it('reports a missing user log as an observed empty retained window', async () => {
  const root = await workspace()
  const result = await doctor(root)
  expect(result.report.userHookSkips).toMatchObject({ status: 'available', value: { count: 0, recentCount: 0, lastAt: null } })
  expect(result.check?.status).toBe('pass')
})

it('does not follow a symbolic-link user log or replace unavailable evidence with zero', async () => {
  const root = await workspace()
  const path = await userLogPath()
  const target = join(root, 'not-a-log')
  await writeFile(target, 'private data')
  await symlink(target, path)
  const result = await doctor(root)
  expect(result.report.userHookSkips).toMatchObject({ status: 'unavailable', omissionReason: 'user hook diagnostics symbolic link' })
  expect(result.report.userHookSkips).not.toHaveProperty('value')
  expect(result.check?.status).toBe('warn')
  expect(await readFile(target, 'utf8')).toBe('private data')
})

it('keeps unreadable user diagnostics unavailable without breaking workspace diagnostics', async () => {
  const root = await workspace()
  faults.openPath = await userLogPath()
  const result = await doctor(root)
  expect(result.code).toBe(0)
  expect(result.report.userHookSkips).toMatchObject({ status: 'unavailable', omissionReason: 'user hook diagnostics unreadable' })
  expect(result.report.userHookSkips).not.toHaveProperty('value')
  expect(result.check?.status).toBe('warn')
  expect(await collectSupportBundle(root)).toMatchObject({ userHookSkips: { status: 'unavailable' } })
})

it('bounds user-log reads without rotating or rewriting the user log', async () => {
  const root = await workspace()
  const path = await userLogPath()
  const text = `${new Date().toISOString()}\tcodex\tStop\tbridge_not_found\t0\n`.repeat(30_000)
  await writeFile(path, text)
  expect(Buffer.byteLength(text)).toBeGreaterThan(1024 * 1024)
  const result = await doctor(root)
  expect(result.report.userHookSkips).toMatchObject({ status: 'partial', value: { truncated: true, workspaceAttribution: 'unknown' } })
  expect((await stat(path)).size).toBe(Buffer.byteLength(text))
  await expect(stat(`${path}.1`)).rejects.toMatchObject({ code: 'ENOENT' })
})
