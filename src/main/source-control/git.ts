import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { access, lstat, readFile, readdir, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { ScDiff, ScFile, ScGitAction, ScRepository } from '../../shared/source-control'
import { ScCommandError, ScProcess } from './process'

const hash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex')
const readConfig = [
  '--no-pager',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'gc.auto=0',
  '-c',
  'maintenance.auto=false'
]
const readOnly = ['-c', 'core.hooksPath=/dev/null']
// Match the native commands below: no checkout/merge/rebase/am/receive or amend,
// and automatic maintenance is disabled. Unused hooks do not block unrelated operations.
const hookActions = new Map<string, readonly ScGitAction[]>([
  ['pre-commit', ['commit']],
  ['prepare-commit-msg', ['commit']],
  ['commit-msg', ['commit']],
  ['post-commit', ['commit']],
  ['pre-push', ['push']],
  ['post-index-change', ['stage', 'unstage', 'commit']],
  ['reference-transaction', ['commit', 'fetch', 'push']]
])

export interface GitIdentity {
  id: string
  root: string
  gitDir: string
  commonDir: string
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

function pathInRepository(path: string): boolean {
  return (
    path.length > 0 &&
    !isAbsolute(path) &&
    !path.split(/[\\/]/).includes('..') &&
    !path.includes('\0') &&
    !path.split(/[\\/]/).includes('.git')
  )
}

export function parseGitStatus(
  output: string
): Pick<ScRepository, 'files' | 'branch' | 'head' | 'upstream' | 'ahead' | 'behind'> {
  const result: ReturnType<typeof parseGitStatus> = {
    files: [],
    branch: null,
    head: null,
    upstream: null,
    ahead: null,
    behind: null
  }
  const records = output.split('\0')
  for (let i = 0; i < records.length; i++) {
    const row = records[i]
    if (!row) continue
    if (row.startsWith('# branch.oid ')) result.head = row.slice(13) === '(initial)' ? null : row.slice(13)
    else if (row.startsWith('# branch.head '))
      result.branch = row.slice(14) === '(detached)' ? null : row.slice(14)
    else if (row.startsWith('# branch.upstream ')) result.upstream = row.slice(18)
    else if (row.startsWith('# branch.ab ')) {
      const match = /^# branch\.ab \+(\d+) -(\d+)$/.exec(row)
      if (!match) throw new Error('无法解析 Git upstream 状态')
      result.ahead = Number(match[1])
      result.behind = Number(match[2])
    } else if (row[0] !== '#') {
      const fields = row.split(' ')
      let file: ScFile
      if (row.startsWith('? '))
        file = { path: row.slice(2), index: '.', worktree: '?', untracked: true, conflict: false }
      else if (['1', '2', 'u'].includes(fields[0])) {
        const count = fields[0] === '1' ? 8 : fields[0] === '2' ? 9 : 10
        if (fields.length <= count || fields[1].length !== 2) throw new Error('无法完整解析 Git 文件状态')
        file = {
          path: fields.slice(count).join(' '),
          index: fields[1][0],
          worktree: fields[1][1],
          untracked: false,
          conflict: fields[0] === 'u'
        }
        if (fields[2] !== 'N...') throw new Error('当前工作区含子模块变化；暂不支持在源代码管理中修改子模块')
        if (fields[0] === '2') file.previousPath = records[++i]
      } else throw new Error('不支持的 Git 状态记录')
      if (
        !pathInRepository(file.path) ||
        (file.previousPath !== undefined && !pathInRepository(file.previousPath))
      )
        throw new Error('Git 返回了不安全的相对路径')
      result.files.push(file)
    }
  }
  return result
}

export class ScGit {
  constructor(
    readonly process: ScProcess,
    private readonly authorizeLocalRemote: (path: string) => string
  ) {}

  run(root: string, args: string[], read = true, timeout = 15_000): Promise<string> {
    return this.process.run('git', [...readConfig, ...(read ? readOnly : []), ...args], root, { timeout })
  }

  async identity(cwd: string): Promise<GitIdentity> {
    const output = await this.run(cwd, [
      'rev-parse',
      '--show-toplevel',
      '--absolute-git-dir',
      '--git-common-dir'
    ])
    const paths = output.trimEnd().split('\n')
    if (paths.length !== 3) throw new Error('Git 根目录含无法安全表示的换行或格式不受支持')
    const [root, gitDir, commonDir] = await Promise.all(paths.map((path) => realpath(resolve(cwd, path))))
    return { root, gitDir, commonDir, id: hash(`${root}\0${gitDir}\0${commonDir}`) }
  }

  private async config(root: string, scope?: '--local' | '--worktree'): Promise<string> {
    return this.run(root, ['config', ...(scope ? [scope] : []), '--null', '--list', '--includes'], false)
  }

  private async fingerprint(identity: GitIdentity, files: ScFile[], config: string): Promise<string> {
    let index: Buffer
    try {
      index = await readFile(join(identity.gitDir, 'index'))
    } catch (error) {
      if (!isMissing(error)) throw error
      index = Buffer.alloc(0)
    }
    const versions: string[] = []
    for (const file of files) {
      const full = resolve(identity.root, file.path)
      // Git can track symlinks; never open their targets. Parent directories must remain inside root.
      if (!file.conflict) {
        let parent: string
        try {
          parent = await realpath(resolve(full, '..'))
        } catch (error) {
          if (!isMissing(error)) throw error
          parent = identity.root
        }
        const suffix = relative(identity.root, parent)
        if (suffix === '..' || suffix.startsWith(`..${sep}`) || isAbsolute(suffix))
          throw new Error('文件父目录已越出仓库')
      }
      try {
        const stat = await lstat(full, { bigint: true })
        versions.push(`${file.path}\0${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}:${stat.mode}`)
      } catch (error) {
        if (!isMissing(error)) throw error
        versions.push(`${file.path}\0deleted`)
      }
    }
    return hash(`${hash(index)}\0${config}\0${versions.join('\0')}`)
  }

  private async actionBlockers(
    identity: GitIdentity,
    configText: string
  ): Promise<ScRepository['actionBlockers']> {
    const blockers: ScRepository['actionBlockers'] = {}
    const config = configText.split('\0')
    for (const key of ['commit.gpgsign', 'push.gpgsign']) {
      const signing = config.filter((row) => row === key || row.startsWith(`${key}\n`)).at(-1)
      if (
        signing !== undefined &&
        (signing.indexOf('\n') < 0 || /\n(?:true|yes|on|1|if-asked)$/i.test(signing))
      ) {
        blockers[key === 'commit.gpgsign' ? 'commit' : 'push'] =
          `此仓库配置了 ${key}；原生签名程序尚无独立执行授权，请在终端处理`
      }
    }
    const hooks = (await this.run(identity.root, ['rev-parse', '--git-path', 'hooks'], false)).trim()
    let entries: string[]
    try {
      entries = await readdir(resolve(identity.root, hooks))
    } catch (error) {
      if (!isMissing(error)) throw error
      entries = []
    }
    for (const name of entries) {
      const actions = hookActions.get(name)
      if (!actions) continue
      try {
        await access(resolve(identity.root, hooks, name), constants.X_OK)
        for (const action of actions) {
          blockers[action] ??= `原生 Git hook ${name} 尚未单独授权；不会继承 recorder 自动授权或绕过 hook`
        }
      } catch (error) {
        if (isMissing(error)) continue
        if (error instanceof Error && 'code' in error && error.code === 'EACCES') continue
        throw error
      }
    }
    return blockers
  }

  private async executionBlocker(identity: GitIdentity): Promise<string | null> {
    for (const name of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply']) {
      try {
        await lstat(join(identity.gitDir, name))
        return `Git ${name} 操作尚未完成，请先在终端处理`
      } catch (error) {
        if (!isMissing(error)) throw error
      }
    }
    return null
  }

  private async assertSafeWorktreeRead(root: string): Promise<void> {
    // Even status may invoke clean/process filters while comparing index and worktree.
    // Enumerate names and attributes first; these commands do not run content filters.
    const index = await this.run(root, ['ls-files', '--stage', '-z'])
    if (/(?:^|\0)160000 /.test(index))
      throw new Error('仓库包含子模块；第一版不递归读取或修改子模块，避免执行未授权的子仓配置')
    const names = await this.run(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'])
    if (!names) return
    const attributes = await this.process.run(
      'git',
      [...readConfig, ...readOnly, 'check-attr', '-z', '--stdin', 'filter'],
      root,
      { input: names }
    )
    const configured = new Map(
      (await this.config(root))
        .split('\0')
        .filter(Boolean)
        .map((row) => {
          const separator = row.indexOf('\n')
          return separator < 0 ? [row, 'true'] : [row.slice(0, separator), row.slice(separator + 1)]
        })
    )
    const fields = attributes.split('\0')
    for (let i = 2; i < fields.length; i += 3) {
      const name = fields[i]
      if (configured.get(`filter.${name}.clean`) || configured.get(`filter.${name}.process`)) {
        throw new Error(
          '文件配置了原生 Git filter；git status 本身也可能执行它。未获得独立授权，停止读取和写入，请在终端处理'
        )
      }
    }
  }

  private async readStatus(identity: GitIdentity) {
    const fresh = await this.identity(identity.root)
    if (fresh.id !== identity.id) throw new Error('仓库身份已改变，请重新打开源代码管理')
    await this.assertSafeWorktreeRead(identity.root)
    const output = await this.run(identity.root, [
      'status',
      '--porcelain=v2',
      '-z',
      '--branch',
      '--untracked-files=all'
    ])
    const state = parseGitStatus(output)
    if (state.files.length > 1000)
      throw new Error('工作区超过 1,000 个变更文件；不提供不完整的可写快照，请在终端缩小范围')
    const config = await this.config(identity.root)
    return { state, output, config }
  }

  private async revisionState(
    identity: GitIdentity,
    { state, output, config }: Awaited<ReturnType<ScGit['readStatus']>>
  ): Promise<Omit<ScRepository, 'remotes'>> {
    const actionBlockers = await this.actionBlockers(identity, config)
    const writeBlocker = state.files.some((file) => file.conflict)
      ? '存在未解决的冲突，请在终端处理'
      : await this.executionBlocker(identity)
    return {
      ...state,
      id: identity.id,
      root: identity.root,
      writeBlocker,
      actionBlockers,
      revision: hash(
        `${identity.id}\0${output}\0${await this.fingerprint(identity, state.files, config)}\0${writeBlocker}\0${JSON.stringify(actionBlockers)}`
      ),
      observedAt: Date.now()
    }
  }


  /** Same revision material as status; remotes are a display projection, not hash input. */
  async revisionSnapshot(identity: GitIdentity): Promise<Omit<ScRepository, 'remotes'>> {
    return this.revisionState(identity, await this.readStatus(identity))
  }

  async status(identity: GitIdentity): Promise<ScRepository> {
    const observed = await this.readStatus(identity)
    const remoteNames = (await this.run(identity.root, ['remote'])).trim().split('\n').filter(Boolean)
    const remotes: ScRepository['remotes'] = []
    for (const name of remoteNames) {
      const values = (await this.run(identity.root, ['remote', 'get-url', '--push', '--all', '--', name]))
        .trimEnd()
        .split('\n')
      const fetchUrls = (await this.run(identity.root, ['remote', 'get-url', '--all', '--', name]))
        .trimEnd()
        .split('\n')
      const redact = (value: string): string => value.replace(/(https?:\/\/)[^\s/@]+@/g, '$1[redacted]@')
      remotes.push({ name, pushUrls: values.map(redact), fetchUrls: fetchUrls.map(redact) })
    }
    const snapshot = await this.revisionState(identity, observed)
    return { ...snapshot, remotes }
  }

  async diff(identity: GitIdentity, file: ScFile, staged: boolean): Promise<ScDiff> {
    let patch: string
    if (file.untracked) {
      const stat = await lstat(resolve(identity.root, file.path))
      if (!stat.isFile() || stat.size > 256 * 1024) return { patch: '', binary: false, truncated: true }
      const data = await readFile(resolve(identity.root, file.path))
      if (data.includes(0)) return { patch: '', binary: true, truncated: false }
      const content = new TextDecoder('utf-8', { fatal: true }).decode(data)
      const lines = content ? content.split('\n') : []
      if (content.endsWith('\n')) lines.pop()
      const header = `diff --git ${JSON.stringify(`a/${file.path}`)} ${JSON.stringify(`b/${file.path}`)}\nnew file mode ${stat.mode & 0o111 ? '100755' : '100644'}`
      patch = lines.length
        ? `${header}\n--- /dev/null\n+++ ${JSON.stringify(`b/${file.path}`)}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => `+${line}`).join('\n')}\n${content.endsWith('\n') ? '' : '\\ No newline at end of file\n'}`
        : `${header}\n`
    } else {
      patch = await this.run(identity.root, [
        '--literal-pathspecs',
        'diff',
        '--no-ext-diff',
        '--no-textconv',
        '--no-color',
        ...(staged ? ['--cached'] : []),
        '--',
        ...(file.previousPath && (staged ? file.index === 'R' : file.worktree === 'R')
          ? [file.previousPath]
          : []),
        file.path
      ])
    }
    return {
      patch: Buffer.from(patch)
        .subarray(0, 256 * 1024)
        .toString('utf8'),
      truncated: Buffer.byteLength(patch) > 256 * 1024,
      binary: /^Binary files .* differ$/m.test(patch)
    }
  }

  async stage(identity: GitIdentity, files: ScFile[], unstage: boolean, head: string | null): Promise<string[]> {
    const paths = [
      ...new Set(
        files.flatMap((file) => {
          // An indexed rename already removed its source. Staging the destination must
          // not accidentally add a newly-created, unrelated file at the old path.
          const includeSource = unstage ? file.index === 'R' : file.worktree === 'R'
          return file.previousPath && includeSource ? [file.previousPath, file.path] : [file.path]
        })
      )
    ]
    const command = unstage
      ? head
        ? ['restore', '--staged', '--source=HEAD', '--', ...paths]
        : ['update-index', '--force-remove', '--', ...paths]
      : ['add', '-A', '--', ...paths]
    await this.run(identity.root, ['--literal-pathspecs', ...command], false)
    return paths
  }

  async commitIndex(identity: GitIdentity, message: string): Promise<string> {
    await this.process.run('git', [...readConfig, 'commit', '--file=-'], identity.root, {
      input: message,
      timeout: 60_000
    })
    return (await this.run(identity.root, ['rev-parse', 'HEAD'])).trim()
  }

  async transportTarget(identity: GitIdentity, remote: string, direction: 'fetch' | 'push'): Promise<string> {
    const targetText = await this.run(identity.root, [
      'remote',
      'get-url',
      ...(direction === 'push' ? ['--push'] : []),
      '--all',
      '--',
      remote
    ])
    const targets = targetText.trimEnd().split('\n')
    if (targets.length !== 1) throw new Error(`一个 remote 配置了多个 ${direction} URL；第一版只支持唯一端点`)
    const target = targets[0]
    const localConfig = `${await this.config(identity.root, '--local')}\0${await this.config(identity.root, '--worktree')}`
    if (
      localConfig
        .split('\0')
        .some((row) =>
          /^(?:core\.(?:sshcommand|askpass|gitproxy)|ssh\.variant|credential(?:\.[^\n]*)?\.helper|remote\.[^\n]*\.(?:receivepack|uploadpack|proxy|vcs))\n/i.test(
            row
          )
        )
    )
      throw new Error('仓库配置了自定义传输执行程序；未获独立授权，请在终端操作')
    // A second rewrite of an already resolved endpoint could redirect a direct URL push.
    if (
      (await this.config(identity.root))
        .split('\0')
        .some(
          (row) =>
            /^url\.[^\n]+\.(?:pushinsteadof|insteadof)\n/i.test(row) &&
            target.startsWith(row.slice(row.indexOf('\n') + 1))
        )
    )
      throw new Error('已解析端点仍会被 Git 二次改写；停止执行，请在终端核实目标')
    if (/^https:\/\//.test(target)) {
      const url = new URL(target)
      if (url.username || url.password || url.search || url.hash)
        throw new Error('推送 URL 不允许内嵌凭证、查询或片段')
    } else if (/^(?:git@[A-Za-z0-9.-]+:|ssh:\/\/git@[A-Za-z0-9.-]+\/)[A-Za-z0-9_./-]+$/.test(target)) {
      // User-level SSH configuration is the user's transport, not the GitHub API identity.
    } else if (isAbsolute(target)) {
      if ((await realpath(target)) !== this.authorizeLocalRemote(target))
        throw new Error('本地 remote 尚未授权')
    } else throw new Error('仅支持常规 HTTPS/SSH 或已授权本地 remote；不执行任意 remote helper')
    return target
  }

  async remoteHead(identity: GitIdentity, target: string, branch: string): Promise<string | null> {
    const output = await this.run(
      identity.root,
      ['ls-remote', '--refs', '--', target, `refs/heads/${branch}`],
      false,
      60_000
    )
    const lines = output.trim().split('\n').filter(Boolean)
    if (lines.length > 1) throw new Error('远端分支查询结果不唯一')
    return lines.length ? lines[0].split('\t')[0] : null
  }

  async push(identity: GitIdentity, target: string, branch: string, head: string): Promise<void> {
    await this.run(
      identity.root,
      [
        'push',
        '--porcelain',
        '--no-follow-tags',
        '--recurse-submodules=no',
        '--',
        target,
        `${head}:refs/heads/${branch}`
      ],
      false,
      90_000
    )
  }

  async fetch(identity: GitIdentity, target: string, remote: string): Promise<void> {
    await this.run(
      identity.root,
      [
        'fetch',
        '--no-tags',
        '--no-prune',
        '--no-recurse-submodules',
        '--',
        target,
        `+refs/heads/*:refs/remotes/${remote}/*`
      ],
      false,
      90_000
    )
  }
}

export function isNotRepository(error: unknown): boolean {
  return error instanceof ScCommandError && error.code === 128 && /not a git repository/i.test(error.message)
}
