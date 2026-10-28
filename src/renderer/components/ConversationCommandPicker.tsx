import { useEffect, useMemo, useRef, useState } from 'react'
import type { ConversationTargetRequest } from '@shared/conversation-api'
import { SCRY_WORKFLOW_COMMAND_ID, type TaskCommandCatalog, type TaskCommandDescriptor } from '@shared/task-command'
import { CONVERSATION_COMMAND_COPY as copy } from '../constants/conversation-command-copy'

/** Selection is only an ID request. Main resolves it again before effects;
 * metadata never grants execution, authoring or fee authority. */
export function ConversationCommandPicker({ conversationId, scopeKey, input, disabled, sourceRequest, getTarget, onSelect, onInput, onFocusComposer }: {
  conversationId: string
  scopeKey: string
  input: string
  disabled: boolean
  sourceRequest?: TaskCommandCatalog
  getTarget: () => ConversationTargetRequest
  onSelect: (id?: string) => void
  onInput: (input: string) => void
  onFocusComposer: () => void
}) {
  const [open, setOpen] = useState(false)
  const [catalog, setCatalog] = useState<TaskCommandCatalog>()
  const [selected, setSelected] = useState<TaskCommandDescriptor>()
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>()
  const details = useRef<HTMLDetailsElement>(null)
  const filter = useRef<HTMLInputElement>(null)
  useEffect(() => { if (open) filter.current?.focus() }, [open])
  const generation = useRef(0)
  const inFlight = useRef(false)
  const selectionCallback = useRef(onSelect)
  selectionCallback.current = onSelect
  useEffect(() => {
    generation.current++
    inFlight.current = false
    setCatalog(undefined); setSelected(undefined); setError(undefined); setLoading(false); setOpen(false)
    selectionCallback.current(undefined)
    return () => { generation.current++ }
  }, [conversationId, scopeKey])
  useEffect(() => {
    if (!sourceRequest) return
    generation.current++
    inFlight.current = false
    setLoading(false); setError(undefined); setSelected(undefined); selectionCallback.current(undefined)
    setCatalog(sourceRequest); setOpen(true)
  }, [sourceRequest])
  useEffect(() => {
    if (selected && input.trimStart().split(/\s/, 1)[0] !== `/${selected.name}`) {
      setSelected(undefined)
      selectionCallback.current(undefined)
    }
  }, [input, selected])
  const load = async (native: boolean): Promise<void> => {
    if (inFlight.current) return
    inFlight.current = true
    const epoch = ++generation.current
    setLoading(true); setError(undefined)
    try {
      const next = await window.scry.conversations.commands(conversationId, native ? getTarget() : undefined)
      if (epoch === generation.current) setCatalog(next)
    } catch (error) {
      if (epoch === generation.current) setError(error instanceof Error ? error.message : String(error))
    } finally {
      if (epoch === generation.current) { inFlight.current = false; setLoading(false) }
    }
  }
  const matches = useMemo(() => (catalog?.commands ?? []).filter(command =>
    `${command.name} ${command.description} ${command.id}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())), [catalog, query])
  const visible = matches.slice(0, 40)
  const pick = (command: TaskCommandDescriptor): void => {
    setSelected(command); onSelect(command.id)
    const same = input.trimStart().split(/\s/, 1)[0] === `/${command.name}`
    const next = same ? input : command.id === SCRY_WORKFLOW_COMMAND_ID && input.trim() && !input.trimStart().startsWith('/')
      ? `/${command.name} run ${input}` : `/${command.name} ${input.trimStart().startsWith('/') ? input.trimStart().replace(/^\/\S*\s?/, '') : input}`
    onInput(next); setOpen(false); onFocusComposer()
  }
  return <div className="conversation-commands">
    <details ref={details} className="conversation-options" open={open} onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); setOpen(false); details.current?.querySelector('summary')?.focus() }
    }}>
      <summary onClick={event => {
        // Keep one state owner. A delayed native toggle event must not reopen
        // the menu and steal composer focus after a source was selected.
        event.preventDefault()
        setOpen(!open)
        if (!open && !catalog && !loading) void load(false)
      }}>{copy.commands}</summary>
      <div className="unified-management conversation-command-menu">
        <input ref={filter} aria-label={copy.search} placeholder={copy.search} value={query} onChange={event => setQuery(event.target.value)} />
        <button className="btn" disabled={disabled || loading} onClick={() => { void load(true) }}>{loading ? copy.loading : copy.native}</button>
        {catalog && !catalog.provider.complete && <p role="status">{catalog.provider.reason ?? copy.unknown}</p>}
        {error && <p role="alert">{error}</p>}
        {visible.map(command => <button className="btn conversation-command-row" key={command.id} disabled={disabled || (command.origin.kind === 'provider' && command.ambiguous)}
          onClick={() => pick(command)} title={command.ambiguous && command.origin.kind === 'provider' ? copy.ambiguous : command.description}>
          <strong>{command.origin.kind === 'scry_workflow' ? copy.scry : copy.provider}<code>{`/${command.name}`}</code></strong>
          {command.origin.kind === 'provider' && <span>{[command.origin.providerId, command.origin.agentProfileId, command.nativeSource].filter(Boolean).join(' · ')}</span>}
          <span>{command.description}</span><code>{command.id}</code>
        </button>)}
        {catalog && !matches.length && <p>{copy.noMatches}</p>}
        {matches.length > visible.length && <p role="status">{copy.shown(visible.length, matches.length)}</p>}
      </div>
    </details>
    {selected && <span className="conversation-command-selected" aria-label={copy.selected}>
      <span>{selected.origin.kind === 'scry_workflow' ? copy.scry : copy.provider}<code>{`/${selected.name}`}</code></span>
      <button className="btn" disabled={disabled} onClick={() => {
        setSelected(undefined); onSelect(undefined); onInput(input.split('\n').map(line => `> ${line}`).join('\n')); onFocusComposer()
      }}>{copy.quote}</button>
    </span>}
  </div>
}
