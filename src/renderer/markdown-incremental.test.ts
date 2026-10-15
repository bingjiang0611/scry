import { describe, expect, it } from 'vitest'
import { unified, type Plugin } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import type { Root } from 'mdast'
import { createIncrementalMarkdownPlugin } from './markdown-incremental'
import { remarkWorkspaceFileDirectories } from './workspace-links'

function processor(plugin?: Plugin<[], Root>, parsed?: string[]) {
  const instance = unified().use(remarkParse).use(remarkGfm).use(remarkWorkspaceFileDirectories)
  if (parsed) instance.use(function () {
    const original = this.parser!
    this.parser = (source, file) => {
      parsed.push(source)
      return original(source, file)
    }
  })
  if (plugin) instance.use(plugin)
  return instance
}

function transformed(source: string, plugin?: Plugin<[], Root>) {
  const instance = processor(plugin)
  return instance.runSync(instance.parse(source))
}

const prefix = '`src/` directory: `before.ts`\n\n```ts\nconst a = 1\n```\n\n'

describe('incremental Markdown uses the same authoritative document pipeline', () => {
  it('preserves GFM, positions and paragraph-local workspace links while appending', () => {
    const plugin = createIncrementalMarkdownPlugin()
    const sources = [prefix + 'Tail', prefix + 'Tail **bold**',
      prefix + 'Tail **bold**\n\n`lib/` directory: `after.ts`',
      prefix + 'Tail\n\n| a | b |\n|---|---|\n| x | y |',
      prefix + 'Tail\n\n- [x] done\n- [ ] next',
      prefix + 'Tail\n\n~~~js\nconsole.log(1)\n~~~\n\nLast paragraph']
    for (const source of sources) expect(transformed(source, plugin)).toEqual(transformed(source))
    // A transformed cached paragraph must not accumulate stale file metadata.
    expect(transformed(prefix + 'again', plugin)).toEqual(transformed(prefix + 'again'))
  })

  it('reparses document-wide references and footnotes, including nested definitions', () => {
    const plugin = createIncrementalMarkdownPlugin()
    for (const suffix of ['See [docs].', 'See [docs].\n\n[docs]: https://example.com',
      'See [docs].\n\n[docs]: https://changed.example.com',
      'Footnote[^n]\n\n[^n]: value', '> [docs]: https://nested.example.com']) {
      expect(transformed(prefix + suffix, plugin)).toEqual(transformed(prefix + suffix))
    }
  })

  it('keeps CRLF, BOM, prefix replacements and shortening on correct parsing paths', () => {
    const plugin = createIncrementalMarkdownPlugin()
    for (const source of [prefix, prefix + 'tail\r\nnext', prefix + '\uFEFFtail',
      prefix.replace('a = 1', 'b = 2') + 'changed', 'short', prefix + 'restored']) {
      expect(transformed(source, plugin)).toEqual(transformed(source))
    }
  })

  it.each(['```ts\nx()\n', '```ts\nx()\n```\n', '> ```ts\n> x()\n> ```\n\n',
    '- ```ts\n  x()\n  ```\n\n'])('does not invent a safe boundary for %j', opening => {
    const plugin = createIncrementalMarkdownPlugin()
    const parsed: string[] = []
    for (const suffix of ['tail', 'tail more']) {
      const source = opening + suffix
      const instance = processor(plugin, parsed)
      expect(instance.runSync(instance.parse(source))).toEqual(transformed(source))
    }
    expect(parsed).toEqual([opening + 'tail', opening + 'tail more'])
  })

  it('does not let synthetic parser calls consume or replace the document prefix', () => {
    const plugin = createIncrementalMarkdownPlugin()
    const parsed: string[] = []
    const first = processor(plugin, parsed)
    first.parse(prefix + 'tail')
    const recovery = '```js\nrecovery()\n```\n\n'
    expect(first.parse(recovery)).toEqual(processor().parse(recovery))
    // The cache retains the first processor's parser, including this observer.
    parsed.length = 0
    const second = processor(plugin)
    const source = prefix + 'tail continues'
    expect(second.runSync(second.parse(source))).toEqual(transformed(source))
    expect(parsed).toEqual(['tail continues'])
  })

  it('bounds reparsed characters across repeated streaming appends', () => {
    const plugin = createIncrementalMarkdownPlugin()
    const parsed: string[] = []
    const codePrefix = '```ts\n' + 'const value = 1\n'.repeat(1000) + '```\n\n'
    const count = 100
    for (let index = 0; index < count; index++) {
      const source = codePrefix + `tail ${index}`
      const instance = processor(plugin, parsed)
      expect(instance.runSync(instance.parse(source))).toEqual(transformed(source))
    }
    expect(parsed[0]).toBe(codePrefix + 'tail 0')
    expect(parsed.slice(1)).toEqual(Array.from({ length: count - 1 }, (_, i) => `tail ${i + 1}`))
    const incrementalChars = parsed.reduce((sum, source) => sum + source.length, 0)
    expect(incrementalChars).toBeLessThan(codePrefix.length * 2)
    // Control: full parsing visits the entire prefix on every update.
    expect(codePrefix.length * count).toBeGreaterThan(incrementalChars * 40)
  })
})
