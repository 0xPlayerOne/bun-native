const phase = new URL(location.href).searchParams.get('phase')
if (phase === 'reload') {
  // One fixture-owned native page action. No evaluation or input test endpoint.
  void fetch('/reload-command', { cache: 'no-store' })
    .then((response) => response.text())
    .then((action) => {
      if (action === 'reload') location.reload()
    })
}
const label = document.querySelector('#status')
if (label) label.textContent = `Ready: ${phase ?? 'initial'}`
console.info('BUNLY_DOWNLOAD_PAGE_READY:' + (phase ?? 'initial'))

export {}
