import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { commentLineCounts, commentText, isToolComment, sourceComments, sourcePattern } from './source-comments.mjs'

const cwd = fileURLToPath(new URL('..', import.meta.url))
const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
const paths = (...args) => git(...args).split('\0').filter(file => sourcePattern.test(file))
const read = file => readFileSync(join(cwd, file), 'utf8')
const scope = ['src/cli/', 'src/shared/']

export function addedProse(file, baseline, current) {
  const remaining = new Map()
  for (const comment of sourceComments(file, baseline)) {
    const text = commentText(baseline, comment)
    remaining.set(text, (remaining.get(text) ?? 0) + 1)
  }
  return sourceComments(file, current).flatMap(comment => {
    const text = commentText(current, comment)
    if (isToolComment(text)) return []
    const count = remaining.get(text) ?? 0
    if (!count) return [{ ...comment, text }]
    remaining.set(text, count - 1)
    return []
  })
}

function run(args) {
  if (args[0] === '--inventory') {
    const totals = { files: 0, comments: 0, lines: 0, removable: 0 }
    for (const file of paths('ls-files', '-z', '--', ...(args.length > 1 ? args.slice(1) : scope))) {
      const source = read(file)
      for (const comment of sourceComments(file, source)) {
        const text = commentText(source, comment)
        console.log(JSON.stringify({ file, line: comment.line + 1, column: comment.character + 1, tool: isToolComment(text), text }))
      }
      totals.files++
      for (const [key, value] of Object.entries(commentLineCounts(file, source))) totals[key] += value
    }
    console.error(JSON.stringify(totals))
    return
  }

  if (args.length && !(args.length === 2 && args[0] === '--base')) {
    throw new Error('Usage: check-source-comments.mjs [--base <git-ref> | --inventory [<path>...]]')
  }
  const ref = args[1] ?? git('merge-base', 'HEAD', 'origin/main').trim()
  const base = git('rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`).trim()
  const baseline = new Set(paths('ls-tree', '-rz', '--name-only', base, '--', ...scope))
  const changed = new Set([
    ...paths('diff', '--name-only', '-z', '--no-renames', '--diff-filter=AMT', base, '--', ...scope),
    ...paths('ls-files', '-z', '--others', '--exclude-standard', '--', ...scope)
  ])
  let failures = 0
  for (const file of changed) {
    const before = baseline.has(file) ? git('show', `${base}:${file}`) : ''
    for (const comment of addedProse(file, before, read(file))) {
      console.error(`${file}:${comment.line + 1}:${comment.character + 1} new prose comment: ${comment.text.split('\n')[0]}`)
      failures++
    }
  }
  if (failures) {
    console.error('Remove new or rewritten prose comments. Record durable decisions in docs/adr instead.')
    process.exitCode = 1
  } else {
    console.log(`No new prose comments in ${scope.join(', ')} (compared with ${base.slice(0, 12)}).`)
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) run(process.argv.slice(2))
