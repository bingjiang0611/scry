import { access, mkdir, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { withDirectoryLock, writeFileAtomicExclusive, writeJsonAtomic } from './io'

const tempDir = (): string => mkdtempSync(join(tmpdir(), 'scry-lock-'))

describe('durable archive copy', () => {
  it('publishes complete bytes and never replaces an existing destination', async () => {
    const root = tempDir()
    const target = join(root, 'archive', 'record.json')
    try {
      await writeFileAtomicExclusive(target, Buffer.from('first'))
      await expect(readFile(target, 'utf8')).resolves.toBe('first')
      await expect(writeFileAtomicExclusive(target, Buffer.from('second'))).rejects.toMatchObject({ code: 'EEXIST' })
      await expect(readFile(target, 'utf8')).resolves.toBe('first')
      expect((await readdir(join(root, 'archive'))).filter((name) => name.includes('archive-tmp'))).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('streamed JSON writes', () => {
  const roundTrip = async (value: unknown): Promise<string> => {
    const root = tempDir()
    const target = join(root, 'record.json')
    try {
      await writeJsonAtomic(target, value)
      return await readFile(target, 'utf8')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }

  it('produces exactly JSON.stringify for a payload larger than one slice', async () => {
    const tabbed = `${'\tcolumn\t"quoted" \\ backslash\n'.repeat(60_000)}end`
    const value = { schemaVersion: 1, files: [{ path: 'big.txt', patch: tabbed }], count: 2, ok: true, none: null }
    await expect(roundTrip(value)).resolves.toBe(`${JSON.stringify(value)}\n`)
  }, 60_000)

  it('keeps a surrogate pair intact across the slice boundary', async () => {
    // The 4 MB slice would end after the high surrogate of the first emoji; the writer must not
    // split it, otherwise each half would encode as a replacement character.
    const value = `${'a'.repeat(4 * 1024 * 1024 - 1)}${'😀'.repeat(8)}`
    await expect(roundTrip({ patch: value })).resolves.toBe(`${JSON.stringify({ patch: value })}\n`)
  }, 60_000)

  it('leaves small payloads and sparse arrays identical', async () => {
    const values = [
      { a: 1 },
      { big: 'x'.repeat(1024) },
      [1, undefined, 'three', null],
      { dropped: undefined, kept: 'v' },
      { nested: { list: [{ patch: 'y'.repeat(2 * 1024 * 1024) }] } }
    ]
    for (const value of values) await expect(roundTrip(value)).resolves.toBe(`${JSON.stringify(value)}\n`)
  }, 60_000)
})

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
      // A dead PID is recoverable without shortening the ownerless-lock grace
      // period. A 1ms TTL also stole freshly created contenders before owner write.
      const action = (id: number) => withDirectoryLock(lock, async () => {
        active++
        maxActive = Math.max(maxActive, active)
        await new Promise((resolve) => setTimeout(resolve, 25))
        order.push(id)
        active--
      }, { waitMs: 1_000 })
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

  it('recovers an ancient unheartbeated lock when its PID has been reused', async () => {
    const root = tempDir()
    const lock = join(root, 'commit.lock')
    try {
      await mkdir(lock)
      const ownerPath = join(lock, 'owner.json')
      await writeFile(ownerPath, JSON.stringify({
        pid: process.pid,
        createdAt: Date.now() - 6 * 60_000,
        token: 'old-process-incarnation'
      }))
      const old = new Date(Date.now() - 6 * 60_000)
      await utimes(ownerPath, old, old)
      await withDirectoryLock(lock, async () => undefined, { waitMs: 1_000, ttlMs: 10 })
      expect(await readdir(join(root, 'recovered'))).toHaveLength(1)
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
