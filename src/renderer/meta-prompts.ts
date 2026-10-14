export interface MetaPrompt {
  id: string
  title: string
  body: string
}

export const META_PROMPTS_STORAGE_KEY = 'scry.meta-prompts.v1'
export const META_PROMPT_TITLE_LIMIT = 120

function isMetaPrompt(value: unknown): value is MetaPrompt {
  if (!value || typeof value !== 'object') return false
  const prompt = value as Partial<MetaPrompt>
  return typeof prompt.id === 'string' && prompt.id.length > 0 &&
    typeof prompt.title === 'string' && prompt.title.trim().length > 0 && prompt.title.length <= META_PROMPT_TITLE_LIMIT &&
    typeof prompt.body === 'string' && prompt.body.trim().length > 0
}

// Personal library shares the renderer's persistent app origin, like composer drafts.
// Invalid data must not become an empty library that a subsequent save overwrites.
export function readMetaPrompts(storage: Pick<Storage, 'getItem'>): MetaPrompt[] {
  const raw = storage.getItem(META_PROMPTS_STORAGE_KEY)
  if (raw === null) return []
  const value: unknown = JSON.parse(raw)
  if (!Array.isArray(value) || !value.every(isMetaPrompt) || new Set(value.map(prompt => prompt.id)).size !== value.length) {
    throw new Error('提示词数据格式无效；原数据未被修改')
  }
  return value
}

export function writeMetaPrompts(storage: Pick<Storage, 'setItem'>, prompts: readonly MetaPrompt[]): void {
  storage.setItem(META_PROMPTS_STORAGE_KEY, JSON.stringify(prompts))
}

export function filterMetaPrompts(prompts: readonly MetaPrompt[], query: string): MetaPrompt[] {
  const term = query.trim().toLocaleLowerCase()
  return prompts.filter(prompt => `${prompt.title}\n${prompt.body}`.toLocaleLowerCase().includes(term))
}

export function appendMetaPrompt(draft: string, body: string): string {
  return draft ? `${draft}\n\n${body}` : body
}
