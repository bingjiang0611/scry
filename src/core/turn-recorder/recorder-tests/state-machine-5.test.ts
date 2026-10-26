import { readFile, writeFile, access, utimes, appendFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { it, expect } from 'vitest'
import { handleRecorderHook, drainRecorderDelivery, recoverRecorder } from '../recorder'
import { listRecords, safeKey } from '../store'
import { workspace, commitHook, payload, pexecFile } from './fixture.test'

export function registerSuite5(): void {


  it('deferDelivery 把投递移出 hook 响应，但记录照常提交且后续可投递', async () => {
    const root = await workspace()
    const { path, capture } = await commitHook(root)
    const config = JSON.parse(await readFile(join(root, 'scry.config.json'), 'utf8')) as Record<string, any>
    config.commitHook = { entry: 'commit-hook.sh', files: ['commit-hook.sh'] }
    await writeFile(join(root, 'scry.config.json'), JSON.stringify(config))
    const env = { ...process.env, SCRY_RECORDER_COMMIT_HOOK: path }

    const payloadFor = (event: string) => ({
      provider: 'claude' as const,
      event,
      workspace: root,
      payload: payload('defer-1', { prompt: '一轮', timestamp: '2026-07-19T12:00:00.000Z' }),
      env,
      deferDelivery: true
    })
    await handleRecorderHook(payloadFor('UserPromptSubmit'))
    await handleRecorderHook({ ...payloadFor('Stop'), payload: payload('defer-1', { timestamp: '2026-07-19T12:00:01.000Z' }) })

    // 记录必须已经落盘，而投递没有在 hook 里发生。
    expect((await listRecords(join(root, '.scry'))).length).toBe(1)
    await expect(access(capture)).rejects.toMatchObject({ code: 'ENOENT' })

    // 响应之后由长活进程投递。
    await drainRecorderDelivery(root, env)
    const delivered = (await readFile(capture, 'utf8')).trim().split('\n')
    expect(delivered).toHaveLength(1)
    expect(JSON.parse(delivered[0])).toMatchObject({ event: 'record-committed', sequence: 1 })
  })

  it('终态已到但正文已被轮转的 closing 轮次超窗后收敛为 completed，正文与 diff 标 unavailable', async () => {
    const root = await workspace()
    const transcript = join(root, 'transcript.jsonl')
    await writeFile(transcript, JSON.stringify({ type: 'user', message: { role: 'user', content: '这一轮会被轮转掉' } }) + '\n')
    await handleRecorderHook({
      provider: 'claude',
      event: 'UserPromptSubmit',
      workspace: root,
      payload: payload('claude-closing', { prompt: '这一轮会被轮转掉', transcript_path: transcript })
    })
    // Provider 轮转掉了这一轮：终态事件到达时 transcript 里已经找不到它。
    await writeFile(transcript, JSON.stringify({ type: 'user', message: { role: 'user', content: '完全不同的一轮' } }) + '\n')
    await expect(handleRecorderHook({
      provider: 'claude',
      event: 'Stop',
      workspace: root,
      payload: payload('claude-closing', { transcript_path: transcript })
    })).resolves.toMatchObject({ status: 'pending' })

    const openState = join(root, '.scry', 'runtime', 'claude', safeKey('claude-closing'), 'open.json')
    expect(JSON.parse(await readFile(openState, 'utf8')).status).toBe('closing')
    // 已经在 closing 里卡了 5 天：判据是 recorder 自己最后一次写状态的时间，不是 Provider 给的时间戳。
    const stalledAt = new Date(Date.now() - 5 * 24 * 60 * 60 * 1_000)
    await utimes(openState, stalledAt, stalledAt)

    await expect(recoverRecorder(root)).resolves.toEqual({ recovered: 1, pending: 0, expired: 1 })
    const [record] = await listRecords(join(root, '.scry'))
    // 终态确实到过（这才让它进 closing），所以谎报 interrupted 是错的；只有证据降级。
    expect(record.status).toBe('completed')
    expect(record.assistant.status).toBe('unavailable')
    expect(record.assistant.omissionReason).toContain('no longer contains this turn')
    // 基线是 5 天前的，diff 不能声称属于这一轮。
    expect(record.diff.status).toBe('unavailable')
    // transcript 被丢弃且没有 lifecycle 工具事件：不能声称「这一轮没用工具」。
    expect(record.tools.status).toBe('unavailable')
  })

  it('closing 轮次在过期窗口内不强制收尾，仍等待正文出现', async () => {
    const root = await workspace()
    const transcript = join(root, 'transcript.jsonl')
    await writeFile(transcript, JSON.stringify({ type: 'user', message: { role: 'user', content: '刚刚结束的一轮' } }) + '\n')
    await handleRecorderHook({
      provider: 'claude',
      event: 'UserPromptSubmit',
      workspace: root,
      payload: payload('claude-fresh-closing', { prompt: '刚刚结束的一轮', transcript_path: transcript })
    })
    await writeFile(transcript, JSON.stringify({ type: 'user', message: { role: 'user', content: '换成别的内容' } }) + '\n')
    await handleRecorderHook({
      provider: 'claude',
      event: 'Stop',
      workspace: root,
      payload: payload('claude-fresh-closing', { transcript_path: transcript })
    })

    // 刚结束的轮次可能还会收敛（Provider 稍后补写），不该立刻放弃、更不该丢掉 diff。
    await expect(recoverRecorder(root)).resolves.toMatchObject({ recovered: 0, pending: 1, expired: 0 })
    expect(await listRecords(join(root, '.scry'))).toHaveLength(0)
  })

  it('静默多天的 open 轮次保留身份直到真实终态到达', async () => {
    const root = await workspace()
    const transcript = join(root, 'transcript.jsonl')
    const startedAt = new Date(Date.now() - 3 * 24 * 60 * 60 * 1_000).toISOString()
    // 只有用户消息并不能证明任务已经停止。
    await writeFile(transcript, JSON.stringify({ type: 'user', message: { role: 'user', content: '跑一个长任务' } }))
    await handleRecorderHook({
      provider: 'claude',
      event: 'UserPromptSubmit',
      workspace: root,
      payload: payload('claude-expired', { prompt: '跑一个长任务', transcript_path: transcript, timestamp: startedAt })
    })
    // transcript 已停止增长：把 mtime 推回 3 天前。
    const stoppedAt = new Date(Date.now() - 3 * 24 * 60 * 60 * 1_000)
    await utimes(transcript, stoppedAt, stoppedAt)

    await expect(recoverRecorder(root)).resolves.toEqual({ recovered: 0, pending: 0, expired: 0 })
    expect(await listRecords(join(root, '.scry'))).toEqual([])
    const openState = join(root, '.scry', 'runtime', 'claude', safeKey('claude-expired'), 'open.json')
    expect(JSON.parse(await readFile(openState, 'utf8')).status).toBe('open')
    await appendFile(transcript, `\n${JSON.stringify({
      type: 'assistant', timestamp: new Date().toISOString(),
      message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: '终于完成' }] }
    })}\n`)
    await handleRecorderHook({
      provider: 'claude', event: 'Stop', workspace: root,
      payload: payload('claude-expired', { transcript_path: transcript, timestamp: new Date().toISOString() })
    })
    const [record] = await listRecords(join(root, '.scry'))
    expect(record.status).toBe('completed')
    expect(record.assistant.value?.text).toContain('终于完成')
  })

  it('transcript 缺失不能作为 open 轮次已经中断的证据', async () => {
    const root = await workspace()
    const transcript = join(root, 'rotated-away.jsonl')
    await writeFile(transcript, JSON.stringify({ type: 'user', message: { role: 'user', content: '别的轮次' } }))
    await handleRecorderHook({
      provider: 'claude',
      event: 'UserPromptSubmit',
      workspace: root,
      payload: payload('claude-rotated', {
        prompt: '这一轮',
        promptId: 'gone-turn',
        transcript_path: transcript,
        timestamp: new Date(Date.now() - 3 * 24 * 60 * 60 * 1_000).toISOString()
      })
    })
    // Provider 把 transcript 轮转掉了：身份再也无法在其中匹配。
    await unlink(transcript)

    await expect(recoverRecorder(root)).resolves.toEqual({ recovered: 0, pending: 0, expired: 0 })
    expect(await listRecords(join(root, '.scry'))).toEqual([])
    const openState = join(root, '.scry', 'runtime', 'claude', safeKey('claude-rotated'), 'open.json')
    expect(JSON.parse(await readFile(openState, 'utf8'))).toMatchObject({ status: 'open', prompt: '这一轮' })
  })

  it('静默轮次不会提前发布 diff 或丢掉开始时的基线', async () => {
    const root = await workspace()
    // 该 fixture 的 capture.diff 为 false，这里显式打开以覆盖真实默认配置。
    const config = JSON.parse(await readFile(join(root, 'scry.config.json'), 'utf8')) as Record<string, any>
    config.capture = { ...config.capture, diff: true }
    await writeFile(join(root, 'scry.config.json'), JSON.stringify(config))
    await pexecFile('git', ['init', '-q', '.'], { cwd: root })
    await pexecFile('git', ['-c', 'user.email=a@b', '-c', 'user.name=a', 'commit', '-q', '--allow-empty', '-m', 'i'], { cwd: root })
    const transcript = join(root, 'transcript.jsonl')
    await writeFile(transcript, JSON.stringify({ type: 'user', message: { role: 'user', content: '那一轮' } }))
    await handleRecorderHook({
      provider: 'claude',
      event: 'UserPromptSubmit',
      workspace: root,
      payload: payload('claude-diff-attr', {
        prompt: '那一轮',
        transcript_path: transcript,
        timestamp: new Date(Date.now() - 3 * 24 * 60 * 60 * 1_000).toISOString()
      })
    })
    const openState = join(root, '.scry', 'runtime', 'claude', safeKey('claude-diff-attr'), 'open.json')
    const before = await readFile(openState, 'utf8')
    const stoppedAt = new Date(Date.now() - 3 * 24 * 60 * 60 * 1_000)
    await utimes(transcript, stoppedAt, stoppedAt)
    // 尚无终态，不能靠时间提前确定文件改动的归属边界。
    await writeFile(join(root, 'later-work.ts'), 'export const later = 1\n')

    await expect(recoverRecorder(root)).resolves.toEqual({ recovered: 0, pending: 0, expired: 0 })
    expect(await listRecords(join(root, '.scry'))).toEqual([])
    expect(await readFile(openState, 'utf8')).toBe(before)
  }, 15_000)

  it('transcript 仍在增长的长任务不被误判为过期', async () => {
    const root = await workspace()
    const transcript = join(root, 'transcript.jsonl')
    const startedAt = new Date(Date.now() - 30 * 60 * 60 * 1_000).toISOString()
    await writeFile(transcript, JSON.stringify({ type: 'user', message: { role: 'user', content: '长任务' } }))
    await handleRecorderHook({
      provider: 'claude',
      event: 'UserPromptSubmit',
      workspace: root,
      payload: payload('claude-longrun', { prompt: '长任务', transcript_path: transcript, timestamp: startedAt })
    })
    // 轮次已开了 30 小时，但 transcript 刚刚才写过：仍在工作，不能收敛。
    await appendFile(transcript, `\n${JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '还在跑' }] } })}\n`)

    await expect(recoverRecorder(root)).resolves.toEqual({ recovered: 0, pending: 0, expired: 0 })
    await expect(listRecords(join(root, '.scry'))).resolves.toEqual([])
  })

  it('无 transcript 的 open 轮次不论年龄都不伪造终态', async () => {
    const fresh = await workspace()
    await handleRecorderHook({
      provider: 'claude',
      event: 'UserPromptSubmit',
      workspace: fresh,
      payload: payload('claude-fresh-no-transcript', {
        prompt: '没有 transcript',
        timestamp: new Date(Date.now() - 60_000).toISOString()
      })
    })
    await expect(recoverRecorder(fresh)).resolves.toEqual({ recovered: 0, pending: 0, expired: 0 })

    const root = await workspace()
    await handleRecorderHook({
      provider: 'claude',
      event: 'UserPromptSubmit',
      workspace: root,
      payload: payload('claude-no-transcript', {
        prompt: '没有 transcript',
        // 没有 transcript 也不允许仅按年龄判定中断。
        timestamp: new Date(Date.now() - 3 * 24 * 60 * 60 * 1_000).toISOString()
      })
    })
    await expect(recoverRecorder(root)).resolves.toEqual({ recovered: 0, pending: 0, expired: 0 })
    expect(await listRecords(join(root, '.scry'))).toEqual([])
  })

  it('Claude 只有 promptHash 时未匹配 transcript 也保持 pending', async () => {
    const root = await workspace()
    const transcript = join(root, 'claude-unmatched-hash.jsonl')
    await writeFile(transcript, JSON.stringify({
      type: 'user',
      message: { role: 'user', content: 'other prompt' }
    }))
    await handleRecorderHook({
      provider: 'claude',
      event: 'UserPromptSubmit',
      workspace: root,
      payload: payload('claude-unmatched-hash', { prompt: 'target prompt', transcript_path: transcript })
    })
    const stopped = await handleRecorderHook({
      provider: 'claude',
      event: 'Stop',
      workspace: root,
      payload: payload('claude-unmatched-hash', { transcript_path: transcript })
    })

    expect(stopped).toMatchObject({
      status: 'pending',
      reason: 'target turn is not present in transcript snapshot'
    })
    await expect(listRecords(join(root, '.scry'))).resolves.toEqual([])
  })

  it('Codex 连续两轮输入相同 prompt 时按不同时间边界分别记录', async () => {
    const root = await workspace()
    await handleRecorderHook({ provider: 'codex', event: 'UserPromptSubmit', workspace: root, payload: payload('c1', { prompt: 'same' }) })
    const next = await handleRecorderHook({
      provider: 'codex',
      event: 'UserPromptSubmit',
      workspace: root,
      payload: payload('c1', { prompt: 'same', timestamp: '2026-07-19T12:00:02.000Z' })
    })
    await handleRecorderHook({
      provider: 'codex',
      event: 'turn/completed',
      workspace: root,
      payload: payload('c1', { timestamp: '2026-07-19T12:00:03.000Z' })
    })

    expect(next.status).toBe('started')
    expect(await listRecords(join(root, '.scry'))).toMatchObject([
      { turnIndex: 1, status: 'interrupted', user: { value: { text: 'same' } } },
      { turnIndex: 2, status: 'completed', user: { value: { text: 'same' } } }
    ])
  })
}
