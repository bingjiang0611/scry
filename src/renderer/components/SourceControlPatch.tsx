import { lazy, Suspense } from 'react'
import type { ScDiff } from '@shared/source-control'
import { DIFF_COPY as copy } from '../constants/diff-copy'

const PierrePatch = lazy(() => import('./PierrePatch').then(module => ({ default: module.Patch })))

export function Patch(props: { diff: ScDiff; path?: string; onLine?: (side: 'LEFT' | 'RIGHT', line: number) => void }) {
  return <Suspense fallback={<p role="status">{copy.loadingView}</p>}><PierrePatch {...props} /></Suspense>
}
