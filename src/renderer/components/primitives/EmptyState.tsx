import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { Button } from './Button'
import { Icon, type IconName } from './Icon'
import { TurningIcon } from './TurningIcon'
import { MOTION, prefersReducedMotion } from '../../motion'
import './empty-state.css'

const useCommitEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect
const OutgoingState = createContext(false)

export type EmptyStateSize = 'page' | 'card' | 'row' | 'menu'
export type EmptyStateAction = {
  label: string
  onClick: () => void
  intent?: 'primary' | 'secondary' | 'quiet'
  busy?: boolean
  disabled?: boolean
  icon?: 'refresh' | 'check'
}

type EmptyStateProps = {
  size: EmptyStateSize
  title: string
  description?: ReactNode
  picture?: IconName | ReactNode
  actions?: readonly [EmptyStateAction] | readonly [EmptyStateAction, EmptyStateAction]
  announcement?: 'polite' | 'alert'
  focusAction?: boolean
  className?: string
  status?: string
  as?: 'div' | 'li'
}

/** New content takes the slot immediately; the old state fades as a non-interactive overlay. */
export function EmptyStateSlot({ empty, children, className }: { empty: ReactNode; children?: ReactNode; className?: string }) {
  const latest = useRef<ReactNode>(null)
  const [exiting, setExiting] = useState<ReactNode>(null)
  const showing = Boolean(empty)
  useCommitEffect(() => {
    if (showing && empty) latest.current = empty
  }, [empty, showing])
  useCommitEffect(() => {
    if (showing) { setExiting(null); return }
    if (!latest.current) return
    setExiting(latest.current)
    latest.current = null
    const timer = window.setTimeout(() => setExiting(null), prefersReducedMotion() ? MOTION.durationReduced : MOTION.durationExitMd)
    return () => window.clearTimeout(timer)
  }, [showing])
  return <div className={['empty-state-slot', className].filter(Boolean).join(' ')}>
    {showing ? empty : children}
    {!showing && exiting && <div className="empty-state-outgoing" aria-hidden="true" {...{ inert: '' }}>
      <OutgoingState.Provider value>{exiting}</OutgoingState.Provider>
    </div>}
  </div>
}

export function EmptyState({ size, title, description, picture, actions, announcement, focusAction, className, status, as: Root = 'div' }: EmptyStateProps) {
  const outgoing = useContext(OutgoingState)
  const mainAction = useRef<HTMLButtonElement>(null)
  const [spoken, setSpoken] = useState('')
  useEffect(() => {
    // Mount the live region first; an already-populated live region can be missed.
    if (outgoing || announcement !== 'polite') return
    let nextFrame: number | undefined
    const frame = requestAnimationFrame(() => { nextFrame = requestAnimationFrame(() => setSpoken(title)) })
    return () => {
      cancelAnimationFrame(frame)
      if (nextFrame !== undefined) cancelAnimationFrame(nextFrame)
    }
  }, [announcement, outgoing, title])
  useEffect(() => {
    if (!outgoing && size === 'page' && focusAction && document.activeElement === document.body) {
      mainAction.current?.focus({ preventScroll: true })
    }
  }, [size, focusAction, outgoing])

  const page = size === 'page'
  const compact = size === 'row' || size === 'menu'
  const Title = page ? 'h2' : 'span'
  return <Root className={['empty-state', className].filter(Boolean).join(' ')} data-empty-size={size} data-status={status} role={announcement === 'alert' ? 'alert' : undefined}>
    <div className="empty-state-content">
      {!compact && picture && <span className="empty-state-picture" aria-hidden="true">
        {typeof picture === 'string' ? <Icon name={picture as IconName} /> : picture}
      </span>}
      <div className="empty-state-text">
        <Title className="empty-state-title" dir="auto">{title}</Title>
        {page && description && <div className="empty-state-description">{description}</div>}
      </div>
      {size !== 'menu' && actions && actions.length > 0 && <span className="empty-state-actions">
        {actions.map((action, index) => <Button
          key={index}
          ref={index === 0 ? mainAction : undefined}
          size={page ? 'md' : 'sm'}
          variant={page ? (index === 1 && action.intent === 'primary' ? 'secondary' : action.intent ?? (index === 0 ? 'primary' : 'secondary')) : 'quiet'}
          disabled={action.disabled}
          aria-disabled={action.busy || undefined}
          aria-busy={action.busy || undefined}
          onClick={() => { if (!action.busy) action.onClick() }}
        >
          {action.icon === 'refresh' ? <TurningIcon busy={Boolean(action.busy)} /> : action.icon === 'check' ? <Icon name="check" /> : null}
          {action.label}
        </Button>)}
      </span>}
    </div>
    {announcement === 'polite' && <span className="empty-state-live" aria-live="polite" aria-atomic="true">{spoken}</span>}
  </Root>
}
