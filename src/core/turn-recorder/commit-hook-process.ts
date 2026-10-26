import { spawn } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { UPLOAD_ENV_KEYS } from './commit-environment.js'
import type { RecordCommittedNotification } from './store-notifications.js'


const COMMIT_HOOK_TIMEOUT_MS = 10_000
const COMMIT_HOOK_KILL_GRACE_MS = 1_000
const COMMIT_HOOK_ENV_KEYS = [
  'HOME', 'PATH', 'SHELL', 'TMPDIR', 'TMP', 'TEMP',
  'LANG', 'LC_ALL', 'LC_CTYPE', 'PYTHONDONTWRITEBYTECODE',
  'CLAUDE_PROJECT_DIR', 'CODEX_PROJECT_DIR', 'QODER_PROJECT_DIR',
  'OPENCODE_PROJECT_DIR', 'OPENCODE_WORKSPACE_DIR',
  'SCRY_CLI_PATH', 'SCRY_PROVIDER_ID', 'SCRY_RECORDER_MANAGED',
  'SCRY_RECORDER_REQUIRED_VERSION', 'SCRY_RECORDER_VERIFIED_VERSION',
  'SCRY_RECORDER_COMMIT_HOOK', 'SCRY_RECORDER_COMMIT_HOOK_FINGERPRINT', 'SCRY_RECORDER_ENABLED',
  ...UPLOAD_ENV_KEYS,
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME'
] as const

export async function configuredCommitHook(env: NodeJS.ProcessEnv): Promise<string | null> {
  const path = env.SCRY_RECORDER_COMMIT_HOOK?.trim()
  if (!path) return null
  if (!isAbsolute(path)) throw new Error('SCRY_RECORDER_COMMIT_HOOK must be an absolute executable path')
  const info = await stat(path)
  if (!info.isFile() || (info.mode & 0o111) === 0) {
    throw new Error('SCRY_RECORDER_COMMIT_HOOK must be an absolute executable path')
  }
  return path
}

export function configuredCommitHookFingerprint(env: NodeJS.ProcessEnv): string {
  const fingerprint = env.SCRY_RECORDER_COMMIT_HOOK_FINGERPRINT?.trim()
  return fingerprint || 'explicit-environment-v1'
}

export type CommitHookResult =
  | { acknowledged: true }
  | {
    acknowledged: false
    reason: 'spawn_error' | 'timeout' | 'stdin_error' | 'signal' | 'exit'
    exitCode?: number | null
    signal?: NodeJS.Signals | null
    errorCode?: string
  }

export async function invokeCommitHook(
  path: string,
  notification: RecordCommittedNotification,
  env: NodeJS.ProcessEnv
): Promise<CommitHookResult> {
  return new Promise((resolvePromise) => {
    const childEnv: NodeJS.ProcessEnv = {}
    for (const key of COMMIT_HOOK_ENV_KEYS) if (env[key] !== undefined) childEnv[key] = env[key]
    const child = spawn(path, [], { env: childEnv, stdio: ['pipe', 'ignore', 'ignore'] })
    let settled = false
    let timedOut = false
    let inputFailed = false
    let inputErrorCode: string | undefined
    let terminationRequested = false
    let killTimer: NodeJS.Timeout | undefined
    const settle = (result: CommitHookResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (killTimer) clearTimeout(killTimer)
      resolvePromise(result)
    }
    const terminate = (): void => {
      if (settled || terminationRequested) return
      terminationRequested = true
      child.kill('SIGTERM')
      killTimer = setTimeout(() => {
        if (child.exitCode == null && child.signalCode == null) child.kill('SIGKILL')
      }, COMMIT_HOOK_KILL_GRACE_MS)
      killTimer.unref()
    }
    const timer = setTimeout(() => {
      timedOut = true
      terminate()
    }, COMMIT_HOOK_TIMEOUT_MS)
    timer.unref()
    child.once('error', (error: NodeJS.ErrnoException) => settle({
      acknowledged: false, reason: 'spawn_error', errorCode: error.code
    }))
    child.once('exit', (code, signal) => {
      if (!timedOut && !inputFailed && code === 0) {
        settle({ acknowledged: true })
      } else {
        settle({
          acknowledged: false,
          reason: timedOut ? 'timeout' : inputFailed ? 'stdin_error' : signal ? 'signal' : 'exit',
          exitCode: code,
          signal,
          ...(inputFailed ? { errorCode: inputErrorCode } : {})
        })
      }
    })
    child.stdin.on('error', (error: NodeJS.ErrnoException) => {
      inputFailed = true
      inputErrorCode = error.code
      terminate()
    })
    child.stdin.end(`${JSON.stringify(notification)}\n`)
  })
}
