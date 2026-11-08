import { useEffect, useState, type PropsWithChildren } from 'react'
import { WorkerPoolContextProvider, type WorkerPoolOptions } from '@pierre/diffs/react'

const poolOptions: WorkerPoolOptions = {
  workerFactory: () => new Worker(new URL('../pierre-diff.worker.ts', import.meta.url), { type: 'module' }),
  poolSize: 2,
  totalASTLRUCacheSize: 32
}
export const diffTheme = { light: 'github-light', dark: 'github-dark' }
const highlighterOptions = { theme: diffTheme, preferredHighlighter: 'shiki-js' as const, langs: ['text' as const] }

export function useDiffTheme(): 'light' | 'dark' {
  const read = (): 'light' | 'dark' => typeof document !== 'undefined' && document.documentElement.dataset.theme === 'light' ? 'light' : 'dark'
  const [theme, setTheme] = useState(read)
  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(read()))
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => observer.disconnect()
  }, [])
  return theme
}

export function PierreDiffRuntime({ children }: PropsWithChildren) {
  return <WorkerPoolContextProvider poolOptions={poolOptions} highlighterOptions={highlighterOptions}>
    {children}
  </WorkerPoolContextProvider>
}
