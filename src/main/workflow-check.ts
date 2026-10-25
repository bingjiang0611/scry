import { spawn, type ChildProcess } from 'node:child_process'
import { shellEnv } from './claude-locate'
import type { WorkflowCheckRequest, WorkflowCheckResult, WorkflowFrozenCheck } from '../shared/workflow-check'
import { workflowCheckCopy as copy } from '../shared/constants/copy'
import { assertWorkflowCheckUnchanged, cleanWorkflowCheckEnvironment as cleanEnvironment } from './workflow-check-command'
import { workflowCheckProcessIdentity as identity, workflowCheckGroupEmpty as groupEmpty } from './workflow-check-process'

export { bindWorkflowCheck, freezeWorkflowCheck, validateWorkflowCheck, validateWorkflowFrozenCheck } from './workflow-check-command'

const OUTPUT_BYTES = 1024 * 1024

export function workflowCheckDiagnostics(parser: WorkflowCheckRequest['parser'], stdout: string, stderr: string, truncated: boolean, exitCode?: number | null): WorkflowCheckResult['diagnostics'] {
  if (truncated) return { state: 'unavailable', reason: copy.truncated }
  if (parser === 'exit_code') return { state: 'unavailable', reason: copy.noParser }
  const lines = (stdout + '\n' + stderr).split('\n'), items: Array<{ file: string; line: number; column: number; code: string; message: string }> = []
  const pattern = /^(.+)\((\d+),(\d+)\): error (TS\d+): (.+)$/
  for (const line of lines) {
    if (!line.trim()) continue
    const match = pattern.exec(line)
    if (!match) return { state: 'unavailable', reason: copy.parser }
    items.push({ file: match[1].replaceAll('\\', '/'), line: Number(match[2]), column: Number(match[3]), code: match[4], message: match[5] })
  }
  if (!items.length && exitCode !== 0) return { state: 'unavailable', reason: copy.parser }
  return { state: 'available', source: 'derived', items }
}

export interface WorkflowCheckExecution {
  result: Promise<WorkflowCheckResult>
  /** Resolves only for proven closure of the owned process group. */
  settled: Promise<void>
  /** Acknowledges the cancellation latch, not physical convergence. */
  stop(): boolean
}

/** Called only after the canonical Runner durably admits a SystemStep intent. */
export function executeWorkflowCheck(check: WorkflowFrozenCheck, environment = shellEnv()): WorkflowCheckExecution {
  let cancelled = false, timedOut = false, child: ChildProcess | undefined, processIdentity: string | undefined
  let closeScope!: () => void
  const settled = new Promise<void>(resolveScope => { closeScope = resolveScope })
  let requestStop = (): void => {}
  const stop = async (): Promise<boolean> => {
    if (!child?.pid || child.exitCode !== null || child.signalCode !== null || !processIdentity) return false
    if (await identity(child.pid) !== processIdentity) return false
    try { process.kill(-child.pid, 'SIGKILL'); return true } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
      return false
    }
  }
  const result = (async (): Promise<WorkflowCheckResult> => {
    const startedAt = Date.now(), env = cleanEnvironment(environment)
    const base = { startedAt, finishedAt: startedAt, exitCode: null, signal: null, settled: true, stdout: '', stderr: '', truncated: false, evidence: 'exact' as const, diagnostics: { state: 'unavailable' as const, reason: copy.noParser } }
    try {
      if (process.platform === 'win32') throw new Error(copy.platform)
      await assertWorkflowCheckUnchanged(check, env)
    } catch (error) { closeScope(); return { ...base, state: 'rejected', finishedAt: Date.now(), error: String(error) } }
    if (cancelled) { closeScope(); return { ...base, state: 'cancelled', finishedAt: Date.now(), error: copy.stopped } }
    return new Promise<WorkflowCheckResult>(resolveResult => {
      child = spawn(check.launch.executable, [...check.launch.args, ...check.argv.slice(1)], { cwd: check.workingDirectory, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'], shell: false })
      let stdout: Buffer = Buffer.alloc(0), stderr: Buffer = Buffer.alloc(0)
      let truncated = false, spawnError: Error | undefined, stopError: string | undefined
      let identityReady = false, published = false
      const publishUnknown = (error: string): void => {
        if (published) return
        published = true
        clearTimeout(timer)
        resolveResult({ ...base, state: 'unknown', settled: false, finishedAt: Date.now(), stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8'), truncated: true, diagnostics: { state: 'unavailable', reason: copy.scope }, error })
      }
      requestStop = (): void => { void stop().then(async signalled => {
        if (!signalled && identityReady) {
          if (child!.pid && await groupEmpty(child!.pid)) closeScope()
          publishUnknown(stopError ?? copy.scope)
          child!.stdout!.destroy()
          child!.stderr!.destroy()
        }
      }).catch(error => { stopError = String(error); publishUnknown(stopError) }) }
      const timer = setTimeout(() => { timedOut = true; requestStop() }, check.timeoutMs)
      const append = (old: Buffer, chunk: Buffer): Buffer => {
        const remaining = Math.max(0, OUTPUT_BYTES - old.length)
        if (chunk.length > remaining) truncated = true
        return remaining ? Buffer.concat([old, chunk.subarray(0, remaining)]) : old
      }
      child.stdout!.on('data', (chunk: Buffer) => { stdout = append(stdout, chunk) })
      child.stderr!.on('data', (chunk: Buffer) => { stderr = append(stderr, chunk) })
      child.on('error', error => { spawnError = error })
      child.on('spawn', () => { void (async () => {
        try { processIdentity = await identity(child!.pid!) } finally { identityReady = true }
        if (cancelled || timedOut) requestStop()
      })().catch(error => { stopError = String(error); if (cancelled || timedOut) requestStop() }) })
      child.on('close', () => { void (async () => {
        clearTimeout(timer)
        const closed = !child!.pid || await groupEmpty(child!.pid)
        if (closed) closeScope()
        const output = stdout.toString('utf8'), errors = stderr.toString('utf8')
        if (published) return
        published = true
        const diagnostics = workflowCheckDiagnostics(check.parser, output, errors, truncated, child!.exitCode)
        const diagnosticFailure = diagnostics.state === 'available' && diagnostics.items.length > 0
        const state = !closed ? 'unknown' : spawnError ? 'failed' : timedOut ? 'timed_out' : cancelled ? 'cancelled' : child!.exitCode === 0 && !truncated && !diagnosticFailure ? 'passed' : 'failed'
        resolveResult({ ...base, state, finishedAt: Date.now(), exitCode: child!.exitCode, signal: child!.signalCode, settled: closed, stdout: output, stderr: errors, truncated,
          diagnostics,
          ...(!closed || spawnError || timedOut || cancelled || stopError ? { error: !closed ? copy.scope : spawnError ? String(spawnError) : stopError ?? (timedOut ? copy.timedOut : copy.stopped) } : {}) })
      })().catch(error => resolveResult({ ...base, state: 'unknown', settled: false, finishedAt: Date.now(), error: String(error) })) })
    })
  })()
  return { result, settled, stop: () => { cancelled = true; requestStop(); return true } }
}
