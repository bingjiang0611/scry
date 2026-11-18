// Worker-path evidence for the daemon-mode smoke (S0-5). In daemon mode the terminal
// recording worker and the run output worker are loaded by URL beside daemon.js; packaged,
// that is inside app.asar. A worker that fails to load still lets a run "settle" from
// the App's point of view, so these checks read what the workers wrote, on disk.
import { createHash } from 'node:crypto'
import { lstatSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { readLedger, runIdForScryRun, runSummary } from '../b4v/ledger.mjs'

export const TERMINAL_MARKER = '__SCRY_DAEMON_SMOKE_TERMINAL__'

// The typed command must not contain the marker itself, or the shell's echo would match
// before the command ran: printf turns each \137 into the underscore it stands for.
const typedMarker = `\\\\137\\\\137${TERMINAL_MARKER.slice(2)}`

/** Starts one shell through the preload API and keeps its output on window for the next step. */
export function terminalStartExpression(cwd) {
  return `(async () => {
    const state = window.__daemonSmokeTerminal = { output: '', exit: null, session: null }
    state.offData = window.scry.onTerminalData((event) => {
      if (event.id !== state.session?.id) return
      state.output += event.data
      // Flow control: unacknowledged bytes pause the pty, as in the real view.
      void window.scry.terminalAck(event.id, event.ownershipEpoch, new TextEncoder().encode(event.data).byteLength)
    })
    state.offExit = window.scry.onTerminalExit((event) => { if (event.id === state.session?.id) state.exit = event })
    state.session = await window.scry.terminalStart({ cwd: ${JSON.stringify(cwd)}, cols: 80, rows: 24 })
    await window.scry.terminalReady(state.session.id, state.session.ownershipEpoch)
    return { id: state.session.id, pid: state.session.pid, recording: state.session.recording ?? null }
  })()`
}

/** Prints the marker, exits the shell, then reads the recording back until it is final. */
export function terminalFinishExpression() {
  return `(async () => {
    const state = window.__daemonSmokeTerminal
    const { id, ownershipEpoch } = state.session
    const wait = async (predicate, ms) => {
      const deadline = Date.now() + ms
      while (!(await predicate()) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50))
      return predicate()
    }
    await window.scry.terminalWrite(id, ownershipEpoch, "printf '${typedMarker}\\\\n'; exit" + String.fromCharCode(13))
    const exited = await wait(() => state.exit !== null, 15000)
    let page = null
    const final = await wait(async () => {
      page = await window.scry.terminalRecordingRead({ id, offset: 0, limit: 65536 }).catch((error) => ({ error: String(error) }))
      return Boolean(page && page.state && page.state !== 'recording')
    }, 10000)
    const listed = (await window.scry.terminalRecordingList()).items.find((item) => item.id === id) ?? null
    state.offData(); state.offExit()
    return {
      exited, exit: state.exit, outputHasMarker: state.output.includes(${JSON.stringify(TERMINAL_MARKER)}),
      final, recording: page && !page.error ? { state: page.state, totalBytes: page.totalBytes, hasMarker: page.data.includes(${JSON.stringify(TERMINAL_MARKER)}) } : page,
      listed
    }
  })()`
}

const sizeOf = (path) => { try { const stat = lstatSync(path); return stat.isFile() ? stat.size : -1 } catch { return -1 } }

/** What the recording worker left in userData/terminal-recordings for this terminal. */
export function recordingFiles(userDataDir, id) {
  const directory = join(userDataDir, 'terminal-recordings')
  let names
  try { names = readdirSync(directory) } catch (error) { return { ok: false, reason: `recording_directory_unreadable:${error?.code ?? error}`, directory } }
  const own = names.filter((name) => name.startsWith(`${id}.`))
  const files = Object.fromEntries(own.map((name) => [name, sizeOf(join(directory, name))]))
  const metadata = files[`${id}.json`] ?? -1
  const data = own.filter((name) => name !== `${id}.json`).map((name) => files[name])
  const ok = metadata > 0 && data.some((size) => size > 0)
  return { ok, directory, files, ...(ok ? {} : { reason: 'recording_files_missing_or_empty' }) }
}

/**
 * The run output worker's files for one run: `<sha256(ledger run id)>.jsonl` and `.idx`
 * under userData/remote/output (RunOutputFileStore). The App names the run by its own id;
 * the daemon's ledger links the two with a `bound` event (or the window already holds
 * the ledger id). The text the App streamed must be in the data file, so a settled run
 * with no worker output is a failure.
 */
export function runOutputFiles(userDataDir, appRunId) {
  const directory = join(userDataDir, 'remote', 'output')
  const ledger = readLedger(userDataDir)
  const runId = runIdForScryRun(ledger, appRunId) ?? (runSummary(ledger, appRunId).known ? appRunId : null)
  if (!runId) return { ok: false, reason: 'ledger_run_unlinked', appRunId, ledgerStatus: ledger.status }
  const key = createHash('sha256').update(runId).digest('hex')
  const data = join(directory, `${key}.jsonl`)
  const index = join(directory, `${key}.idx`)
  const sizes = { data: sizeOf(data), index: sizeOf(index) }
  if (sizes.data <= 0 || sizes.index <= 0) {
    let present
    try { present = readdirSync(directory).slice(0, 20) } catch (error) { present = `unreadable:${error?.code ?? error}` }
    return { ok: false, reason: 'run_output_files_missing_or_empty', directory, appRunId, runId, sizes, present }
  }
  let text = ''
  try {
    for (const line of readFileSync(data, 'utf8').split('\n')) {
      if (!line) continue
      const chunk = JSON.parse(line)
      if (chunk.runId === runId && chunk.kind === 'output' && typeof chunk.text === 'string') text += chunk.text
    }
  } catch (error) {
    return { ok: false, reason: `run_output_unreadable:${error?.code ?? error?.message ?? error}`, directory, appRunId, runId, sizes }
  }
  const ok = text.length > 0
  return { ok, directory, appRunId, runId, sizes, outputChars: text.length, ...(ok ? {} : { reason: 'run_output_text_missing' }) }
}
