#!/usr/bin/env node
/**
 * P4-1 startup legacy import benchmark (S3 reproducible script).
 *
 * Measures:
 *   1. Pre-`openLocalChannel` synchronous blocking time (`EventSink.open` + single
 *      `loadLegacyLedgerPlan` + `openOnly` sync import).
 *   2. Post-`openLocalChannel` deferred backfill (`startDeferredLegacyImport` in 100-run
 *      yielding batches) wall time and per-batch event-loop pauses (P50 / P95 / Max).
 *   3. Subsequent no-op startup parse time after `legacy_ledger_seq` has caught up.
 *
 * Datasets (default runs all 3; pass `--only snapshot|jsonl|conversations` to filter):
 *   - `100k-snapshot-plus-tail`: 99,500 runs in `session-ledger.snapshot.json` + 500 in
 *     `session-ledger.log` (1 open dispatched run), ~300 B prompt, no conversation files.
 *   - `100k-pure-jsonl`: 100,000 runs (300,000 lines) in `session-ledger.log` (1 open
 *     dispatched run), ~300 B prompt, no conversation files.
 *   - `1000-convs-20k-runs`: 1,000 H3 `<userData>/conversations/<id>.json` files on disk,
 *     20,000 pre-fix conversation runs (omitting `ordinal` in H1 detail, ~300 B prompt)
 *     in `session-ledger.log` (1 open dispatched run), exercising real H3 ordinal lookup.
 */
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { cpus, loadavg, platform, release, tmpdir } from 'node:os'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const onlyIdx = args.indexOf('--only')
const onlyCase = onlyIdx >= 0 ? args[onlyIdx + 1] : null
const promptBytesIdx = args.indexOf('--prompt-bytes')
const PROMPT_BYTES = promptBytesIdx >= 0 ? Math.max(16, Number(args[promptBytesIdx + 1]) || 300) : 300

function pct(sorted, p) {
  if (sorted.length === 0) return 0
  const idx = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))
  return Number(sorted[idx].toFixed(2))
}

function makePrompt(prefix, index) {
  const head = `${prefix} #${index} `
  return head.length >= PROMPT_BYTES ? head.slice(0, PROMPT_BYTES) : head + 'x'.repeat(PROMPT_BYTES - head.length)
}

async function loadOrchestrationModules() {
  // Place temporary bundle under node_modules/.cache so Node resolves better-sqlite3 without NODE_PATH.
  const cacheRoot = join(repoRoot, 'node_modules', '.cache')
  mkdirSync(cacheRoot, { recursive: true })
  const bundleDir = mkdtempSync(join(cacheRoot, 'scry-orch-bench-bundle-'))
  const entry = join(bundleDir, 'entry.ts')
  const out = join(bundleDir, 'bundle.mjs')
  writeFileSync(
    entry,
    [
      `export { EventSink } from ${JSON.stringify(join(repoRoot, 'src/host-runtime/orchestration/event-sink.ts'))}`,
      `export { importLegacyStateIncrementally, loadLegacyLedgerPlan, loadLegacyLedgerPlanAsync, startDeferredLegacyImport } from ${JSON.stringify(join(repoRoot, 'src/host-runtime/orchestration/legacy-import.ts'))}`
    ].join('\n')
  )
  await build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'esm',
    external: ['better-sqlite3'],
    outfile: out
  })
  const mod = await import(pathToFileURL(out).href)
  return { mod, cleanup: () => rmSync(bundleDir, { recursive: true, force: true }) }
}

function writeConversationFile(conversationsDir, convId, cwd, turnRunIds) {
  const turns = turnRunIds.map((runId, idx) => ({
    origin: 'dispatch',
    ordinal: idx + 1,
    runId,
    bindingId: 'b-1',
    commandId: randomUUID(),
    intentHash: 'a'.repeat(64),
    resumeSessionId: idx === 0 ? null : `native-${convId}`,
    items: [],
    importedItems: [],
    omittedItems: [],
    delivery: { status: 'accepted', nativeSessionId: `native-${convId}`, outcome: 'completed', nativeItems: [] }
  }))
  writeFileSync(
    join(conversationsDir, `${convId}.json`),
    JSON.stringify({
      version: 1,
      id: convId,
      cwd,
      revision: turns.length + 1,
      bindings: [{ id: 'b-1', providerId: 'codex', continuationKey: 'codex:default', nativeSessionId: `native-${convId}` }],
      turns
    }),
    { mode: 0o600 }
  )
}

async function runDataset(mod, spec) {
  const root = mkdtempSync(join(tmpdir(), `scry-import-bench-${spec.name}-`))
  const ledgerDir = join(root, 'remote', 'ledger')
  mkdirSync(ledgerDir, { recursive: true, mode: 0o700 })
  const t0 = 1_700_000_000_000
  let seq = 0
  let conversationFiles = 0

  if (spec.mode === 'snapshot_plus_tail') {
    const snapRuns = spec.totalRuns - 500
    const runs = []
    for (let i = 0; i < snapRuns; i += 1) {
      const intentSeq = ++seq
      seq += 2
      runs.push({
        runId: randomUUID(),
        lifecycle: 'settled',
        intentId: randomUUID(),
        intentSeq,
        intentAt: t0 + i,
        intentDetail: JSON.stringify({ providerId: 'codex', cwd: '/tmp/ws-bench', prompt: makePrompt('snap', i) })
      })
    }
    writeFileSync(join(ledgerDir, 'session-ledger.snapshot.json'), JSON.stringify({ snapshot: { lastSeq: seq, runs } }), { mode: 0o600 })
    const tail = []
    for (let i = 0; i < 499; i += 1) {
      const runId = randomUUID()
      tail.push(
        JSON.stringify({ seq: ++seq, at: t0 + snapRuns + i, runId, kind: 'intent_recorded', intentId: randomUUID(), detail: JSON.stringify({ providerId: 'codex', cwd: '/tmp/ws-bench', prompt: makePrompt('tail', i) }) }),
        JSON.stringify({ seq: ++seq, at: t0 + snapRuns + i + 1, runId, kind: 'run_dispatched' }),
        JSON.stringify({ seq: ++seq, at: t0 + snapRuns + i + 2, runId, kind: 'run_settled' })
      )
    }
    const openRunId = randomUUID()
    tail.push(
      JSON.stringify({ seq: ++seq, at: t0 + spec.totalRuns, runId: openRunId, kind: 'intent_recorded', intentId: randomUUID(), detail: JSON.stringify({ providerId: 'codex', cwd: '/tmp/ws-bench', prompt: makePrompt('open', 0) }) }),
      JSON.stringify({ seq: ++seq, at: t0 + spec.totalRuns + 1, runId: openRunId, kind: 'run_dispatched' })
    )
    writeFileSync(join(ledgerDir, 'session-ledger.log'), `${tail.join('\n')}\n`, { mode: 0o600 })
  } else if (spec.mode === 'pure_jsonl') {
    const chunks = []
    let buf = []
    for (let i = 0; i < spec.totalRuns - 1; i += 1) {
      const runId = randomUUID()
      buf.push(
        JSON.stringify({ seq: ++seq, at: t0 + i, runId, kind: 'intent_recorded', intentId: randomUUID(), detail: JSON.stringify({ providerId: 'codex', cwd: '/tmp/ws-bench', prompt: makePrompt('jsonl', i) }) }),
        JSON.stringify({ seq: ++seq, at: t0 + i + 1, runId, kind: 'run_dispatched' }),
        JSON.stringify({ seq: ++seq, at: t0 + i + 2, runId, kind: 'run_settled' })
      )
      if (buf.length >= 6_000) {
        chunks.push(buf.join('\n'))
        buf = []
      }
    }
    const openRunId = randomUUID()
    buf.push(
      JSON.stringify({ seq: ++seq, at: t0 + spec.totalRuns, runId: openRunId, kind: 'intent_recorded', intentId: randomUUID(), detail: JSON.stringify({ providerId: 'codex', cwd: '/tmp/ws-bench', prompt: makePrompt('open', 0) }) }),
      JSON.stringify({ seq: ++seq, at: t0 + spec.totalRuns + 1, runId: openRunId, kind: 'run_dispatched' })
    )
    chunks.push(buf.join('\n'))
    writeFileSync(join(ledgerDir, 'session-ledger.log'), `${chunks.join('\n')}\n`, { mode: 0o600 })
  } else if (spec.mode === 'conversations_jsonl') {
    const convDir = join(root, 'conversations')
    mkdirSync(convDir, { recursive: true, mode: 0o700 })
    const numConvs = spec.conversations
    const turnsPerConv = Math.floor((spec.totalRuns - 1) / numConvs)
    const convIds = Array.from({ length: numConvs }, () => randomUUID())
    const runIdsByConv = convIds.map(() => Array.from({ length: turnsPerConv }, () => randomUUID()))
    for (let c = 0; c < numConvs; c += 1) {
      writeConversationFile(convDir, convIds[c], '/tmp/ws-bench', runIdsByConv[c])
    }
    conversationFiles = numConvs
    // Interleave turns across all 1,000 conversations (worst-case working set for ordinal lookup cache!)
    const chunks = []
    let buf = []
    let idx = 0
    for (let turn = 0; turn < turnsPerConv; turn += 1) {
      for (let c = 0; c < numConvs; c += 1) {
        const ledgerRunId = randomUUID()
        const canonicalRunId = runIdsByConv[c][turn]
        buf.push(
          JSON.stringify({
            seq: ++seq,
            at: t0 + idx,
            runId: ledgerRunId,
            kind: 'intent_recorded',
            intentId: randomUUID(),
            detail: JSON.stringify({
              providerId: 'codex',
              cwd: '/tmp/ws-bench',
              prompt: makePrompt('conv', idx),
              conversation: { conversationId: convIds[c], runId: canonicalRunId }
            })
          }),
          JSON.stringify({ seq: ++seq, at: t0 + idx + 1, runId: ledgerRunId, kind: 'run_dispatched' }),
          JSON.stringify({ seq: ++seq, at: t0 + idx + 2, runId: ledgerRunId, kind: 'run_settled' })
        )
        idx += 1
        if (buf.length >= 6_000) {
          chunks.push(buf.join('\n'))
          buf = []
        }
      }
    }
    const openRunId = randomUUID()
    buf.push(
      JSON.stringify({ seq: ++seq, at: t0 + idx + 10, runId: openRunId, kind: 'intent_recorded', intentId: randomUUID(), detail: JSON.stringify({ providerId: 'codex', cwd: '/tmp/ws-bench', prompt: makePrompt('open', 0) }) }),
      JSON.stringify({ seq: ++seq, at: t0 + idx + 11, runId: openRunId, kind: 'run_dispatched' })
    )
    chunks.push(buf.join('\n'))
    writeFileSync(join(ledgerDir, 'session-ledger.log'), `${chunks.join('\n')}\n`, { mode: 0o600 })
  }

  try {
    const loadBefore = Number(loadavg()[0].toFixed(2))
    const preStart = performance.now()
    const sink = mod.EventSink.open({ userDataDir: root, fullfsync: false, checkpointFullfsync: true })
    const afterOpen = performance.now()
    // Use monitorEventLoopDelay + a trailing setImmediate tick so structured-clone deserialization
    // stalls at the end of `loadLegacyLedgerPlanAsync` are ALWAYS captured (W9 Must-Fix 8).
    const parseMonitor = monitorEventLoopDelay({ resolution: 1 })
    parseMonitor.enable()
    const plan = await mod.loadLegacyLedgerPlanAsync(sink, root)
    await new Promise((r) => setImmediate(r))
    parseMonitor.disable()
    const afterPlan = performance.now()
    const openSummary = mod.importLegacyStateIncrementally({
      sink,
      userDataDir: root,
      now: t0 + 500_000,
      reconcileOpenRuns: false,
      shadowOnly: true,
      openOnly: true,
      plan
    })
    const afterOpenImport = performance.now()

    const checkpointDurations = []
    let walPeakBytes = sink.walFileBytes()
    const recordWal = (bytes) => {
      if (bytes > walPeakBytes) walPeakBytes = bytes
    }
    sink.setCheckpointObserver((sample) => {
      checkpointDurations.push(sample.durationMs)
      recordWal(sample.walBytesBefore)
      recordWal(sample.walBytesAfter)
    })
    const walSampler = setInterval(() => {
      recordWal(sink.walFileBytes())
    }, 10)
    const backfillMonitor = monitorEventLoopDelay({ resolution: 1 })
    backfillMonitor.enable()
    const postStart = performance.now()
    const deferred = mod.startDeferredLegacyImport({
      sink,
      userDataDir: root,
      now: t0 + 500_000,
      reconcileOpenRuns: false,
      shadowOnly: true,
      plan
    })
    const deferredSummary = await deferred.promise
    await new Promise((r) => setImmediate(r))
    const postEnd = performance.now()
    backfillMonitor.disable()
    clearInterval(walSampler)
    recordWal(sink.walFileBytes())
    sink.setCheckpointObserver(undefined)

    const noopStart = performance.now()
    const noopPlan = await mod.loadLegacyLedgerPlanAsync(sink, root)
    const noopEnd = performance.now()
    sink.close()

    const nsToMs = (ns) => Number((Math.max(0, ns) / 1e6).toFixed(2))
    const sortedCkpt = [...checkpointDurations].sort((a, b) => a - b)
    const ckptTotalMs = Number(checkpointDurations.reduce((acc, v) => acc + v, 0).toFixed(2))
    return {
      case: spec.name,
      shape: {
        mode: spec.mode,
        totalRuns: plan.unimportedRuns.length,
        promptBytes: PROMPT_BYTES,
        conversationFiles,
        interleavedAcrossConversations: spec.mode === 'conversations_jsonl'
      },
      loadBefore,
      loadAfter: Number(loadavg()[0].toFixed(2)),
      expectedLastSeq: seq,
      preSocket: {
        openDbMs: Number((afterOpen - preStart).toFixed(2)),
        parsePlanOnceMs: Number((afterPlan - afterOpen).toFixed(2)),
        parseMainThreadMaxLagMs: nsToMs(parseMonitor.max),
        parseMainThreadP95LagMs: nsToMs(parseMonitor.percentile(95)),
        importOpenRunsMs: Number((afterOpenImport - afterPlan).toFixed(2)),
        totalPreSocketBlockMs: Number((afterOpenImport - preStart).toFixed(2)),
        importedOpenRuns: openSummary.importedRuns
      },
      postSocketDeferred: {
        wallMs: Number((postEnd - postStart).toFixed(2)),
        importedRuns: deferredSummary.importedRuns,
        rejectedCommands: deferredSummary.rejectedCommands,
        finalLegacyLedgerSeq: deferredSummary.legacyLedgerSeq,
        walPeakBytes,
        walPeakMiB: Number((walPeakBytes / (1024 * 1024)).toFixed(2)),
        checkpoints: {
          count: checkpointDurations.length,
          pauseMs: {
            p50: pct(sortedCkpt, 0.5),
            p95: pct(sortedCkpt, 0.95),
            max: sortedCkpt.length > 0 ? Number(sortedCkpt[sortedCkpt.length - 1].toFixed(2)) : 0,
            total: ckptTotalMs
          }
        },
        eventLoopPauseMs: {
          p50: nsToMs(backfillMonitor.percentile(50)),
          p95: nsToMs(backfillMonitor.percentile(95)),
          max: nsToMs(backfillMonitor.max)
        }
      },
      subsequentStartupNoopPlanMs: Number((noopEnd - noopStart).toFixed(2)),
      subsequentUnimportedCount: noopPlan.unimportedRuns.length
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

async function main() {
  const { mod, cleanup } = await loadOrchestrationModules()
  try {
    const allSpecs = [
      { key: 'snapshot', name: '100k-snapshot-plus-tail', mode: 'snapshot_plus_tail', totalRuns: 100_000 },
      { key: 'jsonl', name: '100k-pure-jsonl', mode: 'pure_jsonl', totalRuns: 100_000 },
      { key: 'conversations', name: '1000-convs-20k-runs', mode: 'conversations_jsonl', totalRuns: 20_001, conversations: 1_000 }
    ]
    const specs = onlyCase ? allSpecs.filter((s) => s.key === onlyCase) : allSpecs
    const results = []
    for (const spec of specs) {
      results.push(await runDataset(mod, spec))
    }
    process.stdout.write(
      `${JSON.stringify(
        {
          measuredAt: new Date().toISOString(),
          host: { platform: platform(), release: release(), node: process.version, cores: cpus().length },
          promptBytes: PROMPT_BYTES,
          results
        },
        null,
        2
      )}\n`
    )
  } finally {
    cleanup()
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
