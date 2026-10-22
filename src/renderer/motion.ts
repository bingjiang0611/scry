export const MOTION = {
  durMicro: 100,
  durFast: 160,
  durBase: 220,
  durSlow: 300,
  easeOut: 'cubic-bezier(0.23, 1, 0.32, 1)',
  easeStruct: 'cubic-bezier(0.32, 0.72, 0, 1)',
  easeExit: 'cubic-bezier(0.4, 0, 1, 1)'
} as const

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'

export function prefersReducedMotion(): boolean {
  return window.matchMedia(REDUCED_MOTION_QUERY).matches
}

export function subscribeReducedMotion(cb: (reduced: boolean) => void): () => void {
  const media = window.matchMedia(REDUCED_MOTION_QUERY)
  const onChange = (): void => cb(media.matches)
  media.addEventListener('change', onChange)
  return () => media.removeEventListener('change', onChange)
}
