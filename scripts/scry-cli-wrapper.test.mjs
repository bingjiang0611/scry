import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { defaultPackagedAppPath, electronDevLayout, packagedAppLayout } from './packaged-app-layout.mjs'

const wrapper = readFileSync(new URL('../build/scry-cli', import.meta.url), 'utf8')
const tempRoots = []

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

// 启动器用 `pwd -P` 解析真实路径（macOS 的 /var 指向 /private/var），期望值必须同样先取 realpath。
function tempRoot() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'scry-cli-wrapper-')))
  tempRoots.push(root)
  return root
}

// 假 Electron 只记录收到的 argv 与环境，用来证明启动器选中了哪个可执行文件、
// 以及含空格/中文的参数是否原样传给私有 CLI。
function writeFakeElectron(path) {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, '#!/bin/sh\nprintf "electron\\n"\nfor a in "$@"; do printf "arg=%s\\n" "$a"; done\n')
  chmodSync(path, 0o755)
}

// 按真实产物布局搭一个最小文件树：electron 可执行文件、bin/scry、scry-cli/dist/cli/scry.js。
function writeLayout(root, { platform }) {
  const appPath = join(root, 'app')
  const layout = packagedAppLayout(appPath, { platform })
  writeFakeElectron(layout.executable)
  mkdirSync(join(layout.resources, 'bin'), { recursive: true })
  const cli = join(layout.resources, 'bin', 'scry')
  writeFileSync(cli, wrapper)
  chmodSync(cli, 0o755)
  mkdirSync(join(layout.resources, 'scry-cli', 'dist', 'cli'), { recursive: true })
  writeFileSync(join(layout.resources, 'scry-cli', 'dist', 'cli', 'scry.js'), '')
  return { appPath, layout, cli }
}

function run(cli, args) {
  const result = spawnSync(cli, args, { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: tempRoot() } })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

describe('App 私有 CLI 启动器', () => {
  it.each([
    ['darwin', ['--version']],
    ['linux', ['--version']]
  ])('在 %s 布局下使用随 App 分发的 Electron，并原样传递参数', (platform, args) => {
    const { cli } = writeLayout(tempRoot(), { platform })
    const result = run(cli, args)
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
    // 第一行是假 Electron 自己，说明启动器选中了该布局的可执行文件，而不是 PATH 里的同名命令。
    expect(result.stdout.split('\n')[0]).toBe('electron')
  })

  it('保留含空格和中文的独立参数边界', () => {
    const { cli, layout } = writeLayout(tempRoot(), { platform: process.platform })
    const awkward = ['/tmp/a b/项目 x.scry', '--cwd=工作 区', 'two  spaces']
    const result = run(cli, awkward)
    expect(result.status).toBe(0)
    const expected = ['electron', `arg=${join(layout.resources, 'scry-cli', 'dist', 'cli', 'scry.js')}`, ...awkward.map(arg => `arg=${arg}`)]
    expect(result.stdout).toBe(`${expected.join('\n')}\n`)
  })

  it('跟随指向 bin/scry 的软链接定位 App，而不是用 cwd 或相对路径猜测', () => {
    const root = tempRoot()
    const { cli, layout } = writeLayout(root, { platform: process.platform })
    const linked = join(root, 'bin', 'scry-link')
    mkdirSync(join(root, 'bin'), { recursive: true })
    symlinkSync(cli, linked)
    const result = run(linked, ['--version'])
    expect(result.status).toBe(0)
    expect(result.stdout).toBe(`electron\narg=${join(layout.resources, 'scry-cli', 'dist', 'cli', 'scry.js')}\narg=--version\n`)
  })

  it('缺少 App 内可执行文件时失败，而不是回退到 PATH 里的 electron 或全局 recorder', () => {
    const root = tempRoot()
    const { cli } = writeLayout(root, { platform: process.platform })
    const layout = packagedAppLayout(join(root, 'app'), { platform: process.platform })
    rmSync(layout.executable)
    const result = run(cli, ['--version'])
    expect(result.status).not.toBe(0)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('找不到随 App 分发的 Electron 可执行文件')
  })
})

describe('产物路径布局', () => {
  it('区分 .app bundle 与 Linux 解包目录', () => {
    const darwin = packagedAppLayout('/x/Scry.app', { platform: 'darwin' })
    expect(darwin.executable).toBe('/x/Scry.app/Contents/MacOS/Scry')
    expect(darwin.resources).toBe('/x/Scry.app/Contents/Resources')
    expect(darwin.locales).toContain(join('Electron Framework.framework', 'Versions', 'A', 'Resources'))

    const linux = packagedAppLayout('/x/linux-unpacked', { platform: 'linux' })
    expect(linux.executable).toBe('/x/linux-unpacked/scry')
    expect(linux.resources).toBe('/x/linux-unpacked/resources')
    expect(linux.locales).toBe('/x/linux-unpacked/locales')
  })

  it('默认产物路径跟随平台与架构', () => {
    expect(defaultPackagedAppPath({ platform: 'darwin', arch: 'arm64' })).toBe(join('dist', 'mac-arm64', 'Scry.app'))
    expect(defaultPackagedAppPath({ platform: 'linux', arch: 'x64' })).toBe(join('dist', 'linux-unpacked'))
    expect(defaultPackagedAppPath({ platform: 'linux', arch: 'arm64' })).toBe(join('dist', 'linux-arm64-unpacked'))
  })

  it('开发态 Electron 在 Linux 上是解包目录里的 electron 可执行文件', () => {
    expect(electronDevLayout({ platform: 'darwin' }).executable).toContain(join('Electron.app', 'Contents', 'MacOS', 'Electron'))
    expect(electronDevLayout({ platform: 'linux' }).executable).toBe(join('node_modules', 'electron', 'dist', 'electron'))
  })

  it('拒绝未知平台，而不是猜一个默认布局', () => {
    expect(() => packagedAppLayout('/x', { platform: 'win32' })).toThrow('不支持的桌面打包平台')
  })
})
