#!/usr/bin/env node
/**
 * Publish the recorder CLI to the internal registry.
 *
 * `npm run publish:cli` publishes whatever `packages/turn-recorder-cli/package.json`
 * says, which is the public unscoped `scry-turn-recorder`. Internal delivery uses a
 * scoped name on an internal registry, and that difference used to be made by hand in a
 * temporary copy: rename the package, fix the README install line, publish. This script
 * does that step the same way every time, and refuses to publish a stale build.
 *
 *   node scripts/publish-cli-internal.mjs              # dry run: stage, pack list, stop
 *   node scripts/publish-cli-internal.mjs --publish    # publish and read the result back
 *
 * The dry run is the default because publishing is an external write.
 */
import { execFileSync } from 'node:child_process'
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkReleaseCommit } from './check-release-commit.mjs'

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const packageRoot = join(repoRoot, 'packages', 'turn-recorder-cli')
export const INTERNAL_PACKAGE = '@ali/scry-turn-recorder'
export const INTERNAL_REGISTRY = 'https://registry.anpm.alibaba-inc.com/'
/** What the package manager ships, in the order a reader expects. */
export const SHIPPED = ['dist', 'integrations', 'docs', 'README.md']

export function internalManifest(manifest, { name = INTERNAL_PACKAGE, registry = INTERNAL_REGISTRY } = {}) {
  const next = structuredClone(manifest)
  next.name = name
  // Record the registry in the published manifest, so publishing the staged copy again
  // cannot silently land on whichever registry the machine happens to be configured for.
  next.publishConfig = { ...(next.publishConfig ?? {}), registry }
  // The lifecycle hook runs `check:cli-release`; the staged copy is published with
  // --ignore-scripts (its `--prefix ../..` would not resolve there). Keeping the hook
  // would advertise a gate that never runs.
  if (next.scripts) {
    delete next.scripts.prepublishOnly
    if (Object.keys(next.scripts).length === 0) delete next.scripts
  }
  return next
}

export function internalReadme(text, { name = INTERNAL_PACKAGE, publicName } = {}) {
  let rewritten = text
  for (const command of ['npm install -g', 'npm install --global']) {
    rewritten = rewritten.replaceAll(`${command} ${publicName}`, `${command} ${name}`)
  }
  return rewritten
}

export function assertBuildPresent(source = packageRoot) {
  for (const entry of ['dist/cli/scry.js', 'integrations', 'docs', 'README.md']) {
    if (!existsSync(join(source, entry))) {
      throw new Error(`missing ${entry} in ${source}; run "npm run build:cli" first (a stale or absent build must not be published)`)
    }
  }
}

export async function stage(source, target, options = {}) {
  const manifest = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'))
  const name = options.name ?? INTERNAL_PACKAGE
  const registry = options.registry ?? INTERNAL_REGISTRY
  for (const entry of SHIPPED) await cp(join(source, entry), join(target, entry), { recursive: true })
  const staged = internalManifest(manifest, { name, registry })
  await writeFile(join(target, 'package.json'), `${JSON.stringify(staged, null, 2)}\n`)
  await writeFile(join(target, 'README.md'),
    internalReadme(await readFile(join(source, 'README.md'), 'utf8'), { name, publicName: manifest.name }))
  return { name, version: manifest.version, publicName: manifest.name }
}

function npm(args, options = {}) {
  return execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, {
    cwd: repoRoot, encoding: 'utf8', stdio: options.stdio ?? ['ignore', 'pipe', 'pipe'], ...options
  })
}

function publishedVersion(name, version, registry) {
  try {
    return npm(['view', `${name}@${version}`, 'version', '--registry', registry]).trim()
  } catch (error) {
    // A missing version is the answer we want; anything else (auth, network) must stop us
    // rather than look like "not published yet".
    if (/E404|404 Not Found/.test(String(error.stderr ?? ''))) return ''
    throw new Error(`cannot read ${name}@${version} from ${registry}: ${String(error.stderr ?? error.message).trim()}`)
  }
}

function parse(argv) {
  const options = { publish: false, force: false, skipVerify: false, keep: false, packageRoot, name: INTERNAL_PACKAGE, registry: INTERNAL_REGISTRY }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--publish') options.publish = true
    else if (arg === '--force') options.force = true
    else if (arg === '--skip-verify') options.skipVerify = true
    else if (arg === '--keep') options.keep = true
    else if (arg === '--package') options.name = argv[++i]
    else if (arg === '--registry') options.registry = argv[++i]
    else if (arg === '--source') options.packageRoot = resolve(argv[++i])
    else throw new Error(`unknown argument: ${arg}`)
  }
  return options
}

export async function main(argv = process.argv.slice(2)) {
  const options = parse(argv)
  if (options.publish && options.packageRoot !== packageRoot) throw new Error('--source is only supported for dry runs')
  await checkReleaseCommit({ dryRun: !options.publish })
  assertBuildPresent(options.packageRoot)
  const target = await mkdtemp(join(tmpdir(), 'scry-cli-internal-'))
  try {
    const staged = await stage(options.packageRoot, target, { name: options.name, registry: options.registry })
    console.log(`staged ${staged.publicName} ${staged.version} as ${staged.name}@${staged.version}`)
    console.log(`registry ${options.registry}`)
    console.log(`payload ${SHIPPED.join(' ')}`)
    const packed = JSON.parse(npm(['pack', target, '--dry-run', '--json', '--ignore-scripts']))
    const files = (Array.isArray(packed) ? packed[0] : Object.values(packed)[0]).files ?? []
    console.log(`tarball ${files.length} files, ${files.filter((file) => file.path.startsWith('dist/')).length} under dist/`)
    if (!options.skipVerify) {
      const existing = publishedVersion(staged.name, staged.version, options.registry)
      if (existing && !options.force) {
        throw new Error(`${staged.name}@${staged.version} already exists on ${options.registry} (use --force to republish a different build of the same version)`)
      }
    }
    if (!options.publish) {
      console.log('dry run: nothing was published; re-run with --publish')
      return { published: false, ...staged, target }
    }
    npm(['publish', target, '--ignore-scripts', '--registry', options.registry], { stdio: 'inherit' })
    if (!options.skipVerify) {
      const landed = publishedVersion(staged.name, staged.version, options.registry)
      if (landed !== staged.version) throw new Error(`published but ${staged.name}@${staged.version} does not read back (got "${landed}")`)
      console.log(`verified ${staged.name}@${landed}`)
      console.log(npm(['view', staged.name, 'dist-tags', '--json', '--registry', options.registry]).trim())
    }
    return { published: true, ...staged, target }
  } finally {
    if (!options.keep) await rm(target, { recursive: true, force: true })
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(`publish-cli-internal: ${error.message}`)
    process.exit(1)
  })
}
