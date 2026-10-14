// Install before creating windows. Fail before a regression can interrupt the desktop;
// native events also catch display/focus changes that bypass these methods.
module.exports = function enforceHiddenWindows(app) {
  app.on('browser-window-created', (_event, window) => {
    const fail = action => {
      console.error(`Background test attempted window ${action}`)
      // Throwing from an Electron event can itself open a native error dialog.
      app.exit(1)
    }
    if (window.isVisible()) fail('creation with show enabled')
    for (const method of ['show', 'showInactive', 'focus', 'restore']) {
      window[method] = () => fail(method)
    }
    window.on('show', () => fail('show event'))
    window.on('focus', () => fail('focus event'))
  })
}
