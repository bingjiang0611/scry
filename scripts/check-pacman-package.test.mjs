import { afterEach, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
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
  writeFileSync(artifact, 'controlled archive fixture')
  const contents = join(root, 'archive contents')
  for (const [name, content] of Object.entries(files)) {
    const path = join(contents, name)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, content)
  }
  writeFileSync(join(contents, 'listing'), Object.keys(files).join('\n') + '\n')
  const argvLog = join(root, 'archive-argv')
  const reader = join(bin, 'bsdtar')
  // The fixture only returns bytes; starting Node for every tar operation made
  // archive checks depend on repeated JS runtime startup, not parser behavior.
  writeFileSync(reader, `#!/bin/sh
printf '%s\\0' "$@" >> "$SCRY_ARCHIVE_ARGV"
printf '\\n' >> "$SCRY_ARCHIVE_ARGV"
case "$#:$1" in
  1:--version) printf '%s\\n' 'controlled archive reader' ;;
  2:-tf) [ "$2" = "$SCRY_ARCHIVE_PATH" ] || exit 2; cat "$SCRY_ARCHIVE_CONTENTS/listing" ;;
  3:-xOf) [ "$2" = "$SCRY_ARCHIVE_PATH" ] || exit 2; cat "$SCRY_ARCHIVE_CONTENTS/$3" ;;
  *) exit 2 ;;
esac
`)
  chmodSync(reader, 0o755)
  const result = spawnSync(process.execPath, [script, `--artifact=${artifact}`], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`,
      SCRY_ARCHIVE_ARGV: argvLog, SCRY_ARCHIVE_PATH: artifact, SCRY_ARCHIVE_CONTENTS: contents }
  })
  expect(result.error).toBeUndefined()
  const argv = readFileSync(argvLog, 'utf8').trimEnd().split('\n').map((line) => line.split('\0').slice(0, -1))
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
