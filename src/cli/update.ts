import { execFile, spawn } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import { promisify } from 'node:util'
import { readJson, withDirectoryLock, writeJsonAtomic } from '../core/turn-recorder/io.js'

const execFileAsync = promisify(execFile)
const PACKAGE_NAME = 'scry-turn-recorder'
const DEFAULT_REGISTRY = 'https://registry.npmjs.org'
const SUCCESS_INTERVAL_MS = 24 * 60 * 60 * 1_000
const FAILURE_INTERVAL_MS = 6 * 60 * 60 * 1_000

interface CliUpdateState {
  checkedAt?: string
  currentVersion?: string
  latestVersion?: string
  status?: UpgradeResult['status']
  error?: string
  updatedAt?: string
  updatedFrom?: string
  updatedTo?: string
  notifiedAt?: string
}

export interface UpgradeResult {
  status: 'current' | 'update_available' | 'updated' | 'error'
  currentVersion: string
  latestVersion?: string
  compatibleAutoUpdate?: boolean
  message?: string
}

interface UpgradeOptions {
  currentVersion: string
  entryPath?: string
  checkOnly?: boolean
  allowBreaking?: boolean
  env?: NodeJS.ProcessEnv
  now?: Date
}

interface AutoUpdateOptions {
  command?: string
  action?: string
  noUpdateCheck: boolean
  stderrIsTTY: boolean
  env?: NodeJS.ProcessEnv
}

function enabled(value: string | undefined): boolean {
  return !!value && !['0', 'false', 'no'].includes(value.toLowerCase())
}

function statePath(env: NodeJS.ProcessEnv = process.env): string {
  return env.SCRY_CLI_UPDATE_STATE_PATH ?? join(homedir(), '.scry', 'cli-update.json')
}

function registryOf(env: NodeJS.ProcessEnv): string {
  const value = (env.SCRY_CLI_REGISTRY ?? DEFAULT_REGISTRY).replace(/\/+$/, '')
  const url = new URL(value)
  if (url.protocol !== 'https:') throw new Error('Scry CLI registry must use HTTPS')
  return url.href.replace(/\/+$/, '')
}

function npmExecutable(env: NodeJS.ProcessEnv): string {
  if (env.SCRY_NPM_PATH) return env.SCRY_NPM_PATH
  const sibling = join(dirname(process.execPath), 'npm')
  return existsSync(sibling) ? sibling : 'npm'
}

function parseVersion(value: string): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value.trim())
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null
}

export function compareVersions(left: string, right: string): number {
  const a = parseVersion(left)
  const b = parseVersion(right)
  if (!a || !b) throw new Error(`invalid version: ${!a ? left : right}`)
  for (let index = 0; index < a.length; index++) {
    if (a[index] !== b[index]) return a[index] - b[index]
  }
  return 0
}

/**
 * Auto-update stays inside the same major. 0.x minor used to be a wall too, which meant every
 * 0.x user had to notice a manual upgrade or silently stop receiving fixes; the wall is now major
 * only, and a release that really breaks the CLI contract is expected to bump major instead.
 *
 * Clients decide this with their own copy of the rule, so a permissive rule only reaches users
 * through a release their current rule already accepts — hence shipping this inside 0.2.x.
 */
export function isCompatibleAutoUpdate(current: string, candidate: string): boolean {
  const from = parseVersion(current)
  const to = parseVersion(candidate)
  if (!from || !to || compareVersions(candidate, current) <= 0) return false
  return to[0] === from[0]
}

export function npmPrefixFromEntry(entryPath: string): string | null {
  let resolved: string
  try {
    resolved = realpathSync(entryPath)
  } catch {
    return null
  }
  const packagePath = PACKAGE_NAME.split('/').join(sep)
  const marker = `${sep}lib${sep}node_modules${sep}${packagePath}${sep}`
  const index = resolved.indexOf(marker)
  if (index < 0) return null
  return resolved.slice(0, index) || sep
}

/** Explicitly switched off, as opposed to simply unset. */
function turnedOff(value: string | undefined): boolean {
  return value !== undefined && ['0', 'false', 'no'].includes(value.trim().toLowerCase())
}

/**
 * The environment half of the policy, shared by every trigger so there is one answer to "may this
 * machine install an update at all".
 *
 * Auto-update is **on unless switched off**. An opt-in flag only ever reached machines whose
 * operator already knew about it, which left everyone else on whatever version they first
 * installed. The cost of this default is real and stated in the README: a published release
 * installs itself, unattended, on machines running agents with the local user's permissions. It
 * stays bounded by `isCompatibleAutoUpdate` (never across a major), never runs from a Provider hook
 * event, and any of these switches it off:
 * `SCRY_AUTO_UPDATE=0`, `SCRY_NO_UPDATE_CHECK=1`, or a host that pins the CLI
 * (`SCRY_CLI_BUNDLED`, `SCRY_RECORDER_MANAGED`).
 */
export function autoUpdateAllowedByEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  if (turnedOff(env.SCRY_AUTO_UPDATE)) return false
  return ![
    env.SCRY_CLI_BUNDLED,
    env.SCRY_RECORDER_MANAGED,
    env.SCRY_NO_UPDATE_CHECK,
    env.SCRY_UPDATE_CHILD,
    env.CI
  ].some(enabled)
}

export function shouldScheduleAutoUpdate(options: AutoUpdateOptions): boolean {
  const env = options.env ?? process.env
  if (!options.stderrIsTTY || options.noUpdateCheck) return false
  if (!options.command || ['upgrade', 'version', '__auto_update'].includes(options.command)) return false
  if (options.command === 'recorder' && ['hook', 'serve'].includes(options.action ?? '')) return false
  return autoUpdateAllowedByEnv(env)
}

/**
 * Update trigger for the recorder daemon's idle shutdown. Hook events deliberately cannot trigger
 * one: after the curl fast path they run no Node at all, so a trigger there would re-add a process
 * launch (measured 79ms) to the hottest path and could swap the CLI between two events of the same
 * turn. The daemon instead updates when it has already decided to exit, which needs no extra
 * process and cannot split a turn.
 *
 * Pending turns deliberately do not block this. Records are durable and versioned, a newer CLI
 * recovering an older open turn is a supported path, and `doctor` reports version drift - whereas
 * requiring zero pending would silently disable updates on exactly the workspaces that accumulate
 * them.
 */
export async function runIdleAutoUpdate(
  currentVersion: string,
  entryPath?: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<string | null> {
  if (!autoUpdateAllowedByEnv(env)) return null
  const result = await runBackgroundUpdate(currentVersion, entryPath)
  return result?.status === 'updated' ? result.latestVersion ?? null : null
}

export function isUpdateDue(state: CliUpdateState | null, now = Date.now()): boolean {
  if (!state?.checkedAt) return true
  const checkedAt = Date.parse(state.checkedAt)
  if (!Number.isFinite(checkedAt)) return true
  const interval = state.status === 'error' ? FAILURE_INTERVAL_MS : SUCCESS_INTERVAL_MS
  return now - checkedAt >= interval
}

async function runNpm(
  args: string[],
  env: NodeJS.ProcessEnv,
  timeout: number
): Promise<string> {
  try {
    const { stdout } = await execFileAsync(npmExecutable(env), args, {
      env,
      timeout,
      maxBuffer: 1024 * 1024,
      encoding: 'utf8'
    })
    return stdout.trim()
  } catch (error) {
    const failure = error as Error & { code?: string | number; killed?: boolean; signal?: string; stderr?: string | Buffer }
    if (failure.killed || failure.signal) throw new Error(`npm ${args[0]} 超时（${Math.round(timeout / 1_000)}s）`)
    const stderr = typeof failure.stderr === 'string' ? failure.stderr : failure.stderr?.toString('utf8')
    throw new Error(`npm ${args[0]} 失败：${stderr?.trim() || `exit ${failure.code ?? 'unknown'}`}`)
  }
}

/**
 * `~` pins the minor and npm's `^` also treats 0.x minor as breaking, so neither range can express
 * "anything newer inside this major". Spell the bound out instead, or a 0.x install can never see
 * the next minor even when the compatibility rule allows it.
 */
function updateSpec(currentVersion: string, allowBreaking: boolean, checkOnly: boolean): string {
  if (allowBreaking || checkOnly) return 'latest'
  const current = parseVersion(currentVersion)
  if (!current) throw new Error(`invalid version: ${currentVersion}`)
  return `>=${currentVersion} <${current[0] + 1}.0.0`
}

async function availableVersion(env: NodeJS.ProcessEnv, spec: string): Promise<string> {
  const output = await runNpm([
    'view', `${PACKAGE_NAME}@${spec}`, 'version', '--json',
    '--registry', registryOf(env)
  ], env, 8_000)
  const value = JSON.parse(output) as unknown
  const versions = (Array.isArray(value) ? value : [value])
    .filter((item): item is string => typeof item === 'string' && parseVersion(item) !== null)
  if (versions.length === 0) throw new Error('registry returned an invalid version')
  return versions.reduce((latest, candidate) => compareVersions(candidate, latest) > 0 ? candidate : latest)
}

async function saveResult(
  path: string,
  result: UpgradeResult,
  now: Date,
  previous: CliUpdateState | null
): Promise<void> {
  const updatedAt = result.status === 'updated' ? now.toISOString() : previous?.updatedAt
  await writeJsonAtomic(path, {
    ...previous,
    checkedAt: now.toISOString(),
    currentVersion: result.status === 'updated' ? result.latestVersion : result.currentVersion,
    latestVersion: result.latestVersion,
    status: result.status,
    error: result.status === 'error' ? result.message : undefined,
    updatedAt,
    updatedFrom: result.status === 'updated' ? result.currentVersion : previous?.updatedFrom,
    updatedTo: result.status === 'updated' ? result.latestVersion : previous?.updatedTo,
    notifiedAt: result.status === 'updated' ? updatedAt : previous?.notifiedAt
  } satisfies CliUpdateState)
}

export async function upgradeCli(options: UpgradeOptions): Promise<UpgradeResult> {
  const env = options.env ?? process.env
  const now = options.now ?? new Date()
  const path = statePath(env)
  const previous = await readJson<CliUpdateState>(path)
  let result: UpgradeResult
  try {
    const latest = await availableVersion(
      env,
      updateSpec(options.currentVersion, options.allowBreaking === true, options.checkOnly === true)
    )
    const compatibleAutoUpdate = isCompatibleAutoUpdate(options.currentVersion, latest)
    if (compareVersions(latest, options.currentVersion) <= 0) {
      result = { status: 'current', currentVersion: options.currentVersion, latestVersion: latest, compatibleAutoUpdate: false }
    } else if (options.checkOnly || (!options.allowBreaking && !compatibleAutoUpdate)) {
      result = { status: 'update_available', currentVersion: options.currentVersion, latestVersion: latest, compatibleAutoUpdate }
    } else {
      const entryPath = options.entryPath
      const prefix = entryPath ? npmPrefixFromEntry(entryPath) : null
      if (!entryPath || !prefix) throw new Error('当前 scry 不是 npm 全局安装；请使用对应安装方式升级')
      await runNpm([
        'install', '--global', '--prefix', prefix,
        '--registry', registryOf(env), '--no-audit', '--no-fund', '--ignore-scripts',
        `${PACKAGE_NAME}@${latest}`
      ], env, 120_000)
      const { stdout } = await execFileAsync(process.execPath, [entryPath, '--version'], {
        env: { ...env, SCRY_NO_UPDATE_CHECK: '1' },
        timeout: 8_000,
        maxBuffer: 1024 * 1024,
        encoding: 'utf8'
      })
      if (stdout.trim() !== latest) throw new Error(`升级校验失败：期望 ${latest}，实际 ${stdout.trim() || 'unknown'}`)
      result = {
        status: 'updated',
        currentVersion: options.currentVersion,
        latestVersion: latest,
        compatibleAutoUpdate
      }
    }
  } catch (error) {
    result = {
      status: 'error',
      currentVersion: options.currentVersion,
      message: error instanceof Error ? error.message : String(error)
    }
  }
  await saveResult(path, result, now, previous).catch(() => undefined)
  return result
}

export async function runBackgroundUpdate(currentVersion: string, entryPath?: string): Promise<UpgradeResult | null> {
  const path = statePath()
  const state = await readJson<CliUpdateState>(path)
  if (!isUpdateDue(state)) return null
  return await withDirectoryLock(`${path}.lock`, async () => {
    const latestState = await readJson<CliUpdateState>(path)
    if (!isUpdateDue(latestState)) return null
    // Installs, not just checks: opt-in via SCRY_AUTO_UPDATE, bounded to the same major by
    // isCompatibleAutoUpdate, and reported afterwards through consumeUpdateNotice.
    return await upgradeCli({
      currentVersion,
      entryPath,
      allowBreaking: false,
      env: { ...process.env, SCRY_CLI_REGISTRY: DEFAULT_REGISTRY }
    })
  }, { waitMs: 100, ttlMs: 3 * 60 * 1_000 }).catch(() => null)
}

export async function scheduleBackgroundUpdate(currentVersion: string, entryPath?: string): Promise<void> {
  if (!entryPath) return
  if (!isUpdateDue(await readJson<CliUpdateState>(statePath()))) return
  const child = spawn(process.execPath, [entryPath, '__auto_update'], {
    detached: true,
    env: { ...process.env, SCRY_UPDATE_CHILD: '1', SCRY_UPDATE_CURRENT_VERSION: currentVersion },
    stdio: ['ignore', 'ignore', 'inherit'],
    windowsHide: true
  })
  child.on('error', () => undefined)
  child.unref()
}

export async function consumeUpdateNotice(env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  if ([env.SCRY_CLI_BUNDLED, env.SCRY_RECORDER_MANAGED, env.SCRY_NO_UPDATE_CHECK, env.SCRY_UPDATE_CHILD, env.CI].some(enabled)) return null
  const path = statePath(env)
  const state = await readJson<CliUpdateState>(path)
  if (!state?.updatedAt || state.notifiedAt || !state.updatedFrom || !state.updatedTo) return null
  await writeJsonAtomic(path, { ...state, notifiedAt: new Date().toISOString() }).catch(() => undefined)
  // Default-on means nobody opted in, so the one line that proves it happened also says how
  // to stop it. Disclosure rides on the install instead of a second notice with its own state.
  return `Scry CLI 已自动更新：${state.updatedFrom} → ${state.updatedTo}（关闭：SCRY_AUTO_UPDATE=0）`
}
