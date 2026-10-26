import { appendFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { readHookSkips } from './hook-diagnostics'
import { handleRecorderHook } from './recorder'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

it('invalid-config diagnostics do not bypass the rejected dataDir symlink boundary', async () => {
  const root = await mkdtemp(join(tmpdir(), 'scry-hook-invalid-'))
  const outside = await mkdtemp(join(tmpdir(), 'scry-hook-outside-'))
  roots.push(root, outside)
  await writeFile(join(root, 'scry.config.json'), JSON.stringify({ schemaVersion: 1, enabled: true, workspaceId: 'fixture', dataDir: '.scry' }))
  await mkdir(join(outside, 'logs'))
  const log = join(outside, 'logs/hook-skip.log')
  await writeFile(log, 'KEEP\n')
  await symlink(outside, join(root, '.scry'), 'dir')
  expect(await handleRecorderHook({ workspace: root, provider: 'codex', event: 'Stop', payload: { session_id: 'symlink' }, env: {} }))
    .toMatchObject({ status: 'disabled', reason: 'invalid_config' })
  expect(await readFile(log, 'utf8')).toBe('KEEP\n')
})

it('rotates shell diagnostics at 1 MiB and reports bounded retained evidence, not lifetime counts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'scry-hook-diagnostics-'))
  roots.push(root)
  await mkdir(join(root, '.scry/logs'), { recursive: true })
  const path = join(root, '.scry/logs/hook-skip.log')
  const line = '2026-10-24T12:00:00Z\tcodex\tStop\tcli_failed\t17\n'
  await writeFile(path, line.repeat(25_000))
  const report = await readHookSkips(root)
  expect(report).toMatchObject({ scope: 'retained_log_window', truncated: true, lastAt: '2026-10-24T12:00:00Z' })
  expect(report.count).toBeGreaterThan(0)
  expect(report.count).toBeLessThan(25_000)
  await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' })
  expect((await readFile(`${path}.1`)).byteLength).toBeGreaterThan(1024 * 1024)
  await appendFile(path, '2026-10-24T12:00:01Z\tqoder\tStop\tcli_failed\t17\n')
  expect(await readHookSkips(root)).toMatchObject({ count: report.count + 1, lastAt: '2026-10-24T12:00:01Z' })
})
