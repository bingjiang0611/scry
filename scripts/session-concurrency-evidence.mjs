import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { readRecords } from './performance-report.mjs'
import { evaluateArchiveEvidence } from './session-concurrency-contract.mjs'

// Durable-evidence readers for the P0 concurrency harness. Everything here mirrors an existing App
// contract (archive segment shape, session catalog, app-owned content blob layout) so the harness
// checks the real files instead of trusting the report it just produced.
const hash = value => createHash('sha256').update(value).digest('hex')
const TAIL_MARKER = 'COMPLETE_LARGE_TOOL_TAIL'

// Every harness module, hashed into the report identity so editing one changes harnessSha256. The list lives
// here with the other content hashing, and includes this file.
export const HARNESS_FILES = ['scripts/session-concurrency-bench.mjs', 'scripts/session-concurrency-page.mjs',
  'scripts/session-concurrency-report.mjs', 'scripts/session-concurrency-aggregate.mjs',
  'scripts/session-concurrency-contract.mjs', 'scripts/session-concurrency-lanes.mjs',
  'scripts/session-concurrency-evidence.mjs', 'scripts/session-concurrency-electron.mjs',
  'scripts/session-concurrency-ui.mjs', 'scripts/session-concurrency-validate.mjs',
  'scripts/session-concurrency-pool.mjs']

// Harness identity: every harness file's content, so editing one changes harnessSha256.
export const harnessSha256 = root => hash(HARNESS_FILES.map(file => `${file}\0${readFileSync(join(root, file), 'utf8')}`).join('\0'))

// Identity of the compiled build, hashed from every file under out/ so a rebuild between runs shows
// up as a different measurement subject instead of a silent comparison.
export function builtArtifactHash(root) {
  const digest = createHash('sha256')
  for (const path of readdirSync(join(root, 'out'), { recursive: true }).sort()) {
    if (statSync(join(root, 'out', path)).isFile()) digest.update(`${path}\0${hash(readFileSync(join(root, 'out', path)))}\n`)
  }
  return digest.digest('hex')
}

// Existing archive/catalog contracts (same shapes session-open-bench seeds) give every run its own
// temp workspace plus one history session. No authority check is relaxed.
export function seedWorkspace(userData, cwd, runIndex, scenario) {
  const archiveDir = join(userData, 'trace-archives-v2', 'codex', `cwd-${hash(cwd)}`)
  mkdirSync(archiveDir, { recursive: true })
  const catalog = []
  for (const sessionId of [`conc-${runIndex}-live`, `conc-${runIndex}-history`]) {
    const turns = Array.from({ length: scenario.seedTurns }, (_, index) => {
      const body = Array.from({ length: scenario.seedSections }, (_, line) =>
        `### Section ${line}\n\nA **measured** history paragraph with [a link](https://example.com).\n\n\`\`\`ts\nconst value${line} = ${line}\n\`\`\`\n`).join('\n')
      return {
        runId: `${sessionId}-turn-${index}`, userText: `${sessionId} prompt ${index}`, done: true,
        ts: 1_700_000_000_000 + index,
        items: [{ id: `${sessionId}-text-${index}`, runId: `${sessionId}-turn-${index}`,
          ts: '2023-11-14T22:13:20.000Z', kind: 'model', stage: 'text', text: `${body}\nEND ${sessionId} ${index}` }]
      }
    })
    writeFileSync(join(archiveDir, `sid-${hash(sessionId)}.json`), JSON.stringify({
      version: 3, cwd, sessionId, providerId: 'codex', runtimeProvider: 'codex_cli', turns
    }))
    catalog.push({ sessionId, externalSessionId: sessionId, runId: turns.at(-1).runId,
      providerId: 'codex', runtimeProvider: 'codex_cli', cwd, preview: sessionId, ts: turns.at(-1).ts })
  }
  return catalog
}

// The history-switch UI scenario needs a stable sidebar order. Production sorts pinned projects first
// (SidebarProjects.tsx project comparator) and a newly started session otherwise reorders projects by
// mtime between the geometry read and the native event, which moves a session row under the pointer.
// This writes the real projects.json contract into the temp userData only; no production interface, no
// user directory, and only this scenario pins, so the other scenarios keep the default unpinned order
// and do not hide live reordering cost.
export function seedProjectPinning(userData, cwds) {
  const base = Date.parse('2023-11-14T00:00:00.000Z')
  writeFileSync(join(userData, 'projects.json'), JSON.stringify(cwds.map((cwd, index) => ({
    cwd, lastOpenedAt: base + index, pinnedAt: base + (cwds.length - index) }))))
}

// Durable archive segments store { version, cwd, sessionId, turns: [...] }; the directory also holds
// index files, which are counted and skipped rather than parsed as turns.
// Turns are read from the durable archives after the App exited, never from a page read: a missing turn
// has to look like a missing turn, not like a passing run. Both roots are reported so an absent root cannot
// also pass for absent turns.
export function verifyArchivedRuns({ userData, runs, scenario, archiveRoots }) {
  const archives = archiveRoots.map(archiveRoot => ({ root: archiveRoot, ...readArchiveTurns(archiveRoot) }))
  const persisted = archives.flatMap(archive => archive.turns)
  const archiveFiles = { roots: archives.map(archive => ({
    root: archive.root.slice(userData.length + 1),
    rootPresent: archive.files.rootPresent, segments: archive.files.segments,
    ignored: archive.files.ignored, turns: archive.turns.length
  })) }
  for (const run of runs) {
    const turn = persisted.find(candidate => candidate.runId === run.runId)
    run.archiveReadable = Boolean(turn)
    if (!turn) { run.diskVerified = false; run.evaluation = { passed: false, checks: [{ name: 'archivedTurn', observed: null, expected: run.runId, passed: false }] }; continue }
    const evidence = extractEvidence(turn, null)
    evidence.raw = readRawContent(userData, run.cwd, evidence.toolResult?.contentRef)
    run.evidence = evidence
    run.evaluation = evaluateArchiveEvidence(scenario, evidence)
    run.diskVerified = run.evaluation.passed
  }
  return { archiveFiles, persisted }
}

// Journal lane from the durable performance records. A parse issue or a record without a build hash fails
// instead of being summarised as zero: the journal is the only in-App record of the run's own sampling.
export async function readJournalLane(userData, { enabled = true } = {}) {
  if (!enabled) return { journal: { status: 'unavailable', reason: 'SCRY_PERF_RECORD=0', issues: [] }, records: [] }
  const { records, issues } = await readRecords(join(userData, 'performance'))
  assert.equal(issues.length, 0, 'journal must contain parseable records')
  assert.ok(records.every(record => /^[a-f0-9]{64}$/.test(record.build)),
    'records must identify the compiled source snapshot')
  return { records, journal: { status: 'measured', records: records.length, issues,
    builds: [...new Set(records.map(record => record.build))],
    health: records.filter(record => record.observation.kind === 'health').length,
    droppedRecords: records.filter(record => record.observation.kind === 'health')
      .reduce((total, record) => total + (record.observation.sample?.droppedRecords ?? 0), 0) } }
}

export function readArchiveTurns(archiveRoot) {
  const turns = []
  const files = { segments: 0, ignored: 0, rootPresent: true }
  let paths = []
  try { paths = readdirSync(archiveRoot, { recursive: true }).filter(name => name.endsWith('.json')) } catch { files.rootPresent = false }
  for (const path of paths) {
    let archive
    try { archive = JSON.parse(readFileSync(join(archiveRoot, path), 'utf8')) } catch { files.ignored += 1; continue }
    if (!archive || !Array.isArray(archive.turns) || ![1, 2, 3].includes(archive.version)) { files.ignored += 1; continue }
    files.segments += 1
    turns.push(...archive.turns)
  }
  return { turns, files }
}

// The App stores a captured body under an app-owned root derived from the authorized cwd. The path
// is re-derived here and the digest is verified, so a wrong layout fails loudly instead of scoring.
function appTraceContentPath(userData, cwd, ref) {
  return join(userData, 'trace-content-v1', hash(cwd), 'content', 'sha256', ref.sha256.slice(0, 2), `${ref.sha256}.bin`)
}

export function readRawContent(userData, cwd, ref) {
  if (!ref || typeof ref.sha256 !== 'string') return { status: 'no-content-ref' }
  let bytes
  try { bytes = readFileSync(appTraceContentPath(userData, cwd, ref)) } catch (error) {
    return { status: 'missing-content-blob', error: String(error && error.message) }
  }
  const text = bytes.toString('utf8')
  const payloadRun = (text.match(/x+/g) ?? []).reduce((longest, run) => Math.max(longest, run.length), 0)
  return { status: 'read', bytes: bytes.length, sha256Match: hash(bytes) === ref.sha256,
    payloadRun, tailPresent: text.endsWith(TAIL_MARKER) }
}

export function extractEvidence(turn, raw) {
  const items = Array.isArray(turn.items) ? turn.items : []
  const modelText = items.filter(item => item.kind === 'model' && (item.stage === 'text' || item.stage === 'text_delta'))
    .map(item => (typeof item.text === 'string' ? item.text : '')).join('')
  const toolResults = items.filter(item => item.kind === 'tool' && item.stage === 'tool_result')
  const last = toolResults.at(-1)
  const content = last && last.outputContent ? last.outputContent : null
  const contentRef = content && content.contentRef ? content.contentRef : null
  return {
    userText: turn.userText, done: turn.done === true,
    modelTextChars: modelText.length,
    streamSections: (modelText.match(/## Section \d+/g) ?? []).length,
    streamTokens: modelText.split('stream').length - 1,
    toolResultCount: toolResults.length,
    toolResult: last ? {
      textChars: typeof last.text === 'string' ? last.text.length : 0,
      savedBytes: content && Number.isFinite(content.savedBytes) ? content.savedBytes : null,
      storage: content && typeof content.storage === 'string' ? content.storage : null,
      contentRef: contentRef ? { sha256: contentRef.sha256, bytes: contentRef.bytes, encoding: contentRef.encoding } : null
    } : null,
    toolResultBytes: contentRef && Number.isFinite(contentRef.bytes) ? contentRef.bytes
      : content && Number.isFinite(content.savedBytes) ? content.savedBytes : 0,
    raw
  }
}
