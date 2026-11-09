// 归档列表的 Provider 筛选：单选菜单，保留品牌图标与当前项对勾。
import { useId, useRef } from 'react'

import { PROVIDER_LABELS, type ProviderId } from '@shared/provider'

import { Icon } from './primitives/Icon'
import { ProviderGlyph } from './ProviderGlyph'
import { MenuCheck } from './menu-parts'
import { useMenuDismiss, usePickerOpen, type PickerOpenProps } from './picker-state'
import { moveMenuFocus } from './WorkdirPicker'

/** Provider id 不是给人读的；未知来源单独说明，不冒充成某个 Provider。 */
export function providerFilterLabel(provider: string): string {
  if (provider === 'all') return '全部 Provider'
  if (provider === 'legacy_unknown') return 'Provider 未知'
  return PROVIDER_LABELS[provider as ProviderId] ?? provider
}

export function ProviderFilterMenu({
  providers,
  value,
  onChange,
  open: controlledOpen,
  onOpenChange
}: {
  providers: string[]
  value: string
  onChange: (provider: string) => void
} & PickerOpenProps) {
  const [open, setOpen] = usePickerOpen(controlledOpen, onOpenChange)
  const menuId = useId()
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const close = (): void => setOpen(false)
  useMenuDismiss({ open, close, rootRef, triggerRef, menuRef })
  const pick = (provider: string): void => {
    onChange(provider)
    close()
  }
  return (
    <div className="arch-filter arch-provider-filter" ref={rootRef}>
      <Icon name="filter" />
      <button
        type="button"
        ref={triggerRef}
        className="arch-provider-trigger"
        aria-label="按 Provider 筛选"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        title="按 Provider 筛选"
        onClick={() => setOpen((current) => !current)}
      >
        {providerFilterLabel(value)}
        <Icon name="chevronDown" />
      </button>
      {open && (
        <div
          id={menuId}
          ref={menuRef}
          className="menu arch-provider-menu"
          role="menu"
          aria-label="按 Provider 筛选"
          onKeyDown={(event) => moveMenuFocus(event, menuRef.current)}
        >
          <button
            type="button"
            role="menuitemradio"
            className="mitem"
            aria-checked={value === 'all'}
            onClick={() => pick('all')}
          >
            <MenuCheck selected={value === 'all'} />
            <Icon name="grid" />
            <span>{providerFilterLabel('all')}</span>
          </button>
          <div className="mdiv" role="separator" />
          {providers.map((provider) => (
            <button
              key={provider}
              type="button"
              role="menuitemradio"
              className="mitem"
              data-provider-option={provider}
              aria-checked={value === provider}
              onClick={() => pick(provider)}
            >
              <MenuCheck selected={value === provider} />
              {provider === 'legacy_unknown'
                ? <Icon name="box" />
                : <ProviderGlyph provider={provider as ProviderId} />}
              <span>{providerFilterLabel(provider)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
