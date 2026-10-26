export function fixtureShell(options) {
  const { conversationNavigationOnly, visibilityPollingCheck, visibilityPollingBaseline, unknownReceiptOnly } = options
  return `const noopSubscribe = () => () => {}
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
function PollingSidebar() {
  const groups = useRemoteProjectGroups('')
  return <SidebarRemoteProjects groups={groups} active={null} collapsed={new Set()} onToggle={() => {}} onPickSession={() => {}} onNewProjectChat={() => {}} />
}
function VisibilityPollingFixture() {
  const scrollRef = useRef(null)
  const textareaRef = useRef(null)
  useConnectedCatalogLoader([connection], null)
  return <>
    <RemotePairing onNewSession={() => {}} />
    {${visibilityPollingCheck} && <PollingSidebar />}
    <RemoteChat connectionId={connection.id} cwd="/fixture/project-a" draftStore={createComposerDraftStore(new Map(${visibilityPollingCheck} ? [[remoteDraftKey(connection.id, '/fixture/project-a'), { input: 'visibility draft', attachments: [] }]] : []))}
      queueStore={new RemotePromptQueueStore()} onDraftInput={() => {}} scrollRef={scrollRef} textareaRef={textareaRef}
      renderLocationPicker={() => null} onSessionAdopted={() => {}}
      surface={{ target: null, state: createRightSurfaceState(), onAction: () => {} }} />
  </>
}
function Fixture() {
  const [fullApp, setFullApp] = useState(false)
  if (${visibilityPollingBaseline || visibilityPollingCheck}) return <VisibilityPollingFixture />
  if (fullApp) return <App />
  return <><RemoteHostPanel />
    <button data-app-fixture style={{ position: 'fixed', top: 2, right: 2, zIndex: 9999 }} onClick={() => { if (!${unknownReceiptOnly}) state.intent = null; setFullApp(true) }}>Full App</button>
  </>
}
if (${visibilityPollingCheck}) state.sessionActive = true
createRoot(document.getElementById('root')).render(<Fixture />)
`
}
