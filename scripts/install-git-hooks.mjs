#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, realpathSync, symlinkSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim()
}

const root = git('rev-parse', '--show-toplevel')
const source = join(root, '.githooks/pre-commit')
if (!existsSync(source)) throw new Error(`Missing repository hook: ${source}`)
const destination = git('rev-parse', '--path-format=absolute', '--git-path', 'scry-hooks')
const config = spawnSync('git', ['config', '--path', '--get', 'core.hooksPath'], { encoding: 'utf8' })
if (config.error) throw config.error
if (config.status !== 0 && config.status !== 1) throw new Error(config.stderr)
const configured = config.stdout.trim()
const previous = configured
  ? (isAbsolute(configured) ? configured : resolve(root, configured))
  : git('rev-parse', '--path-format=absolute', '--git-path', 'hooks')

if (previous !== destination) {
  if (existsSync(join(previous, 'pre-commit'))) {
    throw new Error(`Existing pre-commit hook at ${previous}; integrate it explicitly before installing Scry's hook.`)
  }
  // Do not replace global hooks or disable other hooks (e.g. the user's pre-push).
  // Links retain their original executable and arguments. New upstream hooks
  // require reinstalling after restoring the previous core.hooksPath.
  mkdirSync(destination)
  if (existsSync(previous)) {
    for (const name of readdirSync(previous)) {
      symlinkSync(join(previous, name), join(destination, name))
    }
  }
  symlinkSync(source, join(destination, 'pre-commit'))
  git('config', '--local', 'core.hooksPath', destination)
} else if (realpathSync(join(destination, 'pre-commit')) !== realpathSync(source)) {
  throw new Error(`Unexpected pre-commit hook at ${destination}; refusing to replace it.`)
}
console.log(`Scry pre-commit installed at ${destination}; existing hooks preserved.`)
