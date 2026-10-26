import { access, readdir, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { archiveRecords, listRecords, verifyStore, readArchiveState, commitRecord } from '../store'
import { syncDirectory } from '../io'
import { workspace, completeTurn } from './fixture.test'

export function registerSuite20(): void {



describe('archive floor and sequence allocation', () => {
  it('拒绝把 archive records 指回 live store，且不删除正式记录', async () => {
    const root = await workspace()
    await completeTurn(root, 'overlap-1')
    const dataRoot = join(root, '.scry')

    await expect(archiveRecords(dataRoot, { throughSequence: 1, target: dataRoot })).rejects.toThrow('must not overlap')
    const dotDotPrefixedTarget = join(dataRoot, 'records', '..archive')
    await expect(archiveRecords(dataRoot, { throughSequence: 1, target: dotDotPrefixedTarget })).rejects.toThrow('must not overlap')
    await expect(access(dotDotPrefixedTarget)).rejects.toThrow()
    expect((await listRecords(dataRoot)).map((record) => record.sequence)).toEqual([1])
    await expect(verifyStore(dataRoot)).resolves.toMatchObject({ ok: true, records: 1, archivedThrough: 0 })
  })

  it('拒绝覆盖 archive target 中的同名文件', async () => {
    const root = await workspace()
    await completeTurn(root, 'occupied-target-1')
    const dataRoot = join(root, '.scry')
    const target = join(root, 'archive-occupied')
    const [recordName] = await readdir(join(dataRoot, 'records'))
    await mkdir(join(target, 'records'), { recursive: true })
    await writeFile(join(target, 'records', recordName), 'existing archive data')

    await expect(archiveRecords(dataRoot, { throughSequence: 1, target })).rejects.toMatchObject({ code: 'EEXIST' })
    expect((await listRecords(dataRoot)).map((record) => record.sequence)).toEqual([1])
    await expect(readArchiveState(dataRoot)).resolves.toBeNull()
  })

  it('崩溃在 source 删除后由 journal 幂等恢复，恢复前禁止 sequence 分配', async () => {
    const root = await workspace()
    await completeTurn(root, 'journal-1')
    await completeTurn(root, 'journal-2')
    const dataRoot = join(root, '.scry')
    const target = join(root, 'archive-journal')
    const [original] = await listRecords(dataRoot)
    const { sequence: _sequence, ...draft } = original
    let faulted = false

    await expect(archiveRecords(dataRoot, {
      throughSequence: 2,
      target,
      onStep: (phase, sequence) => {
        if (!faulted && phase === 'source-removed' && sequence === 1) {
          faulted = true
          throw new Error('simulated crash')
        }
      }
    })).rejects.toThrow('simulated crash')
    await expect(readArchiveState(dataRoot)).resolves.toBeNull()
    await expect(verifyStore(dataRoot)).resolves.toMatchObject({
      ok: false,
      errors: expect.arrayContaining([expect.stringContaining('pending archive journal')])
    })
    await expect(commitRecord(dataRoot, { ...draft, recordId: 'a'.repeat(64) })).rejects.toThrow('pending archive must be resumed')

    const recovered = await archiveRecords(dataRoot, { throughSequence: 2, target })
    expect(recovered.archived.map((item) => item.sequence)).toEqual([1, 2])
    await expect(readArchiveState(dataRoot)).resolves.toEqual({ schemaVersion: 1, archivedThrough: 2 })
    await expect(access(join(dataRoot, 'archive-journal.json'))).rejects.toThrow()
    await expect(verifyStore(dataRoot)).resolves.toMatchObject({ ok: true, records: 0, archivedThrough: 2 })
  })

  it('target link 已发布但临时 link 未清理时可由 journal 恢复', async () => {
    const root = await workspace()
    await completeTurn(root, 'journal-temp-link')
    const dataRoot = join(root, '.scry')
    const target = join(root, 'archive-temp-link')

    await expect(archiveRecords(dataRoot, {
      throughSequence: 1,
      target,
      onStep: (phase) => {
        if (phase === 'target-published') throw new Error('simulated publish crash')
      }
    })).rejects.toThrow('simulated publish crash')
    expect(await readdir(join(target, 'records'))).toHaveLength(2)

    await expect(archiveRecords(dataRoot, { throughSequence: 1, target })).resolves.toMatchObject({ archivedThrough: 1 })
    expect((await readdir(join(target, 'records'))).filter((name) => name.endsWith('.archive-tmp'))).toEqual([])
    await expect(verifyStore(dataRoot)).resolves.toMatchObject({ ok: true, records: 0, archivedThrough: 1 })
  })

  it('target link 的目录 fsync 失败后重试仍先完成 durability barrier 再删 source', async () => {
    const root = await workspace()
    await completeTurn(root, 'journal-fsync')
    const dataRoot = join(root, '.scry')
    const target = join(root, 'archive-fsync')
    let faulted = false

    await expect(archiveRecords(dataRoot, {
      throughSequence: 1,
      target,
      syncDirectory: async (path) => {
        if (!faulted && path.endsWith('/archive-fsync/records')) {
          faulted = true
          throw new Error('simulated directory fsync failure')
        }
        await syncDirectory(path)
      }
    })).rejects.toThrow('simulated directory fsync failure')
    await expect(listRecords(dataRoot)).resolves.toHaveLength(1)
    await expect(readArchiveState(dataRoot)).resolves.toBeNull()

    await expect(archiveRecords(dataRoot, { throughSequence: 1, target })).resolves.toMatchObject({ archivedThrough: 1 })
    await expect(listRecords(dataRoot)).resolves.toHaveLength(0)
    await expect(verifyStore(dataRoot)).resolves.toMatchObject({ ok: true, archivedThrough: 1 })
  })

  it('journal 恢复前校验 live source，不静默删除冲突内容', async () => {
    const root = await workspace()
    await completeTurn(root, 'journal-source-conflict')
    const dataRoot = join(root, '.scry')
    const target = join(root, 'archive-source-conflict')
    const [recordName] = await readdir(join(dataRoot, 'records'))

    await expect(archiveRecords(dataRoot, {
      throughSequence: 1,
      target,
      onStep: (phase) => {
        if (phase === 'target-published') throw new Error('simulated publish crash')
      }
    })).rejects.toThrow('simulated publish crash')
    await writeFile(join(dataRoot, 'records', recordName), 'corrupted live source')

    await expect(archiveRecords(dataRoot, { throughSequence: 1, target })).rejects.toThrow('does not match journal')
    await expect(access(join(dataRoot, 'records', recordName))).resolves.toBeUndefined()
  })

  it('归档全部记录后新轮次从 floor+1 继续，store 仍连续', async () => {
    const root = await workspace()
    await completeTurn(root, 'floor-1')
    await completeTurn(root, 'floor-2')
    const dataRoot = join(root, '.scry')

    const archived = await archiveRecords(dataRoot, { throughSequence: 2, target: join(root, 'archive-1') })
    expect(archived.archived.map((item) => item.sequence)).toEqual([1, 2])
    expect((await readArchiveState(dataRoot))?.archivedThrough).toBe(2)
    await expect(verifyStore(dataRoot)).resolves.toMatchObject({ ok: true, records: 0, archivedThrough: 2 })

    await completeTurn(root, 'floor-3')
    expect((await listRecords(dataRoot)).map((record) => record.sequence)).toEqual([3])
    await expect(verifyStore(dataRoot)).resolves.toMatchObject({ ok: true, records: 1, archivedThrough: 2 })
  })

  it('未记录 floor 的手动删除仍然报 sequence gap', async () => {
    const root = await workspace()
    await completeTurn(root, 'gap-1')
    await completeTurn(root, 'gap-2')
    const dataRoot = join(root, '.scry')
    const [first] = (await readdir(join(dataRoot, 'records'))).sort()
    await rm(join(dataRoot, 'records', first))

    const store = await verifyStore(dataRoot)
    expect(store.ok).toBe(false)
    expect(store.errors.join(' ')).toContain('sequence gap')
    await expect(archiveRecords(dataRoot, { throughSequence: 2, target: join(root, 'archive-gap') })).rejects.toThrow('sequence gap')
    expect((await listRecords(dataRoot)).map((record) => record.sequence)).toEqual([2])
    await expect(readArchiveState(dataRoot)).resolves.toBeNull()
  })
})
}
