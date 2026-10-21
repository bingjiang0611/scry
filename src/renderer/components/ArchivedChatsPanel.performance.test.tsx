import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { ProjectMeta } from '../env'
import { ArchivedChatsPanel } from './Modals'

describe('archived session date formatting', () => {
  it('reuses its formatter across rows and renders without dropping dates', () => {
    const archivedAt = new Date(2026, 9, 20, 12, 30).getTime()
    const projects: ProjectMeta[] = [{
      cwd: '/fixture', name: 'Archive fixture', mtime: archivedAt,
      sessions: Array.from({ length: 277 }, (_, index) => ({
        sessionId: `archived-${index}`, providerId: 'pi', preview: `Question ${index}`,
        mtime: archivedAt, count: 1, archivedAt
      }))
    }]
    const formatter = vi.spyOn(Intl, 'DateTimeFormat')
    try {
      for (let index = 0; index < 2; index++) {
        const html = renderToStaticMarkup(<ArchivedChatsPanel projects={projects}
          onRefresh={async () => {}} onSessionsChanged={() => {}} />)
        expect(html.match(/存档于 /g)).toHaveLength(277)
        expect(html).toContain('2026年10月20日')
      }
      expect(formatter).not.toHaveBeenCalled()
    } finally {
      formatter.mockRestore()
    }
  })
})
