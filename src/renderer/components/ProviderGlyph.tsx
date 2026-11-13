import type { ProviderId } from '@shared/provider'
import { PROVIDER_BRAND_MARKS } from '../provider-brand-marks'

/**
 * Provider 品牌标志。图形是真实品牌标（颜色由 CSS 的 --glyph-color 决定），
 * 不做单色 mask：同一形状在会话行、欢迎页、选择器与分析面板里保持一致。
 */
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
  const mark = PROVIDER_BRAND_MARKS[provider]
  return (
    <span
      className={['provider-glyph', className].filter(Boolean).join(' ')}
      data-provider={provider}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      title={title ?? label}
    >
      <svg viewBox="0 0 24 24" focusable="false">
        {mark.paths.map((d) => (
          <path key={d} d={d} fillRule={mark.fillRule} clipRule={mark.fillRule} />
        ))}
      </svg>
    </span>
  )
}
