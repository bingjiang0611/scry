import { readdir, stat, readFile, rm, mkdtemp, writeFile, chmod } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, vi, it, expect } from 'vitest'
import { handleRecorderHook } from '../recorder'
import { stableHash, listRecords } from '../store'


export const roots: string[] = []
export const pexecFile = promisify(execFile)

export function commitAckPath(root: string, fingerprint = 'explicit-environment-v1'): string {
  return join(root, '.scry', 'notifications', 'commit-hooks', `${stableHash(fingerprint)}.json`)
}

interface EarlyStopDiagnostic {
  root?: string
  currentPhase: string
  phaseStartedAtMs: number
  phases: Array<{ name: string; durationMs: number; outcome: 'passed' | 'failed' }>
}

let activeEarlyStopDiagnostic: EarlyStopDiagnostic | undefined

function monotonicMs(): number {
  return Number(process.hrtime.bigint()) / 1e6
}

async function earlyStopPhase<T>(diagnostic: EarlyStopDiagnostic, name: string, action: () => Promise<T>): Promise<T> {
  diagnostic.currentPhase = name
  diagnostic.phaseStartedAtMs = monotonicMs()
  try {
    const result = await action()
    diagnostic.phases.push({ name, durationMs: Math.round(monotonicMs() - diagnostic.phaseStartedAtMs), outcome: 'passed' })
    return result
  } catch (error) {
    diagnostic.phases.push({ name, durationMs: Math.round(monotonicMs() - diagnostic.phaseStartedAtMs), outcome: 'failed' })
    throw error
  }
}

async function earlyStopLockOwners(root: string): Promise<{ entries: unknown[]; truncated: boolean }> {
  const locks = join(root, '.scry', 'locks')
  const queue: Array<{ path: string; depth: number }> = [{ path: locks, depth: 0 }]
  const found: unknown[] = []
  let visited = 0
  let truncated = false
  while (queue.length > 0 && visited < 64) {
    const current = queue.shift()!
    let entries
    try { entries = await readdir(current.path, { withFileTypes: true }) } catch (error) {
      found.push({ path: current.path.slice(root.length + 1), state: 'unavailable', error: String(error) })
      continue
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (visited++ >= 64) break
      if (!entry.isDirectory()) continue
      const lockPath = join(current.path, entry.name)
      const ownerPath = join(lockPath, 'owner.json')
      try {
        const info = await stat(ownerPath)
        if (info.size > 4_096) {
          found.push({ path: lockPath.slice(root.length + 1), owner: 'metadata exceeds diagnostic bound' })
        } else {
          const parsed = JSON.parse(await readFile(ownerPath, 'utf8')) as Record<string, unknown>
          found.push({
            path: lockPath.slice(root.length + 1),
            owner: {
              ...(typeof parsed.pid === 'number' ? { pid: parsed.pid } : {}),
              ...(typeof parsed.createdAt === 'number' ? { createdAt: parsed.createdAt } : {}),
              ...(typeof parsed.token === 'string' ? { token: parsed.token } : {})
            }
          })
        }
      } catch (error) {
        // Missing or changing owner metadata is not evidence that no lock exists.
        found.push({ path: lockPath.slice(root.length + 1), state: 'unavailable', error: String(error) })
      }
      if (current.depth < 4) queue.push({ path: lockPath, depth: current.depth + 1 })
      else truncated = true
    }
  }
  return { entries: found, truncated: truncated || queue.length > 0 || visited >= 64 }
}

async function reportEarlyStopDiagnostic(diagnostic: EarlyStopDiagnostic): Promise<void> {
  // The timed-out async test can still advance while lock metadata is read.
  const snapshot = {
    currentPhase: diagnostic.currentPhase,
    currentPhaseElapsedMs: Math.round(monotonicMs() - diagnostic.phaseStartedAtMs),
    phases: diagnostic.phases.map(phase => ({ ...phase }))
  }
  const locks = diagnostic.root
    ? await earlyStopLockOwners(diagnostic.root)
    : { state: 'unavailable', reason: 'workspace initialization has not returned' }
  console.error('SCRY_EARLY_STOP_DIAGNOSTIC', JSON.stringify({ ...snapshot, locks }))
}

afterEach(async () => {
  const diagnostic = activeEarlyStopDiagnostic
  activeEarlyStopDiagnostic = undefined
  if (diagnostic) await reportEarlyStopDiagnostic(diagnostic)
  vi.unstubAllEnvs()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

export async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'scry-recorder-test-'))
  roots.push(root)
  await writeFile(join(root, 'scry.config.json'), JSON.stringify({
    schemaVersion: 1,
    enabled: true,
    workspaceId: 'fixture',
    dataDir: '.scry',
    repositories: { mode: 'workspace-only' },
    capture: { prompt: true, assistant: true, toolOutput: 'summary', diff: false, hooks: true }
  }))
  return root
}

export async function commitHook(root: string, exitCode = 0): Promise<{ path: string; capture: string }> {
  const path = join(root, 'commit-hook.sh')
  const capture = join(root, 'commit-hook.jsonl')
  await writeFile(path, `#!/bin/sh\ncat >> ${JSON.stringify(capture)}\nexit ${exitCode}\n`)
  await chmod(path, 0o700)
  return { path, capture }
}

export const payload = (sessionId: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  session_id: sessionId,
  timestamp: '2026-07-19T12:00:00.000Z',
  ...extra
})

export async function completeTurn(root: string, sessionId: string, prompt = 'implement feature'): Promise<void> {
  await handleRecorderHook({ provider: 'claude', event: 'UserPromptSubmit', workspace: root, payload: payload(sessionId, { prompt }) })
  await handleRecorderHook({
    provider: 'claude',
    event: 'PreToolUse:Bash',
    workspace: root,
    payload: payload(sessionId, { tool_name: 'Bash', tool_use_id: `${sessionId}-tool`, tool_input: { command: 'printf ok' } })
  })
  await handleRecorderHook({
    provider: 'claude',
    event: 'PostToolUse:Bash',
    workspace: root,
    payload: payload(sessionId, { tool_name: 'Bash', tool_use_id: `${sessionId}-tool`, tool_response: 'ok' })
  })
  await handleRecorderHook({ provider: 'claude', event: 'Stop', workspace: root, payload: payload(sessionId, { timestamp: '2026-07-19T12:00:01.000Z' }) })
}
export function registerEarlyStopCase(): void {


  it('真实 Stop 早于 task_complete 时按完整 rollout 去重，且 Skill 路径引用不算执行', async () => {
    const diagnostic: EarlyStopDiagnostic = {
      currentPhase: 'workspace/init',
      phaseStartedAtMs: monotonicMs(),
      phases: []
    }
    activeEarlyStopDiagnostic = diagnostic
    const root = await earlyStopPhase(diagnostic, 'workspace/init', workspace)
    diagnostic.root = root
    const rollout = join(root, 'early-stop-rollout.jsonl')
    const lines = [
      { timestamp: '2026-07-19T12:00:00.000Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'early-turn' } },
      { timestamp: '2026-07-19T12:00:00.010Z', type: 'event_msg', payload: { type: 'user_message', message: 'inspect' } },
      {
        timestamp: '2026-07-19T12:00:00.100Z',
        type: 'response_item',
        payload: {
          type: 'custom_tool_call',
          name: 'exec',
          call_id: 'call_exec',
          input: `const calls = [
  ["mcporter call workitem.query --args '{}'", "mcp"],
  ["sed -n '1,20p' /opt/codex/plugins/chrome/skills/control-chrome/SKILL.md", "skill"]
];
const rs = await Promise.all(calls.map(([cmd]) => tools.exec_command({ cmd })));
rs.forEach((r, i) => text(\`RESULT \${i + 1}\\n\${JSON.stringify(r)}\`));`
        }
      },
      {
        timestamp: '2026-07-19T12:00:00.200Z',
        type: 'response_item',
        payload: {
          type: 'custom_tool_call_output',
          call_id: 'call_exec',
          output: [
            { type: 'input_text', text: 'RESULT 1\n{"exit_code":0,"output":"ok"}' },
            { type: 'input_text', text: 'RESULT 2\n{"exit_code":2,"output":"missing"}' }
          ]
        }
      },
      {
        timestamp: '2026-07-19T12:00:00.300Z',
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'js',
          namespace: 'mcp__node_repl',
          call_id: 'call_js',
          arguments: '{"code":"nodeRepl.write(true)"}'
        }
      },
      {
        timestamp: '2026-07-19T12:00:00.400Z',
        type: 'response_item',
        payload: { type: 'function_call_output', call_id: 'call_js', output: 'true' }
      },
      {
        timestamp: '2026-07-19T12:00:00.500Z',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: {
              input_tokens: 250,
              cached_input_tokens: 200,
              cache_write_input_tokens: 0,
              output_tokens: 25,
              reasoning_output_tokens: 5
            },
            last_token_usage: {
              input_tokens: 250,
              cached_input_tokens: 200,
              cache_write_input_tokens: 0,
              output_tokens: 25,
              reasoning_output_tokens: 5
            }
          }
        }
      }
    ]
    await earlyStopPhase(diagnostic, 'rollout write', async () => {
      await writeFile(rollout, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`)
    })

    await earlyStopPhase(diagnostic, 'start hook', () => handleRecorderHook({
      provider: 'codex',
      event: 'turn.started',
      workspace: root,
      payload: payload('early-session', { prompt: 'inspect', turn_id: 'early-turn', rollout_path: rollout })
    }))
    for (const [index, timestamp] of ['2026-07-19T12:00:00.110Z', '2026-07-19T12:00:00.120Z', '2026-07-19T12:00:00.310Z'].entries()) {
      await earlyStopPhase(diagnostic, `pre hook ${index + 1}`, () => handleRecorderHook({
        provider: 'codex',
        event: 'PreToolUse:Bash',
        workspace: root,
        payload: payload('early-session', {
          timestamp,
          turn_id: 'early-turn',
          tool_name: 'Bash',
          tool_use_id: `exec-${index + 1}`,
          tool_input: {}
        })
      }))
      await earlyStopPhase(diagnostic, `post hook ${index + 1}`, () => handleRecorderHook({
        provider: 'codex',
        event: 'PostToolUse:Bash',
        workspace: root,
        payload: payload('early-session', {
          timestamp,
          turn_id: 'early-turn',
          tool_name: 'Bash',
          tool_use_id: `exec-${index + 1}`,
          tool_response: 'ok'
        })
      }))
    }
    await earlyStopPhase(diagnostic, 'completed hook', () => handleRecorderHook({
      provider: 'codex',
      event: 'turn/completed',
      workspace: root,
      payload: payload('early-session', {
        turn_id: 'early-turn',
        rollout_path: rollout,
        timestamp: '2026-07-19T12:00:00.600Z'
      })
    }))

    const [record] = await earlyStopPhase(diagnostic, 'final records', () => listRecords(join(root, '.scry')))
    diagnostic.currentPhase = 'final assertions'
    diagnostic.phaseStartedAtMs = monotonicMs()
    expect(record.tools.value).toEqual([
      expect.objectContaining({ name: 'Bash', status: 'failed' })
    ])
    expect(record.mcps.value).toEqual([
      expect.objectContaining({ mcp: expect.objectContaining({ server: 'workitem', action: 'query' }) }),
      expect.objectContaining({ mcp: expect.objectContaining({ server: 'node_repl', action: 'js' }) })
    ])
    expect(record.skills.value).toEqual([])
    expect(record.errors.value).toHaveLength(1)
    expect(record.usage.value).toMatchObject({
      inputTokens: 250,
      outputTokens: 25,
      cacheReadTokens: 200,
      reasoningTokens: 5
    })
    activeEarlyStopDiagnostic = undefined
  })
}
