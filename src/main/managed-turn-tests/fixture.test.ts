import { createHash } from 'node:crypto'
import { rm, mkdtemp, writeFile, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach } from 'vitest'
import { type TraceEvent } from '../../shared/trace'
import { aggregateTurnEvidence } from '../../core/turn-recorder/aggregate'
import { handleRecorderHook } from '../../core/turn-recorder/recorder'
import { stableHash } from '../../core/turn-recorder/store'
import { type ManagedTraceTurnCommitInput, canonicalTurnTiming } from '../managed-turn-commit'


const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

export async function fixture(): Promise<{ workspace: string; userDataDir: string }> {
  const workspace = await mkdtemp(join(tmpdir(), 'scry-managed-main-workspace-'))
  const userDataDir = await mkdtemp(join(tmpdir(), 'scry-managed-main-user-data-'))
  roots.push(workspace, userDataDir)
  await writeFile(join(workspace, 'scry.config.json'), JSON.stringify({
    schemaVersion: 1,
    enabled: true,
    workspaceId: 'managed-main-fixture',
    dataDir: '.scry',
    repositories: { mode: 'workspace-only' },
    capture: { prompt: true, assistant: true, toolOutput: 'summary', diff: true, hooks: true }
  }))
  return { workspace, userDataDir }
}

export function input(workspace: string, userDataDir: string): ManagedTraceTurnCommitInput {
  const events: TraceEvent[] = [
    {
      id: 'assistant',
      ts: '2026-07-29T12:00:05.000Z',
      runId: 'run-1',
      kind: 'model',
      stage: 'text_delta',
      text: '准确输出'
    },
    {
      id: 'response',
      ts: '2026-07-29T12:00:05.500Z',
      runId: 'run-1',
      kind: 'model',
      stage: 'response_completed',
      messageId: 'response-1',
      durationMs: 5_500,
      runtimeMetadata: {
        timingSource: 'observed',
        timingBoundary: 'turn_or_activity_end'
      }
    },
    {
      id: 'result',
      ts: '2026-07-29T12:00:10.000Z',
      runId: 'run-1',
      kind: 'harness',
      stage: 'result',
      durationMs: 10_000,
      tokensIn: 10,
      tokensOut: 3
    }
  ]
  const timing = canonicalTurnTiming(events)
  if (!timing) throw new Error('fixture timing missing')
  const evidence = aggregateTurnEvidence({
    userText: '/rate-workflow 1',
    events,
    source: 'scry_provider_adapter'
  })
  return {
    userDataDir,
    cwd: workspace,
    sessionId: 'session-1',
    providerTurnId: 'turn-1',
    providerId: 'codex',
    runtimeProvider: 'codex_cli',
    timing,
    status: 'completed',
    turn: {
      runId: 'run-1',
      providerTurnId: 'turn-1',
      userText: '/rate-workflow 1',
      items: events,
      turnEvidence: evidence,
      done: true,
      status: 'completed',
      ...timing,
      ts: Date.parse(timing.completedAt)
    }
  }
}

export function withCapturedDiff(request: ManagedTraceTurnCommitInput): ManagedTraceTurnCommitInput {
  const diff: TraceEvent = {
    id: 'diff',
    ts: request.timing.completedAt,
    runId: request.turn.runId,
    kind: 'harness',
    stage: 'turn_diff',
    turnDiff: {
      version: 1,
      beforeAt: request.timing.startedAt,
      afterAt: request.timing.completedAt,
      captureMs: 1,
      status: 'captured',
      cleanup: 'ok',
      files: []
    }
  }
  const items = [...request.turn.items, diff]
  return {
    ...request,
    turn: {
      ...request.turn,
      items,
      turnEvidence: aggregateTurnEvidence({
        userText: request.turn.userText,
        events: items,
        source: 'scry_provider_adapter'
      })
    }
  }
}

export function asClaude(request: ManagedTraceTurnCommitInput): ManagedTraceTurnCommitInput {
  return {
    ...request,
    providerId: 'claude',
    runtimeProvider: 'claude_sdk'
  }
}

export function asOpenCode(request: ManagedTraceTurnCommitInput): ManagedTraceTurnCommitInput {
  return {
    ...request,
    providerId: 'opencode',
    runtimeProvider: 'opencode_server'
  }
}

export async function startManagedOpenCode(workspace: string, runId = 'run-1'): Promise<void> {
  await handleRecorderHook({
    provider: 'opencode',
    event: 'chat.message',
    workspace,
    managed: true,
    payload: {
      session_id: 'session-1',
      prompt: '/expanded project command body',
      timestamp: '2026-07-29T12:00:00.000Z'
    },
    env: {
      ...process.env,
      SCRY_MANAGED_RUN_ID: runId,
      SCRY_MANAGED_PROMPT_HASH: createHash('sha256').update('/rate-workflow 1').digest('hex')
    }
  })
}

export async function startManaged(workspace: string, provider: 'claude' | 'codex' = 'codex'): Promise<void> {
  await handleRecorderHook({
    provider,
    event: 'UserPromptSubmit',
    workspace,
    managed: true,
    payload: {
      session_id: 'session-1',
      turn_id: 'turn-1',
      // app-server 会把显式 skill 结构化；hook prompt 不一定保留原始 slash command。
      prompt: '1',
      timestamp: '2026-07-29T12:00:00.000Z'
    }
  })
}

// 通知投递在 App 侧是脱钩的（轮次收口不等仓库回调），所以断言“最终投递到”而不是“同步投递到”。
export async function notificationLine(capture: string, workspace: string, fingerprint: string, timeoutMs = 5_000): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const text = await readFile(capture, 'utf8')
      if (text.includes('\n')) {
        const notification = JSON.parse(text.split('\n')[0]!) as Record<string, unknown>
        const receipt = JSON.parse(await readFile(join(workspace, '.scry', 'notifications', 'commit-hooks', `${stableHash(fingerprint)}.json`), 'utf8')) as { ackedThrough?: number }
        // Callback output precedes receipt/lock cleanup. Deleting the fixture at output
        // time races the detached drain and can intermittently fail with ENOTEMPTY.
        if (receipt.ackedThrough === notification.sequence && !existsSync(join(workspace, '.scry', 'locks', 'commit-notification.lock'))) return notification
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    if (Date.now() >= deadline) throw new Error(`commit notification did not settle: ${capture}`)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

  export const disabledCaptureConfig = (enabled: boolean, toolOutput: 'summary' | 'full') => JSON.stringify({
    schemaVersion: 1,
    enabled,
    workspaceId: 'managed-main-fixture',
    dataDir: '.scry',
    repositories: { mode: 'workspace-only' },
    capture: { prompt: true, assistant: true, toolOutput, diff: true, hooks: true }
  })