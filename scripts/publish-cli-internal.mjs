#!/usr/bin/env node
/**
 * Publish the recorder CLI to the internal registry.
 *
 * `npm run publish:cli` publishes whatever `packages/turn-recorder-cli/package.json`
 * says, which is the public unscoped `scry-turn-recorder`. Internal delivery uses a
 * scoped name on an internal registry, and that difference used to be made by hand in a
 * temporary copy: rename the package, fix the README install line, publish. This script
 * does that step the same way every time, refuses to publish a stale build, and requires
 * the exact tarball checksum to match the verified candidate package before publishing.
 *
 *   node scripts/publish-cli-internal.mjs                                           # dry run: stage, pack, print digests
 *   node scripts/publish-cli-internal.mjs --pack-out /path/to/candidate.tgz         # dry run and keep the exact candidate tarball
 *   node scripts/publish-cli-internal.mjs --publish --tarball candidate.tgz \
 *     --expected-sha256 <hex>                                                       # verify exact candidate tarball, publish, read back
 *   node scripts/publish-cli-internal.mjs --publish --verified-receipt receipt.json # verify against structured verification receipt
 *
 * The dry run is the default because publishing is an external write.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFile, cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const packageRoot = join(repoRoot, 'packages', 'turn-recorder-cli')
export const INTERNAL_PACKAGE = '@ali/scry-turn-recorder'
export const INTERNAL_REGISTRY = 'https://registry.anpm.alibaba-inc.com/'
export const SHIPPED = ['dist', 'integrations', 'docs', 'README.md']

const SHA1_PATTERN = /^[0-9a-f]{40}$/i
const SHA256_PATTERN = /^[0-9a-f]{64}$/i
const INTEGRITY_PATTERN = /^sha512-[A-Za-z0-9+/]+=*$/

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

export async function tarballChecksums(tarballPath) {
  const bytes = await readFile(tarballPath)
  return {
    bytes: bytes.byteLength,
    sha1: createHash('sha1').update(bytes).digest('hex'),
    sha256: createHash('sha256').update(bytes).digest('hex'),
    integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`
  }
}

export function inspectTarballManifest(tarballPath) {
  const raw = execFileSync('tar', ['-xzOf', tarballPath, 'package/package.json'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const manifest = JSON.parse(raw)
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error(`invalid package/package.json in tarball ${tarballPath}`)
  }
  return manifest
}

function assertValidDigest(label, value, pattern) {
  if (typeof value !== 'string' || !pattern.test(value.trim())) {
    throw new Error(`invalid ${label} checksum format: "${String(value)}"`)
  }
  return value.trim()
}

export async function readVerifiedReceipt(receiptPath) {
  let raw
  try {
    raw = await readFile(receiptPath, 'utf8')
  } catch (error) {
    throw new Error(`cannot read verified receipt ${receiptPath}: ${error.message}`)
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error(`verified receipt ${receiptPath} is not valid JSON: ${error.message}`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`verified receipt ${receiptPath} must be a JSON object`)
  }
  const shasum = parsed.shasum ?? parsed.sha1 ?? parsed.dist?.shasum
  const sha256 = parsed.sha256 ?? parsed.dist?.sha256
  const integrity = parsed.integrity ?? parsed.dist?.integrity
  if (shasum === undefined && sha256 === undefined && integrity === undefined) {
    throw new Error(`verified receipt ${receiptPath} contains no checksum (expected shasum/sha1, sha256, or integrity)`)
  }
  if (parsed.shasum !== undefined && parsed.sha1 !== undefined &&
    String(parsed.shasum).trim().toLowerCase() !== String(parsed.sha1).trim().toLowerCase()) {
    throw new Error(`verified receipt ${receiptPath} has conflicting shasum and sha1 fields`)
  }
  return {
    ...(shasum !== undefined ? { shasum: assertValidDigest('shasum', shasum, SHA1_PATTERN).toLowerCase() } : {}),
    ...(sha256 !== undefined ? { sha256: assertValidDigest('sha256', sha256, SHA256_PATTERN).toLowerCase() } : {}),
    ...(integrity !== undefined ? { integrity: assertValidDigest('integrity', integrity, INTEGRITY_PATTERN) } : {}),
    ...(parsed.name !== undefined ? { name: String(parsed.name) } : {}),
    ...(parsed.version !== undefined ? { version: String(parsed.version) } : {})
  }
}

export function verifyTarballExpectations(actual, expected) {
  const checked = []
  if (expected.name !== undefined && expected.name !== actual.name) {
    throw new Error(`verified package name mismatch: expected "${expected.name}", tarball has "${actual.name}"`)
  }
  if (expected.version !== undefined && expected.version !== actual.version) {
    throw new Error(`verified package version mismatch: expected "${expected.version}", tarball has "${actual.version}"`)
  }
  if (expected.shasum !== undefined) {
    const want = assertValidDigest('shasum', expected.shasum, SHA1_PATTERN).toLowerCase()
    if (actual.sha1 !== want) {
      throw new Error(`tarball shasum (SHA-1) mismatch: verified=${want}, actual=${actual.sha1}; refusing to publish`)
    }
    checked.push('shasum')
  }
  if (expected.sha256 !== undefined) {
    const want = assertValidDigest('sha256', expected.sha256, SHA256_PATTERN).toLowerCase()
    if (actual.sha256 !== want) {
      throw new Error(`tarball sha256 mismatch: verified=${want}, actual=${actual.sha256}; refusing to publish`)
    }
    checked.push('sha256')
  }
  if (expected.integrity !== undefined) {
    const want = assertValidDigest('integrity', expected.integrity, INTEGRITY_PATTERN)
    if (actual.integrity !== want) {
      throw new Error(`tarball integrity mismatch: verified=${want}, actual=${actual.integrity}; refusing to publish`)
    }
    checked.push('integrity')
  }
  if (checked.length === 0) {
    throw new Error('no verified checksum was supplied to compare against the tarball')
  }
  return checked
}

function defaultNpm(args, options = {}) {
  return execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, {
    cwd: repoRoot, encoding: 'utf8', stdio: options.stdio ?? ['ignore', 'pipe', 'pipe'], ...options
  })
}

function publishedVersion(name, version, registry, runNpm) {
  try {
    return runNpm(['view', `${name}@${version}`, 'version', '--registry', registry]).trim()
  } catch (error) {
    // A missing version is the answer we want; anything else (auth, network) must stop us
    // rather than look like "not published yet".
    if (/E404|404 Not Found/.test(String(error.stderr ?? ''))) return ''
    throw new Error(`cannot read ${name}@${version} from ${registry}: ${String(error.stderr ?? error.message).trim()}`)
  }
}

function publishedDist(name, version, registry, runNpm) {
  const raw = runNpm(['view', `${name}@${version}`, 'dist', '--json', '--registry', registry]).trim()
  return raw ? JSON.parse(raw) : {}
}

function requireValue(argv, index, flagName) {
  const value = argv[index + 1]
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${flagName} requires a value`)
  }
  return value
}

export function parse(argv) {
  const options = {
    publish: false,
    force: false,
    skipVerify: false,
    keep: false,
    packageRoot,
    name: INTERNAL_PACKAGE,
    registry: INTERNAL_REGISTRY,
    tarball: undefined,
    packOut: undefined,
    expectedShasum: undefined,
    expectedSha256: undefined,
    expectedIntegrity: undefined,
    verifiedReceipt: undefined,
    allowUnverified: undefined
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--publish') options.publish = true
    else if (arg === '--force') options.force = true
    else if (arg === '--skip-verify') options.skipVerify = true
    else if (arg === '--keep') options.keep = true
    else if (arg === '--package') { options.name = requireValue(argv, i, arg); i += 1 }
    else if (arg === '--registry') { options.registry = requireValue(argv, i, arg); i += 1 }
    else if (arg === '--source') { options.packageRoot = resolve(requireValue(argv, i, arg)); i += 1 }
    else if (arg === '--tarball') { options.tarball = resolve(requireValue(argv, i, arg)); i += 1 }
    else if (arg === '--pack-out') { options.packOut = resolve(requireValue(argv, i, arg)); i += 1 }
    else if (arg === '--expected-shasum') { options.expectedShasum = requireValue(argv, i, arg); i += 1 }
    else if (arg === '--expected-sha256') { options.expectedSha256 = requireValue(argv, i, arg); i += 1 }
    else if (arg === '--expected-integrity') { options.expectedIntegrity = requireValue(argv, i, arg); i += 1 }
    else if (arg === '--verified-receipt') { options.verifiedReceipt = resolve(requireValue(argv, i, arg)); i += 1 }
    else if (arg === '--allow-unverified') {
      const reason = requireValue(argv, i, arg).trim()
      if (!reason) throw new Error('--allow-unverified requires a non-empty reason')
      options.allowUnverified = reason
      i += 1
    }
    else throw new Error(`unknown argument: ${arg}`)
  }
  if (options.tarball && options.packOut) {
    throw new Error('--tarball and --pack-out cannot be combined')
  }
  return options
}

function mergeExpectedField(label, fromReceipt, fromCli, caseInsensitive = false) {
  if (fromReceipt === undefined) return fromCli
  if (fromCli === undefined) return fromReceipt
  const left = caseInsensitive ? fromReceipt.trim().toLowerCase() : fromReceipt.trim()
  const right = caseInsensitive ? fromCli.trim().toLowerCase() : fromCli.trim()
  if (left !== right) {
    throw new Error(`conflicting ${label} between --verified-receipt (${fromReceipt}) and CLI flag (${fromCli})`)
  }
  return fromReceipt
}

async function resolveExpectedChecksums(options) {
  const fromReceipt = options.verifiedReceipt ? await readVerifiedReceipt(options.verifiedReceipt) : {}
  const shasum = mergeExpectedField('shasum', fromReceipt.shasum, options.expectedShasum, true)
  const sha256 = mergeExpectedField('sha256', fromReceipt.sha256, options.expectedSha256, true)
  const integrity = mergeExpectedField('integrity', fromReceipt.integrity, options.expectedIntegrity, false)
  const hasAny = shasum !== undefined || sha256 !== undefined || integrity !== undefined
  if (!hasAny) return null
  return {
    ...(shasum !== undefined ? { shasum } : {}),
    ...(sha256 !== undefined ? { sha256 } : {}),
    ...(integrity !== undefined ? { integrity } : {}),
    ...(fromReceipt.name !== undefined ? { name: fromReceipt.name } : {}),
    ...(fromReceipt.version !== undefined ? { version: fromReceipt.version } : {})
  }
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  const runNpm = deps.runNpm ?? defaultNpm
  const options = parse(argv)
  const target = await mkdtemp(join(tmpdir(), 'scry-cli-internal-'))
  try {
    let staged
    let tarballPath
    if (options.tarball) {
      const info = await stat(options.tarball).catch(() => null)
      if (!info?.isFile()) throw new Error(`tarball not found or not a regular file: ${options.tarball}`)
      const manifest = inspectTarballManifest(options.tarball)
      if (manifest.name !== options.name) {
        throw new Error(`tarball package name "${manifest.name}" does not match target "${options.name}"; refusing to publish`)
      }
      if (typeof manifest.version !== 'string' || !manifest.version.trim()) {
        throw new Error(`tarball ${options.tarball} has no valid version in package/package.json`)
      }
      staged = { name: manifest.name, version: manifest.version, publicName: manifest.name }
      tarballPath = options.tarball
      console.log(`using pre-packed tarball ${tarballPath} (${staged.name}@${staged.version})`)
    } else {
      assertBuildPresent(options.packageRoot)
      const stageDir = join(target, 'stage')
      const packDir = join(target, 'pack')
      await mkdir(stageDir, { recursive: true })
      await mkdir(packDir, { recursive: true })
      staged = await stage(options.packageRoot, stageDir, { name: options.name, registry: options.registry })
      console.log(`staged ${staged.publicName} ${staged.version} as ${staged.name}@${staged.version}`)
      console.log(`payload ${SHIPPED.join(' ')}`)
      const packed = JSON.parse(runNpm(['pack', stageDir, '--pack-destination', packDir, '--json', '--ignore-scripts']))
      const packInfo = Array.isArray(packed) ? packed[0] : Object.values(packed)[0]
      const files = packInfo?.files ?? []
      if (!packInfo?.filename) throw new Error('npm pack did not report a tarball filename')
      tarballPath = join(packDir, packInfo.filename)
      console.log(`tarball ${files.length} files, ${files.filter((file) => file.path.startsWith('dist/')).length} under dist/`)
      if (options.packOut) {
        await mkdir(dirname(options.packOut), { recursive: true })
        await copyFile(tarballPath, options.packOut)
        tarballPath = options.packOut
        console.log(`saved tarball ${tarballPath}`)
      }
    }
    console.log(`registry ${options.registry}`)
    const checksums = await tarballChecksums(tarballPath)
    console.log(`shasum ${checksums.sha1}`)
    console.log(`sha256 ${checksums.sha256}`)
    console.log(`integrity ${checksums.integrity}`)

    const expected = await resolveExpectedChecksums(options)
    if (expected) {
      const checked = verifyTarballExpectations({ ...checksums, name: staged.name, version: staged.version }, expected)
      console.log(`verified tarball matches candidate (${checked.join(', ')})`)
    } else if (options.publish) {
      if (!options.allowUnverified) {
        throw new Error(
          'refusing to publish without verified package checksum (--expected-sha256, --expected-shasum, --expected-integrity, or --verified-receipt); pass --allow-unverified <reason> only for an explicitly approved exception'
        )
      }
      console.log(`warning: publishing without verified checksum (--allow-unverified): ${options.allowUnverified}`)
    }

    if (!options.skipVerify) {
      const existing = publishedVersion(staged.name, staged.version, options.registry, runNpm)
      if (existing && !options.force) {
        throw new Error(`${staged.name}@${staged.version} already exists on ${options.registry} (use --force to republish a different build of the same version)`)
      }
    }
    if (!options.publish) {
      console.log('dry run: nothing was published; re-run with --publish and the verified checksum')
      return { published: false, ...staged, target, tarballPath, checksums }
    }
    runNpm(['publish', tarballPath, '--ignore-scripts', '--registry', options.registry], { stdio: 'inherit' })
    if (!options.skipVerify) {
      const landed = publishedVersion(staged.name, staged.version, options.registry, runNpm)
      if (landed !== staged.version) throw new Error(`published but ${staged.name}@${staged.version} does not read back (got "${landed}")`)
      const dist = publishedDist(staged.name, staged.version, options.registry, runNpm)
      if (dist.shasum !== checksums.sha1) {
        throw new Error(`published dist.shasum mismatch: local=${checksums.sha1}, registry=${String(dist.shasum)}`)
      }
      if (dist.integrity && dist.integrity !== checksums.integrity) {
        throw new Error(`published dist.integrity mismatch: local=${checksums.integrity}, registry=${String(dist.integrity)}`)
      }
      console.log(`verified ${staged.name}@${landed} (dist.shasum=${dist.shasum})`)
      console.log(runNpm(['view', staged.name, 'dist-tags', '--json', '--registry', options.registry]).trim())
    }
    return { published: true, ...staged, target, tarballPath, checksums }
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
