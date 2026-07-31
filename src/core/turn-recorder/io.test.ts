import { access, mkdir, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { withDirectoryLock } from './io'

const tempDir = (): string => mkdtempSync(join(tmpdir(), 'scry-lock-'))

describe('withDirectoryLock', () => {
  it('serializes two contenders recovering the same dead legacy owner', async () => {
    const root = tempDir()
    const lock = join(root, 'locks', 'commit.lock')
    try {
      await mkdir(lock, { recursive: true })
      await writeFile(join(lock, 'owner.json'), JSON.stringify({ pid: 2_147_483_647, createdAt: 0 }))
      const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1_000)
      await utimes(lock, old, old)
      let active = 0
      let maxActive = 0
      const order: number[] = []
      const action = (id: number) => withDirectoryLock(lock, async () => {
        active++
        maxActive = Math.max(maxActive, active)
        await new Promise((resolve) => setTimeout(resolve, 25))
        order.push(id)
        active--
      }, { waitMs: 1_000, ttlMs: 1 })
      await Promise.all([action(1), action(2)])
      expect(maxActive).toBe(1)
      expect(order.sort()).toEqual([1, 2])
      const recovered = join(root, 'locks', 'recovered')
      const [tombstone] = await readdir(recovered)
      expect(JSON.parse(await readFile(join(recovered, tombstone, 'owner.json'), 'utf8'))).toMatchObject({ pid: 2_147_483_647 })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('does not release a lock whose owner token changed', async () => {
    const root = tempDir()
    const lock = join(root, 'commit.lock')
    try {
      await withDirectoryLock(lock, async () => {
        await writeFile(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, createdAt: Date.now(), token: 'replacement' }))
      })
      await expect(access(lock)).resolves.toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('does not steal a fresh ownerless lock while owner.json may still be committing', async () => {
    const root = tempDir()
    const lock = join(root, 'commit.lock')
    try {
      await mkdir(lock)
      await expect(withDirectoryLock(lock, async () => undefined, { waitMs: 30, ttlMs: 1_000 }))
        .rejects.toThrow('lock timeout')
      await expect(access(lock)).resolves.toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('recovers an ownerless lock after TTL and still serializes concurrent contenders', async () => {
    const root = tempDir()
    const lock = join(root, 'commit.lock')
    try {
      await mkdir(lock)
      const old = new Date(Date.now() - 60_000)
      await utimes(lock, old, old)
      let active = 0
      let maxActive = 0
      const action = () => withDirectoryLock(lock, async () => {
        active++
        maxActive = Math.max(maxActive, active)
        await new Promise((resolve) => setTimeout(resolve, 20))
        active--
      }, { waitMs: 1_000, ttlMs: 10 })
      await Promise.all([action(), action()])
      expect(maxActive).toBe(1)
      const [tombstone] = await readdir(join(root, 'recovered'))
      expect(JSON.parse(await readFile(join(root, 'recovered', tombstone, 'owner.json'), 'utf8'))).toMatchObject({ pid: process.pid })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('recovers a stale corrupt owner file without treating a fresh partial write as stale', async () => {
    const root = tempDir()
    const lock = join(root, 'commit.lock')
    try {
      await mkdir(lock)
      await writeFile(join(lock, 'owner.json'), '{partial')
      await expect(withDirectoryLock(lock, async () => undefined, { waitMs: 30, ttlMs: 1_000 }))
        .rejects.toThrow('lock timeout')
      const old = new Date(Date.now() - 60_000)
      await utimes(join(lock, 'owner.json'), old, old)
      await withDirectoryLock(lock, async () => undefined, { waitMs: 1_000, ttlMs: 10 })
      expect(await readdir(join(root, 'recovered'))).toHaveLength(1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
