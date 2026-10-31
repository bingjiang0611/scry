// Independent content oracle for the live concurrency trace lane (R6.3).
//
// The expected trace is written here as a literal policy: 1000 harness events, their
// exact ids/text/kind/stage/runId/order, then the one visible marker with its exact id
// and text. Nothing in this file imports the production merge/projection/hash code, so a
// broken projection cannot agree with its own oracle.
//
// Static vs dynamic boundary: the seed and marker policy below is static; cwd, provider,
// external session id and run identity are dynamic and are checked against the launcher's
// own host evidence, passed in as `identity`. A view is never accepted on content alone.
import { PROMPT, ROUNDS_PER_VISIT, SEED_COUNT } from './concurrency-trace-live-plan.mjs'

export const MARKER_TEXT = 'concurrency trace ready'
export const MARKER_KIND = 'model'
export const MARKER_STAGE = 'text'
export const SEED_KIND = 'harness'
export const SEED_STAGE = 'runtime:progress'

/**
 * Harness events the current source emits in addition to the seeds and the marker. Their
 * presence and counts are checked, so "we kept every event" is a measured claim instead of
 * a length lower bound. Unknown extra stages are reported, never dropped.
 */
export const KNOWN_EXTRA_STAGES = Object.freeze([
  // Stage names carry the bootstrap `runtime:` prefix (src/main/bootstrap/run-live-state.ts,
  // run-provider.ts). They are complete stage strings, not bare suffixes.
  Object.freeze({ stage: 'runtime:controls', count: 1 }),
  Object.freeze({ stage: 'runtime:steer_capability', count: 1 }),
  Object.freeze({ stage: 'runtime:input_receipt', count: 2 })
])

/** Fields that legitimately grow between polls and must not be compared for equality. */
const VOLATILE_KEYS = ['llmPerformance']

export function seedLabel(index) {
  return String(index).padStart(4, '0')
}

export function seedText(index) {
  return `concurrency trace seed ${seedLabel(index)}`
}

export function seedId(runId, index) {
  return `${runId}:concurrency-trace:${seedLabel(index)}`
}

export function markerId(runId) {
  return `${runId}:concurrency-trace-ready`
}

/** The 1000 expected events, from 1 to SEED_COUNT in order. */
export function buildSeedOracle(runId) {
  if (typeof runId !== 'string' || runId.length === 0) throw new Error('concurrency-trace-live oracle needs a run id')
  return Array.from({ length: SEED_COUNT }, (_, offset) => {
    const index = offset + 1
    return { index, id: seedId(runId, index), text: seedText(index), kind: SEED_KIND, stage: SEED_STAGE, runId }
  })
}

const isSeedText = (text) => typeof text === 'string' && /^concurrency trace seed \d{4}$/.test(text)

const isSeedItem = (item) => !!item && item.kind === SEED_KIND && isSeedText(item.text)

const hasValidTimestamp = (item) => typeof item.ts === 'string' && item.ts.length > 0 && !Number.isNaN(Date.parse(item.ts))

/**
 * Compares the seed subsequence with the literal oracle, including the event's own runId
 * and a parseable timestamp. App harness events may sit between seeds, so this checks the
 * relative order and every field of the seeds themselves rather than absolute indices.
 */
export function verifySeedSequence(items, runId) {
  const issues = []
  const oracle = buildSeedOracle(runId)
  const seeds = []
  const ids = new Set()
  const duplicates = []
  for (const item of items) {
    if (!item || typeof item !== 'object') { issues.push('item is not an object'); continue }
    if (ids.has(item.id)) duplicates.push(item.id)
    ids.add(item.id)
    if (isSeedItem(item)) seeds.push(item)
  }
  if (duplicates.length > 0) issues.push(`duplicate item ids: ${duplicates.slice(0, 3).join(', ')}`)
  if (seeds.length !== oracle.length) issues.push(`seed count ${seeds.length} != ${oracle.length}`)
  const length = Math.min(seeds.length, oracle.length)
  for (let index = 0; index < length; index++) {
    const actual = seeds[index]
    const expected = oracle[index]
    for (const field of ['id', 'text', 'kind', 'stage', 'runId']) {
      if (actual[field] !== expected[field]) {
        issues.push(`seed ${expected.index} ${field} ${JSON.stringify(actual[field])} != ${JSON.stringify(expected[field])}`)
        break
      }
    }
    if (!hasValidTimestamp(actual)) issues.push(`seed ${expected.index} has no parseable ts`)
    if (issues.length > 8) { issues.push('more seed differences omitted'); break }
  }
  return { ok: issues.length === 0, issues, count: seeds.length, lastSeedIndex: seeds.length > 0 ? items.indexOf(seeds.at(-1)) : -1 }
}

function markerMatches(item, runId) {
  return !!item &&
    item.id === markerId(runId) &&
    item.kind === MARKER_KIND &&
    item.stage === MARKER_STAGE &&
    item.text === MARKER_TEXT
}

/** Markers that claim to be the marker but differ in id, kind, stage or text. */
function nearMarkers(items) {
  return items.filter((item) => !!item && typeof item.text === 'string' && item.text.includes('concurrency trace ready'))
}

const isMarkerLike = (item) => !!item && typeof item.text === 'string' && item.text.includes('concurrency trace ready')

/**
 * Extra harness events that are not seeds or the marker, summarized by stage so the known
 * set can be checked by name and count and anything new is still visible.
 */
export function summarizeExtras(items, runId) {
  return items
    .filter((item) => !!item && !isSeedItem(item) && !isMarkerLike(item))
    .map((item) => ({ id: String(item.id), kind: String(item.kind), stage: String(item.stage) }))
}

function checkKnownExtras(extras) {
  const issues = []
  const byStage = new Map()
  for (const extra of extras) byStage.set(extra.stage, (byStage.get(extra.stage) ?? 0) + 1)
  for (const known of KNOWN_EXTRA_STAGES) {
    const actual = byStage.get(known.stage) ?? 0
    if (actual !== known.count) issues.push(`known extra ${known.stage} count ${actual} != ${known.count}`)
    byStage.delete(known.stage)
  }
  return { issues, unknown: [...byStage].map(([stage, count]) => ({ stage, count })) }
}

/**
 * Verifies one live view of one run: identity against host evidence, the 1000 seeds in
 * order, exactly one exact marker after the last seed, and every extra App event kept.
 */
export function verifyLiveView({ view, runId, identity, prompt = PROMPT, expectDone = false }) {
  const empty = { ok: false, seedCount: 0, markerIndex: -1, itemCount: 0, extras: [], unknownExtras: [] }
  if (!view || typeof view !== 'object') return { ...empty, issues: ['view is not an object'] }
  const issues = []
  const items = Array.isArray(view.items) ? view.items : null
  if (!items) return { ...empty, issues: ['items is not an array'] }
  if (view.runId !== runId) issues.push(`runId ${JSON.stringify(view.runId)} != ${JSON.stringify(runId)}`)
  if (typeof view.userText !== 'string' || view.userText !== prompt) issues.push(`userText is not the lane prompt: ${JSON.stringify(view.userText)}`)
  if (view.done !== expectDone) issues.push(`done ${JSON.stringify(view.done)} != ${String(expectDone)} (a live view must not be terminal)`)
  // Dynamic half of the policy: without the launcher's own host evidence a view cannot be
  // tied to the run it claims, so a missing identity is a failure, not a skipped check.
  if (!identity || typeof identity !== 'object') issues.push('host identity was not provided, so the view cannot be tied to the run it claims')
  else {
    for (const field of ['cwd', 'providerId', 'externalSessionId']) {
      const expected = identity[field]
      if (typeof expected !== 'string' || expected.length === 0) issues.push(`host identity has no ${field}`)
      else if (view[field] !== expected) issues.push(`${field} ${JSON.stringify(view[field])} != host ${JSON.stringify(expected)}`)
    }
  }
  const seeds = verifySeedSequence(items, runId)
  issues.push(...seeds.issues)
  const markers = items.filter((item) => markerMatches(item, runId))
  if (markers.length !== 1) issues.push(`exact marker count ${markers.length} != 1`)
  const near = nearMarkers(items)
  if (near.length !== markers.length) issues.push(`${near.length - markers.length} marker-like event(s) differ from the exact marker id/kind/stage/text`)
  const markerIndex = markers.length === 1 ? items.indexOf(markers[0]) : -1
  if (markerIndex >= 0 && markerIndex < seeds.lastSeedIndex) issues.push('marker appears before the last seed')
  const extras = summarizeExtras(items, runId)
  const known = checkKnownExtras(extras)
  issues.push(...known.issues)
  if (items.length !== seeds.count + near.length + extras.length) issues.push('item accounting does not add up: some events were dropped or invented')
  return {
    ok: issues.length === 0,
    issues,
    seedCount: seeds.count,
    markerIndex,
    itemCount: items.length,
    extras,
    unknownExtras: known.unknown
  }
}

function canonical(item) {
  const rest = { ...item }
  for (const key of VOLATILE_KEYS) delete rest[key]
  return JSON.stringify(rest, Object.keys(rest).sort())
}

const itemFingerprint = (view) => JSON.stringify((Array.isArray(view?.items) ? view.items : []).map(canonical))

function firstDifference(a, b) {
  const length = Math.max(a.length, b.length)
  for (let index = 0; index < length; index++) {
    if (a[index] !== b[index]) return { index, first: a[index] ?? null, other: b[index] ?? null }
  }
  return null
}

/**
 * Verifies every kept view of one visit: exactly `rounds` views, each one valid on its own,
 * the same items in the same order across rounds (excluding fields that legitimately grow),
 * and the visited run matching the launcher's host evidence.
 */
export function verifyVisitViews({ views, runId, identity, prompt = PROMPT, rounds = ROUNDS_PER_VISIT }) {
  const base = { ok: false, issues: [], views: [], seedIdentical: false, itemsIdentical: false, differences: [] }
  if (!Array.isArray(views) || views.length === 0) return { ...base, issues: ['no published views were kept for this visit'] }
  const issues = []
  // Exactly one published view per round: fewer means a round did not commit a run, more
  // means the ledger kept something it should have released.
  if (views.length !== rounds) issues.push(`published view count ${views.length} != ${rounds}`)
  const perView = views.map((view, index) => ({ index, ...verifyLiveView({ view, runId, identity, prompt }) }))
  for (const result of perView) for (const issue of result.issues) issues.push(`view ${result.index}: ${issue}`)
  const seeds = new Set(views.map((view) => JSON.stringify(Array.isArray(view?.items) ? view.items.filter(isSeedItem).map(canonical) : [])))
  const seedIdentical = seeds.size === 1
  if (!seedIdentical) issues.push(`seed sequence differs across ${views.length} views`)
  const fingerprints = views.map(itemFingerprint)
  const itemsIdentical = new Set(fingerprints).size === 1
  const differences = itemsIdentical ? [] : (() => {
    const anchor = JSON.parse(fingerprints[0])
    const found = []
    for (let index = 1; index < fingerprints.length && found.length < 4; index++) {
      const difference = firstDifference(anchor, JSON.parse(fingerprints[index]))
      if (difference) found.push({ view: index, ...difference })
    }
    return found
  })()
  if (!itemsIdentical) issues.push(`item content/order differs across ${views.length} views (volatile keys ignored: ${VOLATILE_KEYS.join(', ')})`)
  return {
    ok: issues.length === 0,
    issues,
    seedIdentical,
    itemsIdentical,
    differences,
    views: perView.map(({ index, seedCount, markerIndex, itemCount, extras, unknownExtras }) => ({ index, seedCount, markerIndex, itemCount, extras, unknownExtras }))
  }
}

/**
 * Verifies the archived turn of one run with the same literal policy. The archive is what
 * the recorder persisted, so the seeds and the exact marker are required; `minimumExtras`
 * lets the launcher require that the archive kept the live harness events too. Extras are
 * reported so presence, not just a length, can be reviewed.
 */
export function verifyArchiveTurn({ turn, runId, prompt = PROMPT, minimumExtras = null }) {
  const issues = []
  if (typeof runId !== 'string' || runId.length === 0) throw new Error('concurrency-trace-live archive check needs the host run id')
  if (!turn || typeof turn !== 'object') return { ok: false, issues: ['archived turn is missing'], seedCount: 0, markerPresent: false, extras: [] }
  if (typeof turn.userText !== 'string' || turn.userText !== prompt) issues.push(`archived userText is not the lane prompt: ${JSON.stringify(turn.userText)}`)
  if (turn.done !== true) issues.push(`archived done ${JSON.stringify(turn.done)} != true`)
  if (turn.runId !== undefined && turn.runId !== runId) issues.push(`archived runId ${JSON.stringify(turn.runId)} != ${JSON.stringify(runId)}`)
  const items = Array.isArray(turn.items) ? turn.items : null
  if (!items) return { ok: false, issues: [...issues, 'archived items is not an array'], seedCount: 0, markerPresent: false, extras: [] }
  const seeds = verifySeedSequence(items, runId)
  issues.push(...seeds.issues)
  const markers = items.filter((item) => markerMatches(item, runId))
  if (markers.length !== 1) issues.push(`archived exact marker count ${markers.length} != 1`)
  const extras = summarizeExtras(items, runId)
  if (minimumExtras) {
    const byStage = new Map()
    for (const extra of extras) byStage.set(extra.stage, (byStage.get(extra.stage) ?? 0) + 1)
    for (const known of minimumExtras) {
      const actual = byStage.get(known.stage) ?? 0
      if (actual < known.count) issues.push(`archived extra ${known.stage} count ${actual} < ${known.count} (the archive dropped events the live run had)`)
    }
  }
  return { ok: issues.length === 0, issues, seedCount: seeds.count, markerPresent: markers.length === 1, extras }
}

/**
 * Archive entry with provenance. The durable contract is per run, not per root: every
 * expected run must exist in at least one real source and pass the content check.
 *
 * A root that does not exist is reported with `rootPresent: false` and an unavailable
 * reason — that is missing evidence, never an empty success — but a missing root does not
 * invalidate another root's complete archive. A fresh live run writes the turn archive
 * (`trace-archive-turns-v1`) and legitimately has no legacy monolithic root when no seeded
 * history exists. A run found in both roots must agree; a disagreement is reported.
 */
export function verifyArchiveEntry({ entry, archive, runId, prompt = PROMPT, minimumExtras = null }) {
  const issues = []
  const roots = Array.isArray(archive?.roots) ? archive.roots : []
  if (!archive) issues.push('archive was not read')
  else if (roots.length === 0) issues.push('no archive root was inspected')
  const sourcesDetail = roots.map((root) => (root.present === true
    ? { name: root.name, rootPresent: true, status: 'present', segments: root.segments ?? null }
    : { name: root.name, rootPresent: false, status: 'unavailable', reason: 'root_missing' }))
  const present = sourcesDetail.filter((root) => root.rootPresent)
  if (archive && roots.length > 0 && present.length === 0) {
    issues.push(`no archive root is present (${sourcesDetail.map((root) => root.name).join(', ')}), so the run has no durable source`)
  }
  if (!entry) issues.push(`run ${runId} is absent from every present archive root (missing: ${JSON.stringify(archive?.missing ?? [])})`)
  if (entry && (!Array.isArray(entry.sources) || entry.sources.length === 0)) issues.push(`run ${runId} has no archive provenance`)
  const variants = Array.isArray(entry?.variants) ? entry.variants : []
  const fingerprint = (turn) => JSON.stringify({ done: turn?.done, userText: turn?.userText, items: Array.isArray(turn?.items) ? turn.items : null })
  const differing = variants.length > 1 && new Set(variants.map((variant) => fingerprint(variant.turn))).size > 1
  if (differing) issues.push(`run ${runId} differs between archive sources (${variants.map((variant) => variant.source).join(' + ')})`)
  const verified = entry ? verifyArchiveTurn({ turn: entry.turn, runId, prompt, minimumExtras }) : { ok: false, issues: [], seedCount: 0, markerPresent: false, extras: [] }
  return {
    ok: issues.length === 0 && verified.ok,
    issues: [...issues, ...verified.issues],
    sources: entry?.sources ?? [],
    sourcesDetail,
    absentSources: sourcesDetail.filter((root) => !root.rootPresent).map((root) => root.name),
    duplicates: { count: entry?.sources?.length ?? 0, consistent: variants.length > 1 ? !differing : null },
    seedCount: verified.seedCount,
    markerPresent: verified.markerPresent,
    extras: verified.extras
  }
}

/**
 * Cross-checks the two independent attempt counters: the renderer counts every read it
 * issues, main counts every read it forwards after authority checks. A renderer count
 * above main means a read was refused before the client; below is impossible.
 */
export function reconcileAttempts({ rendererCalls, mainAttempts }) {
  const issues = []
  const methods = [...new Set([...Object.keys(rendererCalls ?? {}), ...Object.keys(mainAttempts ?? {})])].sort()
  const differences = []
  for (const method of methods) {
    const renderer = rendererCalls?.[method] ?? 0
    const main = mainAttempts?.[method] ?? 0
    if (renderer !== main) { differences.push({ method, renderer, main }); issues.push(`${method}: renderer ${renderer} != main ${main}`) }
  }
  return { ok: issues.length === 0, issues, differences, methods: methods.length }
}
