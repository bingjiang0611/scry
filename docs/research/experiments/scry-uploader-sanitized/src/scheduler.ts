import { realpath, stat } from 'node:fs/promises'
import { homedir, platform, tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { REDACTION_VERSION } from './constants.js'
import { pruneAckedBodiesIfDue } from './custody/index.js'
import { enqueueWakeup, runQueueWorker } from './queue.js'
import { safeSnapshotMaxSequence, uploaderEntrypoint } from './scry.js'
import { assertLegacyLocksMigrated, prepareUploadRoot } from './storage.js'
import { isLockBusy } from './locks.js'
import { acquireDirectoryLock, ensurePrivateDirectory, executable, exists, readJson, run, sleep, writeJsonAtomic } from './util.js'

type Registry = { version: 1; workspaces: Array<{ workspace: string; registeredAt: string }> }

function registryPath(env: NodeJS.ProcessEnv = process.env): string {
  const config = env.XDG_CONFIG_HOME?.trim()
  if (config) return join(config, 'scry-upload', 'workspaces.json')
  if (platform() === 'darwin') return join(env.HOME?.trim() || homedir(), 'Library', 'Application Support', 'scry-upload', 'workspaces.json')
  return join(env.HOME?.trim() || homedir(), '.config', 'scry-upload', 'workspaces.json')
}

async function loadRegistry(env: NodeJS.ProcessEnv): Promise<Registry> {
  const value = await readJson<unknown>(registryPath(env))
  if (value === null) return { version: 1, workspaces: [] }
  if (!value || typeof value !== 'object' || (value as Registry).version !== 1 || !Array.isArray((value as Registry).workspaces))
    throw new Error('scry workspace registry is invalid')
  const workspaces = (value as Registry).workspaces
  if (
    workspaces.some(
      (entry) =>
        !entry ||
        typeof entry.workspace !== 'string' ||
        !entry.workspace.startsWith('/') ||
        typeof entry.registeredAt !== 'string'
    )
  )
    throw new Error('scry workspace registry entry is invalid')
  return { version: 1, workspaces: workspaces.map((entry) => ({ workspace: entry.workspace, registeredAt: entry.registeredAt })) }
}

export async function registeredWorkspaces(env: NodeJS.ProcessEnv = process.env): Promise<string[]> {
  return (await loadRegistry(env)).workspaces.map(entry => entry.workspace)
}

async function mutateRegistry<T>(env: NodeJS.ProcessEnv, action: () => Promise<T>): Promise<T> {
  const path = registryPath(env)
  await ensurePrivateDirectory(join(path, '..'))
  const deadline = Date.now() + 1_000
  while (true) {
    try {
      const release = await acquireDirectoryLock(`${path}.lock`)
      try {
        return await action()
      } finally {
        await release()
      }
    } catch (error) {
      if (!isLockBusy(error)) throw error
      if (Date.now() >= deadline) throw new Error('scry workspace registry is busy')
      await sleep(20)
    }
  }
}

export async function registerWorkspace(input: string, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const workspace = await realpath(input)
  if (!(await stat(workspace)).isDirectory()) throw new Error('workspace is not a directory')
  const config = await readJson<unknown>(join(workspace, 'scry.config.json'))
  if (
    !config ||
    typeof config !== 'object' ||
    (config as { schemaVersion?: unknown }).schemaVersion !== 1 ||
    typeof (config as { workspaceId?: unknown }).workspaceId !== 'string' ||
    !(config as { workspaceId: string }).workspaceId.trim()
  )
    throw new Error('workspace is not initialized')
  const base = await prepareUploadRoot(workspace)
  await assertLegacyLocksMigrated(base)
  const release = await acquireDirectoryLock(join(base, 'standalone.lock'))
  try {
    const statePath = join(base, 'state.json')
    if ((await readJson<unknown>(statePath)) === null) {
      const baseline = await safeSnapshotMaxSequence(workspace, env)
      await writeJsonAtomic(statePath, {
        version: 1,
        enqueuedThrough: baseline,
        initializedAt: new Date().toISOString(),
        redactionVersion: REDACTION_VERSION
      })
    }
  } finally {
    await release()
  }
  await mutateRegistry(env, async () => {
    const registry = await loadRegistry(env)
    if (!registry.workspaces.some((entry) => entry.workspace === workspace))
      registry.workspaces.push({ workspace, registeredAt: new Date().toISOString() })
    registry.workspaces.sort((a, b) => a.workspace.localeCompare(b.workspace))
    await writeJsonAtomic(registryPath(env), registry)
  })
  return workspace
}

export async function unregisterWorkspace(input: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  await mutateRegistry(env, async () => {
    const registry = await loadRegistry(env)
    const requested = resolve(input)
    // Removing saved authority does not require the old directory to exist.
    const workspace = registry.workspaces.some(entry => entry.workspace === requested)
      ? requested
      : await realpath(input)
    registry.workspaces = registry.workspaces.filter((entry) => entry.workspace !== workspace)
    await writeJsonAtomic(registryPath(env), registry)
  })
}

function xml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
}
function serviceEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {
    HOME: env.HOME || homedir(),
    PATH: env.PATH || '/usr/bin:/bin'
  }
  for (const key of ['XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'TRANSPORT_CLI_PATH', 'TRANSPORT_AUTH_PROVIDER', 'TRANSPORT_PROFILE']) {
    if (env[key]) result[key] = env[key]!
  }
  return result
}

function systemdQuote(value: string): string {
  return JSON.stringify(value.replaceAll('%', '%%').replaceAll('$', () => '$$'))
}

export function renderLaunchAgent(node: string, cli: string, env: NodeJS.ProcessEnv): string {
  const environment = Object.entries(serviceEnvironment(env))
    .map(([key, value]) => `<key>${xml(key)}</key><string>${xml(value)}</string>`).join('')
  return `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>Label</key><string>com.scry.uploader</string>
<key>ProgramArguments</key><array><string>${xml(node)}</string><string>${xml(cli)}</string><string>_recover</string></array>
<key>EnvironmentVariables</key><dict>${environment}</dict>
<key>RunAtLoad</key><true/><key>StartInterval</key><integer>60</integer>
<key>ThrottleInterval</key><integer>30</integer>
</dict></plist>
`
}

export function renderSystemdService(node: string, cli: string, env: NodeJS.ProcessEnv): string {
  const environment = Object.entries(serviceEnvironment(env))
    .map(([key, value]) => `Environment=${JSON.stringify(`${key}=${value}`.replaceAll('%', '%%'))}`).join('\n')
  return `[Unit]
Description=Scry uploader recovery
[Service]
Type=oneshot
${environment}
ExecStart=${systemdQuote(node)} ${systemdQuote(cli)} _recover
`
}

async function installedEntrypoint(cli: string): Promise<string> {
  let canonical: string
  try {
    canonical = await realpath(cli)
    const metadata = await stat(canonical)
    if (!metadata.isFile()) throw new Error('not a file')
  } catch {
    throw new Error('installed uploader CLI entrypoint is unavailable')
  }
  const temporaryRoot = await realpath(tmpdir()).catch(() => tmpdir())
  if (canonical === temporaryRoot || canonical.startsWith(`${temporaryRoot}/`))
    throw new Error('installed uploader CLI entrypoint must not be temporary')
  if (await exists(join(dirname(dirname(canonical)), '.git')))
    throw new Error('scheduler requires an installed package, not a source checkout')
  return canonical
}

export async function installScheduler(
  env: NodeJS.ProcessEnv = process.env,
  entrypoint: string = uploaderEntrypoint()
): Promise<Record<string, unknown>> {
  const cli = await installedEntrypoint(entrypoint)
  if (platform() === 'darwin') {
    const path = join(env.HOME?.trim() || homedir(), 'Library', 'LaunchAgents', 'com.scry.uploader.plist')
    await ensurePrivateDirectory(join(path, '..'))
    await ensurePrivateDirectory(join(registryPath(env), '..'))
    const { writeFileAtomic } = await import('./util.js')
    await writeFileAtomic(path, renderLaunchAgent(process.execPath, cli, env), 0o600)
    const activation = await activateRecoveryService(env, { platform: 'darwin', path })
    await writeJsonAtomic(join(registryPath(env), '..', 'install-marker.json'), { version: 1, platform: 'darwin', path, installedAt: new Date().toISOString() })
    return { platform: 'darwin', path, ...activation }
  }
  if (platform() !== 'linux') throw new Error('scheduler requires macOS launchd or Linux systemd')
  const directory = join(env.XDG_CONFIG_HOME?.trim() || join(env.HOME?.trim() || homedir(), '.config'), 'systemd', 'user')
  const path = join(directory, 'scry-uploader.service')
  const timer = join(directory, 'scry-uploader.timer')
  await ensurePrivateDirectory(directory)
  const { writeFileAtomic } = await import('./util.js')
  await writeFileAtomic(path, renderSystemdService(process.execPath, cli, env), 0o600)
  await writeFileAtomic(timer, `[Unit]\nDescription=Periodic Scry uploader recovery\n[Timer]\nOnBootSec=30s\nOnUnitActiveSec=60s\nPersistent=true\n[Install]\nWantedBy=timers.target\n`, 0o600)
  await ensurePrivateDirectory(join(registryPath(env), '..'))
  const activation = await activateRecoveryService(env, { platform: 'linux', path, timer })
  await writeJsonAtomic(join(registryPath(env), '..', 'install-marker.json'), {
    version: 1,
    platform: 'linux',
    path,
    timer,
    installedAt: new Date().toISOString(),
    lingerEnabled: activation.lingerEnabled ?? false
  })
  return { platform: 'linux', path, timer, ...activation }
}

/**
 * Writing a unit file never starts anything. Load the unit now and verify the
 * observed state, so a machine that never logs out is not left with silent
 * recovery gaps. Failures are reported, never downgraded to "installed".
 */
export async function activateRecoveryService(
  env: NodeJS.ProcessEnv,
  service: { platform: string; path: string; timer?: string }
): Promise<{ loaded: boolean; lingerEnabled?: boolean; hint?: string }> {
  if (service.platform === 'darwin') {
    const domain = `gui/${process.getuid?.() ?? 0}`
    const label = `${domain}/com.scry.uploader`
    await serviceCommand(env, 'launchctl', ['bootout', label], { allowFailure: true })
    await serviceCommand(env, 'launchctl', ['bootstrap', domain, service.path])
    const loaded = await serviceCommand(env, 'launchctl', ['print', label], { allowFailure: true })
    if (loaded.exitCode !== 0) throw new Error('launchd did not load com.scry.uploader after bootstrap')
    return { loaded: true }
  }
  if (service.platform !== 'linux') throw new Error(`scheduler requires launchd or systemd, not ${service.platform}`)
  await serviceCommand(env, 'systemctl', ['--user', 'daemon-reload'])
  await serviceCommand(env, 'systemctl', ['--user', 'enable', '--now', 'scry-uploader.timer'])
  const active = await serviceCommand(env, 'systemctl', ['--user', 'is-active', 'scry-uploader.timer'], { allowFailure: true })
  if (active.stdout.trim() !== 'active') throw new Error('systemd did not activate scry-uploader.timer')
  const linger = await serviceCommand(env, 'loginctl', ['show-user', env.USER || env.LOGNAME || '', '-p', 'Linger', '--value'], { allowFailure: true })
  const lingerEnabled = linger.exitCode === 0 && linger.stdout.trim() === 'yes'
  return {
    loaded: true,
    lingerEnabled,
    ...(lingerEnabled ? {} : { hint: 'run: loginctl enable-linger $USER; otherwise the timer stops when you log out' })
  }
}

/** `scheduler-status` reports the observed service state, not just a marker file. */
export async function schedulerStatus(env: NodeJS.ProcessEnv = process.env): Promise<Record<string, unknown>> {
  const workspaces = await registeredWorkspaces(env)
  const marker = await readJson<{ platform?: string }>(join(registryPath(env), '..', 'install-marker.json'))
  let activation: Record<string, unknown>
  if (marker === null) activation = { state: 'not_installed' }
  else if (platform() === 'darwin') {
    const label = `gui/${process.getuid?.() ?? 0}/com.scry.uploader`
    const loaded = await serviceCommand(env, 'launchctl', ['print', label], { allowFailure: true })
    activation = { state: loaded.exitCode === 0 ? 'loaded' : 'not_loaded', target: label }
  } else if (platform() === 'linux') {
    const loaded = await serviceCommand(env, 'systemctl', ['--user', 'is-active', 'scry-uploader.timer'], { allowFailure: true })
    const state = loaded.stdout.trim()
    activation = { state: state === 'active' ? 'loaded' : 'not_loaded', detail: state || `exit ${loaded.exitCode}`, target: 'scry-uploader.timer' }
  } else activation = { state: 'unavailable', detail: `unsupported platform ${platform()}` }
  return { platform: platform(), registry: registryPath(env), workspaces, installed: marker, activation }
}

async function serviceCommand(
  env: NodeJS.ProcessEnv,
  name: string,
  args: string[],
  options: { allowFailure?: boolean } = {}
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const executable = await findCommand(name, env)
  if (!executable) {
    if (options.allowFailure) return { stdout: '', stderr: `${name} is unavailable`, exitCode: 127 }
    throw new Error(`${name} is required to activate the recovery service but was not found on PATH`)
  }
  const result = await run(executable, args, { env, timeoutMs: 20_000 })
  if (!options.allowFailure && result.exitCode !== 0)
    throw new Error(`${name} ${args.join(' ')} failed (exit ${result.exitCode}): ${result.stderr.trim().slice(0, 300)}`)
  return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode }
}

async function findCommand(name: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  for (const directory of (env.PATH ?? '').split(delimiter)) {
    if (!directory) continue
    const candidate = join(directory, name)
    if (await executable(candidate)) return candidate
  }
  return undefined
}

export async function recoverRegistered(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const directory = join(registryPath(env), '..')
  await ensurePrivateDirectory(directory)
  let release: () => Promise<void>
  try {
    release = await acquireDirectoryLock(join(directory, 'recovery.lock'))
  } catch (error) {
    if (isLockBusy(error)) return
    throw error
  }
  try {
    const pending = await registeredWorkspaces(env)
    const schedulerEnv = { ...env, SCRY_UPLOADER_NO_SPAWN: '1' }
    const failures: Error[] = []
    const workers = Array.from({ length: Math.min(2, pending.length) }, async () => {
      while (pending.length) {
        const workspace = pending.shift()!
        try {
          const canonical = await realpath(workspace)
          if (canonical !== workspace || !(await stat(canonical)).isDirectory())
            throw new Error('registered workspace canonical identity changed')
          // Keep failures inside this workspace's boundary, including path
          // resolution failures. Preserve existing backoff and captured context.
          await enqueueWakeup(workspace, schedulerEnv, true)
          await runQueueWorker(workspace, schedulerEnv, { once: true })
          await pruneAckedBodiesIfDue(workspace)
        } catch (error) {
          failures.push(new Error(`recovery failed for ${workspace}`, { cause: error }))
        }
      }
    })
    await Promise.all(workers)
    await writeJsonAtomic(join(directory, 'recovery-health.json'), {
      completedAt: new Date().toISOString(),
      failures: failures.map(error => {
        const cause = error.cause instanceof Error ? error.cause : undefined
        const code = cause && 'code' in cause && typeof cause.code === 'string' ? cause.code : undefined
        return { message: error.message, cause: cause?.name ?? 'unknown', code }
      })
    })
    if (failures.length) throw new AggregateError(failures, `recovery failed for ${failures.length} workspace(s)`)
  } finally {
    await release()
  }
}
