import { execFileSync } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { RECORDER_VERSION } from '../core/turn-recorder/store.js'
import type { ProviderId } from '../shared/provider.js'
import { resolveCommandOnPath } from './command-path'
import { sanitizeProviderEnv } from './provider-environment'

interface RecorderCliRuntimeConfig {
  resourcesPath: string
  requirePrivateCli: boolean
}

let recorderCliRuntimeConfig: RecorderCliRuntimeConfig | undefined
const verifiedRecorderCliVersions = new Set<string>()

function recorderFallbackSearchPath(env: Record<string, string>): string {
  const npmPrefix = env.npm_config_prefix ?? env.NPM_CONFIG_PREFIX
  const directories = process.platform === 'win32'
    ? [env.APPDATA ? join(env.APPDATA, 'npm') : undefined, env.PNPM_HOME, npmPrefix]
    : [
        env.PNPM_HOME,
        npmPrefix ? join(npmPrefix, 'bin') : undefined,
        join(homedir(), '.local', 'bin'),
        join(homedir(), '.npm-global', 'bin'),
        '/opt/homebrew/bin',
        '/usr/local/bin'
      ]
  return directories.filter((directory): directory is string => !!directory).join(delimiter)
}

/** Process-wide runtime source, analogous to storage configuration. */
export function configureRecorderCliRuntime(config: RecorderCliRuntimeConfig | undefined): void {
  if (config?.requirePrivateCli && !existsSync(join(config.resourcesPath, 'bin', 'scry'))) {
    throw new Error('daemon_recorder_cli_unavailable')
  }
  recorderCliRuntimeConfig = config
}

export function packagedRecorderCliPath(
  resourcesPath = recorderCliRuntimeConfig?.resourcesPath ?? (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
): string | undefined {
  if (!resourcesPath) return undefined
  const candidate = join(resourcesPath, 'bin', 'scry')
  return existsSync(candidate) ? candidate : undefined
}

export function resolveRecorderCliPath(
  env: Record<string, string>,
  trustedPath: string,
  fallbackPath: string = recorderFallbackSearchPath(env),
  bundledPath: string | undefined = packagedRecorderCliPath()
): string | undefined {
  if (Object.prototype.hasOwnProperty.call(env, 'SCRY_CLI_PATH')) return env.SCRY_CLI_PATH?.trim() ?? ''
  if (bundledPath) return bundledPath
  return resolveCommandOnPath('scry', trustedPath) ?? resolveCommandOnPath('scry', fallbackPath)
}

function recorderCliVersionKey(path: string): string {
  const file = statSync(path)
  return `${path}\0${file.dev}\0${file.ino}\0${file.size}\0${file.mtimeMs}\0${RECORDER_VERSION}`
}

export function resolveRuntimeRecorderCliPath(env: Record<string, string | undefined>, trustedPath: string): string | undefined {
  const bundledCliPath = packagedRecorderCliPath()
  if (recorderCliRuntimeConfig?.requirePrivateCli) {
    if (!bundledCliPath) throw new Error('daemon_recorder_cli_unavailable')
    return bundledCliPath
  }
  const definedEnv = Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined))
  return resolveRecorderCliPath(definedEnv, trustedPath, recorderFallbackSearchPath(definedEnv), bundledCliPath)
}

export function resolveTrustRecorderCliPath(env: NodeJS.ProcessEnv): string | undefined {
  if (recorderCliRuntimeConfig) return resolveRuntimeRecorderCliPath(env, env.PATH ?? process.env.PATH ?? '')
  return packagedRecorderCliPath() ?? env.SCRY_CLI_PATH
}

export function buildRuntimeCliEnv(
  runtimeBase: Record<string, string>,
  originalPath: string,
  options: { managedRecorder?: boolean; providerId?: ProviderId } = {}
): Record<string, string> {
  const bundledCliPath = packagedRecorderCliPath()
  const scryCliPath = resolveRuntimeRecorderCliPath(runtimeBase, originalPath)
  if (options.managedRecorder) {
    if (!scryCliPath) throw new Error(`Scry managed recorder requires scry CLI ${RECORDER_VERSION}`)
    if (scryCliPath !== bundledCliPath) {
      let verificationKey = ''
      let cached = false
      let actualVersion = ''
      try {
        verificationKey = recorderCliVersionKey(scryCliPath)
        cached = verifiedRecorderCliVersions.has(verificationKey)
        if (!cached) {
          actualVersion = execFileSync(scryCliPath, ['--version'], {
            encoding: 'utf8', timeout: 5_000, env: sanitizeProviderEnv(runtimeBase, options.providerId)
          }).trim()
        }
      } catch {
        throw new Error(`Scry managed recorder could not verify ${scryCliPath}`)
      }
      if (!cached && actualVersion !== RECORDER_VERSION) {
        throw new Error(
          `Scry managed recorder requires CLI ${RECORDER_VERSION}; ${scryCliPath} reports ${actualVersion || 'unknown'}` +
          `；重启/重建当前 Scry 构建，或把该 scry CLI 对齐到 ${RECORDER_VERSION}`
        )
      }
      if (!cached) verifiedRecorderCliVersions.add(verificationKey)
    }
  }
  return sanitizeProviderEnv({
    ...runtimeBase,
    SCRY_CLI_PATH: scryCliPath ?? '',
    ...(options.managedRecorder ? {
      SCRY_RECORDER_MANAGED: '1',
      SCRY_RECORDER_REQUIRED_VERSION: RECORDER_VERSION,
      SCRY_RECORDER_VERIFIED_VERSION: RECORDER_VERSION
    } : {}),
    PATH: runtimeBase.PATH ?? process.env.PATH ?? ''
  }, options.providerId)
}
