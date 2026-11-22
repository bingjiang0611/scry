import ts from 'typescript'

export const sourcePattern = /\.(?:[cm]?[jt]s|[jt]sx)$/

export function sourceComments(file, source) {
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false)
  const comments = []
  let cursor = 0

  function scanGap(end) {
    if (cursor >= end) return
    scanner.setText(source, cursor, end - cursor)
    for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan()) {
      if (kind === ts.SyntaxKind.SingleLineCommentTrivia || kind === ts.SyntaxKind.MultiLineCommentTrivia) {
        const start = scanner.getTokenStart()
        comments.push({ start, end: scanner.getTokenEnd(), ...tree.getLineAndCharacterOfPosition(start) })
      }
    }
  }

  function visit(node) {
    if (node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode) return
    const children = node.getChildren(tree)
    if (children.length) {
      for (const child of children) visit(child)
    } else if (node.kind >= ts.SyntaxKind.FirstToken && node.kind < ts.SyntaxKind.FirstNode &&
               node.kind !== ts.SyntaxKind.EndOfFileToken && node.end > node.pos) {
      scanGap(ts.isJsxText(node) ? node.pos : node.getStart(tree))
      cursor = Math.max(cursor, node.end)
    }
  }

  visit(tree)
  scanGap(source.length)
  return comments
}

export function commentText(source, { start, end }) {
  return source.slice(start, end).replace(/\r\n/g, '\n')
}

export function isToolComment(text) {
  return /^(?:\/\/\/\s*<(?:reference|amd-module|amd-dependency)\b|\/\/[#@]\s*(?:sourceMappingURL|sourceURL)=)/.test(text) ||
    /(?:^\/\*\*?[ \t]*|^\/\/[ \t]*|^\s*\*[ \t]*)@(?:ts-(?:check|nocheck|ignore|expect-error)|jsx(?:ImportSource|Runtime|Frag)?|vite-ignore|__PURE__)(?=\b|$)/m.test(text) ||
    /^\/\*[#@]__(?:PURE|NO_SIDE_EFFECTS|INLINE|NOINLINE)__\s*\*\/$/.test(text) ||
    /(?:^\/\*!|@(?:license|preserve)\b|SPDX-License-Identifier:)/i.test(text)
}

export function commentLineCounts(file, source) {
  const comments = sourceComments(file, source)
  const touched = new Set()
  for (const comment of comments) {
    const lines = commentText(source, comment).split(/\r\n?|\n|\u2028|\u2029/).length
    for (let i = 0; i < lines; i++) touched.add(comment.line + i)
  }
  let withoutComments = source
  for (const { start, end } of comments.toReversed()) {
    withoutComments = withoutComments.slice(0, start) + source.slice(start, end).replace(/[^\r\n\u2028\u2029]/g, '') + withoutComments.slice(end)
  }
  const remaining = withoutComments.split(/\r\n?|\n|\u2028|\u2029/)
  return { comments: comments.length, lines: touched.size, removable: [...touched].filter(line => !remaining[line].trim()).length }
}
