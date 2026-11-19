import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  INTERNAL_PACKAGE,
  INTERNAL_REGISTRY,
  assertBuildPresent,
  internalManifest,
  internalReadme,
  stage
} from './publish-cli-internal.mjs'

const publicManifest = {
  name: 'scry-turn-recorder',
  version: '0.2.78',
  bin: { scry: 'dist/cli/scry.js' },
  files: ['dist', 'integrations', 'docs', 'README.md'],
  scripts: { prepublishOnly: 'npm --prefix ../.. run check:cli-release' },
  license: 'MIT'
}

async function fixture(sourceManifest = publicManifest) {
  const root = await mkdtemp(join(tmpdir(), 'scry-publish-fixture-'))
  const source = join(root, 'packages', 'turn-recorder-cli')
  await mkdir(join(source, 'dist', 'cli'), { recursive: true })
  await mkdir(join(source, 'integrations'), { recursive: true })
  await mkdir(join(source, 'docs'), { recursive: true })
  await writeFile(join(source, 'dist', 'cli', 'scry.js'), '#!/usr/bin/env node\n')
  await writeFile(join(source, 'integrations', 'claude.json'), '{}\n')
  await writeFile(join(source, 'docs', 'contract.md'), '# contract\n')
  await writeFile(join(source, 'package.json'), `${JSON.stringify(sourceManifest, null, 2)}\n`)
  await writeFile(join(source, 'README.md'),
    '# scry-turn-recorder\n\n```bash\nnpm install -g scry-turn-recorder@0.2.78\n```\n\nSee scry-turn-recorder docs.\n')
  return { root, source }
}

describe('internal publish staging', () => {
  it('renames the package and records the registry in the published manifest', () => {
    const staged = internalManifest(publicManifest)
    expect(staged.name).toBe(INTERNAL_PACKAGE)
    expect(staged.version).toBe('0.2.78')
    expect(staged.bin).toEqual(publicManifest.bin)
    expect(staged.files).toEqual(publicManifest.files)
    expect(staged.publishConfig).toEqual({ registry: INTERNAL_REGISTRY })
  })

  it('drops the lifecycle gate the staged copy cannot run', () => {
    const staged = internalManifest(publicManifest)
    // The staged copy is published with --ignore-scripts, so a prepublishOnly hook there
    // would advertise a check that never runs.
    expect(staged.scripts).toBeUndefined()
    const withOther = internalManifest({ ...publicManifest, scripts: { prepublishOnly: 'x', test: 'y' } })
    expect(withOther.scripts).toEqual({ test: 'y' })
  })

  it('points the install line at the scoped name and leaves prose alone', () => {
    const text = internalReadme('# scry-turn-recorder\n\nnpm install -g scry-turn-recorder@0.2.78\nSee scry-turn-recorder docs.\n',
      { name: INTERNAL_PACKAGE, publicName: 'scry-turn-recorder' })
    expect(text).toContain(`npm install -g ${INTERNAL_PACKAGE}@0.2.78`)
    expect(text).toContain('See scry-turn-recorder docs.')
    expect(text).toContain('# scry-turn-recorder')
  })

  it('stages exactly the shipped payload under the scoped identity', async () => {
    const { root, source } = await fixture()
    const target = join(root, 'staged')
    const staged = await stage(source, target)
    expect(staged).toMatchObject({ name: INTERNAL_PACKAGE, version: '0.2.78', publicName: 'scry-turn-recorder' })
    const manifest = JSON.parse(await readFile(join(target, 'package.json'), 'utf8'))
    expect(manifest.name).toBe(INTERNAL_PACKAGE)
    expect(manifest.publishConfig.registry).toBe(INTERNAL_REGISTRY)
    expect(await readFile(join(target, 'dist', 'cli', 'scry.js'), 'utf8')).toBe('#!/usr/bin/env node\n')
    expect(await readFile(join(target, 'integrations', 'claude.json'), 'utf8')).toBe('{}\n')
    // The repository manifest is not touched: the public name stays where contributors see it.
    expect(JSON.parse(await readFile(join(source, 'package.json'), 'utf8')).name).toBe('scry-turn-recorder')
  })

  it('refuses to stage an absent or stale build', async () => {
    const { root, source } = await fixture()
    await writeFile(join(source, 'dist', 'cli', 'scry.js'), '')
    assert.doesNotThrow(() => assertBuildPresent(source))
    const { rm } = await import('node:fs/promises')
    await rm(join(source, 'dist'), { recursive: true })
    assert.throws(() => assertBuildPresent(source), /run "npm run build:cli" first|missing dist/)
  })
})
