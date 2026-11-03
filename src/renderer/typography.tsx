import { Children, Fragment, cloneElement, isValidElement, type ReactElement, type ReactNode } from 'react'
import { Parser } from './vendor/budoux/parser'
import { model as zhHansModel } from './vendor/budoux/zh-hans'

const chineseParser = new Parser(zhHansModel)
const HAN = /\p{Script=Han}/u
const UNIT = /^(?:%|°[CF]|px|r?em|ms|s|min|h|KB|MB|GB|KiB|MiB|GiB|USD|tokens?|credits?|files?|秒|分钟|小时|天|轮|条|个|字|页|文件)(?=$|[\p{P}\p{S}])/iu

export function textContentOf(children: ReactNode): string {
  let text = ''
  Children.forEach(children, child => {
    if (typeof child === 'string' || typeof child === 'number') text += String(child)
    else if (isValidElement<{ children?: ReactNode }>(child)) text += textContentOf(child.props.children)
  })
  return text
}

export function hasChineseText(children: ReactNode): boolean {
  return HAN.test(textContentOf(children))
}

export function isChineseProse(children: ReactNode): boolean {
  const text = textContentOf(children)
  const han = Array.from(text.matchAll(/\p{Script=Han}/gu)).length
  const lettersAndNumbers = Array.from(text.matchAll(/[\p{L}\p{N}]/gu)).length
  return han >= 15 && lettersAndNumbers > 0 && han / lettersAndNumbers >= 0.5
}

export function keepRequiredPairsTogether(value: string): string {
  const emDashProtected = value.replace(/—[ \t]+(?=\S)/g, '—\u00a0')
  return emDashProtected.replace(/(\d+(?:[.,]\d+)?)[ \t]+([^\s]+)/gu, (match, number: string, following: string) => {
    return UNIT.test(following) ? `${number}\u00a0${following}` : match
  })
}

function mapText(children: ReactNode, transform: (value: string) => ReactNode): ReactNode {
  return Children.map(children, child => {
    if (typeof child === 'string') return transform(child)
    if (!isValidElement<{ children?: ReactNode; node?: { tagName?: string } }>(child) || child.props.children == null) return child
    const tagName = typeof child.type === 'string' ? child.type : child.props.node?.tagName
    if (tagName && ['code', 'pre', 'kbd', 'samp'].includes(tagName)) return child
    return cloneElement(child as ReactElement<{ children?: ReactNode }>, undefined, mapText(child.props.children, transform))
  })
}

export function TypographyText({ children }: { children: ReactNode }) {
  return <>{mapText(children, keepRequiredPairsTogether)}</>
}

function segmentChinese(value: string): ReactNode {
  if (!HAN.test(value)) return keepRequiredPairsTogether(value)
  const phrases = chineseParser.parse(keepRequiredPairsTogether(value)).reduce<string[]>((merged, phrase) => {
    const previous = merged.at(-1)
    if (previous && /[\p{Script=Latin}\p{N}]$/u.test(previous) && /^[\p{Script=Latin}\p{N}]/u.test(phrase)) {
      merged[merged.length - 1] = previous + phrase
    } else merged.push(phrase)
    return merged
  }, [])
  return phrases.map((phrase, index) => (
    <Fragment key={`${index}:${phrase}`}>
      {index > 0 ? <wbr /> : null}
      {phrase}
    </Fragment>
  ))
}

export function ChineseHeadingText({ children }: { children: ReactNode }) {
  return <>{mapText(children, segmentChinese)}</>
}
