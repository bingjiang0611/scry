import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { copyFile, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  INTERNAL_PACKAGE,
  INTERNAL_REGISTRY,
  assertBuildPresent,
  internalManifest,
  internalReadme,
  stage
} from './publish-cli-internal.mjs'

const sourceManifest = {
  name: 'scry-turn-recorder',
  version: '0.2.78',
  bin: { scry: 'dist/cli/scry.js' },
  files: ['dist', 'integrations', 'docs', 'README.md'],
  private: true,
  scripts: { prepublishOnly: 'exit 1' },
  license: 'MIT'
}

const fixtures = []
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'

afterEach(async () => {
  for (const path of fixtures.splice(0)) await rm(path, { recursive: true, force: true })
})

async function fixture(manifest = sourceManifest) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'scry-publish-fixture-')))
  fixtures.push(root)
  const source = join(root, 'packages', 'turn-recorder-cli')
  await mkdir(join(source, 'dist', 'cli'), { recursive: true })
  await mkdir(join(source, 'integrations'), { recursive: true })
  await mkdir(join(source, 'docs'), { recursive: true })
  await writeFile(join(source, 'dist', 'cli', 'scry.js'), '#!/usr/bin/env node\n')
  await writeFile(join(source, 'integrations', 'claude.json'), '{}\n')
  await writeFile(join(source, 'docs', 'contract.md'), '# contract\n')
  await writeFile(join(source, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  await writeFile(join(source, 'README.md'),
    '# scry-turn-recorder\n\n```bash\nnpm install -g scry-turn-recorder@0.2.78\n```\n\nSee scry-turn-recorder docs.\n')
  return { root, source }
}

describe('CLI publish entry points', () => {
  it('rejects the public alias and direct npm publish, including dry run', async () => {
    const repo = new URL('../package.json', import.meta.url)
    const cli = new URL('../packages/turn-recorder-cli/package.json', import.meta.url)
    const { root, source } = await fixture(JSON.parse(await readFile(cli, 'utf8')))
    await copyFile(repo, join(root, 'package.json'))
    expect(JSON.parse(await readFile(join(source, 'package.json'), 'utf8')).private).toBe(true)
    const pack = spawnSync(npm, ['pack', '--dry-run', '--json'], { cwd: source, encoding: 'utf8', timeout: 15_000 })
    expect(pack.status, pack.stderr).toBe(0)
    expect(JSON.parse(pack.stdout)[0].files).toContainEqual(expect.objectContaining({ path: 'dist/cli/scry.js' }))
    for (const [cwd, args] of [[root, ['run', 'publish:cli']], [source, ['publish', '--dry-run', '--registry', 'http://127.0.0.1:1/']]]) {
      const result = spawnSync(npm, args, { cwd, encoding: 'utf8', timeout: 15_000 })
      expect(result.status, result.stderr).toBe(1)
      expect(result.stderr).toContain('Public npm publishing is disabled. Use npm run publish:cli:internal')
    }
  })

  it('only publishes the rebuilt HEAD payload, not an ignored dist from another commit', async () => {
    const { root, source } = await fixture()
    const scripts = join(root, 'scripts')
    await mkdir(scripts)
    await copyFile(new URL('./publish-cli-internal.mjs', import.meta.url), join(scripts, 'publish-cli-internal.mjs'))
    // The release gate has its own API/Git tests. Here the verified checkout is
    // real; fake only the gate outcome and registry writes, never the build or stage.
    const dist = join(source, 'dist', 'cli', 'scry.js')
    const payload = join(root, 'payload.js')
    await writeFile(join(root, '.gitignore'), '**/dist/\n')
    await writeFile(join(root, 'package.json'), JSON.stringify({ scripts: {
      'build:cli': `node -e "require('node:fs').copyFileSync('payload.js','packages/turn-recorder-cli/dist/cli/scry.js')"`,
    } }))
    await writeFile(join(scripts, 'check-release-commit.mjs'), `
      import { execFileSync } from 'node:child_process'
      export const cleanReleaseHead = () => execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
      export const checkReleaseCommit = ({ dryRun }) => dryRun ? undefined : cleanReleaseHead()
    `)
    const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: 'pipe' }).trim()
    const commit = text => git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', text)
    git('init')
    await writeFile(payload, 'old commit payload\n')
    git('add', '.')
    commit('old')
    execFileSync(npm, ['run', 'build:cli'], { cwd: root, stdio: 'pipe' })
    await writeFile(payload, 'verified HEAD payload\n')
    git('add', 'payload.js')
    commit('verified')
    expect(await readFile(dist, 'utf8')).toBe('old commit payload\n')

    const intercept = join(root, 'intercept.cjs')
    const receipt = join(root, 'registry-write.json')
    await writeFile(intercept, `
      const fs = require('node:fs')
      const path = require('node:path')
      const child = require('node:child_process')
      const run = child.execFileSync
      child.execFileSync = (file, args, options) => {
        if (file === ${JSON.stringify(npm)} && args[0] === 'publish') {
          fs.writeFileSync(${JSON.stringify(receipt)}, JSON.stringify({
            payload: fs.readFileSync(path.join(args[1], 'dist/cli/scry.js'), 'utf8'),
            manifest: JSON.parse(fs.readFileSync(path.join(args[1], 'package.json'), 'utf8')),
            flags: args.slice(2),
          }))
          return ''
        }
        if (file === ${JSON.stringify(npm)} && args[0] === 'view') {
          if (args[2] === 'dist-tags') return '{}'
          return fs.existsSync(${JSON.stringify(receipt)}) ? '0.2.78' : ''
        }
        return run(file, args, options)
      }
      require('node:module').syncBuiltinESMExports()
    `)
    git('add', 'intercept.cjs')
    commit('registry intercept fixture')
    const run = (...args) => spawnSync(process.execPath, ['--require', intercept, join(scripts, 'publish-cli-internal.mjs'), ...args], {
      cwd: root, encoding: 'utf8', timeout: 15_000,
    })
    const dry = run()
    expect(dry.status, dry.stderr).toBe(0)
    expect(await readFile(dist, 'utf8')).toBe('old commit payload\n')
    await expect(readFile(receipt)).rejects.toMatchObject({ code: 'ENOENT' })
    const redirected = run('--publish', '--registry', 'https://registry.npmjs.org/')
    expect(redirected.status).toBe(1)
    expect(redirected.stderr).toContain('Publication is restricted to')
    const published = run('--publish')
    expect(published.status, published.stderr).toBe(0)
    const registered = JSON.parse(await readFile(receipt, 'utf8'))
    expect(registered.payload).toBe(git('show', 'HEAD:payload.js') + '\n')
    expect(registered.manifest.name).toBe(INTERNAL_PACKAGE)
    expect(registered.manifest.private).toBeUndefined()
    expect(registered.manifest.scripts?.prepublishOnly).toBeUndefined()
    expect(registered.flags).toEqual(['--ignore-scripts', '--registry', INTERNAL_REGISTRY, `--@ali:registry=${INTERNAL_REGISTRY}`])
  })
})

describe('internal publish staging', () => {
  it('renames the package and records the registry in the published manifest', () => {
    const staged = internalManifest(sourceManifest)
    expect(staged.name).toBe(INTERNAL_PACKAGE)
    expect(staged.version).toBe('0.2.78')
    expect(staged.bin).toEqual(sourceManifest.bin)
    expect(staged.files).toEqual(sourceManifest.files)
    expect(staged.publishConfig).toEqual({ registry: INTERNAL_REGISTRY })
  })

  it('only strips the direct-publication protections from the internal manifest', () => {
    const staged = internalManifest(sourceManifest)
    expect(staged.private).toBeUndefined()
    expect(staged.scripts).toBeUndefined()
    expect(sourceManifest.private).toBe(true)
    expect(sourceManifest.scripts.prepublishOnly).toBe('exit 1')
    const withOther = internalManifest({ ...sourceManifest, scripts: { prepublishOnly: 'x', test: 'y' } })
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
    // The repository manifest is not touched.
    expect(JSON.parse(await readFile(join(source, 'package.json'), 'utf8')).name).toBe('scry-turn-recorder')
  })

  it('refuses to stage a missing build', async () => {
    const { root, source } = await fixture()
    await writeFile(join(source, 'dist', 'cli', 'scry.js'), '')
    assert.doesNotThrow(() => assertBuildPresent(source))
    await rm(join(source, 'dist'), { recursive: true })
    assert.throws(() => assertBuildPresent(source), /run "npm run build:cli" first|missing dist/)
  })
})
