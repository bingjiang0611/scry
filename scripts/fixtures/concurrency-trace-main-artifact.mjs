// Artifact build and verification for the 50k main-only Electron trial (measurement only).
//
// Split out of scripts/concurrency-trace-main-50k.mjs so the launcher keeps only spawning, ownership and report
// checks. The contract here is one-directional: build once, then verify and execute. Verification never
// rebuilds, never rewrites the manifest and never describes an old bundle with the current tree's identity.
//
// Two identities are recorded and reported separately:
//   buildSource  - hashes captured when the bundle was built; stored inside the manifest of that artifact.
//   currentSource - hashes of the tree reading the artifact now; differences are reported as drift.
// A frozen baseline stays runnable after later source edits because the bundle bytes and its build-time
// identity are what the run measures; drift is disclosed instead of being treated as a mismatch failure.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Repository root of this worktree: the base every selected source path is resolved against. */
export const PROJECT_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const root = PROJECT_ROOT

/** Fixed entry: the build has no entry parameter, so an artifact cannot silently become another measurement. */
export const MAIN_TRIAL_ENTRY = 'scripts/fixtures/concurrency-trace-main-50k.ts'
/** Must equal MAIN_50K_FIXED_ITEMS in scripts/fixtures/concurrency-trace-main-50k-sample.ts (asserted by test). */
export const FIXED_ITEMS = 50_000

// Selected measurement sources: the sample, its workload and the production modules it drives. Dependencies
// reach the report through the bundle hash, so neither list is an import closure and both say so.
export const MEASUREMENT_SOURCES = [
  'scripts/fixtures/concurrency-trace-main-50k.ts',
  'scripts/fixtures/concurrency-trace-main-50k-sample.ts',
  'scripts/fixtures/concurrency-trace-main-trial.ts',
  'scripts/fixtures/concurrency-trace-workload.ts',
  'src/main/bootstrap/trace-runtime.ts',
  'src/main/remote/desktop-trace-delta.ts',
  'src/main/live-trace.ts',
  'src/main/dock-badge.ts',
  'src/renderer/remote-trace.ts',
  'src/renderer/turn-stream-projection.ts',
  'src/core/turn-recorder/tool-content.ts'
]

// Launcher-side helpers that produce the evidence around this process: artifact identity, the report checks,
// ownership, the stop, and the output capture. Also selected, not a closure.
export const LAUNCHER_SOURCES = [
  'scripts/concurrency-trace-main-50k.mjs',
  'scripts/fixtures/concurrency-trace-main-artifact.mjs',
  'scripts/fixtures/concurrency-trace-main-cell-report.mjs',
  'scripts/fixtures/concurrency-trace-live-lifecycle.mjs',
  'scripts/owned-app-processes.mjs',
  'scripts/session-concurrency-electron.mjs'
]

const SELECTED_NOTE = 'selected sources only: bundle content is covered by its sha256, so this is not an import-closure claim'

const describe = (error) => (error instanceof Error ? error.message : String(error))

export const hashFile = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')

/** Lenient identity: an unreadable source makes the whole identity unavailable instead of a partial claim. */
export function selectedIdentity(base, files) {
  try {
    return { status: 'measured', files: Object.fromEntries(files.map((file) => [file, hashFile(join(base, file))])), note: SELECTED_NOTE }
  } catch (error) {
    return { status: 'unavailable', reason: `could not hash the selected sources: ${describe(error)}`, files: {}, note: SELECTED_NOTE }
  }
}

/** Build-time identity: a missing or unreadable source fails the build rather than yielding a manifest without
 *  provenance. Existing is not the same as readable (a directory or an unreadable file both exist), so the
 *  original reason from selectedIdentity is kept instead of being replaced by a guess. */
export function requiredIdentity(base, files) {
  const missing = files.filter((file) => !existsSync(join(base, file)))
  if (missing.length > 0) throw new Error(`cannot build an artifact without its sources: ${missing.join(', ')}`)
  const identity = selectedIdentity(base, files)
  if (identity.status !== 'measured') throw new Error(`cannot build an artifact from unreadable sources: ${identity.reason}`)
  return identity
}

/** Re-reads a selected list and refuses a manifest whose recorded identity no longer matches the tree. */
function assertSourcesUnchanged(base, label, recorded, files) {
  const after = requiredIdentity(base, files)
  const changed = files.filter((file) => after.files[file] !== recorded.files[file])
  if (changed.length > 0) {
    throw new Error(`refusing to write a manifest: the selected ${label} sources changed during the build (${changed.join(', ')})`)
  }
}

/**
 * Builds main.cjs plus the manifest that describes it. The manifest records the bundle bytes, the build-time
 * source identity and the build-time launcher-helper identity, so an older artifact can always be described by
 * what it was built from instead of by whatever the tree looks like later.
 */
export async function buildArtifact({ appRoot = root, outDir } = {}) {
  if (!outDir) throw new Error('buildArtifact needs an outDir')
  const buildSource = requiredIdentity(appRoot, MEASUREMENT_SOURCES)
  const launcherSource = requiredIdentity(appRoot, LAUNCHER_SOURCES)
  mkdirSync(outDir, { recursive: true })
  const { build } = await import('vite')
  await build({
    configFile: false,
    root: appRoot,
    logLevel: 'error',
    ssr: { noExternal: true },
    build: {
      ssr: join(appRoot, MAIN_TRIAL_ENTRY),
      outDir,
      emptyOutDir: false,
      minify: false,
      target: 'node20',
      rollupOptions: { external: ['electron'], output: { format: 'cjs', entryFileNames: 'main.cjs' } }
    }
  })
  // The manifest has to describe the bytes that were really built, so both selected lists are re-read after the
  // build and any difference aborts before a manifest exists.
  assertSourcesUnchanged(appRoot, 'measurement', buildSource, MEASUREMENT_SOURCES)
  assertSourcesUnchanged(appRoot, 'launcher helper', launcherSource, LAUNCHER_SOURCES)
  const bundlePath = join(outDir, 'main.cjs')
  const bytes = statSync(bundlePath).size
  if (bytes <= 0) throw new Error('the trial bundle is empty')
  const manifest = {
    schema: 1,
    entry: MAIN_TRIAL_ENTRY,
    k: FIXED_ITEMS,
    bundle: { file: 'main.cjs', sha256: hashFile(bundlePath), bytes },
    builtAtEpochMs: Date.now(),
    bundler: 'vite ssr build, noExternal: true, electron external, target node20',
    buildSource,
    launcherSource
  }
  const manifestPath = join(outDir, 'manifest.json')
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  return { bundlePath, manifestPath, manifest }
}

/**
 * Read-only verification. Throws only when the artifact cannot be trusted to be itself: missing files, wrong
 * schema or workload, or bundle bytes that do not match the manifest hash and size. Source drift is data, not
 * a failure, so a frozen baseline stays executable.
 */
export function verifyArtifact({ artifactDir, appRoot = root } = {}) {
  if (!artifactDir) throw new Error('verifyArtifact needs an artifactDir')
  const dir = resolve(artifactDir)
  const manifestPath = join(dir, 'manifest.json')
  const bundlePath = join(dir, 'main.cjs')
  if (!existsSync(manifestPath)) throw new Error(`artifact has no manifest.json: ${dir}`)
  if (!existsSync(bundlePath)) throw new Error(`artifact has no main.cjs: ${dir}`)
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  if (!manifest || manifest.schema !== 1) throw new Error('artifact manifest schema must be 1')
  if (manifest.entry !== MAIN_TRIAL_ENTRY) throw new Error(`artifact was built from ${JSON.stringify(manifest.entry)}, not ${MAIN_TRIAL_ENTRY}`)
  if (manifest.k !== FIXED_ITEMS) throw new Error(`artifact was built for k=${JSON.stringify(manifest.k)}, this launcher only runs ${FIXED_ITEMS}`)
  if (!manifest.bundle || manifest.bundle.file !== 'main.cjs') throw new Error('artifact manifest does not describe main.cjs')
  if (manifest.buildSource?.status !== 'measured') throw new Error('artifact manifest has no build-time source identity')
  const bytes = statSync(bundlePath).size
  const sha256 = hashFile(bundlePath)
  if (bytes !== manifest.bundle.bytes || sha256 !== manifest.bundle.sha256) {
    throw new Error(`artifact bundle does not match its manifest (bytes ${bytes} vs ${manifest.bundle.bytes}, sha256 ${sha256} vs ${manifest.bundle.sha256})`)
  }
  const currentSource = selectedIdentity(appRoot, MEASUREMENT_SOURCES)
  const sourceDrift = currentSource.status === 'measured'
    ? Object.keys(manifest.buildSource.files).filter((file) => currentSource.files[file] !== manifest.buildSource.files[file])
    : null
  return {
    manifestPath,
    bundlePath,
    manifestSha256: hashFile(manifestPath),
    manifest,
    bundle: { bytes, sha256 },
    buildSource: manifest.buildSource,
    buildLauncherSource: manifest.launcherSource ?? { status: 'unavailable', reason: 'the manifest records no build-time launcher identity', files: {} },
    currentSource,
    sourceDrift,
    driftReason: sourceDrift === null ? `the current selected sources are unavailable: ${currentSource.reason}` : null
  }
}
