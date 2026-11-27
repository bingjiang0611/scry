import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  INTERNAL_PACKAGE,
  INTERNAL_REGISTRY,
  assertBuildPresent,
  internalManifest,
  internalReadme,
  main,
  readVerifiedReceipt,
  stage,
  tarballChecksums,
  verifyTarballExpectations
} from './publish-cli-internal.mjs'

const roots = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

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
  roots.push(root)
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

function realPackNpm(calls, registryState) {
  return (args, options = {}) => {
    calls.push(args)
    if (args[0] === 'pack') {
      return execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        ...options
      })
    }
    if (args[0] === 'view' && args[2] === 'version') {
      if (!registryState.published) {
        throw Object.assign(new Error('404'), { stderr: 'npm error code E404\nnpm error 404 Not Found' })
      }
      return `${registryState.version}\n`
    }
    if (args[0] === 'view' && args[2] === 'dist') {
      return `${JSON.stringify(registryState.dist)}\n`
    }
    if (args[0] === 'view' && args[2] === 'dist-tags') {
      return `${JSON.stringify({ latest: registryState.version })}\n`
    }
    if (args[0] === 'publish') {
      registryState.published = true
      registryState.publishedTarget = args[1]
      return ''
    }
    throw new Error(`unexpected npm invocation: ${args.join(' ')}`)
  }
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
    expect(JSON.parse(await readFile(join(source, 'package.json'), 'utf8')).name).toBe('scry-turn-recorder')
  })

  it('refuses to stage an absent or stale build', async () => {
    const { source } = await fixture()
    await writeFile(join(source, 'dist', 'cli', 'scry.js'), '')
    assert.doesNotThrow(() => assertBuildPresent(source))
    await rm(join(source, 'dist'), { recursive: true })
    assert.throws(() => assertBuildPresent(source), /run "npm run build:cli" first|missing dist/)
  })
})

describe('verified candidate tarball checksum guard', () => {
  it('refuses to publish without a verified checksum or explicit override', async () => {
    const { source } = await fixture()
    const calls = []
    const registryState = { published: false, version: '0.2.78', dist: {} }
    await expect(main(['--source', source, '--publish', '--skip-verify'], {
      runNpm: realPackNpm(calls, registryState)
    })).rejects.toThrow(/refusing to publish without verified package checksum/)
    expect(calls.filter(args => args[0] === 'publish')).toEqual([])
  })

  it('packs a candidate tarball in dry-run and publishes that exact tarball when checksums match', async () => {
    const { root, source } = await fixture()
    const candidatePath = join(root, 'candidate.tgz')
    const dryCalls = []
    const dry = await main(['--source', source, '--pack-out', candidatePath, '--skip-verify'], {
      runNpm: realPackNpm(dryCalls, { published: false, version: '0.2.78', dist: {} })
    })
    expect(dry.published).toBe(false)
    const actual = await tarballChecksums(candidatePath)
    expect(dry.checksums).toEqual(actual)

    const receiptPath = join(root, 'verified-receipt.json')
    await writeFile(receiptPath, JSON.stringify({
      name: INTERNAL_PACKAGE,
      version: '0.2.78',
      shasum: actual.sha1,
      sha256: actual.sha256,
      integrity: actual.integrity
    }))

    const publishCalls = []
    const registryState = {
      published: false,
      version: '0.2.78',
      dist: { shasum: actual.sha1, integrity: actual.integrity }
    }
    const result = await main([
      '--tarball', candidatePath,
      '--verified-receipt', receiptPath,
      '--publish'
    ], { runNpm: realPackNpm(publishCalls, registryState) })
    expect(result.published).toBe(true)
    expect(registryState.publishedTarget).toBe(candidatePath)
    expect(publishCalls.filter(args => args[0] === 'pack')).toEqual([])
    expect(publishCalls.filter(args => args[0] === 'publish')).toHaveLength(1)
  })

  it('refuses to publish when the candidate tarball bytes differ from the verified checksum', async () => {
    const { root, source } = await fixture()
    const candidatePath = join(root, 'candidate.tgz')
    await main(['--source', source, '--pack-out', candidatePath, '--skip-verify'], {
      runNpm: realPackNpm([], { published: false, version: '0.2.78', dist: {} })
    })
    const verified = await tarballChecksums(candidatePath)

    await writeFile(join(source, 'dist', 'cli', 'scry.js'), '#!/usr/bin/env node\nconsole.log("rebuilt")\n')
    const rebuiltPath = join(root, 'rebuilt.tgz')
    await main(['--source', source, '--pack-out', rebuiltPath, '--skip-verify'], {
      runNpm: realPackNpm([], { published: false, version: '0.2.78', dist: {} })
    })

    for (const flagArgs of [
      ['--expected-sha256', verified.sha256],
      ['--expected-shasum', verified.sha1],
      ['--expected-integrity', verified.integrity]
    ]) {
      const calls = []
      const registryState = { published: false, version: '0.2.78', dist: {} }
      await expect(main(['--tarball', rebuiltPath, ...flagArgs, '--publish', '--skip-verify'], {
        runNpm: realPackNpm(calls, registryState)
      })).rejects.toThrow(/mismatch.*refusing to publish/i)
      expect(calls.filter(args => args[0] === 'publish')).toEqual([])
    }
  })

  it('refuses a tarball with wrong package name or a receipt naming a different version', async () => {
    const { root, source } = await fixture()
    const wrongTarballDir = join(root, 'wrong-pack')
    await mkdir(wrongTarballDir, { recursive: true })
    const packed = JSON.parse(execFileSync(
      process.platform === 'win32' ? 'npm.cmd' : 'npm',
      ['pack', source, '--pack-destination', wrongTarballDir, '--json', '--ignore-scripts'],
      { encoding: 'utf8' }
    ))
    const wrongTarball = join(wrongTarballDir, packed[0].filename)
    const wrongDigests = await tarballChecksums(wrongTarball)
    const calls = []
    await expect(main([
      '--tarball', wrongTarball,
      '--expected-sha256', wrongDigests.sha256,
      '--publish', '--skip-verify'
    ], { runNpm: realPackNpm(calls, { published: false, version: '0.2.78', dist: {} }) }))
      .rejects.toThrow(/does not match target "@ali\/scry-turn-recorder"/)
    expect(calls).toEqual([])

    const goodTarball = join(root, 'good.tgz')
    await main(['--source', source, '--pack-out', goodTarball, '--skip-verify'], {
      runNpm: realPackNpm([], { published: false, version: '0.2.78', dist: {} })
    })
    const goodDigests = await tarballChecksums(goodTarball)
    const wrongVersionReceipt = join(root, 'wrong-version.json')
    await writeFile(wrongVersionReceipt, JSON.stringify({
      name: INTERNAL_PACKAGE,
      version: '0.2.79',
      sha256: goodDigests.sha256
    }))
    await expect(main([
      '--tarball', goodTarball,
      '--verified-receipt', wrongVersionReceipt,
      '--publish', '--skip-verify'
    ], { runNpm: realPackNpm(calls, { published: false, version: '0.2.78', dist: {} }) }))
      .rejects.toThrow(/verified package version mismatch/)
    expect(calls).toEqual([])
  })

  it('fails closed on post-publish registry checksum mismatch and malformed receipts', async () => {
    const { root, source } = await fixture()
    const candidatePath = join(root, 'candidate.tgz')
    await main(['--source', source, '--pack-out', candidatePath, '--skip-verify'], {
      runNpm: realPackNpm([], { published: false, version: '0.2.78', dist: {} })
    })
    const actual = await tarballChecksums(candidatePath)

    const emptyReceipt = join(root, 'empty.json')
    await writeFile(emptyReceipt, JSON.stringify({ name: INTERNAL_PACKAGE, version: '0.2.78' }))
    await expect(readVerifiedReceipt(emptyReceipt)).rejects.toThrow(/contains no checksum/)
    expect(() => verifyTarballExpectations({ ...actual, name: INTERNAL_PACKAGE, version: '0.2.78' }, { sha256: 'not-hex' }))
      .toThrow(/invalid sha256 checksum format/)

    const registryState = {
      published: false,
      version: '0.2.78',
      dist: { shasum: '0'.repeat(40), integrity: actual.integrity }
    }
    await expect(main([
      '--tarball', candidatePath,
      '--expected-sha256', actual.sha256,
      '--publish'
    ], { runNpm: realPackNpm([], registryState) })).rejects.toThrow(/published dist\.shasum mismatch/)
  })

  it('permits an explicitly reasoned --allow-unverified exception when publishing', async () => {
    const { root, source } = await fixture()
    const candidatePath = join(root, 'candidate.tgz')
    await main(['--source', source, '--pack-out', candidatePath, '--skip-verify'], {
      runNpm: realPackNpm([], { published: false, version: '0.2.78', dist: {} })
    })
    const actual = await tarballChecksums(candidatePath)
    const calls = []
    const registryState = {
      published: false,
      version: '0.2.78',
      dist: { shasum: actual.sha1, integrity: actual.integrity }
    }
    const result = await main([
      '--tarball', candidatePath,
      '--allow-unverified', 'maintainer pre-verification registry handoff',
      '--publish'
    ], { runNpm: realPackNpm(calls, registryState) })
    expect(result.published).toBe(true)
    expect(calls.filter(args => args[0] === 'publish')).toHaveLength(1)
  })
})
