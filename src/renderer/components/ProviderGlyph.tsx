import type { ProviderId } from '@shared/provider'

export function ProviderGlyph({
  provider,
  label,
  className,
  title
}: {
  provider: ProviderId
  label?: string
  className?: string
  title?: string
}) {
  return (
    <span
      className={['provider-glyph', className].filter(Boolean).join(' ')}
      data-provider={provider}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      title={title ?? label}
    />
  )
}
