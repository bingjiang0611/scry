import type { IpcMainInvokeEvent } from 'electron'
import type {
  ScCommitDraft,
  ScExpected,
  ScInlineComment,
  ScMutation,
  ScPrExpected,
  ScPrRef,
  ScRef,
  ScReviewDraft,
  SourceControlApi
} from '../../shared/source-control'
import { validGithubRepository } from './github'
import { operationIdPattern } from './store'
import type { SourceControlService } from './service'

type Input = Record<string, unknown>
function object(value: unknown): Input {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('源代码管理请求必须是对象')
  return value as Input
}
function text(value: unknown, limit = 4096, empty = false): string {
  if (typeof value !== 'string' || (!empty && !value.trim()) || value.length > limit || value.includes('\0'))
    throw new Error('请求字符串为空、过长或包含 NUL')
  return value
}
function choice<T extends string>(value: unknown, values: readonly T[]): T {
  if (typeof value !== 'string' || !values.includes(value as T)) throw new Error('不支持的操作选项')
  return value as T
}
function bool(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new Error('请求字段必须是布尔值')
  return value
}
function integer(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0)
    throw new Error('请求编号必须是正整数')
  return value
}
function hash(value: unknown): string {
  const result = text(value, 64)
  if (!/^[a-f0-9]{64}$/.test(result)) throw new Error('无效仓库引用或快照版本')
  return result
}
function sha(value: unknown): string {
  const result = text(value, 64)
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(result)) throw new Error('无效提交 SHA')
  return result
}
function repository(value: unknown): string {
  const result = text(value, 220)
  if (!validGithubRepository(result)) throw new Error('仅接受 github.com owner/repository，不接受 URL')
  return result
}
function ref(input: Input): ScRef {
  return { repositoryId: hash(input.repositoryId) }
}
function expected(input: Input): ScExpected {
  return { ...ref(input), expectedRevision: hash(input.expectedRevision) }
}
function prRef(input: Input): ScPrRef {
  return { ...ref(input), repository: repository(input.repository), number: integer(input.number) }
}
function prExpected(input: Input): ScPrExpected {
  return { ...prRef(input), account: text(input.account, 100), head: sha(input.head), base: sha(input.base) }
}
function path(value: unknown): string {
  const result = text(value)
  if (
    result.startsWith('/') ||
    result.startsWith('\\') ||
    /^[A-Za-z]:/.test(result) ||
    result.split(/[\\/]/).some((part) => ['..', '.git'].includes(part))
  )
    throw new Error('只接受安全的仓库相对文件路径')
  return result
}
function branch(value: unknown): string {
  const result = text(value, 256)
  if (
    result.startsWith('-') ||
    /[\s~^:?*\[\\]/.test(result) ||
    result.includes('..') ||
    result.includes('@{') ||
    result.endsWith('/') ||
    result.endsWith('.') ||
    result.endsWith('.lock')
  )
    throw new Error('无效分支或 remote 名称')
  return result
}
function operation(input: Input): ScRef & { operationId: string } {
  const id = text(input.operationId, 36)
  if (!operationIdPattern.test(id)) throw new Error('无效 operation ID')
  return { ...ref(input), operationId: id }
}
function comments(value: unknown): ScInlineComment[] {
  if (!Array.isArray(value) || value.length > 100) throw new Error('一批审查最多 100 条行评论')
  return value.map((item) => {
    const row = object(item)
    return {
      path: path(row.path),
      line: integer(row.line),
      side: choice(row.side, ['LEFT', 'RIGHT']),
      body: text(row.body, 10_000)
    }
  })
}
function parseCommitDraft(value: unknown): ScCommitDraft {
  const input = object(value)
  return {
    ...ref(input),
    head: input.head === null ? null : sha(input.head),
    message: text(input.message, 20_000, true)
  }
}

export function parseReviewDraft(value: unknown): ScReviewDraft {
  const input = object(value)
  return {
    ...prExpected(input),
    body: text(input.body, 60_000, true),
    verdict: choice(input.verdict, ['COMMENT', 'APPROVE', 'REQUEST_CHANGES']),
    comments: comments(input.comments)
  }
}
export function parseScMutation(value: unknown): ScMutation & { operationId: string } {
  const input = object(value)
  const op = operation(input)
  const action = choice(input.action, [
    'stage',
    'unstage',
    'commit',
    'fetch',
    'push',
    'createPr',
    'review',
    'merge'
  ])
  switch (action) {
    case 'stage':
    case 'unstage': {
      if (!Array.isArray(input.paths) || !input.paths.length || input.paths.length > 1000)
        throw new Error('需明确选择 1–1,000 个文件')
      return {
        ...op,
        ...expected(input),
        action,
        paths: [...new Set(input.paths.map(path))],
        ...(action === 'stage' && input.allowStagedOverwrite !== undefined
          ? { allowStagedOverwrite: bool(input.allowStagedOverwrite) }
          : {})
      }
    }
    case 'commit': {
      if (input.paths !== undefined && (!Array.isArray(input.paths) || input.paths.length > 1000))
        throw new Error('提交范围最多 1,000 个文件')
      return {
        ...op, ...expected(input), action, message: text(input.message, 20_000),
        ...(Array.isArray(input.paths) ? { paths: [...new Set(input.paths.map(path))] } : {})
      }
    }
    case 'fetch':
    case 'push':
      return { ...op, ...expected(input), action, remote: branch(input.remote) }
    case 'createPr':
      return {
        ...op,
        ...expected(input),
        action,
        repository: repository(input.repository),
        account: text(input.account, 100),
        headRepository: repository(input.headRepository),
        headBranch: branch(input.headBranch),
        baseBranch: branch(input.baseBranch),
        title: text(input.title, 256),
        body: text(input.body, 60_000, true),
        draft: bool(input.draft)
      }
    case 'review': {
      const draft = parseReviewDraft(input)
      if (draft.verdict === 'COMMENT' && !draft.body.trim() && !draft.comments.length)
        throw new Error('评论审查不能为空')
      return { ...op, ...draft, action }
    }
    case 'merge':
      return {
        ...op,
        ...prExpected(input),
        action,
        method: choice(input.method, ['merge', 'squash', 'rebase'])
      }
  }
}

// Both trusted local IPC and authenticated desktop requests use these parsers.
export function sourceControlHandlers(service: SourceControlService, authorize?: () => void) {
  return {
    read: (request: unknown) => service.read(text(request)),
    diff: (request: unknown) => {
      const input = object(request)
      return service.diff({ ...expected(input), path: path(input.path), staged: bool(input.staged) })
    },
    mutate: (request: unknown) => {
      const mutation = parseScMutation(request)
      return authorize ? service.mutate(mutation, authorize) : service.mutate(mutation)
    },
    operations: (request: unknown) => service.operations(ref(object(request))),
    reconcile: (request: unknown) => service.reconcile(operation(object(request))),
    acknowledge: (request: unknown) => service.acknowledge(operation(object(request))),
    pullRequests: (request: unknown) => {
      const input = object(request)
      return service.pullRequests({ ...ref(input), repository: repository(input.repository) })
    },
    pullRequest: (request: unknown) => service.pullRequest(prRef(object(request))),
    saveCommitDraft: (request: unknown) => service.saveCommitDraft(parseCommitDraft(request)),
    loadCommitDraft: async (request: unknown) => {
      const requestRef = ref(object(request))
      const value = await service.loadCommitDraft(requestRef)
      if (value === null) return null
      const draft = parseCommitDraft(value)
      if (draft.repositoryId !== requestRef.repositoryId) throw new Error('提交消息草稿不属于此仓库')
      return draft
    },
    saveDraft: (request: unknown) => service.saveDraft(parseReviewDraft(request)),
    loadDraft: async (request: unknown) => {
      const target = prRef(object(request))
      const draft = await service.loadDraft(target)
      if (draft === null) return null
      const parsed = parseReviewDraft(draft)
      if (parsed.repositoryId !== target.repositoryId || parsed.repository !== target.repository || parsed.number !== target.number)
        throw new Error('持久化草稿的目标不匹配')
      return parsed
    }
  } satisfies Record<keyof SourceControlApi, (request: unknown) => unknown>
}

type Register = (channel: string, listener: (event: IpcMainInvokeEvent, request: unknown) => unknown) => void
export function registerSourceControlIpc(register: Register, service: SourceControlService): void {
  for (const [method, handler] of Object.entries(sourceControlHandlers(service))) {
    register(`sourceControl:${method}`, (_event, request) => handler(request))
  }
}
