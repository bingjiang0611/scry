import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// pacman 产物契约检查。只验证"装进系统后 pacman 会读到什么"，
// 不重跑打包：pkgdesc 曾经因为换行变成空描述，而包仍能安装，
// 所以必须直接读 .PKGINFO，而不是相信构建成功。
const root = process.cwd()
const explicit = process.argv.find((argument) => argument.startsWith('--artifact='))?.slice('--artifact='.length)
const artifact = explicit ?? findArtifact()
const archive = readArchive()

function findArtifact() {
  const dist = join(root, 'dist')
  const candidates = readdirSync(dist)
    .filter((name) => name.endsWith('.pacman'))
    .map((name) => join(dist, name))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
  assert.ok(candidates.length > 0, 'no .pacman artifact in dist; run SCRY_RELEASE_BUILD=1 node scripts/run-electron-builder.mjs first')
  return candidates[0]
}

function readArchive() {
  const probe = spawnSync('bsdtar', ['--version'], { encoding: 'utf8' })
  assert.equal(probe.error, undefined, 'bsdtar (libarchive) is required to read the pacman archive; install libarchive-tools')
  // bsdtar 的参数顺序是 bsdtar <flags> ARCHIVE [PATTERN]。
  const run = (args) => {
    const result = spawnSync('bsdtar', [...args, artifact], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
    assert.equal(result.status, 0, `bsdtar ${args.join(' ')} failed: ${result.stderr}`)
    return result.stdout
  }
  const extract = (pattern) => {
    const result = spawnSync('bsdtar', ['-xOf', artifact, pattern], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
    assert.equal(result.status, 0, `bsdtar -xOf ${pattern} failed: ${result.stderr}`)
    return result.stdout
  }
  const entries = run(['-tf']).split('\n').filter(Boolean)
  const pkgInfo = extract('.PKGINFO')
  const install = entries.includes('.INSTALL') ? extract('.INSTALL') : null
  return { entries, pkgInfo, install, extract }
}

function parsePkgInfo(text) {
  const records = text.split('\n').filter((line) => line.trim() && !line.startsWith('#'))
  // Validate raw records before parsing can discard a description continuation.
  for (const line of records) assert.match(line, /^[a-z]+ = [^\r\n]*$/, 'pkginfo has a malformed or continued record')
  assert.equal(records.filter((line) => line.startsWith('pkgdesc = ')).length, 1, 'pkginfo must contain exactly one pkgdesc record')
  return Object.fromEntries(records.map((line) => {
    const [key, ...rest] = line.split(' = ')
    return [key, rest.join(' = ').trim()]
  }))
}

function dependsOf(text) {
  return text
    .split('\n')
    .filter((line) => line.startsWith('depend = '))
    .map((line) => line.slice('depend = '.length).trim())
}

const { entries, pkgInfo, install } = archive
const meta = parsePkgInfo(pkgInfo)
const metadata = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const depends = dependsOf(pkgInfo)

// electron-builder 把 Linux 描述拼成 "${synopsis}\n ${description}" 传给 fpm；
// pacman 的 .PKGINFO 是逐行 key = value，换行会让 pkgdesc 变成空值（pacman -Qi 显示 None）。
assert.ok(meta.pkgdesc, `pkgdesc is empty; pacman would show Description: None\n${pkgInfo.slice(0, 400)}`)
assert.equal(meta.pkgname, 'scry')
assert.equal(meta.pkgver, `${metadata.version}-1`)
assert.ok(meta.arch, 'pkginfo has no arch')
assert.ok(depends.length > 0, 'pkginfo declares no runtime dependency')
for (const name of ['gtk3', 'nss', 'libnotify', 'libxtst', 'libxss', 'xdg-utils', 'at-spi2-core', 'libsecret']) {
  assert.ok(depends.includes(name), `pkginfo is missing the ${name} runtime dependency`)
}

// Electron 把 package.json 的 desktopName 用作 Wayland app_id / WM_CLASS。
// 桌面环境按 StartupWMClass 关联运行中的窗口，所以三者必须是同一个值：
// .desktop 文件名、StartupWMClass、desktopName（去掉 .desktop 后缀）。
assert.ok(metadata.desktopName, 'package.json has no desktopName; Electron would fall back to a different app_id')
const desktopName = metadata.desktopName.replace(/\.desktop$/, '')
const desktopPath = `usr/share/applications/${desktopName}.desktop`

for (const path of ['opt/Scry/scry', 'opt/Scry/resources/bin/scry', desktopPath, '.MTREE', '.INSTALL']) {
  assert.ok(entries.includes(path), `package is missing ${path}`)
}

const desktopEntry = archive.extract(desktopPath)
const desktopField = (key) => desktopEntry.split('\n').find((line) => line.startsWith(`${key}=`))?.slice(key.length + 1)
assert.equal(desktopField('StartupWMClass'), desktopName, `StartupWMClass must match desktopName: ${desktopEntry}`)
assert.equal(desktopField('Exec'), '/opt/Scry/scry %U', `desktop entry must launch the packaged binary: ${desktopEntry}`)
assert.ok(desktopField('Name'), 'desktop entry has no Name')

// chrome-sandbox 权限与 /usr/bin 链接由 install 脚本负责；语法错误会让安装直接失败。
assert.ok(install, 'package has no install script')
assert.ok(install.includes('chrome-sandbox'), 'install script does not fix chrome-sandbox permissions')
const scratch = mkdtempSync(join(tmpdir(), 'scry-install-'))
try {
  writeFileSync(join(scratch, 'install.sh'), install)
  const syntax = spawnSync('bash', ['-n', join(scratch, 'install.sh')], { encoding: 'utf8' })
  assert.equal(syntax.status, 0, `install script is not valid shell: ${syntax.stderr}`)
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

console.log(JSON.stringify({
  artifact: artifact.slice(root.length + 1),
  bytes: statSync(artifact).size,
  entries: entries.length,
  pkgname: meta.pkgname,
  pkgver: meta.pkgver,
  pkgdesc: meta.pkgdesc,
  arch: meta.arch,
  depends,
}))
