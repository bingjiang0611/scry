import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { ChineseHeadingText, isChineseProse, keepRequiredPairsTogether } from './typography'

const NBSP = '\u00a0'

describe('typography helpers', () => {
  it('keeps authored pairs together without changing unrelated spaces', () => {
    expect(keepRequiredPairsTogether('Ada — Lovelace measured 30 ms and 4 files')).toBe(`Ada —${NBSP}Lovelace measured 30${NBSP}ms and 4${NBSP}files`)
    expect(keepRequiredPairsTogether('30 examples remain proportional')).toBe('30 examples remain proportional')
  })

  it('inserts real wbr elements at BudouX phrase boundaries', () => {
    const html = renderToStaticMarkup(<ChineseHeadingText>在本地查看每一次执行如何变成可核对的证据</ChineseHeadingText>)
    expect(html).toContain('<wbr/>')
    expect(html.replaceAll('<wbr/>', '')).toBe('在本地查看每一次执行如何变成可核对的证据')
  })

  it('does not insert BudouX breaks inside Latin words in mixed headings', () => {
    const html = renderToStaticMarkup(<ChineseHeadingText>在本地查看 Agent 执行证据</ChineseHeadingText>)
    expect(html).toContain('Agent')
    expect(html).not.toMatch(/[A-Za-z]<wbr\/>[A-Za-z]/)
  })

  it('only marks sufficiently long, mostly-Chinese body copy as prose', () => {
    expect(isChineseProse('这是一段足够长的中文正文，用来验证整行字符测量与两端对齐。')).toBe(true)
    expect(isChineseProse('短说明')).toBe(false)
    expect(isChineseProse('Scry uses Provider CLI with a 少量中文 label.')).toBe(false)
  })
})
