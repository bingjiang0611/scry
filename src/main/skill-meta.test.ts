import { describe, it, expect } from 'vitest'
import { readSkillMeta } from './skill-meta'

describe('readSkillMeta', () => {
  it('无 frontmatter → 空对象', () => {
    expect(readSkillMeta('# 普通 markdown\n没有 frontmatter')).toEqual({})
  })

  it('单行 name + description', () => {
    const md = `---
name: foo
description: 一句话描述
---
正文`
    expect(readSkillMeta(md)).toEqual({ name: 'foo', description: '一句话描述' })
  })

  it('description 是 >- 折叠块（多行缩进续行拼成一行）', () => {
    const md = `---
name: baoyu-translate
description: >-
  把英文技术文章翻译成中文，
  保留图片与代码块，
  去 AI 味。
---`
    expect(readSkillMeta(md)).toEqual({
      name: 'baoyu-translate',
      description: '把英文技术文章翻译成中文， 保留图片与代码块， 去 AI 味。'
    })
  })

  it('description 是 | 字面块', () => {
    const md = `---
name: bar
description: |
  第一行
  第二行
---`
    expect(readSkillMeta(md).description).toBe('第一行 第二行')
  })

  it('裸 > 折叠标记同样解析续行', () => {
    const md = `---
description: >
  alpha
  beta
---`
    expect(readSkillMeta(md).description).toBe('alpha beta')
  })

  it('多行块在遇到下一个非缩进 key 时停止', () => {
    const md = `---
name: claude-to-im
description: >-
  只取这两行
  续行
allowed-tools: Read, Write
---`
    expect(readSkillMeta(md).description).toBe('只取这两行 续行')
  })

  it('折叠标记后的空行被跳过，不混入描述', () => {
    const md = `---
description: |

  内容行
---`
    expect(readSkillMeta(md).description).toBe('内容行')
  })

  it('只有 name 没有 description', () => {
    const md = `---
name: only-name
---`
    expect(readSkillMeta(md)).toEqual({ name: 'only-name', description: '' })
  })

  it('description 截断到 300 字符', () => {
    const long = 'x'.repeat(500)
    const md = `---
description: ${long}
---`
    expect(readSkillMeta(md).description).toHaveLength(300)
  })
})
