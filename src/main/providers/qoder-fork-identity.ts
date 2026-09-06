import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { isTranscriptUserPrompt } from './session-fork-boundary'

/** SDK message projection drops promptId. Read only the exact UUID transcript,
 * then require the matching user UUID to exist in the SDK's active lineage. */
export async function resolveQoderForkUserId(args: {
  projectsDir: string
  sessionId: string
  cwd?: string
  promptId: string
  activeUserIds: ReadonlySet<string>
}): Promise<string> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(args.sessionId)) {
    throw new Error('Qoder 会话 ID 无效')
  }
  const projects = await readdir(args.projectsDir, { withFileTypes: true })
  if (projects.length > 2_000) throw new Error('Qoder 项目索引超出安全读取范围')
  const matches = new Set<string>()
  for (const project of projects) {
    if (!project.isDirectory()) continue
    const file = join(args.projectsDir, project.name, `${args.sessionId}.jsonl`)
    let size: number
    try { size = (await stat(file)).size } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    if (size > 32 * 1024 * 1024) throw new Error('Qoder transcript 超出安全读取范围')
    const text = await readFile(file, 'utf8')
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      let row: Record<string, unknown>
      try { row = JSON.parse(line) } catch { throw new Error('Qoder transcript 不完整，无法验证分支边界') }
      if (!row || typeof row !== 'object') throw new Error('Qoder transcript 格式无效')
      if (!isTranscriptUserPrompt(row) || row.isMeta === true || row.isSidechain === true ||
        row.sessionId !== args.sessionId || (args.cwd && row.cwd !== args.cwd) ||
        row.promptId !== args.promptId || typeof row.uuid !== 'string') continue
      matches.add(row.uuid)
    }
  }
  if (matches.size !== 1) throw new Error('Qoder 旧轮次无法唯一映射原生消息 UUID')
  const id = [...matches][0]
  if (!args.activeUserIds.has(id)) throw new Error('Qoder 所选轮次已不在原生活动分支中，无法安全分支')
  return id
}
