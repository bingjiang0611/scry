import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { readHookSkips } from './hook-diagnostics'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
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
