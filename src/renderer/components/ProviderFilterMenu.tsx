import { PROVIDER_LABELS, type ProviderId } from '@shared/provider'
import { PROVIDER_FILTER_COPY } from '../constants/copy'
import { Icon } from './primitives/Icon'

export function providerFilterLabel(provider: string): string {
  if (provider === 'all') return PROVIDER_FILTER_COPY.all
  if (provider === 'legacy_unknown') return PROVIDER_FILTER_COPY.unknown
  return PROVIDER_LABELS[provider as ProviderId] ?? provider
}

export function ProviderFilterSelect({ providers, value, onChange }: {
  providers: readonly string[]
  value: string
  onChange: (provider: string) => void
}) {
  const choices = value === 'all' || providers.includes(value) ? providers : [value, ...providers]
  return <label className="arch-filter">
    <Icon name="filter" />
    <select aria-label={PROVIDER_FILTER_COPY.label} value={value} onChange={event => onChange(event.currentTarget.value)}>
      <option value="all">{providerFilterLabel('all')}</option>
      {choices.map(provider => <option key={provider} value={provider}>{providerFilterLabel(provider)}</option>)}
    </select>
  </label>
}
