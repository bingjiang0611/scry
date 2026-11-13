import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { writeJsonAtomic } from './io'

vi.mock('node:crypto', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:crypto')>(),
  randomUUID: () => '00000000-0000-4000-8000-000000000000'
}))

it.each(['incomplete value', 'valid-looking value', 'key'] as const)(
  'keeps JSON byte-identical when a chunk token collides with a data %s', async (kind) => {
    const root = await mkdtemp(join(tmpdir(), 'scry-json-collision-'))
    try {
      const token = '@@scry-chunk-00000000-0000-4000-8000-000000000000@@'
      const marker = `${token}0${token}`
      // A real large field is emitted first, so a late fallback must not append a second document.
      const value = { large: 'x'.repeat(1 << 20),
        ...(kind === 'key' ? { [marker]: 'ordinary value' }
          : { collision: kind === 'valid-looking value' ? marker : `ordinary ${token}tail` }) }
      const path = join(root, 'value.json')
      await writeJsonAtomic(path, value)
      expect(await readFile(path, 'utf8')).toBe(`${JSON.stringify(value)}\n`)
      expect(await readdir(root)).toEqual(['value.json'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
)
