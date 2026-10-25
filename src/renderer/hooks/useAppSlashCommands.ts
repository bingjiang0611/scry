import { useCallback, useRef, useState, useSyncExternalStore } from 'react'
import type { ProviderContext } from '@shared/provider'
import type { SlashCmd } from '@shared/trace'
import type { createComposerDraftStore } from '../composer-drafts'
import { failedSlashCatalog, providerContextCacheKey } from '../app-model'

export function useAppSlashCommands(
  providerContext: ProviderContext,
  draftStore: ReturnType<typeof createComposerDraftStore>,
  draftKey: string
) {
  const slashRequestSeqRef = useRef(0)
  const slashCacheRef = useRef(new Map<string, { commands: SlashCmd[]; reason: string | null }>())
  const integrationContextKeyRef = useRef('')
  integrationContextKeyRef.current = providerContextCacheKey(providerContext)
  // 斜杠命令面板：输入以 / 开头且无空白时弹出；命令清单由当前 Provider 原生能力提供。
  const [slashCmds, setSlashCmds] = useState<SlashCmd[]>([])
  const [slashReason, setSlashReason] = useState<string | null>(null)
  const [slashLoading, setSlashLoading] = useState(false)
  const [slashRefreshKey, setSlashRefreshKey] = useState(0)
  const [slashSel, setSlashSel] = useState(0)
  const [slashHidden, setSlashHidden] = useState(false) // Esc 临时收起；改输入时复位
  const readSlashToken = () => {
    const input = draftStore.getSnapshot().get(draftKey)?.input ?? ''
    return input.startsWith('/') && !/\s/.test(input) ? input.slice(1) : null
  }
  const slashToken = useSyncExternalStore(draftStore.subscribe, readSlashToken, readSlashToken)
  // 输入命令 token 时总是开菜单：加载中/清单空/无匹配 都摊开显示，不再静默藏掉
  const slashOpen = slashToken != null && !slashHidden
  const retrySlash = (): void => {
    slashRequestSeqRef.current += 1
    slashCacheRef.current.delete(integrationContextKeyRef.current)
    setSlashCmds([])
    setSlashReason(null)
    setSlashRefreshKey((key) => key + 1)
  }
  const refreshSlashCatalog = useCallback((): void => {
    const seq = ++slashRequestSeqRef.current
    const context = providerContext
    const requestKey = providerContextCacheKey(context)
    const cached = slashCacheRef.current.get(requestKey)
    setSlashCmds(cached?.commands ?? [])
    setSlashReason(cached?.reason ?? null)
    // 防御：老 preload 可能没 slashCommands（dev 没重建时）。直接 undefined() 会同步抛错冲垮整个渲染树→黑屏。
    const fn = window.scry?.listCommands
    if (typeof fn !== 'function') return
    setSlashLoading(cached == null)
    Promise.resolve()
      .then(() => fn(context))
      .then((result) => {
        if (seq !== slashRequestSeqRef.current || requestKey !== integrationContextKeyRef.current) return
        slashCacheRef.current.set(requestKey, {
          commands: result.data ?? [],
          reason: result.reason ?? null
        })
        setSlashCmds(result.data ?? [])
        setSlashReason(result.reason ?? null)
      })
      .catch((error) => {
        if (seq !== slashRequestSeqRef.current || requestKey !== integrationContextKeyRef.current) return
        const failure = failedSlashCatalog<SlashCmd, { commands: SlashCmd[]; reason: string | null }>(
          slashCacheRef.current,
          requestKey,
          error
        )
        setSlashCmds(failure.commands)
        setSlashReason(failure.reason)
      })
      .finally(() => {
        if (seq === slashRequestSeqRef.current) setSlashLoading(false)
      })
  }, [providerContext, slashRefreshKey])
  return {
    slashCmds, slashReason, slashLoading, slashSel, setSlashSel,
    slashHidden, setSlashHidden, slashToken, slashOpen, retrySlash, refreshSlashCatalog
  }
}
