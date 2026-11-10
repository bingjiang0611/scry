#!/usr/bin/env node
// Replay an archived workflow turn in the real App, without any Provider.
//
// The fixture holds the native Claude Code messages of one run (a sanitized excerpt of a
// real provider-event-log thread). This script normalizes them with the production
// normalizer, writes one archived turn into a temporary userData, and runs the App smoke
// `--dev-workflow-only`, which asserts phases, agents and terminal states row by row.
//
//   node scripts/workflow-archive-smoke.mjs --fixture src/main/workflow-wire-fixtures/<name>.json
//   SCRY_WORKFLOW_ARCHIVE_SCREENSHOT=<dir> renders PNGs of the same run.

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadWorkflowModules } from './workflow-wire-modules.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const args = process.argv.slice(2)
const flag = (name) => { const index = args.indexOf(name); return index === -1 ? undefined : args[index + 1] }
const fixturePath = flag('--fixture')
if (fixturePath && !existsSync(fixturePath)) throw new Error(`fixture not found: ${fixturePath}`)
const { normalizeSdkMessage, workflowFixtureMessages } = await loadWorkflowModules()
const fixture = fixturePath ? JSON.parse(readFileSync(fixturePath, 'utf8')) : null
// No fixture: replay the shared synthetic one, so the smoke runs without extra files.
const messages = fixture ? (Array.isArray(fixture) ? fixture : fixture.messages) : workflowFixtureMessages()
if (!Array.isArray(messages) || messages.length === 0) throw new Error('fixture must contain native messages')

const temp = mkdtempSync(join(tmpdir(), 'scry-workflow-archive-'))
// The App resolves the session cwd through realpath, so the archive must store the same
// canonical path or its identity check rejects the turn.
mkdirSync(join(temp, 'workspace'), { recursive: true })
const workspace = realpathSync(join(temp, 'workspace'))
writeFileSync(join(workspace, 'a.txt'), 'alpha\n')

let counter = 0
const items = []
const ctx = { runId: 'run-archive-workflow', newId: () => `archive-ev-${counter++}`, now: () => '2026-11-10T00:00:00.000Z' }
for (const message of messages) {
  if (!['system', 'assistant', 'user', 'attachment'].includes(message?.type)) continue
  items.push(...normalizeSdkMessage(message, ctx))
}
const workflowEvents = items.filter((event) => event.stage === 'workflow_activity')
if (workflowEvents.length === 0) throw new Error('the fixture produced no workflow_activity events')
const firstUser = messages.find((message) => message.type === 'user')?.message?.content
const userText = fixture?.userText ?? (typeof firstUser === 'string' ? firstUser : 'archived workflow run')

const source = {
  version: 3,
  cwd: workspace,
  sessionId: 'workflow-archive-replay',
  externalSessionId: 'workflow-archive-replay',
  providerId: 'claude',
  runtimeProvider: 'claude_sdk',
  turns: [{ runId: 'run-archive-workflow', userText, items, done: true, ts: Date.now() }]
}
const archivePath = join(temp, 'archive.json')
// The same run also exists as a Provider-native transcript, minus the task_* progress rows:
// the archive stays the only source of workflow detail, and the App must merge the two
// without duplicating or dropping rows. The dedupe key under test lives in that merge.
// A real transcript starts with the human prompt; the archive pairs turns by that text, so
// the replay must carry it or the two sources stay separate turns.
const nativeRows = [
  { type: 'user', message: { role: 'user', content: userText } },
  ...messages.filter((message) =>
    message?.type === 'user' || (message?.type === 'assistant' && message?.message?.content))
]
const nativePath = join(temp, 'native-transcript.jsonl')
writeFileSync(nativePath, nativeRows.map((message) => JSON.stringify(message)).join('\n') + '\n')
writeFileSync(archivePath, JSON.stringify(source))

const child = spawn(process.execPath, [join(root, 'scripts/electron-security-smoke.mjs'), '--dev-workflow-only', archivePath, nativePath], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env }
})
const code = await new Promise((resolve) => child.once('exit', (exitCode) => resolve(exitCode ?? 1)))
if (args.includes('--keep')) console.log(JSON.stringify({ kept: temp, archive: archivePath, native: nativePath, workflowEvents: workflowEvents.length }))
else rmSync(temp, { recursive: true, force: true })
process.exitCode = code
