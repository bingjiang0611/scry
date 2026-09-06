import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { resolveQoderForkUserId } from './qoder-fork-identity'

describe('Qoder legacy fork identity', () => {
  it('rejects foreign cwd, duplicate prompt identities, malformed and abandoned transcripts', async () => {
    const projectsDir = await mkdtemp(join(tmpdir(), 'scry-fork-identity-'))
    const sessionId = '11111111-1111-4111-8111-111111111111'
    const dir = join(projectsDir, 'project')
    await mkdir(dir)
    const file = join(dir, `${sessionId}.jsonl`)
    const row = { type: 'user', uuid: 'native-user', promptId: 'prompt', sessionId, cwd: '/repo' }
    const args = { projectsDir, sessionId, cwd: '/repo', promptId: 'prompt', activeUserIds: new Set(['native-user']) }
    const save = (...rows: unknown[]) => writeFile(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n')
    try {
      await save(row)
      await expect(resolveQoderForkUserId(args)).resolves.toBe('native-user')
      await expect(resolveQoderForkUserId({ ...args, cwd: '/foreign' })).rejects.toThrow('无法唯一映射')
      await expect(resolveQoderForkUserId({ ...args, activeUserIds: new Set() })).rejects.toThrow('不在原生活动分支')
      await save(row, { ...row, uuid: 'duplicate' })
      await expect(resolveQoderForkUserId(args)).rejects.toThrow('无法唯一映射')
      await save(row, { ...row, uuid: 'meta', isMeta: true }, { ...row, uuid: 'child', isSidechain: true }, {
        ...row, uuid: 'tool-return', message: { content: [{ type: 'tool_result', content: 'done' }] }
      })
      await expect(resolveQoderForkUserId(args)).resolves.toBe('native-user')
      await writeFile(file, '{')
      await expect(resolveQoderForkUserId(args)).rejects.toThrow('transcript 不完整')
      await expect(resolveQoderForkUserId({ ...args, sessionId: '../escape' })).rejects.toThrow('会话 ID 无效')
    } finally {
      await rm(projectsDir, { recursive: true, force: true })
    }
  })
})
