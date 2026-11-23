import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import asar from '@electron/asar'
import { expect, it } from 'vitest'
import { addPackagedSmokeEntry } from './packaged-smoke-entry.mjs'

it('preserves the shipped entry and unpacked resources in a separate smoke archive', async () => {
  const root = await mkdtemp(join(tmpdir(), 'scry-packaged-smoke-entry-'))
  try {
    const content = join(root, 'content')
    const original = join(root, 'original.asar')
    const fixture = join(root, 'fixture.asar')
    const entry = join(root, 'fixture.mjs')
    await mkdir(content)
    await writeFile(join(content, 'package.json'), JSON.stringify({ main: 'index.js', version: '1.2.3' }))
    await writeFile(join(content, 'index.js'), 'production')
    await writeFile(join(content, 'native.node'), 'unpacked native bytes')
    await writeFile(entry, 'fixture wrapper')
    await asar.createPackageWithOptions(content, original, { unpack: '*.node' })
    await addPackagedSmokeEntry(original, fixture, entry, join(root, 'extracted'))
    expect(JSON.parse(asar.extractFile(original, 'package.json').toString()).main).toBe('index.js')
    const manifest = JSON.parse(asar.extractFile(fixture, 'package.json').toString())
    expect(manifest.version).toBe('1.2.3')
    expect(asar.extractFile(fixture, manifest.main).toString()).toBe('fixture wrapper')
    expect(asar.extractFile(fixture, 'index.js').toString()).toBe('production')
    expect(asar.statFile(fixture, 'native.node')).toMatchObject({ unpacked: true })
    expect(asar.extractFile(fixture, 'native.node').toString()).toBe('unpacked native bytes')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
