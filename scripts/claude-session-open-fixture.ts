// Offline Claude history fixture for the real-App measurements (claude-session-open-bench.mjs,
// claude-history-acceptance.mjs). A Claude session is a transcript JSONL in the Provider's
// directory plus the segmented archive the recorder writes, so the fixture writes both through
// production code: transcriptPath decides where the Provider file lives, and
// upsertTraceArchiveTurnAsync writes segments, sidecars and index stamps exactly as capture does.
// History reads must page over this, not over a hand-built archive.
//
//   vite-node scripts/claude-session-open-fixture.ts <spec.json>
//
// The last stdout line is `SCRY_CLAUDE_FIXTURE=<json>` with the facts a driver asserts on.
import { mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { join } from 'node:path'
import { transcriptPath, upsertTraceArchiveTurnAsync } from '../src/main/transcript-archive'
import type { TraceEvent } from '../src/shared/trace'

export interface ClaudeFixtureSessionSpec {
  sessionId: string
  turns: number
  toolsPerTurn: number
  outputBytes: number
  /** Writes this turn index twice: first keyed by runId (no providerTurnId), then keyed by
   *  providerTurnId. Both segments carry the same runId — the case an archive index cannot
   *  describe, so history must fall back to the complete read. */
  duplicateRunIdTurn?: number
}

export interface ClaudeFixtureSpec {
  userDataDir: string
  home: string
  cwd: string
  sessions: ClaudeFixtureSessionSpec[]
}

const BASE = 1_700_000_000_000
const iso = (ms: number): string => new Date(ms).toISOString()

function toolOutput(sessionId: string, turn: number, tool: number, bytes: number): string {
  const head = `${sessionId} turn ${turn} tool ${tool}: `
  if (head.length >= bytes) return head.slice(0, bytes)
  return head + 'x'.repeat(bytes - head.length)
}

function turnContent(spec: ClaudeFixtureSessionSpec, cwd: string, turn: number) {
  const sessionId = spec.sessionId
  const userText = `${sessionId} prompt ${turn}`
  const runId = `${sessionId}-run-${turn}`
  const at = BASE + turn * 1000
  const identity = { sessionId, cwd }
  // Provider transcript lines. Every line repeats cwd/sessionId because the identity check
  // rejects a file whose lines disagree.
  const lines: string[] = [JSON.stringify({
    type: 'user', ...identity, uuid: `${sessionId}-u-${turn}`,
    message: { role: 'user', content: [{ type: 'text', text: userText }] }
  })]
  const items: TraceEvent[] = []
  for (let tool = 0; tool < spec.toolsPerTurn; tool++) {
    const toolUseId = `${runId}-tool-${tool}`
    const command = `echo ${sessionId}-${turn}-${tool}`
    const output = toolOutput(sessionId, turn, tool, spec.outputBytes)
    items.push(
      { id: `${toolUseId}-call`, runId, ts: iso(at + tool * 2), kind: 'tool', stage: 'tool_call', tool: 'Bash', toolUseId, input: { command } },
      { id: `${toolUseId}-result`, runId, ts: iso(at + tool * 2 + 1), kind: 'tool', stage: 'tool_result', tool: 'Bash', toolUseId, output }
    )
    lines.push(
      JSON.stringify({
        type: 'assistant', ...identity, uuid: `${toolUseId}-a`,
        message: { role: 'assistant', content: [{ type: 'tool_use', id: toolUseId, name: 'Bash', input: { command } }], stop_reason: null }
      }),
      JSON.stringify({
        type: 'user', ...identity, uuid: `${toolUseId}-r`,
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: output }] }
      })
    )
  }
  const finalText = `END ${sessionId} ${turn}`
  items.push({ id: `${runId}-text`, runId, ts: iso(at + spec.toolsPerTurn * 2), kind: 'model', stage: 'text', text: finalText })
  lines.push(JSON.stringify({
    type: 'assistant', ...identity, uuid: `${runId}-final`,
    message: { role: 'assistant', content: [{ type: 'text', text: finalText }], stop_reason: 'end_turn' }
  }))
  return { userText, runId, at, items, lines, finalText }
}

export async function writeClaudeFixture(spec: ClaudeFixtureSpec) {
  for (const dir of [spec.userDataDir, spec.home, spec.cwd]) mkdirSync(dir, { recursive: true })
  // The App resolves the workspace (and /tmp on macOS) before hashing the archive layout, so the
  // fixture must write under the same canonical path or the session looks unarchived.
  const cwd = realpathSync(spec.cwd)
  const home = realpathSync(spec.home)
  const userDataDir = realpathSync(spec.userDataDir)
  const args = { userDataDir, cwd, providerId: 'claude' as const }
  const catalog: Record<string, unknown>[] = []
  const report: Record<string, unknown>[] = []
  for (const session of spec.sessions) {
    const lines: string[] = []
    let last = { runId: '', finalText: '', ts: BASE }
    for (let turnIndex = 0; turnIndex < session.turns; turnIndex++) {
      const providerTurnId = `${session.sessionId}-pt-${turnIndex}`
      const content = turnContent(session, cwd, turnIndex)
      lines.push(...content.lines)
      const record = { runId: content.runId, userText: content.userText, items: content.items, done: true, ts: content.at }
      if (session.duplicateRunIdTurn === turnIndex) {
        // Keyed by runId: no providerTurnId on this copy of the turn.
        if (!await upsertTraceArchiveTurnAsync({ ...args, sessionId: session.sessionId, turn: record })) {
          throw new Error(`archive write failed for ${content.runId} (runId keyed)`)
        }
      }
      if (!await upsertTraceArchiveTurnAsync({
        ...args, sessionId: session.sessionId, turn: { ...record, providerTurnId }
      })) throw new Error(`archive write failed for ${content.runId}`)
      last = { runId: content.runId, finalText: content.finalText, ts: content.at }
    }
    const path = transcriptPath(cwd, session.sessionId, home)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `${lines.join('\n')}\n`)
    catalog.push({
      sessionId: session.sessionId, externalSessionId: session.sessionId, runId: last.runId,
      providerId: 'claude', runtimeProvider: 'claude_sdk', cwd,
      preview: session.sessionId, ts: last.ts
    })
    report.push({
      sessionId: session.sessionId, turns: session.turns, toolsPerTurn: session.toolsPerTurn,
      outputBytes: session.outputBytes, duplicateRunIdTurn: session.duplicateRunIdTurn ?? null,
      lastRunId: last.runId, lastTurnText: last.finalText, transcriptBytes: statSync(path).size
    })
  }
  writeFileSync(join(userDataDir, 'app-sessions.json'), JSON.stringify(catalog))
  return report
}

const specPath = process.argv[2]
if (specPath) {
  const spec = JSON.parse(readFileSync(specPath, 'utf8')) as ClaudeFixtureSpec
  const report = await writeClaudeFixture(spec)
  console.log(`SCRY_CLAUDE_FIXTURE=${JSON.stringify({
    spec: { ...spec, userDataDir: realpathSync(spec.userDataDir), home: realpathSync(spec.home), cwd: realpathSync(spec.cwd) },
    sessions: report
  })}`)
}
