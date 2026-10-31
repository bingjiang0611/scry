// Build helper for the live concurrency trace fixture (R6.2).
//
// Bundles the fixture renderer with production React (profiling build) and the
// build-time instrumentation the driver needs. The production sources are never
// edited on disk: every insertion is anchored on one exact source line, and the
// build fails unless every anchor occurs exactly once and every entry was applied.
// No Electron import here — the launcher spawns Electron itself.
import { writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const defaultRoot = dirname(dirname(fileURLToPath(import.meta.url)))

// Fixture ABI names. The focused test asserts these match the typed constants in
// scripts/fixtures/concurrency-trace-live-visits.ts and -client.ts.
export const PRELOAD_BRIDGE_KEY = '__scryTraceLiveHost'
export const PRELOAD_CHANNEL = 'concurrency-trace-live:call'

export const LIVE_PRELOAD = `const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld(${JSON.stringify(PRELOAD_BRIDGE_KEY)}, {
  call: (method, args) => ipcRenderer.invoke(${JSON.stringify(PRELOAD_CHANNEL)}, method, args)
})
`

export const INDEX_HTML = '<!doctype html><meta charset="utf-8">' +
  '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'self\'; style-src \'self\' \'unsafe-inline\'; img-src data:">' +
  '<link rel="stylesheet" href="renderer.css"><div id="root" style="height:100vh"></div><script src="renderer.js"></script>'

/**
 * The window the launcher must create. Kept here so a launcher cannot quietly
 * relax sandbox/context isolation to make the fixture work.
 */
export function liveWindowOptions(preloadPath) {
  return {
    title: 'Scry concurrency trace live fixture',
    show: false,
    width: 1100,
    height: 800,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, preload: preloadPath }
  }
}

// kind 'replace' swaps one exact expression; 'append' inserts after an exact line.
// Several entries may target the same file; all of them are applied, in order.
export const LIVE_INSTRUMENTATION = [
  {
    id: 'controls-register-poll',
    file: 'src/renderer/components/RemoteChatControls.tsx',
    kind: 'append',
    anchor: '    pollRef.current = poll\n',
    // The readiness flags and the production catalog strings travel with the registration:
    // an inactive session or a missing traceDelta capability is then a named failure instead
    // of a poll that quietly read nothing.
    insertion: [
      '    window.__scryTraceLive?.registerPoll?.({',
      '      poll, context, contextKey, connectionId, connected, catalogReady,',
      '      sessionActive, traceDelta,',
      '      diagnostics: {',
      '        catalogTraceDelta: typeof catalog?.traceDelta === \'number\' ? catalog.traceDelta : null,',
      '        sessionCount: Array.isArray(catalog?.sessions) ? catalog.sessions.length : null,',
      '        activeSessionCount: (catalog?.sessions ?? []).filter((item) => item.isActive === true).length,',
      '        catalogSessions: (catalog?.sessions ?? []).slice(0, 5).map((item) => ({',
      '          externalSessionId: item.externalSessionId ?? null, cwd: item.cwd, providerId: item.providerId,',
      '          agentProfileId: item.agentProfileId ?? null, isActive: item.isActive === true',
      '        }))',
      '      }',
      '    })',
      ''
    ].join('\n')
  },
  {
    id: 'controls-unregister-poll',
    file: 'src/renderer/components/RemoteChatControls.tsx',
    kind: 'append',
    anchor: '      if (pollRef.current === poll) pollRef.current = undefined\n',
    insertion: '      window.__scryTraceLive?.unregisterPoll?.(poll)\n'
  },
  {
    id: 'controls-suppress-auto-poll',
    file: 'src/renderer/components/RemoteChatControls.tsx',
    kind: 'replace',
    anchor: '() => pollRef.current?.()',
    insertion: '() => { window.__scryTraceLive?.autoPoll?.() }'
  },
  {
    id: 'foundation-commit-hook-alias',
    file: 'src/renderer/components/RemoteChatFoundation.tsx',
    kind: 'replace',
    anchor: 'import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from \'react\'\n',
    insertion: 'import { useCallback, useEffect, useLayoutEffect as useFixtureCommitEffect, useMemo, useRef, useState, useSyncExternalStore } from \'react\'\n'
  },
  {
    id: 'foundation-publish-committed-run',
    file: 'src/renderer/components/RemoteChatFoundation.tsx',
    kind: 'append',
    anchor: '  const [activeRun, setActiveRun] = useState<ActiveRun | null>(null)\n',
    insertion: [
      '  // Fixture instrumentation: publish only after React committed this run, and',
      '  // clear it on unmount or when the shown run changes.',
      '  useFixtureCommitEffect(() => {',
      '    window.__scryTraceLive?.publishRun?.(activeRun)',
      '    return () => { window.__scryTraceLive?.releaseRun?.(activeRun) }',
      '  }, [activeRun])',
      ''
    ].join('\n')
  }
]

// Explicit source list for the launcher's pre/post-build hashing.
export const LIVE_INSTRUMENTED_SOURCES = [...new Set(LIVE_INSTRUMENTATION.map((entry) => entry.file))]

/**
 * Applies every instrumentation entry for a file, in listed order, and records
 * each one by id. An anchor that is missing or duplicated fails the build, and so
 * does an entry that never reached the transform.
 */
export function liveInstrumentationPlugin(root = defaultRoot) {
  const applied = new Set()
  return {
    name: 'concurrency-trace-live-instrumentation',
    enforce: 'pre',
    buildStart() { applied.clear() },
    transform(code, id) {
      const entries = LIVE_INSTRUMENTATION.filter((entry) => id === join(root, entry.file))
      if (entries.length === 0) return
      let next = code
      for (const entry of entries) {
        if (next.split(entry.anchor).length !== 2) {
          throw new Error(`concurrency-trace-live anchor changed in ${entry.file} (${entry.id}): ${JSON.stringify(entry.anchor)}`)
        }
        next = entry.kind === 'replace' ? next.replace(entry.anchor, entry.insertion) : next.replace(entry.anchor, `${entry.anchor}${entry.insertion}`)
        applied.add(entry.id)
      }
      return { code: next, map: null }
    },
    buildEnd() {
      const missing = LIVE_INSTRUMENTATION.filter((entry) => !applied.has(entry.id)).map((entry) => entry.id)
      if (missing.length > 0) {
        throw new Error(`concurrency-trace-live instrumentation was never applied: ${missing.join(', ')}`)
      }
    }
  }
}

/**
 * Bundles the fixture renderer plus its preload/index documents. Passes the real
 * `mainEntry` through when the launcher has one; the launcher owns spawning.
 */
export async function buildLiveFixture({ outDir, root = defaultRoot, mainEntry } = {}) {
  if (!outDir) throw new Error('concurrency-trace-live build requires outDir')
  const { build } = await import('vite')
  await build({
    configFile: false, root: outDir, envDir: outDir, logLevel: 'error', esbuild: { jsx: 'automatic' },
    plugins: [liveInstrumentationPlugin(root)],
    // Production React with the profiling renderer, so <Profiler> reports commit durations.
    resolve: { alias: [{ find: '@shared', replacement: join(root, 'src/shared') }, { find: /^react-dom$/, replacement: 'react-dom/profiling' }] },
    define: { 'process.env.NODE_ENV': '"production"' },
    build: { outDir, emptyOutDir: false, copyPublicDir: false, minify: false, target: 'es2022',
      lib: { entry: join(root, 'scripts/fixtures/concurrency-trace-live-profile.tsx'), formats: ['iife'],
        name: 'ScryConcurrencyTraceLive', fileName: () => 'renderer.js', cssFileName: 'renderer' } }
  })
  const index = join(outDir, 'index.html')
  const preload = join(outDir, 'preload.cjs')
  await writeFile(index, INDEX_HTML)
  await writeFile(preload, LIVE_PRELOAD)
  let main
  if (mainEntry) {
    // Bundle dependencies too: the launcher runs from a temp directory without node_modules.
    // `electron` is the one module that must stay external: it is provided by the runtime,
    // not resolved from the bundle.
    await build({
      configFile: false, root, logLevel: 'error', ssr: { noExternal: true },
      build: { ssr: mainEntry, outDir: join(outDir, 'main'), emptyOutDir: false, minify: false, target: 'node20',
        rollupOptions: { external: ['electron'], output: { format: 'cjs', entryFileNames: 'main.cjs' } } }
    })
    main = join(outDir, 'main', 'main.cjs')
  }
  return { index, preload, main, sources: LIVE_INSTRUMENTED_SOURCES }
}
