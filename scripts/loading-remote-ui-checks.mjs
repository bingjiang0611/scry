// Remote project and directory pickers keep their loading guard while browsing.
export async function exerciseRemotePicker({ read, wait, check, click, screenshot }) {
await read("window.loadingFixture.configure(400); window.loadingFixture.remote('projects')")
await wait("document.querySelector('#loading-projects .loading-status')")
check(!await read("document.querySelector('#loading-projects').textContent.includes('这台主机还没有项目')"), 'remote pending catalog became empty')
await wait("document.querySelector('#loading-projects .location-project-list')")
await screenshot('remote-projects')
await read('window.loadingFixture.closeRemote()')
await read("window.loadingFixture.configure(400); window.loadingFixture.remote('directory')")
await wait("document.querySelector('.remote-directory-modal .skeleton-rows[role=\"status\"]')")
check(await read("document.querySelector('.remote-directory-body').getAttribute('aria-busy')==='true' && document.querySelector('.remote-directory-actions .btn.primary').disabled"), 'directory browsing delayed its authority guard')
await wait("document.querySelector('[data-remote-directory=\"/remote/child\"]')")
await click('[data-remote-directory="/remote/child"]')
await wait("document.querySelector('.remote-directory-modal .skeleton-rows[role=\"status\"]')")
await wait("document.querySelector('.remote-directory-path input').value==='/remote/child' && !document.querySelector('.remote-directory-modal .skeleton-rows[role=\"status\"]')")
await screenshot('remote-directory')
await read('window.loadingFixture.closeRemote()')
  return ['remote-projects', 'remote-directory-navigation']
}
