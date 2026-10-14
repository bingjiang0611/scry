import { describe, expect, it } from 'vitest'
import {
  appendMetaPrompt,
  filterMetaPrompts,
  META_PROMPTS_STORAGE_KEY,
  readMetaPrompts,
  writeMetaPrompts,
  type MetaPrompt
} from './meta-prompts'

const prompt: MetaPrompt = { id: 'one', title: '技术方案', body: '  Check Provider\n\n<script>literal</script>\n' }

function storage(initial: string | null = null) {
  const values = new Map<string, string>(initial === null ? [] : [[META_PROMPTS_STORAGE_KEY, initial]])
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) }
  }
}

describe('personal Meta Prompts library', () => {
  it('starts empty only when the storage key is absent', () => {
    expect(readMetaPrompts(storage())).toEqual([])
    expect(() => readMetaPrompts(storage(''))).toThrow()
  })

  it('persists exact plain text and can be read by a new consumer', () => {
    const local = storage()
    writeMetaPrompts(local, [prompt])
    expect(readMetaPrompts(local)).toEqual([prompt])
    expect(local.getItem(META_PROMPTS_STORAGE_KEY)).not.toContain('starred')
  })

  it.each(['{broken', '{}', 'null', '[{"id":"one","title":" ","body":"text"}]'])('rejects invalid data without replacing it: %s', raw => {
    const local = storage(raw)
    expect(() => readMetaPrompts(local)).toThrow()
    expect(local.getItem(META_PROMPTS_STORAGE_KEY)).toBe(raw)
  })

  it('rejects duplicate identities and invalid fields', () => {
    expect(() => readMetaPrompts(storage(JSON.stringify([prompt, prompt])))).toThrow('格式无效')
    expect(() => readMetaPrompts(storage(JSON.stringify([{ ...prompt, body: '\n  ' }])))).toThrow()
    expect(() => readMetaPrompts(storage(JSON.stringify([{ ...prompt, title: 'a'.repeat(121) }])))).toThrow()
  })

  it('does not hide storage read or write failures', () => {
    expect(() => readMetaPrompts({ getItem: () => { throw new Error('access denied') } })).toThrow('access denied')
    expect(() => writeMetaPrompts({ setItem: () => { throw new Error('quota exceeded') } }, [prompt])).toThrow('quota exceeded')
  })

  it('persists edits and deletion without reordering unrelated prompts', () => {
    const local = storage()
    const second = { id: 'two', title: '第二条', body: '保留内容' }
    writeMetaPrompts(local, [{ ...prompt, body: '修改后\n\n的正文' }, second])
    expect(readMetaPrompts(local)[0].body).toBe('修改后\n\n的正文')
    writeMetaPrompts(local, [second])
    expect(readMetaPrompts(local)).toEqual([second])
    writeMetaPrompts(local, [])
    expect(readMetaPrompts(local)).toEqual([])
  })

  it('searches title and body without modifying library order or text', () => {
    expect(filterMetaPrompts([prompt], '方案')).toEqual([prompt])
    expect(filterMetaPrompts([prompt], ' PROVIDER ')).toEqual([prompt])
    expect(filterMetaPrompts([prompt], '')).toEqual([prompt])
    expect(filterMetaPrompts([prompt], 'missing')).toEqual([])
  })

  it('appends to the selected composer draft without losing existing text or line breaks', () => {
    expect(appendMetaPrompt('原任务\n', prompt.body)).toBe(`原任务\n\n\n${prompt.body}`)
    expect(appendMetaPrompt('', prompt.body)).toBe(prompt.body)
  })
})
