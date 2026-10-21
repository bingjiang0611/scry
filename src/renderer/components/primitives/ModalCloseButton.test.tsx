import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { MODAL_COPY } from '../../constants/copy'
import { Icon } from './Icon'
import { ModalCloseButton } from './ModalCloseButton'

describe('ModalCloseButton', () => {
  it('preserves the icon button markup and accessible name', () => {
    expect(renderToStaticMarkup(<ModalCloseButton aria-label={MODAL_COPY.close} />)).toBe(
      renderToStaticMarkup(<button aria-label={MODAL_COPY.close} type="button" className="modal-x"><Icon name="x" /></button>)
    )
  })

  it('preserves disabled state, local classes and existing glyph content', () => {
    expect(renderToStaticMarkup(
      <ModalCloseButton aria-label={MODAL_COPY.closeRename} disabled className="capabilities-close">×</ModalCloseButton>
    )).toBe(renderToStaticMarkup(
      <button aria-label={MODAL_COPY.closeRename} disabled type="button" className="modal-x capabilities-close">×</button>
    ))
  })
})
