#!/usr/bin/env node
// Machine-checkable verdicts for the real-Provider part of the rollout check.
// The executing agent drives the Provider; this script only reads local
// evidence (records, receipts, status) and prints PASS / WARN / FAIL /
// UNAVAILABLE. It never uploads, never edits records and never reads
// credentials.
//
//   snapshot  --workspace W                                   > snap.json
//   turns     --workspace W --since snap.json --provider P \
//             --expect tool:MARK,text:MARK,interrupt:MARK [--file NAME]
//   upload    --workspace W --turns turns.json --uploader CLI [--timeout 180] [--repo-module FILE]
//   observe   --workspaces W1,W2 --uploader CLI --interval 60 --count N --out obs.jsonl
//   report    obs.jsonl
//
// Exit code: 1 when any check is FAIL, otherwise 0.

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, appendFileSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const [command, ...rest] = process.argv.slice(2)
const args = {}
for (let i = 0; i < rest.length; i++) {
  if (rest[i].startsWith('--')) { args[rest[i].slice(2)] = rest[i + 1]; i++ } else (args._ ??= []).push(rest[i])
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const checks = []
const check = (name, verdict, detail = {}) => { checks.push({ name, verdict, ...detail }) }

function dataRoot(workspace) {
  const configPath = join(workspace, 'scry.config.json')
  if (!existsSync(configPath)) throw new Error(`no scry.config.json in ${workspace}`)
  const config = JSON.parse(readFileSync(configPath, 'utf8'))
  return resolve(workspace, typeof config.dataDir === 'string' && config.dataDir.trim() ? config.dataDir : '.scry')
}

function recordFiles(workspace) {
  const dir = join(dataRoot(workspace), 'records')
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .map((name) => ({ name, sequence: Number(name.split('-')[0]) }))
    .filter((f) => f.name.endsWith('.json') && Number.isSafeInteger(f.sequence))
    .sort((a, b) => a.sequence - b.sequence)
    .map((f) => ({ ...f, path: join(dir, f.name) }))
}

const SECTIONS = ['user', 'assistant', 'tools', 'skills', 'mcps', 'hooks', 'usage', 'files', 'diff', 'dangerousOperations', 'errors']
const STATUSES = new Set(['available', 'partial', 'unavailable', 'disabled'])

// Honesty rules from CLAUDE.md that can be checked on one record.
function honesty(record) {
  const problems = []
  for (const section of SECTIONS) {
    const evidence = record[section]
    if (evidence === undefined) continue
    if (!STATUSES.has(evidence.status)) problems.push(`${section}: unknown status ${evidence.status}`)
    // "unavailable" must not carry an empty list that reads as "nothing happened".
    if (section !== 'diff' && (evidence.status === 'unavailable' || evidence.status === 'disabled') && evidence.value !== undefined)
      problems.push(`${section}: ${evidence.status} but carries a value`)
    if ((evidence.status === 'unavailable' || evidence.status === 'disabled') && !evidence.omissionReason)
      problems.push(`${section}: ${evidence.status} without omissionReason`)
  }
  const usage = record.usage
  if (usage?.status === 'available' && usage.quality === 'exact') {
    const v = usage.value ?? {}
    if ((v.inputTokens ?? 0) === 0 && (v.outputTokens ?? 0) === 0)
      problems.push('usage: exact but input and output tokens are both 0/missing (missing must be unavailable, not 0)')
  }
  return problems
}

const userText = (record) => (typeof record.user?.value?.text === 'string' ? record.user.value.text : undefined)

function commandSnapshot() {
  const workspace = resolve(args.workspace)
  const files = recordFiles(workspace)
  const out = { workspace, maxSequence: files.at(-1)?.sequence ?? 0, records: files.length, at: new Date().toISOString() }
  process.stdout.write(JSON.stringify(out, null, 2) + '\n')
}

function commandTurns() {
  const workspace = resolve(args.workspace)
  const since = JSON.parse(readFileSync(args.since, 'utf8'))
  const provider = args.provider
  const expected = String(args.expect ?? '').split(',').filter(Boolean).map((item) => {
    const [kind, mark] = item.split(':')
    return { kind, mark }
  })
  const fresh = recordFiles(workspace).filter((f) => f.sequence > since.maxSequence)
  const records = fresh.map((f) => JSON.parse(readFileSync(f.path, 'utf8')))
  check('record count matches turns run', records.length === expected.length ? 'PASS' : 'FAIL',
    { expected: expected.length, got: records.length })
  const ids = new Set(records.map((r) => r.recordId))
  check('recordIds unique', ids.size === records.length ? 'PASS' : 'FAIL')
  const sequences = fresh.map((f) => f.sequence)
  check('sequences contiguous', sequences.every((s, i) => i === 0 || s === sequences[i - 1] + 1) ? 'PASS' : 'WARN', { sequences })

  const matched = []
  expected.forEach((turn, index) => {
    let candidates = records.filter((r) => userText(r)?.includes(turn.mark))
    let matchedBy = 'marker'
    if (candidates.length === 0 && records.every((r) => userText(r) === undefined)) {
      candidates = records[index] ? [records[index]] : []
      matchedBy = 'order (user text not captured)'
    }
    const label = `${turn.kind}[${turn.mark}]`
    if (candidates.length !== 1) {
      check(`${label}: exactly one record`, 'FAIL', { got: candidates.length })
      return
    }
    const r = candidates[0]
    matched.push({ kind: turn.kind, mark: turn.mark, recordId: r.recordId, sequence: r.sequence, status: r.status })
    check(`${label}: provider`, r.provider?.id === provider ? 'PASS' : 'FAIL', { got: r.provider?.id, matchedBy })
    const problems = honesty(r)
    check(`${label}: evidence honesty`, problems.length ? 'FAIL' : 'PASS', problems.length ? { problems } : {})
    const tools = r.tools
    const files = r.files
    if (turn.kind === 'tool') {
      check(`${label}: status completed`, r.status === 'completed' ? 'PASS' : 'FAIL', { got: r.status })
      if (tools?.status === 'unavailable') check(`${label}: tool evidence`, 'UNAVAILABLE', { omissionReason: tools.omissionReason })
      else check(`${label}: tool evidence`, Array.isArray(tools?.value) && tools.value.length > 0 ? 'PASS' : 'FAIL',
        { status: tools?.status, calls: tools?.value?.length ?? 0 })
      const name = args.file
      if (name) {
        const inFiles = Array.isArray(files?.value) && files.value.some((f) => String(f.path).endsWith(name))
        const inDiff = Array.isArray(r.diff?.value) && JSON.stringify(r.diff.value).includes(name)
        if (inFiles || inDiff) check(`${label}: file footprint has ${name}`, 'PASS', { inFiles, inDiff })
        else if (files?.status === 'unavailable' && r.diff?.status === 'unavailable') check(`${label}: file footprint`, 'UNAVAILABLE')
        else check(`${label}: file footprint has ${name}`, 'FAIL', { filesStatus: files?.status, diffStatus: r.diff?.status })
      }
    } else if (turn.kind === 'text') {
      check(`${label}: status completed`, r.status === 'completed' ? 'PASS' : 'FAIL', { got: r.status })
      if (tools?.status === 'unavailable') check(`${label}: no-tool turn`, 'PASS', { tools: 'unavailable (provider gives no tool evidence)' })
      else if (Array.isArray(tools?.value) && tools.value.length === 0) check(`${label}: no-tool turn`, 'PASS', { tools: 'available + []' })
      else check(`${label}: no-tool turn`, 'WARN', { detail: 'model still called tools; rerun with a stricter prompt', calls: tools?.value?.length })
    } else if (turn.kind === 'interrupt') {
      if (r.status === 'completed') check(`${label}: not completed`, 'WARN', { detail: 'turn finished before the stop arrived; rerun with a longer task' })
      else check(`${label}: interrupted/cancelled`, ['interrupted', 'cancelled'].includes(r.status) ? 'PASS' : 'FAIL', { got: r.status })
      const partial = SECTIONS.filter((s) => r[s]?.status === 'partial')
      if (r.status !== 'completed') check(`${label}: partial evidence marked`, partial.length ? 'PASS' : 'WARN', { partialSections: partial })
    }
  })

  if (args.scry) {
    const [bin, pre] = /\.(m?js|cjs)$/.test(args.scry) ? [process.execPath, [args.scry]] : [args.scry, []]
    const verify = spawnSync(bin, [...pre, 'turns', 'verify', '--workspace', workspace], { encoding: 'utf8' })
    check('scry turns verify', verify.status === 0 ? 'PASS' : 'FAIL', { exit: verify.status, stdout: (verify.stdout ?? '').slice(0, 400), error: verify.error ? String(verify.error) : undefined })
  }
  return { workspace, provider, turns: matched }
}

function uploaderStatus(uploader, workspace) {
  const out = execFileSync(process.execPath, [uploader, 'status', '--workspace', workspace, '--json'], { encoding: 'utf8', timeout: 30_000 })
  return JSON.parse(out)
}

// The uploader computes the wire `repo` value itself; call that same function instead of
// re-implementing it. Builds differ in which module holds it, so look for the export among the
// uploader's own dist modules (only files whose source mentions it are imported).
async function repositoryName(uploader, workspace) {
  const dir = dirname(realpathSync(resolve(uploader)))
  const candidates = args['repo-module'] ? [resolve(args['repo-module'])]
    : readdirSync(dir).filter((n) => n.endsWith('.js') && n !== basename(uploader)).map((n) => join(dir, n))
      .filter((f) => { try { return readFileSync(f, 'utf8').includes('repositoryName') } catch { return false } })
  const tried = []
  for (const file of candidates) {
    try {
      const mod = await import(pathToFileURL(file).href)
      if (typeof mod.repositoryName === 'function') return { value: await mod.repositoryName(workspace), module: basename(file) }
      tried.push(`${basename(file)}: no export`)
    } catch (error) { tried.push(`${basename(file)}: ${String(error.message).slice(0, 80)}`) }
  }
  return { unavailable: candidates.length ? `no repositoryName export (${tried.join('; ')}); pass --repo-module <file>` : `no module next to ${basename(uploader)} mentions repositoryName; pass --repo-module <file>` }
}

async function commandUpload() {
  const workspace = resolve(args.workspace)
  const uploader = resolve(args.uploader)
  const turns = JSON.parse(readFileSync(args.turns, 'utf8'))
  const ids = (turns.result?.turns ?? turns.turns ?? []).map((t) => t.recordId)
  const timeoutMs = Number(args.timeout ?? 180) * 1000
  const started = Date.now()
  let status
  for (;;) {
    try { status = uploaderStatus(uploader, workspace) } catch (error) {
      check('uploader status readable', 'FAIL', { error: String(error.stderr || error).trim().slice(0, 300) })
      return { workspace, ids }
    }
    if (status.outboxPending === 0 && status.committedPending === 0) break
    if (Date.now() - started > timeoutMs) break
    await sleep(5000)
  }
  const drainedMs = Date.now() - started
  check('outbox drained', status.outboxPending === 0 && status.committedPending === 0 ? 'PASS' : 'FAIL',
    { drainedMs, outboxPending: status.outboxPending, committedPending: status.committedPending, lastError: status.lastError })
  check('no dead letters', status.deadLetterRecords === 0 && status.deadLetterJobs === 0 ? 'PASS' : 'FAIL',
    { deadLetterRecords: status.deadLetterRecords, deadLetterJobs: status.deadLetterJobs })
  const receipts = join(dataRoot(workspace), 'upload', 'receipts')
  for (const id of ids) {
    const path = join(receipts, `${id}.json`)
    if (!existsSync(path)) { check(`receipt ${id}`, 'FAIL', { detail: 'no custody receipt' }); continue }
    const receipt = JSON.parse(readFileSync(path, 'utf8'))
    const held = args['expect-held'] === 'true'
    const okStatus = held ? receipt.status === 'skipped_disabled' : receipt.status === 'uploaded' && ['inserted', 'duplicated'].includes(receipt.remoteStatus)
    check(`receipt ${id}`, okStatus ? 'PASS' : 'FAIL', { status: receipt.status, remoteStatus: receipt.remoteStatus })
  }
  const repo = await repositoryName(uploader, workspace)
  if (repo.unavailable) check('repo identity host/org/repo', 'UNAVAILABLE', { reason: repo.unavailable })
  else check('repo identity host/org/repo', /^[^/\s]+\/[^/\s]+\/[^/\s]+/.test(repo.value) ? 'PASS' : 'FAIL', { repo: repo.value, module: repo.module })
  return { workspace, drainedMs, ids }
}

// Only this uploader's processes: workers/recover carry the CLI path, lock
// helpers carry the fixed hold marker from locks.ts.
function processes(uploader) {
  const out = spawnSync('ps', ['-axo', 'pid=,etime=,pcpu=,command='], { encoding: 'utf8' }).stdout ?? ''
  return out.split('\n').filter((line) =>
    (line.includes(uploader) && /\s_(worker|recover)\b/.test(line)) || line.includes('__scry_lock_acquired__'))
}

function duBytes(path) {
  let total = 0
  const walk = (p) => {
    let st
    try { st = statSync(p) } catch { return }
    if (st.isDirectory()) { for (const name of readdirSync(p)) walk(join(p, name)) } else total += st.size
  }
  walk(path)
  return total
}

async function commandObserve() {
  const workspaces = String(args.workspaces).split(',').map((w) => resolve(w))
  const uploader = resolve(args.uploader)
  const count = Number(args.count ?? 60)
  const interval = Number(args.interval ?? 60) * 1000
  for (let i = 0; i < count; i++) {
    const procs = processes(uploader)
    const sample = { at: new Date().toISOString(), workers: procs.filter((l) => /_worker/.test(l)).length,
      lockHelpers: procs.filter((l) => l.includes('__scry_lock_acquired__')).length, processes: procs.map((l) => l.trim().slice(0, 200)), workspaces: {} }
    for (const ws of workspaces) {
      try {
        const s = uploaderStatus(uploader, ws)
        const health = JSON.parse(readFileSync(join(dataRoot(ws), 'upload', 'health.json'), 'utf8'))
        sample.workspaces[ws] = { outboxPending: s.outboxPending, committedPending: s.committedPending, deadLetterRecords: s.deadLetterRecords,
          retryingJobs: s.retryingJobs, timeoutRecords: s.timeoutRecords, transportFailures: s.transportFailures ?? 0,
          health: health.status, scryBytes: duBytes(dataRoot(ws)), records: recordFiles(ws).length }
      } catch (error) { sample.workspaces[ws] = { error: String(error).slice(0, 200) } }
    }
    appendFileSync(args.out, JSON.stringify(sample) + '\n')
    if (i < count - 1) await sleep(interval)
  }
}

const etimeSeconds = (etime) => {
  const [days, clock] = etime.includes('-') ? etime.split('-') : [0, etime]
  const parts = clock.split(':').map(Number)
  while (parts.length < 3) parts.unshift(0)
  return Number(days) * 86400 + parts[0] * 3600 + parts[1] * 60 + parts[2]
}

function commandReport() {
  const samples = readFileSync(args._?.[0] ?? args.in, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  const workspaces = Object.keys(samples[0]?.workspaces ?? {})
  const maxWorkers = Math.max(...samples.map((s) => s.workers))
  check('workers never exceed 2 (admission slots)', maxWorkers <= 2 ? 'PASS' : 'FAIL', { maxWorkers })
  const longLived = samples.flatMap((s) => s.processes).filter((l) => /_worker/.test(l) && etimeSeconds(l.split(/\s+/)[1] ?? '0') > 300)
  check('no worker lives longer than 5 min', longLived.length ? 'FAIL' : 'PASS', longLived.length ? { examples: longLived.slice(0, 3) } : {})
  const tail = samples.slice(-3)
  check('lock helpers do not accumulate', tail.every((s) => s.lockHelpers === 0) ? 'PASS' : 'WARN', { last: tail.map((s) => s.lockHelpers) })
  for (const ws of workspaces) {
    const rows = samples.map((s) => s.workspaces[ws]).filter((r) => r && !r.error)
    if (rows.length === 0) { check(`${ws}: samples`, 'UNAVAILABLE'); continue }
    const last = rows.at(-1)
    check(`${ws}: backlog drained at end`, last.outboxPending === 0 && last.committedPending === 0 ? 'PASS' : 'FAIL',
      { outboxPending: last.outboxPending, committedPending: last.committedPending })
    check(`${ws}: dead letters stay 0`, rows.every((r) => r.deadLetterRecords === 0) ? 'PASS' : 'FAIL', { max: Math.max(...rows.map((r) => r.deadLetterRecords)) })
    const peak = Math.max(...rows.map((r) => r.outboxPending))
    check(`${ws}: backlog peak`, peak <= 20 ? 'PASS' : 'WARN', { peak })
    check(`${ws}: health not stuck in error`, rows.slice(-3).some((r) => r.health !== 'error') ? 'PASS' : 'FAIL', { last: rows.slice(-3).map((r) => r.health) })
    const hours = (Date.parse(samples.at(-1).at) - Date.parse(samples[0].at)) / 3_600_000
    const records = last.records - rows[0].records
    check(`${ws}: disk growth`, 'PASS', { bytesPerRecord: records > 0 ? Math.round((last.scryBytes - rows[0].scryBytes) / records) : null, hours: Number(hours.toFixed(2)) })
  }
}

const commands = { snapshot: commandSnapshot, turns: commandTurns, upload: commandUpload, observe: commandObserve, report: commandReport }
if (!commands[command]) {
  process.stderr.write('usage: record-check.mjs snapshot|turns|upload|observe|report [options]\n')
  process.exit(2)
}
const result = await commands[command]()
if (command !== 'snapshot' && command !== 'observe') {
  const failed = checks.filter((c) => c.verdict === 'FAIL').length
  process.stdout.write(JSON.stringify({ command, result, checks, failed }, null, 2) + '\n')
  process.exit(failed ? 1 : 0)
}
