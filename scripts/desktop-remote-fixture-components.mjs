export function desktopRemoteFixtureComponents(context) {
  const { root, unknownReceiptOnly, structureOnly, openingOnly, measureOpening, composerHistoryOnly, lifecycleOnly, conversationNavigationOnly, visibilityPollingCheck, visibilityPollingBaseline, negativeUnknownReceiptControl } = context
  return `function PollingSidebar() {
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
