// S0-5: which artifact the daemon-mode smoke drives, and what the packaged one must prove.
//
// `--app <executable>` names the packaged binary (dist/linux-unpacked/scry, or
// Scry.app/Contents/MacOS/Scry). Everything the smoke later asserts about the daemon is
// compared against this one resolved layout, so "the check passed" and "the process that
// ran" cannot be two different builds. Anything that does not resolve to a packaged
// layout fails here, before an App is launched: a dev Electron, a renamed binary, a
// missing file, or an artifact older than the source.
import { accessSync, constants, existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join, resolve, sep } from 'node:path'
import { listPackage } from '@electron/asar'
import { electronDevLayout, packagedAppLayout } from '../packaged-app-layout.mjs'
import { packagedArtifactVersion } from '../packaged-artifact-guard.mjs'

// The daemon entries and the workers they load by URL beside them. All four must be
// inside the archive the packaged App runs from.
export const PACKAGED_MAIN_ENTRIES = Object.freeze([
  'daemon.js', 'daemon-supervisor.js', 'terminal-recording-worker.js', 'run-output-file-worker.js'
])

const refused = (reason, detail = {}) => ({ ok: false, reason, ...detail })

/** `--app <path>` and `--log <path>`; an option without its value is an error, not a default. */
export function parseSmokeArguments(argv) {
  const options = { app: undefined, log: undefined }
  for (let index = 0; index < argv.length; index++) {
    const name = argv[index]
    if (name !== '--app' && name !== '--log') return refused('unknown_argument', { argument: name })
    const value = argv[index + 1]
    if (typeof value !== 'string' || value.length === 0 || value.startsWith('--')) return refused('argument_value_missing', { argument: name })
    options[name.slice(2)] = value
    index++
  }
  return { ok: true, ...options }
}

// The inverse of packagedAppLayout: the bundle or unpacked directory that holds it.
export function appPathOfExecutable(executable, platform = process.platform) {
  return platform === 'darwin' ? dirname(dirname(dirname(executable))) : dirname(executable)
}

export function resolvePackagedApp(argument, { platform = process.platform, sourcePackage = resolve('package.json') } = {}) {
  if (typeof argument !== 'string' || argument.length === 0) return refused('app_argument_missing')
  const given = resolve(argument)
  let executable
  try { executable = realpathSync(given) } catch { return refused('app_executable_missing', { given }) }
  if (!statSync(executable).isFile()) return refused('app_executable_not_file', { executable })
  try { accessSync(executable, constants.X_OK) } catch { return refused('app_executable_not_executable', { executable }) }
  let layout
  try { layout = packagedAppLayout(appPathOfExecutable(executable, platform), { platform }) } catch (error) {
    return refused('app_platform_unsupported', { detail: String(error?.message ?? error) })
  }
  // A dev Electron (node_modules/electron/dist/electron) or a copied binary sits in a
  // directory whose layout names a different executable.
  if (layout.executable !== executable) return refused('app_executable_not_packaged_layout', { executable, expected: layout.executable })
  const archive = join(layout.resources, 'app.asar')
  if (!existsSync(archive)) return refused('app_not_packaged', { expected: archive })
  let entries
  try { entries = new Set(listPackage(archive)) } catch (error) { return refused('app_archive_unreadable', { detail: String(error?.message ?? error) }) }
  const missing = PACKAGED_MAIN_ENTRIES.filter((entry) => !entries.has(`/out/main/${entry}`))
  if (missing.length > 0) return refused('app_archive_missing_entries', { missing })
  let artifactVersion
  try { artifactVersion = packagedArtifactVersion(layout.appPath, platform) } catch (error) {
    return refused('app_version_unreadable', { detail: String(error?.message ?? error) })
  }
  const sourceVersion = JSON.parse(readFileSync(sourcePackage, 'utf8')).version
  // An older artifact answers with older envelopes; asserting against it would report a
  // source regression that is really a stale build (see packaged-artifact-guard.mjs).
  if (artifactVersion !== sourceVersion) return refused('app_artifact_stale', { artifactVersion, sourceVersion })
  const resources = realpathSync(layout.resources)
  return {
    ok: true, packaged: true, executable, appPath: layout.appPath, resources, version: artifactVersion,
    // What the App passes the supervisor: app.getAppPath() is the archive, and the
    // supervisor resolves daemon.js beside itself.
    appArchive: join(resources, 'app.asar'),
    entryDirectory: join(resources, 'app.asar', 'out', 'main')
  }
}

/** The development target the smoke used before S0-5; same expectation shape. */
export function devTarget(root, platform = process.platform) {
  const executable = realpathSync(resolve(root, electronDevLayout({ platform }).executable))
  return { ok: true, packaged: false, executable, appPath: root, entryDirectory: join(root, 'out', 'main') }
}

const inside = (child, parent) => child.startsWith(parent.endsWith(sep) ? parent : `${parent}${sep}`)

/**
 * The private recorder CLI the packaged daemon resolves: `<resources>/bin/scry`, where the
 * resources directory is the one the daemon was actually given (read from its
 * environment), not the one this script expects. The daemon refuses to start without it
 * when packaged (daemon_recorder_cli_unavailable), so a running packaged daemon plus this
 * file is the path in use; running it proves it is the App's own CLI and that it works.
 */
export function privateCliEvidence(target, daemonResources, { exec = execFileSync, env = process.env } = {}) {
  if (!target.packaged) return refused('not_packaged')
  if (typeof daemonResources !== 'string' || daemonResources.length === 0) return refused('daemon_resources_unavailable')
  const path = join(resolve(daemonResources), 'bin', 'scry')
  let real
  try { real = realpathSync(path) } catch { return refused('private_cli_missing', { path }) }
  if (!inside(real, target.resources)) return refused('private_cli_outside_resources', { path, real, resources: target.resources })
  try { accessSync(real, constants.X_OK) } catch { return refused('private_cli_not_executable', { path }) }
  let expected
  try { expected = JSON.parse(readFileSync(join(target.resources, 'scry-cli', 'package.json'), 'utf8')).version } catch {
    return refused('private_cli_package_missing', { path })
  }
  let actual
  try {
    actual = String(exec(path, ['--version'], { encoding: 'utf8', timeout: 15_000, env })).trim()
  } catch (error) {
    return refused('private_cli_failed', { path, detail: String(error?.message ?? error).slice(0, 400) })
  }
  if (actual !== expected) return refused('private_cli_version_mismatch', { path, expected, actual })
  return { ok: true, path, version: actual }
}
