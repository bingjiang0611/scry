import { beforeAll, describe, expect, it } from 'vitest'

interface Seed { index: number; id: string; text: string; kind: string; stage: string; runId: string }
interface Extra { stage: string }
interface ViewIssue {
  ok: boolean
  issues: string[]
  seedCount: number
  markerIndex?: number
  itemCount?: number
  extras?: Extra[]
  unknownExtras?: Extra[]
}
interface VisitIssue {
  ok: boolean
  issues: string[]
  seedIdentical: boolean
  itemsIdentical: boolean
  views: ViewIssue[]
}
interface Identity { cwd: string; providerId: string; externalSessionId: string }
interface OracleModule {
  MARKER_TEXT: string
  MARKER_KIND: string
  MARKER_STAGE: string
  KNOWN_EXTRA_STAGES: ReadonlyArray<{ stage: string; count: number }>
  buildSeedOracle(runId: string): Seed[]
  seedId(runId: string, index: number): string
  seedText(index: number): string
  markerId(runId: string): string
  verifySeedSequence(items: unknown[], runId: string): { ok: boolean; issues: string[]; count: number }
  verifyLiveView(input: { view: unknown; runId: string; identity: Identity | null; prompt?: string; expectDone?: boolean }): ViewIssue
  verifyVisitViews(input: { views: unknown[]; runId: string; identity: Identity | null; prompt?: string; rounds?: number }): VisitIssue
  verifyArchiveTurn(input: { turn: unknown; prompt?: string; runId?: string; minimumExtras?: ReadonlyArray<{ stage: string; count: number }> }): { ok: boolean; issues: string[]; seedCount: number; markerPresent: boolean; extras: Extra[] }
  verifyArchiveEntry(input: { entry: unknown; archive: unknown; runId: string; prompt?: string; minimumExtras?: ReadonlyArray<{ stage: string; count: number }> }): {
    ok: boolean
    issues: string[]
    sources: string[]
    sourcesDetail: Array<{ name: string; rootPresent: boolean; status: string; reason?: string }>
    absentSources: string[]
    duplicates: { count: number; consistent: boolean | null }
  }
  reconcileAttempts(input: { rendererCalls?: Record<string, number>; mainAttempts?: Record<string, number> }): { ok: boolean; issues: string[]; differences: Array<{ method: string; renderer: number; main: number }> }
}

interface PlanModule { PROMPT: string; ROUNDS_PER_VISIT: number; SEED_COUNT: number }

let oracle: OracleModule
let plan: PlanModule
beforeAll(async () => {
  oracle = await import(new URL('./fixtures/concurrency-trace-live-oracle.mjs', import.meta.url).href) as OracleModule
  plan = await import(new URL('./fixtures/concurrency-trace-live-plan.mjs', import.meta.url).href) as PlanModule
})

const RUN = 'run-fixture-1'
const IDENTITY: Identity = { cwd: '/tmp/concurrency-trace-live/task-00', providerId: 'codex', externalSessionId: 'ext-session-1' }

// The real App emits these harness events next to the seeds; each is checked by name and
// count, so "every event was kept" is measured instead of assumed.
const EXTRA_ITEMS = [
  { id: `${RUN}:controls`, kind: 'harness', stage: 'runtime:controls', text: 'controls' },
  { id: `${RUN}:steer`, kind: 'harness', stage: 'runtime:steer_capability', text: 'steer' },
  { id: `${RUN}:receipt-1`, kind: 'harness', stage: 'runtime:input_receipt', text: 'receipt 1' },
  { id: `${RUN}:receipt-2`, kind: 'harness', stage: 'runtime:input_receipt', text: 'receipt 2' }
]

/**
 * The expected extras written out independently, from the archive of a real run and from the
 * bootstrap stages in src/main/bootstrap/run-live-state.ts / run-provider.ts. Deliberately not
 * derived from KNOWN_EXTRA_STAGES: an expectation generated from the value under test would
 * agree with a wrong value, which is exactly how a bare 'controls' slipped through.
 */
const EXPECTED_EXTRAS = [
  { stage: 'runtime:controls', count: 1 },
  { stage: 'runtime:steer_capability', count: 1 },
  { stage: 'runtime:input_receipt', count: 2 }
]

const at = (index: number) => new Date(Date.UTC(2026, 9, 15, 12, 0, 0, index)).toISOString()

const seedItems = (runId = RUN, count = 1000) =>
  oracle.buildSeedOracle(runId).slice(0, count).map(({ id, kind, stage, text }) => ({ id, kind, stage, text, runId, ts: at(0) }))

const markerItem = (runId = RUN) => ({ id: oracle.markerId(runId), kind: 'model', stage: 'text', text: oracle.MARKER_TEXT, runId, ts: at(1) })

const items = ({ runId = RUN, count = 1000, extras = EXTRA_ITEMS, marker = true } = {}): Array<Record<string, unknown>> => [
  ...seedItems(runId, count),
  ...(marker ? [markerItem(runId)] : []),
  ...extras
]

const liveView = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  runId: RUN,
  userText: 'concurrency trace live',
  done: false,
  ...IDENTITY,
  items: items(),
  ...overrides
})

const sevenViews = (view: Record<string, unknown> = liveView()) => Array.from({ length: plan.ROUNDS_PER_VISIT }, () => structuredClone(view))

describe('concurrency trace live content oracle', () => {
  it('writes the expected trace as a literal policy, not by copying a response', () => {
    const expected = oracle.buildSeedOracle(RUN)
    expect(plan.SEED_COUNT).toBe(1000)
    expect(expected).toHaveLength(1000)
    expect(expected[0]).toMatchObject({ id: `${RUN}:concurrency-trace:0001`, text: 'concurrency trace seed 0001', kind: 'harness', stage: 'runtime:progress', runId: RUN })
    expect(expected[999]).toMatchObject({ id: `${RUN}:concurrency-trace:1000`, text: 'concurrency trace seed 1000' })
    expect(oracle.seedText(7)).toBe('concurrency trace seed 0007')
    expect(oracle.seedId(RUN, 7)).toBe(`${RUN}:concurrency-trace:0007`)
    expect(new Set(expected.map((seed) => seed.id)).size).toBe(1000)
    expect(() => oracle.buildSeedOracle('')).toThrow(/needs a run id/)
  })

  it('accepts a live view with the 1000 seeds, the exact marker and every real App extra', () => {
    const result = oracle.verifyLiveView({ view: liveView(), runId: RUN, identity: IDENTITY })
    expect(result.issues).toEqual([])
    expect(result).toMatchObject({ ok: true, seedCount: 1000, itemCount: 1005 })
    expect(result.extras?.map((extra) => extra.stage).sort()).toEqual(['runtime:controls', 'runtime:input_receipt', 'runtime:input_receipt', 'runtime:steer_capability'])
  })

  it('declares exactly the extras the production bootstrap stages emit', () => {
    // This is the independent expectation check: KNOWN_EXTRA_STAGES must match the raw literal
    // above, so a bare stage name ('controls' instead of 'runtime:controls') fails here even
    // though every other extras assertion is written against the same literal.
    expect(oracle.KNOWN_EXTRA_STAGES).toEqual(EXPECTED_EXTRAS)
  })

  it('rejects the seed sequence when a seed is wrong, missing, reordered or duplicated', () => {
    const wrong = items()
    wrong[4] = { ...wrong[4], text: 'concurrency trace seed 9999' }
    expect(oracle.verifyLiveView({ view: liveView({ items: wrong }), runId: RUN, identity: IDENTITY }).issues.join()).toMatch(/seed 5 text/)

    const reordered = items()
    const [first, second] = [reordered[0], reordered[1]]
    reordered[0] = second
    reordered[1] = first
    expect(oracle.verifyLiveView({ view: liveView({ items: reordered }), runId: RUN, identity: IDENTITY }).issues.join()).toMatch(/seed 1 id/)

    expect(oracle.verifyLiveView({ view: liveView({ items: items({ count: 999 }) }), runId: RUN, identity: IDENTITY }).issues.join()).toMatch(/seed count 999 != 1000/)
    expect(oracle.verifyLiveView({ view: liveView({ items: items({ runId: 'other-run' }) }), runId: RUN, identity: IDENTITY }).ok).toBe(false)

    const duplicated = items()
    duplicated.push({ ...duplicated[0] })
    expect(oracle.verifyLiveView({ view: liveView({ items: duplicated }), runId: RUN, identity: IDENTITY }).issues.join()).toMatch(/duplicate item ids/)
  })

  it('requires the event fields the real trace carries, not just id and text', () => {
    const noRunId = items()
    noRunId[0] = { ...noRunId[0], runId: 'another-run' }
    expect(oracle.verifySeedSequence(noRunId, RUN).issues.join()).toMatch(/seed 1 runId/)

    const noTs = items()
    noTs[0] = { ...noTs[0], ts: 'not-a-date' }
    expect(oracle.verifySeedSequence(noTs, RUN).issues.join()).toMatch(/seed 1 has no parseable ts/)

    const wrongStage = items()
    wrongStage[0] = { ...wrongStage[0], stage: 'text' }
    expect(oracle.verifySeedSequence(wrongStage, RUN).issues.join()).toMatch(/seed 1 stage/)
  })

  it('rejects a marker that only looks right (the parent counterexample)', () => {
    const wr = items()
    wr[1000] = { ...wr[1000], id: 'wrong-marker-id', stage: 'wrong-stage', text: 'WRONG concurrency trace ready WRONG' }
    const issues = oracle.verifyLiveView({ view: liveView({ items: wr }), runId: RUN, identity: IDENTITY })
    expect(issues.ok).toBe(false)
    expect(issues.issues.join()).toMatch(/marker count 0 != 1/)
    expect(issues.issues.join()).toMatch(/marker-like event/)

    const missing = items({ marker: false })
    expect(oracle.verifyLiveView({ view: liveView({ items: missing }), runId: RUN, identity: IDENTITY }).issues.join()).toMatch(/marker count 0 != 1/)

    const twice = items()
    twice.push(markerItem())
    expect(oracle.verifyLiveView({ view: liveView({ items: twice }), runId: RUN, identity: IDENTITY }).issues.join()).toMatch(/marker count 2 != 1/)

    const early = [markerItem(), ...seedItems(), ...EXTRA_ITEMS]
    expect(oracle.verifyLiveView({ view: liveView({ items: early }), runId: RUN, identity: IDENTITY }).issues.join()).toMatch(/marker appears before the last seed/)
  })

  it('rejects deleted or altered App extras instead of passing a length lower bound', () => {
    const withoutControls = items({ extras: EXTRA_ITEMS.filter((extra) => extra.stage !== 'runtime:controls') })
    expect(oracle.verifyLiveView({ view: liveView({ items: withoutControls }), runId: RUN, identity: IDENTITY }).issues.join()).toMatch(/known extra runtime:controls count 0 != 1/)

    const oneReceipt = items({ extras: EXTRA_ITEMS.filter((extra) => extra.id !== `${RUN}:receipt-2`) })
    expect(oracle.verifyLiveView({ view: liveView({ items: oneReceipt }), runId: RUN, identity: IDENTITY }).issues.join()).toMatch(/known extra runtime:input_receipt count 1 != 2/)

    const renamed = items({ extras: [...EXTRA_ITEMS, { id: `${RUN}:unknown`, kind: 'harness', stage: 'brand_new', text: 'x' }] })
    const result = oracle.verifyLiveView({ view: liveView({ items: renamed }), runId: RUN, identity: IDENTITY })
    expect(result.ok).toBe(true)
    expect(result.unknownExtras).toEqual([{ stage: 'brand_new', count: 1 }])
  })

  it('rejects a view whose metadata does not match the host evidence', () => {
    expect(oracle.verifyLiveView({ view: liveView({ cwd: '/tmp/elsewhere' }), runId: RUN, identity: IDENTITY }).issues.join()).toMatch(/cwd .* != host/)
    expect(oracle.verifyLiveView({ view: liveView({ externalSessionId: 'ext-other' }), runId: RUN, identity: IDENTITY }).issues.join()).toMatch(/externalSessionId/)
    expect(oracle.verifyLiveView({ view: liveView({ providerId: 'claude' }), runId: RUN, identity: IDENTITY }).issues.join()).toMatch(/providerId/)
    expect(oracle.verifyLiveView({ view: liveView(), runId: RUN, identity: null }).issues.join()).toMatch(/host identity was not provided/)
    expect(oracle.verifyLiveView({ view: liveView({ done: true }), runId: RUN, identity: IDENTITY }).issues.join()).toMatch(/done true != false/)
    expect(oracle.verifyLiveView({ view: liveView({ userText: 'another prompt' }), runId: RUN, identity: IDENTITY }).ok).toBe(false)
    expect(oracle.verifyLiveView({ view: null, runId: RUN, identity: IDENTITY }).ok).toBe(false)
  })

  it('accepts exactly seven identical views and rejects every other count', () => {
    const result = oracle.verifyVisitViews({ views: sevenViews(), runId: RUN, identity: IDENTITY })
    expect(result.issues).toEqual([])
    expect(result).toMatchObject({ ok: true, seedIdentical: true, itemsIdentical: true })
    expect(result.views).toHaveLength(7)

    const oneView = oracle.verifyVisitViews({ views: [liveView()], runId: RUN, identity: IDENTITY })
    expect(oneView.ok).toBe(false)
    expect(oneView.issues.join()).toMatch(/published view count 1 != 7/)

    const eightViews = oracle.verifyVisitViews({ views: Array.from({ length: 8 }, () => liveView()), runId: RUN, identity: IDENTITY })
    expect(eightViews.issues.join()).toMatch(/published view count 8 != 7/)

    expect(oracle.verifyVisitViews({ views: [], runId: RUN, identity: IDENTITY }).issues).toEqual(['no published views were kept for this visit'])
  })

  it('rejects a visit whose later round silently changed one item', () => {
    const views = sevenViews()
    // Same length, same bytes except one field in round 5: content comparison must catch it.
    const round = views[4] as { items: Array<{ text: string }> }
    round.items[3].text = `${round.items[3].text} `
    const result = oracle.verifyVisitViews({ views, runId: RUN, identity: IDENTITY })
    expect(result.ok).toBe(false)
    expect(result.itemsIdentical).toBe(false)
    expect(result.issues.join()).toMatch(/item content\/order differs/)
  })

  it('ignores only the fields that legitimately grow between polls', () => {
    const views = sevenViews()
    const round = views[2] as { items: Array<Record<string, unknown>> }
    round.items[0].llmPerformance = { msToFirstChunk: 12 }
    expect(oracle.verifyVisitViews({ views, runId: RUN, identity: IDENTITY }).ok).toBe(true)
  })

  it('verifies the archived turn against the same literal policy, extras included', () => {
    const archived = { runId: RUN, userText: 'concurrency trace live', done: true, items: items() }
    const result = oracle.verifyArchiveTurn({ turn: archived, prompt: plan.PROMPT, runId: RUN, minimumExtras: EXPECTED_EXTRAS })
    expect(result.issues).toEqual([])
    expect(result).toMatchObject({ ok: true, seedCount: 1000, markerPresent: true })

    const noMarker = { ...archived, items: items({ marker: false }) }
    expect(oracle.verifyArchiveTurn({ turn: noMarker, prompt: plan.PROMPT, runId: RUN }).issues.join()).toMatch(/archived exact marker count 0 != 1/)

    const droppedExtras = { ...archived, items: items({ extras: [EXTRA_ITEMS[0]] }) }
    expect(oracle.verifyArchiveTurn({ turn: droppedExtras, prompt: plan.PROMPT, runId: RUN, minimumExtras: EXPECTED_EXTRAS }).issues.join()).toMatch(/the archive dropped events/)

    expect(oracle.verifyArchiveTurn({ turn: { ...archived, done: false }, prompt: plan.PROMPT, runId: RUN }).issues.join()).toMatch(/archived done false != true/)
    expect(oracle.verifyArchiveTurn({ turn: { ...archived, runId: 'other' }, prompt: plan.PROMPT, runId: RUN }).issues.join()).toMatch(/archived runId/)
    expect(oracle.verifyArchiveTurn({ turn: undefined, prompt: plan.PROMPT, runId: RUN }).issues).toEqual(['archived turn is missing'])
    expect(() => oracle.verifyArchiveTurn({ turn: archived, prompt: plan.PROMPT })).toThrow(/needs the host run id/)
  })

  it('accepts one complete source and keeps a missing root as unavailable evidence', () => {
    // A fresh live run writes the turn archive; the legacy monolithic root legitimately does
    // not exist when there is no seeded history.
    const entry = { runId: RUN, turn: { runId: RUN, userText: plan.PROMPT, done: true, items: items() }, sources: ['trace-archive-turns-v1'], variants: [{ source: 'trace-archive-turns-v1', turn: { runId: RUN, userText: plan.PROMPT, done: true, items: items() } }] }
    const archive = {
      roots: [{ name: 'trace-archive-turns-v1', present: true, segments: 3 }, { name: 'trace-archives-v2', present: false }],
      turns: [entry],
      missing: []
    }
    const result = oracle.verifyArchiveEntry({ entry, archive, runId: RUN, prompt: plan.PROMPT, minimumExtras: EXPECTED_EXTRAS })
    expect(result.issues).toEqual([])
    expect(result).toMatchObject({ ok: true, sources: ['trace-archive-turns-v1'], absentSources: ['trace-archives-v2'] })
    // The absent root is reported with rootPresent:false and a reason, never as an empty list.
    expect(result.sourcesDetail).toEqual([
      { name: 'trace-archive-turns-v1', rootPresent: true, status: 'present', segments: 3 },
      { name: 'trace-archives-v2', rootPresent: false, status: 'unavailable', reason: 'root_missing' }
    ])
  })

  it('fails when no archive root exists at all', () => {
    const archive = { roots: [{ name: 'trace-archive-turns-v1', present: false }, { name: 'trace-archives-v2', present: false }], turns: [], missing: [RUN] }
    const result = oracle.verifyArchiveEntry({ entry: null, archive, runId: RUN, prompt: plan.PROMPT })
    expect(result.ok).toBe(false)
    expect(result.issues.join()).toMatch(/no archive root is present/)
    expect(result.issues.join()).toMatch(/absent from every present archive root/)
  })

  it('fails when the present root has no turn for the run', () => {
    const archive = { roots: [{ name: 'trace-archive-turns-v1', present: true, segments: 1 }, { name: 'trace-archives-v2', present: false }], turns: [], missing: [RUN] }
    const result = oracle.verifyArchiveEntry({ entry: null, archive, runId: RUN, prompt: plan.PROMPT })
    expect(result.ok).toBe(false)
    expect(result.issues.join()).toMatch(/absent from every present archive root/)
    expect(result.sourcesDetail[0]).toMatchObject({ rootPresent: true, status: 'present' })
  })

  it('reports duplicate sources honestly: agreeing copies pass, differing copies fail', () => {
    const turn = { runId: RUN, userText: plan.PROMPT, done: true, items: items() }
    const agreeing = {
      runId: RUN,
      turn,
      sources: ['trace-archive-turns-v1', 'trace-archives-v2'],
      variants: [{ source: 'trace-archive-turns-v1', turn }, { source: 'trace-archives-v2', turn }]
    }
    const roots = [{ name: 'trace-archive-turns-v1', present: true }, { name: 'trace-archives-v2', present: true }]
    const same = oracle.verifyArchiveEntry({ entry: agreeing, archive: { roots, turns: [agreeing], missing: [] }, runId: RUN, prompt: plan.PROMPT })
    expect(same.issues).toEqual([])
    expect(same.duplicates).toEqual({ count: 2, consistent: true })

    const corruptedTurn = { ...turn, items: items().slice(0, 999) }
    const conflicting = {
      runId: RUN,
      turn,
      sources: ['trace-archive-turns-v1', 'trace-archives-v2'],
      variants: [{ source: 'trace-archive-turns-v1', turn }, { source: 'trace-archives-v2', turn: corruptedTurn }]
    }
    const different = oracle.verifyArchiveEntry({ entry: conflicting, archive: { roots, turns: [conflicting], missing: [] }, runId: RUN, prompt: plan.PROMPT })
    expect(different.ok).toBe(false)
    expect(different.issues.join()).toMatch(/differs between archive sources/)
    expect(different.duplicates).toEqual({ count: 2, consistent: false })
  })

  it('reconciles the renderer and main attempt counters', () => {
    expect(oracle.reconcileAttempts({ rendererCalls: { traceDelta: 7, intents: 7 }, mainAttempts: { traceDelta: 7, intents: 7 } })).toMatchObject({ ok: true, differences: [] })
    const differing = oracle.reconcileAttempts({ rendererCalls: { traceDelta: 7 }, mainAttempts: { traceDelta: 6 } })
    expect(differing).toMatchObject({ ok: false, differences: [{ method: 'traceDelta', renderer: 7, main: 6 }] })
    expect(oracle.reconcileAttempts({ rendererCalls: {}, mainAttempts: { intents: 1 } }).differences).toEqual([{ method: 'intents', renderer: 0, main: 1 }])
  })
})
