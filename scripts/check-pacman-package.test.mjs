import { afterEach, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(new URL('./check-pacman-package.mjs', import.meta.url))
const roots = []
const dependencies = ['gtk3', 'nss', 'libnotify', 'libxtst', 'libxss', 'xdg-utils', 'at-spi2-core', 'libsecret']

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

// Control archive-reader output to test the production checker against raw metadata.
// This does not test libarchive or a real Linux package; packaged-linux does that.
function check(descriptionRecords) {
  const root = mkdtempSync(join(tmpdir(), 'scry-pacman-check-'))
  roots.push(root)
  const bin = join(root, 'fixture bin')
  mkdirSync(bin)
  writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '0.2.227', desktopName: 'scry.desktop' }))
  const artifact = join(root, 'Scry package.pacman')
  const files = {
    '.PKGINFO': [
      '# generated fixture', '', 'pkgname = scry', 'pkgver = 0.2.227-1', descriptionRecords,
      'arch = x86_64', ...dependencies.map((name) => `depend = ${name}`), ''
    ].join('\n'),
    '.INSTALL': 'post_install() { chmod 4755 /opt/Scry/chrome-sandbox; }\n',
    '.MTREE': '',
    'opt/Scry/scry': '',
    'opt/Scry/resources/bin/scry': '',
    'usr/share/applications/scry.desktop': '[Desktop Entry]\nName=Scry\nExec=/opt/Scry/scry %U\nStartupWMClass=scry\n'
  }
  writeFileSync(artifact, JSON.stringify(files))
  const argvLog = join(root, 'archive-argv.jsonl')
  const reader = join(bin, 'bsdtar')
  writeFileSync(reader, `#!/usr/bin/env node
const fs = require('node:fs')
const args = process.argv.slice(2)
fs.appendFileSync(${JSON.stringify(argvLog)}, JSON.stringify(args) + '\\n')
if (args.length === 1 && args[0] === '--version') {
  console.log('controlled archive reader')
} else if (args.length === 2 && args[0] === '-tf') {
  console.log(Object.keys(JSON.parse(fs.readFileSync(args[1], 'utf8'))).join('\\n'))
} else if (args.length === 3 && args[0] === '-xOf') {
  process.stdout.write(JSON.parse(fs.readFileSync(args[1], 'utf8'))[args[2]])
} else {
  process.exit(2)
}
`)
  chmodSync(reader, 0o755)
  const result = spawnSync(process.execPath, [script, `--artifact=${artifact}`], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}` }
  })
  expect(result.error).toBeUndefined()
  const argv = readFileSync(argvLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
  expect(argv).toContainEqual(['-xOf', artifact, '.PKGINFO'])
  return result
}

describe('pacman raw description contract', () => {
  it('accepts one nonempty description and preserves equals signs in its value', () => {
    const result = check('pkgdesc = Scry = desktop')
    expect(result.status, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout).pkgdesc).toBe('Scry = desktop')
  })

  it('rejects a continuation even when the first description line is nonempty', () => {
    const result = check('pkgdesc = Scry\n continued description')
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('malformed or continued record')
  })

  it('rejects multiple description records instead of silently choosing the last', () => {
    const result = check('pkgdesc = first\npkgdesc = second')
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('exactly one pkgdesc record')
  })

  it('still rejects an empty description', () => {
    const result = check('pkgdesc = ')
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('pkgdesc is empty')
  })
})
