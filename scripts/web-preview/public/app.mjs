const status = document.querySelector('#status')
const errorPanel = document.querySelector('#error-panel')
const liveButtons = ['run', 'theme', 'help'].map(id => document.getElementById(id))
const fit = new FitAddon.FitAddon()
export const terminal = new Terminal({
  fontFamily: '"Cascadia Code", "Cascadia Mono", Consolas, monospace',
  fontSize: 12,
  lineHeight: 1.15,
  cursorBlink: true,
  scrollback: 2000,
  allowProposedApi: false,
  theme: { background: '#101114', foreground: '#d7dce2', cursor: '#c2d5f5', selectionBackground: '#405675' },
})
terminal.loadAddon(fit)
terminal.open(document.getElementById('terminal'))
lucide.createIcons()
let socket
let ready = false
let pendingResize
const decoder = new TextDecoder()

function state(text, kind) {
  status.textContent = text
  status.dataset.state = kind
  ready = kind === 'ready'
  for (const button of liveButtons) button.disabled = !ready
}
function send(message) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message))
}
function resize() {
  const size = fit.proposeDimensions()
  if (!size) return
  const cols = Math.min(240, Math.max(30, size.cols))
  const rows = Math.min(90, Math.max(10, size.rows))
  terminal.resize(cols, rows)
  document.getElementById('size').textContent = `${cols} x ${rows}`
  send({ type: 'resize', cols, rows })
}
function connect() {
  if (socket) { socket.onclose = null; socket.close() }
  terminal.reset()
  errorPanel.hidden = true
  state('Connecting', 'connecting')
  socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/terminal`)
  const connection = socket
  socket.binaryType = 'arraybuffer'
  socket.onmessage = event => {
    if (connection !== socket) return
    if (event.data instanceof ArrayBuffer) { terminal.write(decoder.decode(event.data, { stream: true })); return }
    const message = JSON.parse(event.data)
    if (message.type === 'size-request') resize()
    if (message.type === 'ready') { state('Live', 'ready'); terminal.focus() }
    if (message.type === 'ended') {
      state(message.error ? 'Error' : 'Ended', message.error ? 'error' : 'ended')
      if (message.error) {
        errorPanel.hidden = false
        document.querySelector('#error').textContent = message.error
      }
    }
  }
  socket.onerror = () => state('Connection error', 'error')
  socket.onclose = () => {
    if (status.dataset.state !== 'error') state('Disconnected', 'ended')
  }
}
terminal.onData(data => { if (ready) send({ type: 'input', data }) })
function command(value) {
  if (!ready) return
  const connection = socket
  // The real input parser sees text first, then Enter after React has applied it.
  send({ type: 'input', data: `\x15${value}` })
  setTimeout(() => { if (ready && connection === socket) send({ type: 'input', data: '\r' }) }, 100)
  terminal.focus()
}
document.getElementById('run').onclick = () => command('Show me this example project')
document.getElementById('theme').onclick = () => command('/theme')
document.getElementById('help').onclick = () => command('/help')
document.getElementById('reset').onclick = connect
document.getElementById('fullscreen').onclick = async () => {
  if (document.fullscreenElement) await document.exitFullscreen()
  else await document.documentElement.requestFullscreen()
}
new ResizeObserver(() => {
  clearTimeout(pendingResize)
  pendingResize = setTimeout(resize, 80)
}).observe(document.getElementById('terminal'))
window.addEventListener('beforeunload', () => socket?.close())
resize()
connect()
