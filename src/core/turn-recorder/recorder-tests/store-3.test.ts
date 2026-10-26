import { mkdir, writeFile, mkdtemp, access, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { it, expect } from 'vitest'
import { handleRecorderHook } from '../recorder'
import { listRecords, commitRecord } from '../store'
import { workspace, completeTurn, roots, payload } from './fixture.test'

export function registerSuite15(): void {


  it('正式文件已 rename 后重试提交保持幂等，并能回收死进程锁', async () => {
    const root = await workspace()
    await completeTurn(root, 'a')
    const [record] = await listRecords(join(root, '.scry'))
    const { sequence: _sequence, ...draft } = record
    await expect(commitRecord(join(root, '.scry'), draft)).resolves.toMatchObject({ status: 'duplicate', record: { sequence: 1 } })

    const stale = join(root, '.scry', 'locks', 'commit.lock')
    await mkdir(stale, { recursive: true })
    await writeFile(join(stale, 'owner.json'), JSON.stringify({ pid: 2_147_483_647, createdAt: 0 }))
    await completeTurn(root, 'b')
    expect((await listRecords(join(root, '.scry'))).map((item) => item.sequence)).toEqual([1, 2])
  })

  it('立即回收刚刚崩溃进程留下的锁，不等待 TTL', async () => {
    const root = await workspace()
    const stale = join(root, '.scry', 'locks', 'commit.lock')
    await mkdir(stale, { recursive: true })
    await writeFile(join(stale, 'owner.json'), JSON.stringify({ pid: 2_147_483_647, createdAt: Date.now() }))
    const started = Date.now()
    await completeTurn(root, 'recent-dead-lock')
    expect(Date.now() - started).toBeLessThan(1_000)
  })

  it('缺配置或外部熔断时不创建 .scry', async () => {
    const missing = await mkdtemp(join(tmpdir(), 'scry-recorder-disabled-'))
    roots.push(missing)
    const noConfig = await handleRecorderHook({ provider: 'claude', event: 'UserPromptSubmit', workspace: missing, payload: payload('s1') })
    expect(noConfig).toMatchObject({ status: 'disabled', reason: 'missing_config' })
    await expect(access(join(missing, '.scry'))).rejects.toThrow()

    const root = await workspace()
    const envDisabled = await handleRecorderHook({ provider: 'claude', event: 'UserPromptSubmit', workspace: root, payload: payload('s1'), env: { SCRY_RECORDER_ENABLED: '0' } })
    expect(envDisabled).toMatchObject({ status: 'disabled', reason: 'environment' })
    await expect(access(join(root, '.scry'))).rejects.toThrow()

    await writeFile(join(root, '.scry-disabled'), '')
    const sentinel = await handleRecorderHook({ provider: 'claude', event: 'UserPromptSubmit', workspace: root, payload: payload('s1') })
    expect(sentinel).toMatchObject({ status: 'disabled', reason: 'sentinel' })
    await expect(access(join(root, '.scry'))).rejects.toThrow()
  })

  it('正式记录是独立 JSON 文件且不含上传配置', async () => {
    const root = await workspace()
    await completeTurn(root, 's1')
    const names = await import('node:fs/promises').then(({ readdir }) => readdir(join(root, '.scry', 'records')))
    expect(names).toHaveLength(1)
    const source = await readFile(join(root, '.scry', 'records', names[0]), 'utf8')
    expect(source).not.toContain('reportTraces')
    expect(source).not.toContain('upload')
  })
}
