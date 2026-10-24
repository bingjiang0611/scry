import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { AgentModelOption } from '@shared/runtime'
import { ModelEffortPicker } from './ModelEffortPicker'
import { groupModelOptions, modelPickerOptions } from './model-picker-options'

const catalog: AgentModelOption[] = [
  { model: { providerId: 'provider-a', id: 'shared' }, label: 'Shared Model', efforts: [] },
  { model: { providerId: 'provider-b', id: 'shared' }, label: 'Shared Model', efforts: [] },
  { model: { providerId: 'provider-a', id: 'fast' }, label: 'Fast Model', efforts: [] }
]

describe('provider-grouped model picker', () => {
  it('keeps identical names and IDs separate across providers without redundant ID suffixes', () => {
    const options = modelPickerOptions(catalog, null, false)
    expect(options.map(({ value, label }) => [value, label])).toEqual([
      ['', '自动模型'],
      ['["provider-a","shared"]', 'Shared Model'],
      ['["provider-b","shared"]', 'Shared Model'],
      ['["provider-a","fast"]', 'Fast Model']
    ])
    expect(groupModelOptions(options, '').map(({ providerId, options }) => [providerId, options.length]))
      .toEqual([[undefined, 1], ['provider-a', 2], ['provider-b', 1]])
  })

  it('only appends model ID for duplicate names within the same provider', () => {
    const options = modelPickerOptions([...catalog,
      { model: { providerId: 'provider-a', id: 'shared-v2' }, label: 'Shared Model', efforts: [] }
    ], null, false)
    expect(options.slice(1).map((option) => option.label)).toEqual([
      'Shared Model · shared', 'Shared Model', 'Fast Model', 'Shared Model · shared-v2'
    ])
  })

  it.each([
    ['  PROVIDER-B shared  ', ['["provider-b","shared"]']],
    ['fast', ['["provider-a","fast"]']],
    ['shared', ['["provider-a","shared"]', '["provider-b","shared"]']],
    ['nothing-matches', []],
    ['自动', ['']]
  ])('filters names, IDs and providers without changing identity: %s', (query, expected) => {
    const groups = groupModelOptions(modelPickerOptions(catalog, null, false), query)
    expect(groups.flatMap((group) => group.options.map((option) => option.value))).toEqual(expected)
  })

  it('searches an ID that differs from the display label', () => {
    const options = modelPickerOptions([{ model: { id: 'internal-42' }, label: 'Friendly Name', efforts: [] }], null, false)
    expect(groupModelOptions(options, 'INTERNAL-42')[0].options[0].label).toBe('Friendly Name')
    expect(options[1].value).toBe('[null,"internal-42"]')
  })

  it('does not invent a provider for provider-less catalog entries or replace error reasons', () => {
    const options = modelPickerOptions([{ model: { id: 'local' }, label: 'Local', efforts: [] }], 'catalog unavailable', true)
    expect(options[0].description).toBe('catalog unavailable')
    expect(groupModelOptions(options, '')[0].providerId).toBeUndefined()
    expect(modelPickerOptions([], null, true)[0].description).toContain('正在后台读取')
  })

  it('retains the provider in both the selected trigger and summary', () => {
    const html = renderToStaticMarkup(<ModelEffortPicker
      open
      modelValue='["provider-b","shared"]'
      modelOptions={modelPickerOptions(catalog, null, false)}
      effortValue=""
      effortOptions={[{ value: '', label: '默认' }]}
      onModelChange={() => {}}
      onEffortChange={() => {}}
    />)
    expect(html).toContain('class="model-effort-model">provider-b / Shared Model')
    expect(html).toContain('class="model-effort-current-model">provider-b / Shared Model')
  })
})
