import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { vi } from 'vitest'
import { piProfileForExecutable, type PiAgentProfile } from '../pi-agent-profiles'
import * as locate from '../claude-locate'

export async function withProbeFixture(run: (profile: PiAgentProfile, cwd: string, starts: () => string[]) => Promise<void>) {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'scry-pi-lifecycle-')))
  const executable = join(cwd, 'fixture-pi')
  const releasePipe = join(cwd, 'release-child')
  const fifo = spawnSync('mkfifo', [releasePipe])
  if (fifo.status !== 0) throw new Error(`mkfifo failed: ${fifo.stderr.toString()}`)
  const log = join(cwd, 'starts.jsonl')
  writeFileSync(log, '')
  writeFileSync(executable, `#!/usr/bin/env node
const fs = require('node:fs')
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.cwd()) + '\\n')
fs.writeFileSync(process.cwd() + '/pid', String(process.pid))
if (fs.existsSync(process.cwd() + '/startup-wire')) {
  fs.writeSync(1, fs.readFileSync(process.cwd() + '/startup-wire'))
  process.exit(0)
}
if (fs.existsSync(process.cwd() + '/stubborn')) {
  process.on('SIGTERM', () => {})
  setInterval(() => {}, 1000)
}
if (fs.existsSync(process.cwd() + '/probe-idle')) {
  // A real live handle keeps read-only discovery alive after EOF; TERM closes it cleanly.
  const server = require('node:net').createServer()
  server.listen(0, '127.0.0.1')
  process.on('SIGTERM', () => server.close(() => {
    fs.writeFileSync(process.cwd() + '/probe-closed', 'graceful')
    process.exit(0)
  }))
}
const sessionFile = process.cwd() + '/fixture-session.jsonl'
const resumeIndex = process.argv.indexOf('--session')
if (resumeIndex >= 0 && !fs.existsSync(sessionFile)) {
  process.stderr.write("No session found matching '" + process.argv[resumeIndex + 1] + "'")
  process.exit(1)
}
const entries = fs.existsSync(sessionFile)
  ? fs.readFileSync(sessionFile, 'utf8').trim().split('\\n').slice(1).map((line) => JSON.parse(line))
  : []
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n')
require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const command = JSON.parse(line)
  fs.appendFileSync(process.cwd() + '/commands', command.type + '\\n')
  const fail = fs.existsSync(process.cwd() + '/fail-probe')
  const data = {
    get_state: {
      cwd: process.cwd(), sessionId: 'fixture-session', sessionFile,
      isStreaming: false, isCompacting: false, pendingMessageCount: 0
    },
    get_entries: { entries, leafId: entries.at(-1)?.id ?? null },
    get_available_models: { models: [] },
    get_available_thinking_levels: { levels: ['off'] },
    get_commands: { commands: [{ name: 'fixture-menu', source: 'extension' }] }
  }[command.type]
  if (command.type === 'prompt' && command.message !== '/fixture-menu') {
    entries.push({
      type: 'message', id: 'user-' + (entries.length + 1), parentId: entries.at(-1)?.id ?? null,
      message: { role: 'user', content: command.message }
    })
    fs.writeFileSync(sessionFile, [
      { type: 'session', id: 'fixture-session' }, ...entries
    ].map((entry) => JSON.stringify(entry)).join('\\n') + '\\n')
    send({ type: 'agent_start' })
    if (command.message === 'stop-after-persist') {
      send({ type: 'extension_ui_request', id: 'persisted', method: 'setStatus', statusKey: 'persisted', text: 'Persisted' })
      return
    }
    if (command.message === 'background-child' || command.message.startsWith('background-cleared')) {
      const snapshot = (state, id = 'child-1') => send({ type: 'extension_ui_request', method: 'setWidget', widgetKey: 'subagent-async',
        widgetLines: ['PI_SUBAGENT_ASYNC_JSON:' + JSON.stringify({ kind: 'pi-subagents.async-status-snapshot', version: 1,
          generatedAt: Date.now(), omitted: { runs: 0, children: 0, byteLimitExceeded: false },
          runs: [{ id, kind: 'subagent', label: 'worker', state }] })] })
      snapshot('running')
      if (command.message === 'background-cleared-resume' || command.message === 'background-cleared-new-child') {
        // Clear while the parent is active, then wake it without resurrecting the
        // old child. A later child's widget must not restore that old ownership.
        send({ type: 'extension_ui_request', method: 'setWidget', widgetKey: 'subagent-async' })
        send({ type: 'agent_start' })
        if (command.message === 'background-cleared-new-child') {
          snapshot('running', 'child-2')
          snapshot('complete', 'child-2')
          send({ type: 'message_end', message: { role: 'custom', customType: 'subagent-notify', content: 'New child finished' } })
        }
        send({ type: 'agent_end', messages: [] })
        send({ type: 'agent_settled' })
      } else if (command.message === 'background-cleared') {
        send({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'Work wrapped up' }], stopReason: 'stop' } })
        send({ type: 'agent_end', messages: [] })
        send({ type: 'agent_settled' })
        // The extension clears this widget once no async job is left, and no terminal
        // row is ever replayed. A run must not wait on that missing row forever.
        send({ type: 'extension_ui_request', method: 'setStatus', statusKey: 'checkpoint', text: 'child waiting checkpoint' })
        setTimeout(() => send({ type: 'extension_ui_request', method: 'setWidget', widgetKey: 'subagent-async' }), 25)
      } else {
        send({ type: 'agent_end', messages: [] })
        send({ type: 'agent_settled' })
        require('node:readline').createInterface({ input: fs.createReadStream(${JSON.stringify(releasePipe)}) }).once('line', (line) => {
          if (line === 'exit') process.exit(2)
          snapshot('complete')
          send({ type: 'agent_start' })
          send({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'Child reviewed; parent continued' }], stopReason: 'stop' } })
          send({ type: 'agent_end', messages: [] })
          send({ type: 'agent_settled' })
        })
        send({ type: 'extension_ui_request', method: 'setStatus', statusKey: 'checkpoint', text: 'child waiting checkpoint' })
      }
    } else {
      send({ type: 'agent_end', messages: [] })
      send({ type: 'agent_settled' })
    }
  }
  if (command.type === 'abort') send({ type: 'agent_settled', aborted: true })
  send({ type: 'response', id: command.id, command: command.type,
    success: !fail, data, ...(fail ? { error: 'fixture probe failed' } : {}) })
})
`)
  chmodSync(executable, 0o755)
  // Lifecycle tests own their launcher: don't warm a login shell or scan the
  // developer's PATH for Node. The dedicated Node-selection test overrides this
  // boundary explicitly; RPC, process exit and recorder IO remain real.
  const environment = vi.spyOn(locate, 'shellEnv').mockReturnValue({
    PATH: dirname(process.execPath), HOME: cwd, PI_AGENT_NODE: process.execPath
  })
  try {
    await run(piProfileForExecutable(executable), cwd, () => readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as string))
  } finally {
    environment.mockRestore()
    rmSync(cwd, { recursive: true, force: true })
  }
}
