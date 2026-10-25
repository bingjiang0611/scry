import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readHookSkips } from '../core/turn-recorder/hook-diagnostics'
import { runScryCli } from './scry'
import { collectSupportBundle } from './support-bundle'

const NOW = Date.parse('2026-10-25T12:00:00Z')
const HOUR = 60 * 60 * 1000
const roots: string[] = []
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
})
afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function workspace(times: string[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'scry-hook-recency-'))
  roots.push(root)
  await writeFile(join(root, 'scry.config.json'), JSON.stringify({
    schemaVersion: 1, enabled: true, workspaceId: 'recency-test', dataDir: '.scry',
    repositories: { mode: 'workspace-only' },
    capture: { prompt: true, assistant: true, toolOutput: 'summary', diff: false, hooks: true }
  }))
  await mkdir(join(root, '.scry/logs'), { recursive: true })
  for (const [index, time] of times.entries()) {
    // Exercise both retained generations; neither file mtime nor rotation defines recency.
    await writeFile(join(root, `.scry/logs/hook-skip.log${index ? '.1' : ''}`),
      `${time}\tcodex\tStop\tcli_not_executable\t0\n`)
  }
  return root
}

const ago = (hours: number) => new Date(NOW - hours * HOUR).toISOString()
describe('hook skip severity uses a rolling 24-hour window', () => {
  it.each([
    { name: 'one hour ago', times: [ago(1)], recent: 1, check: 'fail', status: 'error', exit: 5 },
    { name: '25 hours ago', times: [ago(25)], recent: 0, check: 'warn', status: 'healthy', exit: 0 },
    { name: 'both old and recent', times: [ago(25), ago(1)], recent: 1, check: 'fail', status: 'error', exit: 5 },
    { name: 'unparseable timestamp', times: ['not-a-time'], recent: 1, check: 'fail', status: 'error', exit: 5 },
    { name: 'exactly 24 hours ago', times: [ago(24)], recent: 1, check: 'fail', status: 'error', exit: 5 },
    { name: 'empty history', times: [], recent: 0, check: 'pass', status: 'healthy', exit: 0 }
  ])('$name', async ({ times, recent, check, status, exit }) => {
    const root = await workspace(times)
    const summary = { count: times.length, recentCount: recent, scope: 'retained_log_window', truncated: false }
    expect.soft(await readHookSkips(root)).toMatchObject(summary)
    let output = ''
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      output += String(chunk)
      return true
    }) as typeof process.stdout.write)
    expect.soft(await runScryCli(['doctor', '--workspace', root])).toBe(exit)
    expect.soft(JSON.parse(output)).toMatchObject({
      status, healthy: exit === 0, hookSkips: summary,
      checks: expect.arrayContaining([expect.objectContaining({ id: 'hook.skips', status: check })])
    })
    output = ''
    expect(await runScryCli(['recorder', 'status', '--workspace', root])).toBe(0)
    expect.soft(JSON.parse(output).hookSkips).toMatchObject(summary)
    expect.soft((await collectSupportBundle(root)).hookSkips).toMatchObject(summary)
  })

  it('does not mask an unrelated pending warning when all skips are old', async () => {
    const root = await workspace([ago(25)])
    const inbox = join(root, '.scry/runtime/codex/pending-session/inbox')
    await mkdir(inbox, { recursive: true })
    await writeFile(join(inbox, '000000000000001-fixture.json'), '{broken')
    let output = ''
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      output += String(chunk)
      return true
    }) as typeof process.stdout.write)
    expect(await runScryCli(['doctor', '--workspace', root])).toBe(5)
    expect(JSON.parse(output)).toMatchObject({
      status: 'degraded', healthy: false,
      checks: expect.arrayContaining([
        expect.objectContaining({ id: 'hook.skips', status: 'warn' }),
        expect.objectContaining({ id: 'turns.pending', status: 'warn' })
      ])
    })
  })
})
