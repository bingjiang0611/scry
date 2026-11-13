import { useEffect, useId, useMemo, useRef, useState, type CSSProperties } from 'react'
import { flushSync } from 'react-dom'
import { Icon } from './primitives/Icon'
import { usePickerOpen, type PickerOpenProps, type RunControlSelectOption } from './picker-state'
import { groupModelOptions, type ModelPickerOption } from './model-picker-options'
import { useOpenPresence } from '../hooks/usePresence'
import { MOTION, prefersReducedMotion } from '../motion'
import { MODEL_PICKER_COPY as COPY } from '../constants/model-picker-copy'
import './model-picker.css'

export function ModelEffortPicker({
  modelValue,
  modelOptions,
  effortValue,
  effortOptions,
  onModelChange,
  onEffortChange,
  loading = false,
  open: controlledOpen,
  onOpenChange
}: {
  modelValue: string
  modelOptions: ModelPickerOption[]
  effortValue: string
  effortOptions: RunControlSelectOption[]
  onModelChange: (value: string) => void
  onEffortChange: (value: string) => void
  loading?: boolean
} & PickerOpenProps) {
  const [open, setOpen] = usePickerOpen(controlledOpen, onOpenChange)
  const [listView, setListView] = useState(false)
  // Only a real hand-over between the two layers animates; the first mount of the
  // summary must not slide in as if the user came back from the list.
  const [viewMotion, setViewMotion] = useState<'list' | 'summary' | null>(null)
  const [query, setQuery] = useState('')
  const pickerRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const currentRef = useRef<HTMLButtonElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const optionListRef = useRef<HTMLDivElement>(null)
  const popoverRef = useRef<HTMLDivElement | null>(null)
  const morphRef = useRef<Animation | null>(null)
  const presence = useOpenPresence(open)
  const popoverId = useId()
  const selectedModel = modelOptions.find((option) => option.value === modelValue) ?? modelOptions[0]
  const modelLabel = selectedModel ? COPY.qualified(selectedModel.providerId, selectedModel.label) : COPY.automatic
  const selectedEffort = effortOptions.find((option) => option.value === effortValue) ?? effortOptions[0]
  const effortLabel = selectedEffort?.label ?? COPY.defaultEffort
  const effortIndex = Math.max(0, effortOptions.findIndex((option) => option.value === effortValue))
  const effortProgress = effortOptions.length > 1 ? `${effortIndex / (effortOptions.length - 1) * 100}%` : '100%'
  const effortStyle = { '--effort-progress': effortProgress } as CSSProperties
  const groups = useMemo(() => listView ? groupModelOptions(modelOptions, query) : [], [listView, modelOptions, query])
  const resultCount = groups.reduce((count, group) => count + group.options.filter((option) => option.value !== '').length, 0)

  useEffect(() => {
    // Reset only after the exit finishes so the outgoing popover keeps the layer
    // the user was looking at instead of swapping back to the summary while fading.
    if (presence.present) return
    setListView(false)
    setQuery('')
    // A hand-over retired before its animation ended never fires animationend, so the
    // one-shot flag has to be cleared with the rest of the per-open state.
    setViewMotion(null)
  }, [presence.present])

  useEffect(() => {
    if (!loading) return
    setOpen(false)
  }, [loading])

  useEffect(() => () => { morphRef.current?.cancel(); morphRef.current = null }, [])

  useEffect(() => {
    if (!open) return
    const focusTimer = window.setTimeout(() => {
      if (listView) searchRef.current?.focus()
      else currentRef.current?.focus()
    }, 0)
    const dismissOnOutsidePointer = (event: PointerEvent): void => {
      if (!(event.target instanceof Node) || pickerRef.current?.contains(event.target)) return
      setOpen(false)
    }
    const dismissOnEscape = (event: KeyboardEvent): void => {
      if (event.isComposing || event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      setOpen(false)
      triggerRef.current?.focus()
    }
    document.addEventListener('pointerdown', dismissOnOutsidePointer, true)
    document.addEventListener('keydown', dismissOnEscape)
    return () => {
      window.clearTimeout(focusTimer)
      document.removeEventListener('pointerdown', dismissOnOutsidePointer, true)
      document.removeEventListener('keydown', dismissOnEscape)
    }
  }, [listView, open])

  /**
   * The popover is anchored at its bottom-right corner, so animating its own box
   * keeps the corner next to the trigger fixed while the summary and the model list
   * hand over to each other. Nothing else on the page reflows: it is an overlay.
   */
  const morphPopover = (next: () => void): void => {
    const node = popoverRef.current
    if (!node || prefersReducedMotion() || typeof node.animate !== 'function') { next(); return }
    // Layout box, not the visual rect: an entry scale is still running on the popover
    // and must not leak into the morph's end size. The previous morph has to be gone
    // before the new size is measured, otherwise its animating width is what we read
    // and the second hand-over would animate the old box onto itself.
    const before = { width: node.offsetWidth, height: node.offsetHeight }
    morphRef.current?.cancel()
    morphRef.current = null
    flushSync(next)
    const after = { width: node.offsetWidth, height: node.offsetHeight }
    if (before.width === after.width && before.height === after.height) return
    morphRef.current = node.animate([
      { width: `${before.width}px`, height: `${before.height}px` },
      { width: `${after.width}px`, height: `${after.height}px` }
    ], { duration: MOTION.durationSm, easing: MOTION.easeOutStrong })
  }

  const renderOption = (option: ModelPickerOption) => {
    const selected = option.value === modelValue
    const label = COPY.qualified(option.providerId, option.label)
    return (
      <button
        type="button"
        role="option"
        aria-label={label}
        aria-selected={selected}
        disabled={option.disabled}
        title={[label, option.description].filter(Boolean).join(' · ')}
        key={option.value}
        onClick={() => {
          if (!selected) onModelChange(option.value)
          morphPopover(() => { setListView(false); setViewMotion('summary') })
        }}
      >
        <span>{option.label}</span>
        {selected && <Icon name="check" />}
      </button>
    )
  }

  return (
    <div className="model-effort-picker" ref={pickerRef}>
      <button
        ref={triggerRef}
        type="button"
        className="model-effort-trigger"
        disabled={loading}
        aria-label={COPY.trigger}
        aria-description={COPY.current(modelLabel, effortLabel)}
        aria-busy={loading}
        aria-expanded={open}
        aria-controls={popoverId}
        aria-haspopup="dialog"
        title={[modelLabel, selectedModel?.description, selectedEffort?.description].filter(Boolean).join(' · ')}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="model-effort-model">{modelLabel}</span>
        <span className="model-effort-effort">{effortLabel}</span>
        <Icon name="chevronDown" className="chev" />
      </button>
      {presence.present && (
        <div
          ref={(node) => { popoverRef.current = node; presence.ref(node); if (node) node.inert = !open }}
          id={popoverId}
          data-state={presence.state}
          className={`model-effort-popover${listView ? ' model-effort-grouped' : ''}`}
          role="dialog"
          aria-label={COPY.dialog}
        >
          <div
            className="model-effort-view"
            data-view-motion={viewMotion ?? undefined}
            onAnimationEnd={(event) => { if (event.target === event.currentTarget) setViewMotion(null) }}
          >
            {!listView ? (
              <>
                <div className="model-effort-summary">
                  <button
                    ref={currentRef}
                    type="button"
                    className="model-effort-current"
                    title={modelLabel}
                    aria-label={COPY.chooseModel(modelLabel)}
                    aria-expanded={false}
                    onClick={() => morphPopover(() => { setListView(true); setViewMotion('list') })}
                  >
                    <span className="model-effort-field-label">{COPY.model}</span>
                    <span className="model-effort-current-model">{modelLabel}</span>
                    <Icon name="chevronRight" className="chev" />
                  </button>
                  <div className="model-effort-strength">
                    <span className="model-effort-field-label">{COPY.effort}</span>
                    <span className="model-effort-current-effort">{effortLabel}</span>
                  </div>
                </div>
                <div className="model-effort-slider" style={effortStyle}>
                  <input
                    type="range"
                    min="0"
                    max={Math.max(0, effortOptions.length - 1)}
                    step="1"
                    value={effortIndex}
                    aria-label={COPY.effort}
                    aria-valuetext={effortLabel}
                    disabled={effortOptions.length <= 1}
                    onChange={(event) => {
                      const option = effortOptions[Number(event.target.value)]
                      if (option && !option.disabled) onEffortChange(option.value)
                    }}
                  />
                  <div className="model-effort-slider-dots" aria-hidden="true">
                    {effortOptions.map((option, index) => (
                      <i className={index <= effortIndex ? 'active' : ''} key={option.value} />
                    ))}
                  </div>
                </div>
              </>
            ) : (
              <>
                <div className="model-effort-search-row">
                  <Icon name="search" />
                  <input
                    ref={searchRef}
                    type="search"
                    className="model-effort-search"
                    aria-label={COPY.search}
                    placeholder={COPY.search}
                    aria-controls={`${popoverId}-models`}
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.nativeEvent.isComposing || event.key !== 'ArrowDown') return
                      event.preventDefault()
                      optionListRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
                    }}
                  />
                  {query && (
                    <button type="button" className="model-effort-clear" aria-label={COPY.clear}
                      onClick={() => { setQuery(''); searchRef.current?.focus() }}>
                      <Icon name="x" />
                    </button>
                  )}
                </div>
                <div
                  id={`${popoverId}-models`}
                  ref={optionListRef}
                  className="model-effort-list"
                  role="listbox"
                  aria-label={COPY.list}
                  onKeyDown={(event) => {
                    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
                    const options = Array.from(optionListRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])
                    if (options.length === 0) return
                    event.preventDefault()
                    const current = options.indexOf(document.activeElement as HTMLButtonElement)
                    const next = event.key === 'Home' ? 0
                      : event.key === 'End' ? options.length - 1
                        : event.key === 'ArrowUp' ? (current <= 0 ? options.length - 1 : current - 1)
                          : (current + 1) % options.length
                    options[next]?.focus()
                  }}
                >
                  {groups.map((group) => (
                    group.providerId ? (
                      <div role="group" aria-label={group.providerId} key={group.providerId} className="model-effort-provider">
                        <div className="model-effort-provider-heading" aria-hidden="true">
                          <span>{group.providerId}</span><span>{group.options.length}</span>
                        </div>
                        {group.options.map(renderOption)}
                      </div>
                    ) : group.options.map(renderOption)
                  ))}
                </div>
                <div className="model-effort-search-status" role="status">
                  {groups.length === 0 ? COPY.empty : COPY.count(resultCount)}
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
