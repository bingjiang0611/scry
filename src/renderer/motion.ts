export const MOTION = {
  durationHover: 120,
  durationSm: 200,
  durationMd: 250,
  durationLg: 400,
  durationExitSm: 150,
  durationExitMd: 200,
  durationReduced: 150,
  durationOvershoot: 300,
  easeOut: 'cubic-bezier(0, 0, 0.58, 1)',
  easeOutStrong: 'cubic-bezier(0.22, 1, 0.36, 1)',
  easeIn: 'cubic-bezier(0.42, 0, 1, 1)',
  easeInOut: 'cubic-bezier(0.42, 0, 0.58, 1)',
  easeOvershoot: 'cubic-bezier(0.34, 1.56, 0.64, 1)',
  easeSpring: 'linear(0, .32, .78, 1.04, 1.09, 1.06, 1.02, 1, .99, .99, 1)'
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
