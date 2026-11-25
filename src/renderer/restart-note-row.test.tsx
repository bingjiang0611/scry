import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { RestartNoteRow } from './components/chat-view/RestartNoteRow'
import { RESTART_NOTE_COPY } from './constants/restart-note-copy'

const base = { pressing: false, error: null, press: () => {} }

describe('RestartNoteRow', () => {
  it('offers 继续 only while the host still holds the note', () => {
    expect(renderToStaticMarkup(<RestartNoteRow state={{ ...base, offer: 'pending' }} />))
      .toContain(RESTART_NOTE_COPY.continue)
    // Consumed or never present: nothing to press, and no claim that the work is done.
    expect(renderToStaticMarkup(<RestartNoteRow state={{ ...base, offer: 'none' }} />)).toBe('')
    expect(renderToStaticMarkup(<RestartNoteRow state={{ ...base, offer: 'idle' }} />)).toBe('')
  })

  it('says the host has not answered instead of staying silent', () => {
    const html = renderToStaticMarkup(<RestartNoteRow state={{ ...base, offer: 'unknown' }} />)
    expect(html).toContain(RESTART_NOTE_COPY.title)
    expect(html).not.toContain('<button')
  })

  it('shows the refusal and disables the press while it runs', () => {
    expect(renderToStaticMarkup(<RestartNoteRow state={{ ...base, offer: 'pending', error: RESTART_NOTE_COPY.refused('x') }} />))
      .toContain(RESTART_NOTE_COPY.refused('x'))
    expect(renderToStaticMarkup(<RestartNoteRow state={{ ...base, offer: 'pending', pressing: true }} />))
      .toContain(RESTART_NOTE_COPY.continuing)
  })
})
