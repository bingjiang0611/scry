export function desktopRemoteFixtureApi(context) {
  const { root, unknownReceiptOnly, structureOnly, openingOnly, measureOpening, composerHistoryOnly, lifecycleOnly, conversationNavigationOnly, visibilityPollingCheck, visibilityPollingBaseline, negativeUnknownReceiptControl } = context
  return `const api = {
  async list() { state.listCalls++; await holdVisibilityRead('list'); if (state.listFailure) throw new Error('fixture connection read failed'); return [{ ...connection, state: state.connected ? 'connected' : 'disconnected' }] },
  async pair() { throw new Error('pairing is outside this fixture') },
  async finishPairing() { throw new Error('pairing is outside this fixture') },
  async updateSsh(id, ssh) {
    state.updateSshCalls.push({ id, ssh })
    if (state.updateFailure) throw new Error('fixture secure storage failure')
    if (state.holdAddressUpdate) await new Promise(resolve => { window.releaseAddressUpdate = resolve })
    connection.ssh = { ...ssh }
    state.connected = false
  },
  async connect() { state.connectCalls++; state.connected = true },
  async disconnect() { state.connected = false },
  async forget() {},
  async catalog() {
    state.catalogCalls++
    await holdVisibilityRead('catalog')
    if (state.catalogFailure) throw new Error('fixture catalog unavailable')
    return structuredClone({ ...catalog,
      projects: catalog.projects.map(project => ({ ...project, label: project.label + (state.catalogRevision ? ' v2' : '') })),
      sessions: catalog.sessions.map(session => session.externalSessionId === 'old-native' ? { ...session, isActive: state.sessionActive, ts: state.sessionTs,
        ...(state.sessionLastRunId ? { lastRunId: state.sessionLastRunId, lastRunOutcome: state.sessionLastRunOutcome } : {}) } : session),
      providers: (state.hideProvider ? [beta] : catalog.providers).map(provider => state.legacyProviderHost ? provider
        : ({ id: provider.id, label: provider.label, available: provider.available, observedAt: state.providerMetadataObservedAt, metadataRevision: state.providerMetadataRevision, ...(provider.forkSession === true ? { forkSession: true } : {}), ...(provider.agentProfileId ? { agentProfileId: provider.agentProfileId } : {}) })),
      providerDiscovery: state.legacyProviderHost ? undefined : 2,
      providerEvidence: state.legacyProviderHost ? 'legacy_host' : 'host_snapshot',
      directorySelection: state.oldDirectoryHost ? undefined : true
    })
  },
  async workbench(id, request) {
    state.workbenchCalls.push({ id, request })
    if (id !== 'fixture-connection' || request.cwd !== '/fixture/project-a' || request.surface !== 'workspace') throw new Error('Wrong remote workspace authority')
    if (request.method === 'workspaceList') return { entries: [{ name: 'notes.txt', path: 'notes.txt', kind: 'file', mtimeMs: 1 }], truncated: false }
    if (request.method === 'workspaceRead') return { name: 'notes.txt', path: 'notes.txt', content: 'original remote file', size: 20, mtimeMs: 1, revision: 'structure-rev', language: 'plaintext' }
    throw new Error('Unexpected remote workspace operation: ' + request.method)
  },
  async providerControls(id, context) {
    state.providerControlsCalls.push({ id, context: contextFor({ context }) })
    if (state.holdProviderControls) await new Promise(resolve => state.providerControlWaiters.push(resolve))
    const match = catalog.providers.find(provider => provider.id === context.providerId && (provider.agentProfileId ?? '') === (context.agentProfileId ?? ''))
    if (!match || state.providerControlsFailure === 'throw') throw new Error('fixture provider controls unavailable')
    return structuredClone(state.providerControlsFailure === 'unavailable' ? { id: match.id, label: match.label, available: false } : { ...match, observedAt: state.providerControlsObservedAt })
  },
  async commands(id, context) {
    state.commandCalls.push({ id, context })
    if (state.holdCommands) await new Promise(resolve => { window.releaseCommands = resolve })
    if (state.commandFailure) throw new Error('fixture host commands unavailable')
    return { commands: [{ name: 'skill:host-only', description: 'Skill from the remote host' }] }
  },
  async sessionAction(id, context, action) {
    state.sessionActions.push({ id, context, action })
    const session = catalog.sessions.find(item => item.externalSessionId === context.externalSessionId && item.cwd === context.cwd && item.providerId === context.providerId)
    if (!session) throw new Error('remote session mismatch')
    if (action.kind === 'rename') session.label = action.title
    if (action.kind === 'pin') session.pinnedAt = action.pinned ? Date.now() : undefined
    if (action.kind === 'archive') session.archivedAt = action.archived ? Date.now() : undefined
    return true
  },
  async forkSession(id, request) {
    state.forks.push({ id, request })
    catalog.sessions.push({ sessionId: 'forked-native', externalSessionId: 'forked-native', providerId: request.providerId, cwd: request.cwd, label: 'Forked session', ts: Date.now() })
    return { externalSessionId: 'forked-native' }
  },
  async deleteSession(id, request) {
    state.deletions.push({ id, request })
    if (state.deleteFailure) throw new Error('fixture deletion failed')
    const index = catalog.sessions.findIndex(item => item.externalSessionId === request.externalSessionId && item.archivedAt)
    if (index < 0 || request.confirmed !== true) throw new Error('not archived or confirmed')
    catalog.sessions.splice(index, 1)
    return { ok: true, deleted: [], failed: [] }
  },
  async directories(id, path = '/fixture/home', cursor = 0, snapshot) {
    state.directoryReads.push({ id, path, cursor, snapshot })
    if (!['/fixture/home', '/fixture/home/custom', '/fixture/home/empty'].includes(path)) throw new Error('directory_unavailable')
    const directories = path === '/fixture/home' ? [{ path: '/fixture/home/custom', label: 'custom' }, { path: '/fixture/home/empty', label: 'empty' }, { path: '/fixture/home/other', label: 'other' }] : []
    const end = Math.min(cursor + 2, directories.length)
    return { current: { path, label: path.split('/').pop() }, parent: { path: '/fixture/home', label: 'home' }, directories: directories.slice(cursor, end), cursor: end, total: directories.length, hasMore: end < directories.length, snapshot: 'a'.repeat(64) }
  },
  async selectDirectory(id, path) {
    state.directorySelectCalls.push({ id, path })
    if (state.selectDirectoryFailure) throw new Error('fixture directory grant not confirmed')
    if (state.holdDirectorySelection) await new Promise(resolve => { window.releaseDirectorySelection = resolve })
    const project = { path, label: path.split('/').pop() }
    state.directoryGrants.push(project)
    if (!catalog.projects.some(item => item.path === path)) catalog.projects.push(project)
    return project
  },
  async history(_id, context) {
    state.historyCalls.push(contextFor({ context }))
    if (state.holdHistory) await new Promise(resolve => { window.releaseHistory = resolve })
    if (${openingOnly || measureOpening || structureOnly}) return { turns: [{ runId: 'opening-history', userText: 'Long remote history', done: true, items: [
      { id: 'opening-answer', runId: 'opening-history', ts: '2026-10-19T12:00:00.000Z', kind: 'model', stage: 'text', text: Array.from({ length: 80 }, (_, i) => 'Remote history paragraph ' + i).join('\\n\\n') }
    ] }], hasOlder: false, source: 'trace_archive', status: 'available' }
    // A run typed on the host's own UI becomes history once it leaves the live set.
    if (state.hostRunArchived && context.externalSessionId === 'old-native') return { turns: [{ ...activeRun('run-hostui-1', 'old-native', 'host ui continue'), done: true }], hasOlder: false, source: 'trace_archive', status: 'available' }
    const turns = ${composerHistoryOnly} && context.externalSessionId === 'old-native'
      ? state.historyPrompts.map((userText, index) => ({ runId: 'history-' + index, userText, items: [], done: true }))
      : state.firstIntentCleared && context.externalSessionId === 'native-session'
      ? [{ runId: firstScryRun, userText: 'archived terminal turn', items: [], done: true }]
      : ${lifecycleOnly} && context.externalSessionId === 'old-native'
        ? [{ runId: 'old-run', providerTurnId: 'old-provider-turn', forkTurnId: 'old-fork-turn', userText: 'Fork boundary', items: [], done: true }] : []
    return { turns, hasOlder: false, source: 'trace_archive', status: 'available' }
  },
  async trace(_id, context, runId) {
    state.traceCalls.push({ context: contextFor({ context }), runId })
    if (context.cwd !== '/fixture/project-a') throw new Error('fixture trace context mismatch: ' + context.cwd)
    if (runId === firstScryRun && state.firstIntentCleared) throw new Error('terminal trace unavailable')
    if (runId === firstScryRun) return activeRun(firstScryRun, 'native-session', 'first remote run', question)
    if (runId === secondScryRun) return activeRun(secondScryRun, 'native-session', 'second remote run', undefined, true)
    if (runId === 'run-hostui-1') return activeRun('run-hostui-1', 'old-native', 'host ui continue')
    return null
  },
  async intents() {
    state.intentsCalls++
    return structuredClone(state.intent ? [state.intent] : [])
  },
  async submit(_id, input) {
    state.submitInputs.push(input)
    if (state.autoResetOnSubmit) state.runState = 'dispatched'
    if (state.holdSubmit) await new Promise(resolve => { window.releaseSubmit = resolve })
    const first = state.submitInputs.length === 1
    state.intent = { intentId: first ? 'intent-first' : 'intent-second', connectionId: connection.id, context: contextFor(input), createdAt: state.submitInputs.length, status: 'recorded', runId: first ? firstLedger : secondLedger }
    return structuredClone(state.intent)
  },
  async intentStatus() { return structuredClone(state.intent) },
  async resolveIntent(id, intentId) {
    state.resolveIntentCalls.push({ id, intentId })
    if (intentId !== 'unknown-original-id') throw new Error('fixture recovery used a replacement id')
    if (state.resolveFailure === 'generic') throw new Error('fixture recovery transport failed')
    if (${negativeUnknownReceiptControl}) throw new Error('desktop_remote_unknown_op')
    state.intent = { intentId, connectionId: connection.id, context: { cwd: '/fixture/project-b', providerId: 'qoder', externalSessionId: 'other-native' }, createdAt: 1, status: 'recorded', runId: 'received-active-run' }
    return structuredClone(state.intent)
  },
  async runStatus(_id, runId) {
    state.runStatusCalls++
    if (runId === 'received-active-run') return { state: 'dispatched', detail: 'fixture received active task' }
    if (state.holdRunStatus) await new Promise(resolve => { window.releaseRunStatus = resolve })
    if (state.runStatusFailure) throw new Error('desktop_remote_output_capture_queue_full')
    if (state.answerFailure && runId === firstLedger) {
      state.firstIntentCleared = true; state.intent = null
      return { state: 'failed', scryRunId: firstScryRun, externalSessionId: 'native-session' }
    }
    if (state.runState !== 'dispatched' || !state.exposeTrace) {
      if (state.runState === 'settled' || state.runState === 'failed') state.intent = null
      return { state: state.runState }
    }
    if (state.intent && !state.intent.context.externalSessionId) {
      state.intent.context.externalSessionId = 'native-session'
      if (!catalog.sessions.some(session => session.externalSessionId === 'native-session')) catalog.sessions.push({
        sessionId: 'native-session', externalSessionId: 'native-session', ...state.intent.context, label: 'Adopted remote session', ts: Date.now()
      })
    }
    if (runId === firstLedger) return { state: 'dispatched', scryRunId: firstScryRun, externalSessionId: 'native-session', detail: 'fixture dispatched' }
    return { state: 'dispatched', scryRunId: secondScryRun, externalSessionId: 'native-session', detail: 'fixture background work' }
  },
  // Host-UI run on old-native: present only while the catalog marks it active.
  async liveRun(_id, context) {
    state.liveRunCalls++
    return state.sessionActive && context.externalSessionId === 'old-native' ? { runId: 'run-hostui-1', origin: 'mac', state: 'running', scryRunId: 'run-hostui-1' } : null
  },
  async stop(_id, runId) { state.stopCalls.push(runId) },
  async answer(_id, runId, response) { state.answerCalls.push({ runId, response }); state.answerFailure = true; throw new Error('remote answer rejected') },
  async files(id, context, path = '', cursor) {
    state.fileLists.push({ id, context, path, cursor })
    const entry = (name, kind, parent = '') => ({ name, kind, path: parent ? parent + '/' + name : name, mtimeMs: 1 })
    return path === 'src'
      ? { entries: [entry('nested.txt', 'file', 'src')], truncated: false }
      : cursor ? { entries: [entry('image.png', 'file'), entry('small.md', 'file')], truncated: false }
      : { entries: [entry('src', 'directory'), entry('README.md', 'file')], truncated: true, nextCursor: 'remote-next' }
  },
  async file(id, context, path, offset = 0, snapshot) {
    state.fileReads.push({ id, context, path, offset, snapshot })
    if (path === 'image.png') throw new Error('SCRY_FILE_PREVIEW_UNSUPPORTED')
    if (path === 'small.md') return { name: path, path, content: '# Remote markdown', offset: 0, nextOffset: 17, totalBytes: 17, hasMore: false, snapshot: 'small-snapshot', language: 'markdown' }
    return { name: path.split('/').pop(), path, content: offset ? 'second remote page' : 'first remote page',
      offset, nextOffset: offset ? 34 : 17, totalBytes: 34, hasMore: !offset, snapshot: 'remote-snapshot', language: 'text' }
  }
}
const noopSubscribe = () => () => {}
const navigationConversation = { id: 'navigation-conversation', cwd: '/fixture/pinned', title: 'Conversation navigation', revision: 1, turnCount: 40, lastRunOutcome: 'completed' }
window.scry = {
  // Same minimal full-App bridge contract as session-selection-smoke.tsx.
  activeRun: async () => null, activeRuns: async () => [],
  onTrace: noopSubscribe, onTurnDone: noopSubscribe, onError: noopSubscribe,
  listProjects: async () => [
    { cwd: '/fixture/pinned', name: 'Pinned local', pinnedAt: 1, mtime: 1, sessions: [], ...(${conversationNavigationOnly} ? { conversations: [navigationConversation] } : {}) },
    { cwd: '/fixture/recent', name: 'Recent local', mtime: 1700000001000, sessions: [] },
    { cwd: '/fixture/older', name: 'Older local', mtime: 1699999999000, sessions: [] }
  ],
  listArchivedSessions: async () => [],
  recentFolders: async () => Array.from({ length: 12 }, (_, index) => '/fixture/recent-' + index),
  catalogHealth: async () => ({ status: 'ready', source: 'empty' }),
  detect: async () => [], listSkills: async () => ({ state: 'unavailable', data: null }),
  mcpSnapshot: async () => ({ state: 'unavailable', data: null }),
  listCommands: async () => ({ state: 'ready', data: [{ name: 'skill:local-only', description: 'Local skill must never appear remotely' }] }),
  usageStats: async () => null, stats: async () => null, focusRun: async () => true,
  setCwd: async () => true,
  newSession: async () => { state.localNewSessions++; return true },
  start: async () => { state.localStarts++; throw new Error('Local execution must not be reached') },
  remoteStatus: async () => {
    state.remoteStatusCalls++
    await holdVisibilityRead('remoteStatus')
    if (state.phoneStatusFailure) throw new Error('fixture phone status unavailable')
    return state.phoneEnabled ? { enabled: true, hostId: 'local-host', anchorSHA256: 'local-anchor', relayConfigured: state.relayConfigured,
      pending: [], devices: [{ deviceId: 'phone', deviceLabel: 'Fixture iPhone', confirmedAt: 1, expiresAt: 4102444800000, revoked: false }] } : { enabled: false }
  },
  remoteBeginPairing: async () => { state.phonePairingCalls++; return { pairingId: 'fixture-pairing', secret: 'fixture-secret', hostId: 'local-host', anchorSHA256: 'local-anchor', expiresAt: Date.now() + 120000, deviceCode: 'scry1:fixture' } },
  copyText: async () => {},
  clipboardImage: async () => { state.clipboardImageCalls++; return { kind: 'image', name: 'clipboard.png', mimeType: 'image/png', dataBase64: 'aQ==', size: 1 } },
  desktopRemote: api, stopBackgroundTask: async () => { state.backgroundStopCalls++; return { status: 'unavailable', message: 'fixture remote task stop trap' } },
  async remoteDesktopHostStatus() { return state.hostEnabled ? { enabled: true, pairPort: 10001, runPort: 10002 } : { enabled: false } },
  async remoteDesktopHostInvite() { state.hostInviteCalls++; state.hostEnabled = true; return 'scry-desktop1:fixture' },
  async remoteDesktopHostDisable() { state.hostDisableCalls++; state.hostEnabled = false }
}
if (${conversationNavigationOnly}) window.scry.conversations = {
  read: async () => ({ summary: navigationConversation, bindings: [], turns: Array.from({ length: 40 }, (_, index) => ({
    ordinal: index + 1, runId: 'conversation-run-' + index, bindingId: 'fixture', providerId: 'claude', delivery: { status: 'imported' },
    history: { runId: 'conversation-run-' + index, userText: 'Conversation prompt ' + index, done: true, items: [
      { id: 'conversation-answer-' + index, runId: 'conversation-run-' + index, ts: '', kind: 'model', stage: 'text', text: ('Variable answer ' + index + '. ').repeat(100 + index % 7 * 30) }
    ] }
  })) })
}
for (const method of ['workspaceList', 'workspaceRead', 'workspaceReadKnown', 'workspaceReadPage', 'workspaceReadPageKnown', 'workspaceOpenExternal', 'workspaceOpenKnownExternal', 'workspaceWrite', 'workspaceCreate', 'workspaceRename', 'workspaceMove', 'workspaceTrash']) {
  window.scry[method] = async () => { state.localWorkspaceCalls.push(method); throw new Error('Local workspace must not be reached: ' + method) }
}
window.desktopRemoteFixture = state
window.refreshFixtureCatalog = () => refreshRemoteCatalog(connection.id)
window.refreshFixtureConnections = refreshDesktopConnections
for (const type of ['keydown', 'change', 'mousedown', 'click']) document.addEventListener(type, event => {
  state.uiEvents.push({ type, key: event.key, value: event.target.value, tag: event.target.tagName, text: event.target.textContent?.slice(0, 100) })
  if (state.uiEvents.length > 24) state.uiEvents.shift()
}, true)
`
}
