import { isAbsolute } from 'node:path'
import type { ScFile, ScRepository } from '../../shared/source-control'

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
