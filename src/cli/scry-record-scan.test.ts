import { mkdir, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { runScryCli } from './scry'
import { captureStdout, workspace } from './scry.test-fixture.js'

function captureStderr(): { text: () => string } {
  let output = ''
  vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => {
    output += String(chunk)
    return true
  }) as typeof process.stderr.write)
  return { text: () => output }
}

/** 写盘中辍留下的临时文件名；它绝不会被 rename 上屏，也绝不能冒充一条记录。 */
const leftover = `00000000000000002328-${'a'.repeat(32)}.json.4242.6f1e.tmp`
const damaged = `00000000000000000003-${'b'.repeat(32)}.json`

describe('scry record scanning', () => {
  it('turns list skips files that are not records and says how many', async () => {
    const root = await workspace()
    const records = join(root, '.scry', 'records')
    await mkdir(records, { recursive: true })
    await writeFile(join(records, leftover), '')
    const stdout = captureStdout()
    const stderr = captureStderr()

    const code = await runScryCli(['turns', 'list', '--workspace', root])

    expect(code, stderr.text()).toBe(0)
    expect(JSON.parse(stdout.text())).toEqual([])
    expect(stderr.text()).toContain('skipped 1 file(s)')
    expect(stderr.text()).toContain(leftover)
  })

  it('records archive stops on a file whose name promises a record but does not parse', async () => {
    const root = await workspace()
    const records = join(root, '.scry', 'records')
    await mkdir(records, { recursive: true })
    await writeFile(join(records, damaged), '{"schemaVersion":1}')

    // 严格读取：损坏的证据让命令失败，而不是被安静地当成“没有这条记录”。
    const failure = await runScryCli(['records', 'archive', '--before', '1d', '--yes', '--workspace', root])
      .then((code) => `resolved: ${code}`, (error: unknown) => String(error))

    expect(failure).toContain('invalid turn record')
    expect(failure).toContain(damaged)
  })

  it('records maintain reports the files it skipped instead of failing on them', async () => {
    const root = await workspace()
    const records = join(root, '.scry', 'records')
    await mkdir(records, { recursive: true })
    await writeFile(join(records, leftover), '')
    // 过期才不是“可能有进程正在写”的阻断项；这里考的是怎么报告，不是宽限期。
    const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1_000)
    await utimes(join(records, leftover), old, old)
    const stdout = captureStdout()

    const code = await runScryCli(['records', 'maintain', '--workspace', root])

    expect(code).toBe(0)
    expect(JSON.parse(stdout.text())).toMatchObject({
      action: 'maintain',
      skippedRecords: [{ name: leftover, reason: 'unrecognized_name' }]
    })
  })
})
