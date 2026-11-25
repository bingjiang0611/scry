import assert from 'node:assert/strict'
import { test } from 'vitest'
import { addedProse } from './check-source-comments.mjs'
import { commentLineCounts, commentText, sourceComments } from './source-comments.mjs'

test('finds JS and JSX comments without treating code literals and JSX text as comments', () => {
  const source = [
    '#!/usr/bin/env node',
    '/// <reference types="node" />',
    '/** JSDoc with another // marker */',
    'export const site = <div title="// in an attribute">/* JSX text */',
    '  {/* real JSX comment */}{`// raw text ${/[/][/]/.test("//") /* real template comment */}`}',
    '</div> // trailing',
    '/* EOF */'
  ].join('\n')
  assert.deepEqual(sourceComments('source.tsx', source).map(comment => commentText(source, comment)), [
    '/// <reference types="node" />', '/** JSDoc with another // marker */', '/* real JSX comment */',
    '/* real template comment */', '// trailing', '/* EOF */'
  ])
})

test('ratchet lets text move in a file but rejects duplicates and same-count rewrites', () => {
  const report = (before, after) => addedProse('source.ts', before, after).map(({ text, line }) => [text, line + 1])
  const before = '// original\nconst x = 1\n// removed\n'
  assert.deepEqual(report(before, 'const x = 1\r\n// original\r\n'), [])
  assert.deepEqual(report(before, '// original\n// original\nconst x = 1\n'), [['// original', 2]])
  assert.deepEqual(report(before, '// original\nconst x = 1\n// replacement\n'), [['// replacement', 3]])
  assert.deepEqual(report('', before), [['// original', 1], ['// removed', 3]])
})

test('retains real tool directives and notices, but ordinary prose cannot mention its way out', () => {
  const after = [
    '/// <reference types="node" />',
    '// @ts-expect-error deliberate negative test',
    'const x: string = 1',
    '/* @vite-ignore */',
    '/*#__PURE__*/ factory()',
    '/*! retained license */',
    '//# sourceMappingURL=source.js.map',
    '// prose mentioning @ts-expect-error',
    '// @vital to mention'
  ].join('\n')
  assert.deepEqual(addedProse('source.ts', '', after).map(c => c.text), [
    '// prose mentioning @ts-expect-error', '// @vital to mention'
  ])
})

test('counts physical comment-only lines without double-counting same-line comments', () => {
  assert.deepEqual(commentLineCounts('source.ts', '/* first */ /* second */\r\nconst x = 1 /* inline\r\ncomment */\r\n'), {
    comments: 3, lines: 3, removable: 2
  })
})
