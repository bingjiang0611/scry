import { join } from 'node:path'

// Build-only controls: production modules on disk are never mutated.
export function sessionPerformanceInstrumentation(root, flags) {
  const fixture = join(root, 'scripts/fixtures/session-performance-smoke.tsx')
  const remoteFixture = join(root, 'scripts/fixtures/session-performance-remote.tsx')
  const replaceOnce = (code, marker, replacement) => {
    if (code.split(marker).length !== 2) throw new Error('Performance instrumentation anchor changed: ' + marker)
    return code.replace(marker, replacement)
  }
  return { name: 'session-performance-controls', enforce: 'pre', transform(code, id) {
    if (id === join(root, 'src/renderer/components/SidebarRemoteProjects.tsx') && !flags.unisolatedRemote) {
      return replaceOnce(code, "from '../hooks/useDesktopConnections'", `from ${JSON.stringify(remoteFixture)}`)
    }
    if (flags.negativeCallback && id === join(root, 'src/renderer/hooks/useEventCallback.ts')) {
      // Break the production hook's stable identity, not the Sidebar counter.
      return replaceOnce(code, 'return useCallback((...args: Args) => latest.current(...args), [])', 'return callback')
    }
    if (id === fixture) {
      if (flags.remotePoll) {
        code += `\nimport { startRemotePollProbe } from './session-performance-remote'\nstartRemotePollProbe()\n`
        code = replaceOnce(code, '  return sidebarRender(props)', `  console.log('SCRY_SIDEBAR_RENDER=' + JSON.stringify({
    stream: document.querySelector('#stream')?.textContent,
    remotePublications: Number(document.body.dataset.remotePublications ?? 0)
  }))
  return sidebarRender(props)`)
      }
      return code
    }
    if (flags.remotePoll && id === join(root, 'src/renderer/hooks/useDesktopConnections.ts')) {
      return replaceOnce(code, 'const publish = (): void => {', `const publish = (): void => {
  document.body.dataset.remotePublications = String(Number(document.body.dataset.remotePublications ?? 0) + 1)
  console.log('SCRY_REMOTE_PUBLISH=' + JSON.stringify({
    publication: Number(document.body.dataset.remotePublications),
    stream: document.querySelector('#stream')?.textContent, ...snapshot
  }));`)
    }
    if (flags.negativeNavigation && id === join(root, 'src/renderer/hooks/useChatNavigation.ts')) {
      // Existing navigation negative control: recreate one-shot/same-ID behavior.
      return code.replace('setRequest({ runId, eventId })', 'setRequest(current => current?.runId === runId ? current : { runId, eventId })')
        .replace('new ResizeObserver(schedule)', 'new ResizeObserver(() => {})')
        .replace('new MutationObserver(schedule)', 'new MutationObserver(() => {})')
    }
    if (id !== join(root, 'src/renderer/components/SidebarSessionRow.tsx')) return
    const marker = '  const pinned = Boolean(session.pinnedAt)'
    return replaceOnce(code, marker, `  document.body.dataset.sessionRowRenders = String(Number(document.body.dataset.sessionRowRenders ?? 0) + 1)\n${marker}`)
  } }
}
