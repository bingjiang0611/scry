import { useEffect, useRef, useState, type AnimationEvent } from 'react'

import { prefersReducedMotion } from '../../motion'
import { Icon, type IconName } from './Icon'

// An icon that already means the action (refresh, sync) turns instead of being
// swapped for a spinner. Phases, all transform-only:
// The decision to loop or settle is taken at 180°, so an instant answer still
// gets exactly one whole turn (640ms), three turns land at 1.7s, and a long
// wait always stops on a whole turn.
type TurnPhase = 'idle' | 'start' | 'loop' | 'settle'

export function TurningIcon({ busy, name = 'refresh' }: { busy: boolean; name?: IconName }) {
  const [phase, setPhase] = useState<TurnPhase>('idle')
  const busyRef = useRef(busy)
  busyRef.current = busy
  useEffect(() => {
    // Reduced motion keeps the busy state (aria-busy, blocked press) without the turn.
    if (busy && phase === 'idle' && !prefersReducedMotion()) setPhase('start')
  }, [busy, phase])
  const onEnd = (event: AnimationEvent<HTMLSpanElement>): void => {
    if (event.target !== event.currentTarget) return
    if (phase === 'start') setPhase(busyRef.current ? 'loop' : 'settle')
    else if (phase === 'settle') setPhase('idle')
    // The global reduced-motion rule can cut the loop to one run mid-wait.
    else if (phase === 'loop') setPhase('settle')
  }
  const onIteration = (event: AnimationEvent<HTMLSpanElement>): void => {
    if (event.target === event.currentTarget && phase === 'loop' && !busyRef.current) setPhase('settle')
  }
  return (
    <span className="turning-icon" data-phase={phase} aria-hidden="true" onAnimationEnd={onEnd} onAnimationIteration={onIteration}>
      <Icon name={name} />
    </span>
  )
}
