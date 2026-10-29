import { readFileSync, writeFileSync } from 'node:fs'

/**
 * Real native window sizes for the isolated production App.
 *
 * `Emulation.setDeviceMetricsOverride` leaves CSS `vw`/`vh` on the real window, so it can
 * only prove a component-level number. The fixture main process applies
 * `BrowserWindow.setContentSize` and answers with the size the window really took; this
 * module asks for one size at a time and waits for both the receipt and the renderer.
 */
export function createWindowResize({ wait, idle, check, windowControlPath, json }) {
  let seq = 0
  const applied = []
  const resize = async (width, height) => {
    check(typeof windowControlPath === 'string', 'the layout acceptance needs the fixture window control path')
    seq += 1
    const receiptPath = `${windowControlPath}.receipt`
    const previous = (() => { try { return JSON.parse(readFileSync(receiptPath, 'utf8')) } catch { return null } })()
    writeFileSync(windowControlPath, JSON.stringify({ seq, width, height }))
    let receipt = null
    const deadline = Date.now() + 20000
    while (Date.now() < deadline) {
      try {
        const candidate = JSON.parse(readFileSync(receiptPath, 'utf8'))
        if (candidate.seq !== (previous?.seq ?? 0)) { receipt = candidate; break }
      } catch { /* the receipt is written only after the window really changed */ }
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    check(receipt != null, `the isolated window never accepted ${width}x${height}`)
    // A shown window would cover the user's screen; the acceptance stays off screen.
    check(receipt.visible === false, `the fixture window must stay hidden: ${json(receipt)}`)
    const [contentWidth, contentHeight] = receipt.contentSize
    check(Math.abs(contentWidth - width) <= 1 && Math.abs(contentHeight - height) <= 1,
      `the native window clamped ${width}x${height} to ${json(receipt)}`)
    await wait(`window.innerWidth === ${width} && window.innerHeight === ${height}`, 20000)
    await idle()
    applied.push({ width, height, contentSize: receipt.contentSize })
    return receipt
  }
  return { resize, applied }
}
