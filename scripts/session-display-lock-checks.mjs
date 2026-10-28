export async function exerciseTranscriptDisplayLock({ read, wait, click }) {
  await click('#short-history')
  await wait(`document.querySelectorAll('[data-run-id]').length === 4 && document.querySelectorAll('[data-virtualized]').length === 0`)
  if (!await read(`Array.from(document.querySelectorAll('.transcript-turn')).every(element => getComputedStyle(element).contentVisibility === 'visible')`)) {
    throw new Error('Interactive transcript turns entered Chromium display locking')
  }
  await read(`document.querySelector('[data-run-id="turn-119"] .tool-group-row').scrollIntoView({ block: 'center' })`)
  await wait(`document.elementFromPoint(...(() => { const box = document.querySelector('[data-run-id="turn-119"] .tool-group-row').getBoundingClientRect(); return [box.left + box.width / 2, box.top + box.height / 2] })())?.closest('.tool-group-row') != null`)
  await click('[data-run-id="turn-119"] .tool-group-row')
  await wait(`document.querySelector('[data-run-id="turn-119"] .tool-group-row').getAttribute('aria-expanded') === 'true'`)
  await click('#reset-history')
  await wait(`document.querySelectorAll('[data-run-id]').length === 40 && document.querySelectorAll('[data-virtualized]').length > 20`)
  return true
}
