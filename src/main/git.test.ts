import { execFile } from 'node:child_process'
import { access, chmod, mkdtemp, mkdir, realpath, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, it, expect } from 'vitest'
import { beginGitTurnDiff, finishGitTurnDiff, gitNumstat, parseNumstat, parsePorcelainPaths } from './git'

const pexecFile = promisify(execFile)

describe('parseNumstat（P2 git diff）', () => {
  it('解析 added/deleted/path，拼绝对路径', () => {
    const out = parseNumstat('12\t3\tsrc/a.ts\n0\t5\tsrc/b.ts\n', '/repo')
    expect(out).toEqual([
      { path: '/repo/src/a.ts', added: 12, deleted: 3 },
      { path: '/repo/src/b.ts', added: 0, deleted: 5 }
    ])
  })

  it('二进制文件的 - 计为 0', () => {
    expect(parseNumstat('-\t-\timg.png\n', '/repo')).toEqual([{ path: '/repo/img.png', added: 0, deleted: 0, binary: true }])
  })

  it('路径含 tab 也能还原', () => {
    expect(parseNumstat('1\t1\ta\tb.ts\n', '/r')[0].path).toBe('/r/a\tb.ts')
  })

  it('解析 -z 输出时保留中文和换行路径，不显示 Git quotePath 转义', () => {
    const out = parseNumstat('41\t52\tdocs/垂直标签定坑排序实验.md\0' + '1\t0\tdocs/a\nb.md\0', '/repo')
    expect(out).toEqual([
      { path: '/repo/docs/垂直标签定坑排序实验.md', added: 41, deleted: 52 },
      { path: '/repo/docs/a\nb.md', added: 1, deleted: 0 }
    ])
  })

  it('空输出 / 坏行跳过', () => {
    expect(parseNumstat('', '/r')).toEqual([])
    expect(parseNumstat('garbage\n', '/r')).toEqual([])
  })

  it('选择父仓库内的无 Git 子目录时只返回 cwd 内的 diff', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scry-git-scope-'))
    const selected = join(root, 'selected')
    const sibling = join(root, 'sibling.txt')
    try {
      await mkdir(selected)
      await writeFile(join(selected, 'inside.txt'), 'before\n')
      await writeFile(sibling, 'before\n')
      await pexecFile('git', ['init'], { cwd: root })
      await pexecFile('git', ['config', 'user.name', 'Scry Test'], { cwd: root })
      await pexecFile('git', ['config', 'user.email', 'scry@example.invalid'], { cwd: root })
      await pexecFile('git', ['add', '.'], { cwd: root })
      await pexecFile('git', ['commit', '-m', 'baseline'], { cwd: root })
      await writeFile(join(selected, 'inside.txt'), 'after\n')
      await writeFile(sibling, 'after\n')

      const canonicalRoot = await realpath(root)
      await expect(gitNumstat(selected)).resolves.toEqual([
        { path: join(canonicalRoot, 'selected/inside.txt'), added: 1, deleted: 1 }
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('parsePorcelainPaths（定向候选发现）', () => {
  it('解析普通、未跟踪与 rename 的两端路径', () => {
    expect(parsePorcelainPaths(
      ' M src/a.ts\0?? 新文件.md\0R  src/new.ts\0src/old.ts\0',
      '/repo'
    )).toEqual([
      '/repo/src/a.ts',
      '/repo/新文件.md',
      '/repo/src/new.ts',
      '/repo/src/old.ts'
    ])
  })
})

describe('每轮 Git 工作树快照', () => {
  async function initRepo(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'scry-turn-diff-test-'))
    await pexecFile('git', ['init'], { cwd: root })
    await pexecFile('git', ['config', 'user.name', 'Scry Test'], { cwd: root })
    await pexecFile('git', ['config', 'user.email', 'scry@example.invalid'], { cwd: root })
    return root
  }

  it('只统计本轮净变化，纳入 untracked、排除 ignored，且不改变真实 index', async () => {
    const root = await initRepo()
    try {
      await writeFile(join(root, '.gitignore'), 'ignored.txt\n')
      await writeFile(join(root, 'a.txt'), 'base\n')
      await writeFile(join(root, 'staged.txt'), 'base\n')
      await pexecFile('git', ['add', '.'], { cwd: root })
      await pexecFile('git', ['commit', '-m', 'baseline'], { cwd: root })
      await writeFile(join(root, 'a.txt'), 'preexisting\n')
      await writeFile(join(root, 'staged.txt'), 'staged\n')
      await pexecFile('git', ['add', 'staged.txt'], { cwd: root })
      const stagedBefore = (await pexecFile('git', ['diff', '--cached'], { cwd: root })).stdout

      const capture = await beginGitTurnDiff(root)
      const canonicalRoot = await realpath(root)
      const tempDir = capture.tempDir
      await writeFile(join(root, 'a.txt'), 'after\n')
      await writeFile(join(root, 'new.txt'), 'one\ntwo\n')
      await writeFile(join(root, 'ignored.txt'), 'ignored\n')
      const result = await finishGitTurnDiff(capture)

      expect(result.status).toBe('captured')
      expect(result.collection).toMatchObject({
        strategy: 'targeted',
        evidence: 'git_status',
        candidatePathCount: 3
      })
      expect(result.files).toHaveLength(2)
      expect(result.files[0]).toMatchObject({
        path: join(canonicalRoot, 'a.txt'),
        added: 1,
        deleted: 1,
        patchStatus: 'captured'
      })
      expect(result.files[0].patch).toContain('-preexisting')
      expect(result.files[0].patch).toContain('+after')
      expect(result.files[1]).toMatchObject({
        path: join(canonicalRoot, 'new.txt'),
        added: 2,
        deleted: 0,
        patchStatus: 'captured'
      })
      expect(result.files[1].patch).toContain('+one')
      expect((await pexecFile('git', ['diff', '--cached'], { cwd: root })).stdout).toBe(stagedBefore)
      if (tempDir) await expect(access(tempDir)).rejects.toThrow()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 30_000)

  it('结构化路径作为交叉证据，但 Git status 仍补齐 Bash 写入', async () => {
    const root = await initRepo()
    try {
      await writeFile(join(root, 'a.txt'), 'base\n')
      await writeFile(join(root, 'b.txt'), 'base\n')
      await pexecFile('git', ['add', '.'], { cwd: root })
      await pexecFile('git', ['commit', '-m', 'baseline'], { cwd: root })

      const capture = await beginGitTurnDiff(root)
      await writeFile(join(root, 'a.txt'), 'structured\n')
      await writeFile(join(root, 'b.txt'), 'opaque bash write\n')
      const result = await finishGitTurnDiff(capture, 20_000, {
        structuredPaths: [
          join(root, 'a.txt'),
          join(root, '..', 'outside', '.gitignore')
        ]
      })

      expect(result.status).toBe('captured')
      expect(result.collection).toMatchObject({
        strategy: 'targeted',
        evidence: 'git_status+structured',
        candidatePathCount: 2
      })
      expect(result.files.map((file) => file.path).sort()).toEqual([
        join(await realpath(root), 'a.txt'),
        join(await realpath(root), 'b.txt')
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 15_000)

  it('Git 语义控制文件变化时回退全量快照', async () => {
    const root = await initRepo()
    try {
      await writeFile(join(root, '.gitignore'), 'generated.json\n')
      await writeFile(join(root, 'base.txt'), 'base\n')
      await pexecFile('git', ['add', '.'], { cwd: root })
      await pexecFile('git', ['commit', '-m', 'baseline'], { cwd: root })
      await writeFile(join(root, 'generated.json'), '{"ready":true}\n')

      const capture = await beginGitTurnDiff(root)
      await writeFile(join(root, '.gitignore'), '')
      const result = await finishGitTurnDiff(capture)

      expect(result.status).toBe('captured')
      expect(result.collection).toMatchObject({
        strategy: 'full_fallback',
        fallbackReason: 'git_semantics'
      })
      expect(result.files.map((file) => file.path).sort()).toEqual([
        join(await realpath(root), '.gitignore'),
        join(await realpath(root), 'generated.json')
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 15_000)

  it('运行时开关可强制使用旧全量行为', async () => {
    const root = await initRepo()
    try {
      await writeFile(join(root, 'base.txt'), 'base\n')
      await pexecFile('git', ['add', '.'], { cwd: root })
      await pexecFile('git', ['commit', '-m', 'baseline'], { cwd: root })

      const capture = await beginGitTurnDiff(root)
      await writeFile(join(root, 'base.txt'), 'changed\n')
      const result = await finishGitTurnDiff(capture, 20_000, { forceFull: true })

      expect(result.status).toBe('captured')
      expect(result.collection).toMatchObject({
        strategy: 'full_fallback',
        fallbackReason: 'forced'
      })
      expect(result.files).toHaveLength(1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 15_000)

  it('候选过多时不构造超长定向命令，自动回退全量', async () => {
    const root = await initRepo()
    try {
      await writeFile(join(root, 'base.txt'), 'base\n')
      await pexecFile('git', ['add', '.'], { cwd: root })
      await pexecFile('git', ['commit', '-m', 'baseline'], { cwd: root })

      const capture = await beginGitTurnDiff(root)
      const result = await finishGitTurnDiff(capture, 20_000, {
        structuredPaths: Array.from({ length: 1_001 }, (_, index) => join(root, `candidate-${index}.txt`))
      })

      expect(result.status).toBe('captured')
      expect(result.collection).toMatchObject({
        strategy: 'full_fallback',
        fallbackReason: 'candidate_limit',
        candidatePathCount: 1_001
      })
      expect(result.files).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 15_000)

  it('选择子目录时不统计 sibling，并支持同仓并发快照隔离', async () => {
    const root = await initRepo()
    const selected = join(root, 'selected')
    try {
      await mkdir(selected)
      await writeFile(join(selected, 'inside.txt'), 'base\n')
      await writeFile(join(root, 'sibling.txt'), 'base\n')
      await pexecFile('git', ['add', '.'], { cwd: root })
      await pexecFile('git', ['commit', '-m', 'baseline'], { cwd: root })

      const [first, second] = await Promise.all([beginGitTurnDiff(selected), beginGitTurnDiff(selected)])
      const canonicalRoot = await realpath(root)
      expect(first.tempDir).not.toBe(second.tempDir)
      await writeFile(join(selected, 'inside.txt'), 'changed\n')
      await writeFile(join(root, 'sibling.txt'), 'changed\n')
      const [a, b] = await Promise.all([finishGitTurnDiff(first), finishGitTurnDiff(second)])
      const expected = { path: join(canonicalRoot, 'selected/inside.txt'), added: 1, deleted: 1, patchStatus: 'captured' }
      expect(a.files).toHaveLength(1)
      expect(b.files).toHaveLength(1)
      expect(a.files[0]).toMatchObject(expected)
      expect(b.files[0]).toMatchObject(expected)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 30_000)

  it('目录名含 pathspec 元字符时按字面 scope 隔离 sibling', async () => {
    const root = await initRepo()
    const selected = join(root, 'foo*bar')
    const sibling = join(root, 'fooxbar')
    try {
      await mkdir(selected)
      await mkdir(sibling)
      await writeFile(join(selected, 'inside.txt'), 'base\n')
      await writeFile(join(sibling, 'outside.txt'), 'base\n')
      await pexecFile('git', ['add', '.'], { cwd: root })
      await pexecFile('git', ['commit', '-m', 'baseline'], { cwd: root })

      const capture = await beginGitTurnDiff(selected)
      await writeFile(join(selected, 'inside.txt'), 'changed\n')
      await writeFile(join(sibling, 'outside.txt'), 'changed\n')
      const result = await finishGitTurnDiff(capture)

      expect(result.status).toBe('captured')
      expect(result.files).toHaveLength(1)
      expect(result.files[0]).toMatchObject({
        path: join(await realpath(root), 'foo*bar/inside.txt'),
        added: 1,
        deleted: 1
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 15_000)

  it('scope 外存在未合并 index entry 时仍能采集所选目录', async () => {
    const root = await initRepo()
    const selected = join(root, 'selected')
    try {
      await mkdir(selected)
      await writeFile(join(selected, 'inside.txt'), 'base\n')
      await writeFile(join(root, 'conflict.txt'), 'base\n')
      await pexecFile('git', ['add', '.'], { cwd: root })
      await pexecFile('git', ['commit', '-m', 'baseline'], { cwd: root })
      const baseBranch = (await pexecFile('git', ['branch', '--show-current'], { cwd: root })).stdout.trim()

      await pexecFile('git', ['checkout', '-b', 'conflict-side'], { cwd: root })
      await writeFile(join(root, 'conflict.txt'), 'side\n')
      await pexecFile('git', ['add', 'conflict.txt'], { cwd: root })
      await pexecFile('git', ['commit', '-m', 'side'], { cwd: root })
      await pexecFile('git', ['checkout', baseBranch], { cwd: root })
      await writeFile(join(root, 'conflict.txt'), 'main\n')
      await pexecFile('git', ['add', 'conflict.txt'], { cwd: root })
      await pexecFile('git', ['commit', '-m', 'main'], { cwd: root })
      await expect(pexecFile('git', ['merge', '--no-edit', 'conflict-side'], { cwd: root })).rejects.toThrow()
      expect((await pexecFile('git', ['ls-files', '--unmerged'], { cwd: root })).stdout).not.toBe('')

      const capture = await beginGitTurnDiff(selected)
      await writeFile(join(selected, 'inside.txt'), 'changed\n')
      const result = await finishGitTurnDiff(capture)

      expect(result.status).toBe('captured')
      expect(result.files).toHaveLength(1)
      expect(result.files[0]).toMatchObject({
        path: join(await realpath(root), 'selected/inside.txt'),
        added: 1,
        deleted: 1
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 30_000)

  it('禁用 clean/process filter，不执行项目配置的副作用命令', async () => {
    const root = await initRepo()
    const sentinel = join(root, 'filter-ran.txt')
    try {
      await writeFile(join(root, '.gitattributes'), '*.secret filter=spy\n')
      await writeFile(join(root, 'base.txt'), 'base\n')
      await pexecFile('git', ['add', '.gitattributes', 'base.txt'], { cwd: root })
      await pexecFile('git', ['commit', '-m', 'baseline'], { cwd: root })
      const command = `node -e "require('fs').writeFileSync('${sentinel}','ran');process.stdin.pipe(process.stdout)"`
      await pexecFile('git', ['config', 'filter.spy.clean', command], { cwd: root })
      await pexecFile('git', ['config', 'filter.spy.required', 'true'], { cwd: root })

      const capture = await beginGitTurnDiff(root)
      const canonicalRoot = await realpath(root)
      await writeFile(join(root, 'new.secret'), 'secret\n')
      const result = await finishGitTurnDiff(capture)

      expect(result.status).toBe('captured')
      expect(result.files.map((file) => file.path)).toContain(join(canonicalRoot, 'new.secret'))
      await expect(access(sentinel)).rejects.toThrow()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 15_000)

  it('本轮新增 clean filter 时 finish 会重新扫描并禁用副作用命令', async () => {
    const root = await initRepo()
    const sentinel = join(root, 'late-filter-ran.txt')
    try {
      await writeFile(join(root, 'base.txt'), 'base\n')
      await pexecFile('git', ['add', '.'], { cwd: root })
      await pexecFile('git', ['commit', '-m', 'baseline'], { cwd: root })

      const capture = await beginGitTurnDiff(root)
      await writeFile(join(root, '.gitattributes'), '*.secret filter=late-spy\n')
      const command = `node -e "require('fs').writeFileSync('${sentinel}','ran');process.stdin.pipe(process.stdout)"`
      await pexecFile('git', ['config', 'filter.late-spy.clean', command], { cwd: root })
      await pexecFile('git', ['config', 'filter.late-spy.required', 'true'], { cwd: root })
      await writeFile(join(root, 'new.secret'), 'secret\n')
      const result = await finishGitTurnDiff(capture)

      expect(result.status).toBe('captured')
      await expect(access(sentinel)).rejects.toThrow()
      expect(result.files.map((file) => file.path)).toContain(join(await realpath(root), 'new.secret'))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 15_000)

  it('隔离快照禁用仓库 Git hook，不允许 hook 间接修改真实 index', async () => {
    const root = await initRepo()
    const hooks = join(root, '.githooks')
    const sentinel = join(root, 'hook-ran.txt')
    try {
      await writeFile(join(root, 'base.txt'), 'base\n')
      await pexecFile('git', ['add', '.'], { cwd: root })
      await pexecFile('git', ['commit', '-m', 'baseline'], { cwd: root })
      await mkdir(hooks)
      const hook = join(hooks, 'post-index-change')
      await writeFile(hook, `#!/bin/sh\nprintf ran > "${sentinel}"\n`)
      await chmod(hook, 0o755)
      await pexecFile('git', ['config', 'core.hooksPath', hooks], { cwd: root })

      const capture = await beginGitTurnDiff(root)
      await writeFile(join(root, 'new.txt'), 'new\n')
      const result = await finishGitTurnDiff(capture)

      expect(result.status).toBe('captured')
      await expect(access(sentinel)).rejects.toThrow()
      expect((await pexecFile('git', ['diff', '--cached', '--name-only'], { cwd: root })).stdout).toBe('')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 15_000)

  it('复制真实 index 时保留 mtime，不漏掉本轮前已有的 racy-clean 改动', async () => {
    const root = await initRepo()
    try {
      const file = join(root, 'same-size.txt')
      const index = join(root, '.git', 'index')
      const oldTime = new Date('2020-01-02T03:04:05.000Z')
      await writeFile(file, 'AAAA\n')
      await pexecFile('git', ['add', '.'], { cwd: root })
      await pexecFile('git', ['commit', '-m', 'baseline'], { cwd: root })
      await pexecFile('git', ['config', 'core.trustctime', 'false'], { cwd: root })
      await pexecFile('git', ['config', 'core.checkStat', 'minimal'], { cwd: root })
      await utimes(file, oldTime, oldTime)
      await pexecFile('git', ['update-index', '--refresh'], { cwd: root })
      await utimes(index, oldTime, oldTime)
      await writeFile(file, 'BBBB\n')
      await utimes(file, oldTime, oldTime)

      const sourceMtime = (await stat(index)).mtimeMs
      const capture = await beginGitTurnDiff(root)
      await writeFile(file, 'CCCC\n')
      const result = await finishGitTurnDiff(capture)

      expect(sourceMtime).toBe(oldTime.getTime())
      expect(result.status).toBe('captured')
      expect(result.files[0]?.patch).toContain('-BBBB')
      expect(result.files[0]?.patch).toContain('+CCCC')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 15_000)

  it('真实 index 标记 assume-unchanged 时仍捕获本轮改动', async () => {
    const root = await initRepo()
    try {
      const file = join(root, 'assumed.txt')
      await writeFile(file, 'before\n')
      await pexecFile('git', ['add', '.'], { cwd: root })
      await pexecFile('git', ['commit', '-m', 'baseline'], { cwd: root })
      await pexecFile('git', ['update-index', '--assume-unchanged', 'assumed.txt'], { cwd: root })

      const capture = await beginGitTurnDiff(root)
      await writeFile(file, 'after\n')
      const result = await finishGitTurnDiff(capture)

      expect(result.status).toBe('captured')
      expect(result.files).toHaveLength(1)
      expect(result.files[0]).toMatchObject({ path: join(await realpath(root), 'assumed.txt'), added: 1, deleted: 1 })
      expect(result.files[0].patch).toContain('-before')
      expect(result.files[0].patch).toContain('+after')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 15_000)

  it('linked worktree 使用自己的 index，快照前后不修改主仓或 worktree 暂存区', async () => {
    const root = await initRepo()
    const linked = `${root}-linked`
    try {
      await writeFile(join(root, 'base.txt'), 'base\n')
      await pexecFile('git', ['add', '.'], { cwd: root })
      await pexecFile('git', ['commit', '-m', 'baseline'], { cwd: root })
      await pexecFile('git', ['worktree', 'add', '--detach', linked, 'HEAD'], { cwd: root })

      const capture = await beginGitTurnDiff(linked)
      await writeFile(join(linked, 'base.txt'), 'changed\n')
      const result = await finishGitTurnDiff(capture)

      expect(result.status).toBe('captured')
      expect(result.files[0]).toMatchObject({ path: join(await realpath(linked), 'base.txt'), added: 1, deleted: 1 })
      expect((await pexecFile('git', ['diff', '--cached', '--name-only'], { cwd: root })).stdout).toBe('')
      expect((await pexecFile('git', ['diff', '--cached', '--name-only'], { cwd: linked })).stdout).toBe('')
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(linked, { recursive: true, force: true })
    }
  }, 30_000)

  it('非 Git、无 HEAD 与 deadline 分别给出稳定降级原因', async () => {
    const plain = await mkdtemp(join(tmpdir(), 'scry-turn-diff-plain-'))
    const emptyRepo = await initRepo()
    try {
      const nonGit = await finishGitTurnDiff(await beginGitTurnDiff(plain))
      const noHead = await finishGitTurnDiff(await beginGitTurnDiff(emptyRepo))
      const timeout = await finishGitTurnDiff(await beginGitTurnDiff(emptyRepo, 0))
      expect({ status: nonGit.status, reason: nonGit.reason }).toEqual({ status: 'unavailable', reason: 'not_git' })
      expect({ status: noHead.status, reason: noHead.reason }).toEqual({ status: 'unavailable', reason: 'no_head' })
      expect({ status: timeout.status, reason: timeout.reason }).toEqual({ status: 'timeout', reason: 'deadline' })
    } finally {
      await rm(plain, { recursive: true, force: true })
      await rm(emptyRepo, { recursive: true, force: true })
    }
  })

  it('真实 index 缺失时回退到 HEAD 建立隔离快照', async () => {
    const root = await initRepo()
    try {
      await writeFile(join(root, 'base.txt'), 'base\n')
      await pexecFile('git', ['add', '.'], { cwd: root })
      await pexecFile('git', ['commit', '-m', 'baseline'], { cwd: root })
      await rm(join(root, '.git', 'index'), { force: true })

      const capture = await beginGitTurnDiff(root)
      await writeFile(join(root, 'new.txt'), 'new\n')
      const result = await finishGitTurnDiff(capture)

      expect(result.status).toBe('captured')
      expect(result.files).toHaveLength(1)
      expect(result.files[0]).toMatchObject({ path: join(await realpath(root), 'new.txt'), added: 1, deleted: 0 })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 15_000)

  it('大文件 patch 按单轮预算截断，但 numstat 仍保持完整', async () => {
    const root = await initRepo()
    try {
      await writeFile(join(root, 'base.txt'), 'base\n')
      await pexecFile('git', ['add', '.'], { cwd: root })
      await pexecFile('git', ['commit', '-m', 'baseline'], { cwd: root })

      const capture = await beginGitTurnDiff(root)
      await writeFile(join(root, 'large.txt'), `${'你'.repeat(Math.ceil((1024 * 1024 + 8192) / 3))}\n`)
      const result = await finishGitTurnDiff(capture, 10_000)

      expect(result.status).toBe('captured')
      expect(result.files[0]).toMatchObject({
        added: 1,
        deleted: 0,
        patchStatus: 'truncated'
      })
      expect(Buffer.byteLength(result.files[0].patch ?? '', 'utf8')).toBeLessThanOrEqual(1024 * 1024)
      expect(result.files[0].patch).not.toContain('�')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 15_000)
})
