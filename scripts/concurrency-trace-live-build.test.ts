import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { LIVE_FIXTURE_CHANNEL } from './fixtures/concurrency-trace-live-client'
import { LIVE_BRIDGE_KEY, LIVE_DRIVER_KEY } from './fixtures/concurrency-trace-live-visits'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const CONTROLS = 'src/renderer/components/RemoteChatControls.tsx'
const FOUNDATION = 'src/renderer/components/RemoteChatFoundation.tsx'

interface InstrumentationEntry { id: string; file: string; kind: string; anchor: string; insertion: string }

interface InstrumentationPlugin {
  buildStart(): void
  transform(code: string, id: string): { code: string } | undefined
  buildEnd(): void
}

interface BuildModule {
  PRELOAD_BRIDGE_KEY: string
  PRELOAD_CHANNEL: string
  LIVE_PRELOAD: string
  INDEX_HTML: string
  LIVE_INSTRUMENTATION: InstrumentationEntry[]
  LIVE_INSTRUMENTED_SOURCES: string[]
  liveInstrumentationPlugin(root?: string): InstrumentationPlugin
  liveWindowOptions(preloadPath: string): { webPreferences: Record<string, unknown> }
}

// Loaded through a computed specifier: the build helper is plain ESM without declarations.
async function loadBuild(): Promise<BuildModule> {
  return await import(new URL('./concurrency-trace-live-build.mjs', import.meta.url).href) as BuildModule
}

const source = (file: string): Promise<string> => readFile(join(root, file), 'utf8')

function transform(plugin: InstrumentationPlugin, code: string, file: string): string {
  const result = plugin.transform(code, join(root, file))
  if (!result) throw new Error(`concurrency-trace-live transform skipped ${file}`)
  return result.code
}

describe('live concurrency trace build instrumentation', () => {
  it('applies every entry of both files through the real transform and seals the build', async () => {
    const build = await loadBuild()
    const plugin = build.liveInstrumentationPlugin(root)
    plugin.buildStart()
    const controls = transform(plugin, await source(CONTROLS), CONTROLS)
    const foundation = transform(plugin, await source(FOUNDATION), FOUNDATION)
    plugin.buildEnd()

    // All three RemoteChatControls entries, not only the first one. The registration injection is
    // multi-line, so the assertion is whitespace-normalized: it must still forward every original
    // field and the production readiness flags the fixture reads (`sessionActive`, `traceDelta`).
    const normalized = controls.replace(/\s+/g, ' ')
    expect(normalized).toContain(
      'window.__scryTraceLive?.registerPoll?.({ poll, context, contextKey, connectionId, connected, catalogReady, sessionActive, traceDelta, diagnostics: {'
    )
    // An emptied diagnostics object would still match the prefix above.
    expect(normalized).toContain('catalogSessions: (catalog?.sessions ?? [])')
    expect(controls).toContain('window.__scryTraceLive?.unregisterPoll?.(poll)')
    expect(controls).toContain('() => { window.__scryTraceLive?.autoPoll?.() }')
    expect(controls).not.toContain('() => pollRef.current?.()')
    expect(controls.indexOf('registerPoll')).toBeLessThan(controls.indexOf('unregisterPoll'))
    expect(controls.indexOf('unregisterPoll')).toBeLessThan(controls.indexOf('autoPoll'))

    // The committed run is published from a layout-effect hook, not from render.
    expect(foundation).toContain('useLayoutEffect as useFixtureCommitEffect')
    expect(foundation).toContain('useFixtureCommitEffect(() => {')
    expect(foundation).toContain('window.__scryTraceLive?.publishRun?.(activeRun)')
    expect(foundation).toContain('return () => { window.__scryTraceLive?.releaseRun?.(activeRun) }')
    expect(foundation.indexOf('publishRun')).toBeGreaterThan(foundation.indexOf('const [activeRun, setActiveRun] = useState<ActiveRun | null>(null)'))
    expect(foundation).not.toContain('__scryTraceLivePublishedRun')

    // A file that is not instrumented is left alone.
    expect(plugin.transform('const x = 1\n', join(root, 'src/renderer/other.ts'))).toBeUndefined()
  })

  it('fails when the second or third anchor is missing instead of silently skipping it', async () => {
    const build = await loadBuild()
    const controls = await source(CONTROLS)

    const withoutCleanup = controls.replace('      if (pollRef.current === poll) pollRef.current = undefined\n', '')
    expect(withoutCleanup).not.toBe(controls)
    const cleanupPlugin = build.liveInstrumentationPlugin(root)
    cleanupPlugin.buildStart()
    expect(() => transform(cleanupPlugin, withoutCleanup, CONTROLS)).toThrow(/controls-unregister-poll/)

    const withoutAutoAnchor = controls.replace('() => pollRef.current?.()', '() => undefined')
    expect(withoutAutoAnchor).not.toBe(controls)
    const autoPlugin = build.liveInstrumentationPlugin(root)
    autoPlugin.buildStart()
    expect(() => transform(autoPlugin, withoutAutoAnchor, CONTROLS)).toThrow(/controls-suppress-auto-poll/)
  })

  it('fails when an anchor occurs more than once', async () => {
    const build = await loadBuild()
    const controls = await source(CONTROLS)
    const anchor = '      if (pollRef.current === poll) pollRef.current = undefined\n'
    const duplicated = `${controls}${anchor}`
    const plugin = build.liveInstrumentationPlugin(root)
    plugin.buildStart()
    expect(() => transform(plugin, duplicated, CONTROLS)).toThrow(/controls-unregister-poll/)
  })

  it('fails the build when an entry never reached the transform', async () => {
    const build = await loadBuild()
    const partial = build.liveInstrumentationPlugin(root)
    partial.buildStart()
    transform(partial, await source(CONTROLS), CONTROLS)
    expect(() => partial.buildEnd()).toThrow(/foundation-commit-hook-alias, foundation-publish-committed-run/)

    const empty = build.liveInstrumentationPlugin(root)
    empty.buildStart()
    expect(() => empty.buildEnd()).toThrow(/controls-register-poll/)
  })

  it('keeps the anchors unique in the real sources and the fixture ABI in sync', async () => {
    const build = await loadBuild()
    expect(build.LIVE_INSTRUMENTATION.map((entry) => entry.id)).toEqual([
      'controls-register-poll',
      'controls-unregister-poll',
      'controls-suppress-auto-poll',
      'foundation-commit-hook-alias',
      'foundation-publish-committed-run'
    ])
    expect(build.LIVE_INSTRUMENTED_SOURCES).toEqual([CONTROLS, FOUNDATION])
    for (const entry of build.LIVE_INSTRUMENTATION) {
      const file = await source(entry.file)
      expect(`${entry.id}:${file.split(entry.anchor).length - 1}`).toBe(`${entry.id}:1`)
    }
    expect(build.PRELOAD_CHANNEL).toBe(LIVE_FIXTURE_CHANNEL)
    expect(build.PRELOAD_BRIDGE_KEY).toBe(LIVE_BRIDGE_KEY)
    expect(build.LIVE_PRELOAD).toContain(LIVE_BRIDGE_KEY)
    expect(build.LIVE_PRELOAD).toContain(LIVE_FIXTURE_CHANNEL)
    expect(build.INDEX_HTML).toContain('id="root"')
    expect(build.INDEX_HTML).toContain("script-src 'self'")
    const insertions = build.LIVE_INSTRUMENTATION.map((entry) => entry.insertion).join('\n')
    expect(insertions).toContain(`${LIVE_DRIVER_KEY}?.registerPoll?.`)
    expect(insertions).toContain(`${LIVE_DRIVER_KEY}?.unregisterPoll?.(poll)`)
    expect(insertions).toContain(`${LIVE_DRIVER_KEY}?.autoPoll?.()`)
    expect(insertions).toContain(`${LIVE_DRIVER_KEY}?.publishRun?.(activeRun)`)
    expect(insertions).toContain(`${LIVE_DRIVER_KEY}?.releaseRun?.(activeRun)`)
    expect(build.liveWindowOptions('/fixture/preload.cjs').webPreferences).toMatchObject({
      sandbox: true, contextIsolation: true, nodeIntegration: false
    })
  })
})
