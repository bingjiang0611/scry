import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { BackgroundNotice } from '../background-notices'
import { BackgroundNotices } from './BackgroundNotices'

const session = { sessionId: 's', providerId: 'claude' as const, preview: '迁移数据库', mtime: 1, count: 1 }
const notice = (key: string, kind: BackgroundNotice['kind'], title = '迁移数据库'): BackgroundNotice =>
  ({ key, kind, title, projectName: 'Store', target: { kind: 'session', cwd: '/work/store', session } })

describe('BackgroundNotices', () => {
  it('renders nothing while there is nothing to say, so no empty live region exists', () => {
    expect(renderToStaticMarkup(<BackgroundNotices notices={[]} onOpen={() => {}} onDismiss={() => {}} />)).toBe('')
  })

  it('announces results that need the user as alerts and the rest as status, with open and dismiss actions', () => {
    const html = renderToStaticMarkup(<BackgroundNotices notices={[notice('a', 'failed'), notice('b', 'completed', ' ')]} onOpen={() => {}} onDismiss={() => {}} />)
    expect(html).toContain('<section class="background-notices" aria-label="后台通知">')
    expect(html).toMatch(/<article class="background-notice" data-kind="failed" role="alert"><button type="button" class="background-notice-open" title="打开会话：迁移数据库"><svg[^>]*>.*?<\/svg><b>运行失败<\/b><span class="background-notice-title">迁移数据库<\/span><small>Store<\/small><\/button>/)
    expect(html).toMatch(/<article class="background-notice" data-kind="completed" role="status">.*<b>已完成<\/b><span class="background-notice-title">未命名会话<\/span>/)
    expect(html).toContain('aria-label="关闭通知：迁移数据库"')
  })
})
