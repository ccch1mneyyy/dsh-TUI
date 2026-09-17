import { createServer } from 'node:http'
import { readFile, mkdtemp, rm, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { WebSocketServer, WebSocket } from 'ws'

const directory = dirname(fileURLToPath(import.meta.url))
const root = resolve(directory, '../..')
const require = createRequire(import.meta.url)
const asset = (path, type) => ({ path, type })
const assets = new Map([
  ['/', asset(join(directory, 'public/index.html'), 'text/html; charset=utf-8')],
  ['/app.mjs', asset(join(directory, 'public/app.mjs'), 'text/javascript; charset=utf-8')],
  ['/style.css', asset(join(directory, 'public/style.css'), 'text/css; charset=utf-8')],
  ['/logo.svg', asset(join(root, 'docs/assets/logo.svg'), 'image/svg+xml')],
  ['/xterm.js', asset(require.resolve('@xterm/xterm'), 'text/javascript')],
  ['/xterm.css', asset(join(dirname(require.resolve('@xterm/xterm')), '../css/xterm.css'), 'text/css')],
  ['/fit.js', asset(require.resolve('@xterm/addon-fit'), 'text/javascript')],
  ['/icons.js', asset(join(dirname(require.resolve('lucide')), '../umd/lucide.js'), 'text/javascript')],
])

export function parseMessage(raw) {
  const message = JSON.parse(raw)
  if (message?.type === 'input' && typeof message.data === 'string' && message.data.length <= 4096) return message
  if (message?.type === 'resize' && Number.isInteger(message.cols) && Number.isInteger(message.rows)
    && message.cols >= 30 && message.cols <= 240 && message.rows >= 10 && message.rows <= 90) return message
  throw new Error('Invalid terminal message')
}

/** Loopback-only preview, not a remotely hosted shell or production DSH server. */
export async function startPreview({ port = 4173 } = {}) {
  await access(join(root, 'lib/types/screens/Chat.js'))
  const token = randomBytes(32).toString('hex')
  const sessions = new Set()
  const cleanupTasks = new Set()
  let actualPort
  const validHost = host => host === `127.0.0.1:${actualPort}` || host === `localhost:${actualPort}`
  const validOrigin = req => req.headers.origin === `http://${req.headers.host}`
  const authenticated = req => req.headers.cookie?.split(';').some(part => part.trim() === `preview=${token}`)
  const server = createServer(async (req, res) => {
    if (!validHost(req.headers.host) || req.method !== 'GET') { res.writeHead(403).end(); return }
    const route = new URL(req.url, `http://${req.headers.host}`).pathname
    const file = assets.get(route)
    if (!file) { res.writeHead(404).end(); return }
    try {
      const bytes = await readFile(file.path)
      res.writeHead(200, {
        'Content-Type': file.type,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'",
        ...(route === '/' ? { 'Set-Cookie': `preview=${token}; HttpOnly; SameSite=Strict; Path=/` } : {}),
      }).end(bytes)
    } catch (error) { res.writeHead(500).end('Preview asset unavailable'); console.error(error) }
  })
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 16384, perMessageDeflate: false })
  server.on('upgrade', (req, socket, head) => {
    if (req.url !== '/terminal' || !validHost(req.headers.host) || !validOrigin(req) || !authenticated(req) || sessions.size >= 4) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
      return
    }
    sockets.handleUpgrade(req, socket, head, ws => sockets.emit('connection', ws))
  })
  sockets.on('connection', ws => {
    const session = { ws, child: undefined }
    sessions.add(session)
    const task = (async () => {
      const prefix = resolve(tmpdir(), 'dsh-tui-web-preview-')
      const home = await mkdtemp(prefix)
      if (!home.startsWith(prefix)) throw new Error('Unexpected preview directory')
      if (ws.readyState !== WebSocket.OPEN) { await rm(home, { recursive: true }); return }
      const env = {
        HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home,
        TMPDIR: home, TMP: home, TEMP: home,
        DSH_HOME: join(home, '.dsh'), DSH_TUI_LANG: 'zh',
        FORCE_COLOR: '3', TERM: 'xterm-256color', LANG: 'en_US.UTF-8',
        DSH_TUI_DISABLE_TERMINAL_IMAGES: '1',
        ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      }
      // Credentials and user configuration are not inherited. No subprocess,
      // worker or addon permissions are granted to the demo runtime.
      const child = spawn(process.execPath, [
        '--permission', `--allow-fs-read=${root}`, `--allow-fs-read=${home}`,
        `--allow-fs-write=${home}`, '--disable-warning=ExperimentalWarning',
        join(directory, 'runtime.mjs'),
      ], { cwd: home, env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true })
      session.child = child
      let diagnostic = ''
      let frames = 0
      let ready = false
      const bootTimer = setTimeout(() => { diagnostic = 'Preview startup timed out'; child.kill() }, 20000)
      ws.on('message', raw => {
        if (++frames > 500) { ws.close(1008, 'Input rate limit'); return }
        try {
          const message = parseMessage(raw.toString())
          if (message.type === 'input' && !ready) return
          if (child.connected) child.send(message)
        } catch { ws.close(1008, 'Invalid terminal message') }
      })
      const rateTimer = setInterval(() => { frames = 0 }, 1000)
      const lifetimeTimer = setTimeout(() => ws.close(1000, 'Demo session expired'), 30 * 60 * 1000)
      ws.on('close', () => child.kill())
      ws.on('error', () => child.kill())
      child.stdout.on('data', data => {
        if (ws.readyState !== WebSocket.OPEN) return
        if (ws.bufferedAmount > 2 * 1024 * 1024) { ws.close(1008, 'Slow client'); return }
        ws.send(data, { binary: true })
      })
      child.stderr.on('data', data => { diagnostic = (diagnostic + data.toString()).slice(-8000) })
      child.on('message', message => {
        if (message.type === 'ready') { ready = true; clearTimeout(bootTimer) }
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message))
      })
      // Ask for dimensions only after the child and message listener exist.
      ws.send(JSON.stringify({ type: 'size-request' }))
      await new Promise(resolveExit => {
        child.once('error', error => { diagnostic = error.message; resolveExit() })
        child.once('exit', resolveExit)
      })
      clearTimeout(bootTimer)
      clearTimeout(lifetimeTimer)
      clearInterval(rateTimer)
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'ended', error: diagnostic || undefined }))
        ws.close(1000)
      }
      await rm(home, { recursive: true, force: true })
    })().catch(error => {
      console.error(error)
      ws.close(1011, 'Preview runtime failed')
    }).finally(() => { sessions.delete(session); cleanupTasks.delete(task) })
    cleanupTasks.add(task)
  })
  await new Promise((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', resolveListen)
  })
  actualPort = server.address().port
  return {
    url: `http://127.0.0.1:${actualPort}`,
    sessions,
    async close() {
      for (const { ws, child } of sessions) { ws.terminate(); child?.kill() }
      await Promise.all(cleanupTasks)
      sockets.close()
      await new Promise(resolveClose => server.close(resolveClose))
    },
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const port = Number(process.env.DSH_TUI_PREVIEW_PORT ?? 4173)
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid preview port')
  const preview = await startPreview({ port })
  console.log(`dsh-TUI live demo: ${preview.url}`)
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => void preview.close().then(() => process.exit(0)))
}
