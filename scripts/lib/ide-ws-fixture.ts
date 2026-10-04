/**
 * A minimal in-process IDE selection server, shared by verify-ide-channel.tsx
 * and the channel-level regressions so they all drive the same protocol: an
 * HTTP upgrade answer, masked client text-frame decoding, unmasked server text
 * frames. On `ide/hello` with the right token it acks (protocol 2, the given
 * workspace folders) and pushes one selection (`src/a.ts` lines 2–4 with the
 * buffer text `fa.ts\nfb.ts\nfc.ts`), then, unless `clearSelectionAfterMs` is
 * null, an empty one 50 ms later.
 *
 * Import from TypeScript scripts run with `node --import tsx/esm`.
 */
import { createHash } from 'node:crypto'
import { createServer, type IncomingMessage } from 'node:http'
import type { Socket } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'

const sleep = async (ms: number): Promise<void> => { await delay(ms) }

// ── 最小 RFC6455 服务端 fixture（仅够本验证：upgrade 应答 + 掩码文本帧解码 +
//    非掩码文本帧编码；close 帧直接断开，其余非文本帧忽略）────────────────────
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

export type WsFixture = {
  port: number
  helloPromise: Promise<{ token: string }>
  close: () => void
}

/** 解析一帧客户端帧（RFC6455：客户端帧必带掩码）；数据不足返回 null。 */
function decodeClientFrame(buf: Buffer): { opcode: number; payload: Buffer; rest: Buffer } | null {
  if (buf.length < 2) return null
  const opcode = buf[0] & 0x0f
  const masked = (buf[1] & 0x80) !== 0
  let len = buf[1] & 0x7f
  let offset = 2
  if (len === 126) {
    if (buf.length < 4) return null
    len = buf.readUInt16BE(2)
    offset = 4
  } else if (len === 127) {
    if (buf.length < 10) return null
    len = Number(buf.readBigUInt64BE(2))
    offset = 10
  }
  // 1 MiB 上限：fixture 只服务本验证的握手帧，超长帧视为畸形直接拒绝。
  if (len > 1024 * 1024) return null
  let maskKey: Buffer | null = null
  if (masked) {
    if (buf.length < offset + 4) return null
    maskKey = buf.subarray(offset, offset + 4)
    offset += 4
  }
  if (buf.length < offset + len) return null
  let payload = buf.subarray(offset, offset + len)
  if (maskKey !== null) {
    const unmasked = Buffer.allocUnsafe(len)
    for (let i = 0; i < len; i++) unmasked[i] = payload[i] ^ maskKey[i % 4]
    payload = unmasked
  }
  return { opcode, payload, rest: buf.subarray(offset + len) }
}

/** 编码一帧服务端文本帧（服务端帧不掩码）。 */
function encodeTextFrame(text: string): Buffer {
  const payload = Buffer.from(text, 'utf8')
  const len = payload.length
  if (len < 126) return Buffer.concat([Buffer.from([0x81, len]), payload])
  if (len < 65536) {
    const header = Buffer.alloc(4)
    header[0] = 0x81
    header[1] = 126
    header.writeUInt16BE(len, 2)
    return Buffer.concat([header, payload])
  }
  const header = Buffer.alloc(10)
  header[0] = 0x81
  header[1] = 127
  header.writeBigUInt64BE(BigInt(len), 2)
  return Buffer.concat([header, payload])
}

export function startWsFixture(
  token: string,
  workspaceFolders: string[] = ['/fixture-ws'],
  options: { clearSelectionAfterMs?: number | null } = {},
): Promise<WsFixture> {
  return new Promise(resolveFixture => {
    let socketRef: Socket | null = null
    let buffer = Buffer.alloc(0)
    let helloResolve!: (value: { token: string }) => void
    const helloPromise = new Promise<{ token: string }>(resolve => { helloResolve = resolve })

    const sendSelection = (isEmpty: boolean) => {
      const socket = socketRef
      if (socket === null || socket.destroyed) return
      socket.write(encodeTextFrame(JSON.stringify({
        method: 'selection_changed',
        params: {
          path: 'src/a.ts',
          startLine: 2,
          endLine: 4,
          isEmpty,
          // Protocol 2: the editor buffer's own text (3 selected lines),
          // deliberately different from any on-disk fixture so a test can
          // prove the attach path used the pushed text, not a disk read.
          text: isEmpty ? '' : 'fa.ts\nfb.ts\nfc.ts',
          documentVersion: 7,
        },
      })))
    }

    const server = createServer()
    server.on('upgrade', (req: IncomingMessage, socket: Socket) => {
      const key = String(req.headers['sec-websocket-key'] ?? '')
      const accept = createHash('sha1').update(key + WS_GUID).digest('base64')
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n'
        + 'Upgrade: websocket\r\n'
        + 'Connection: Upgrade\r\n'
        + 'Sec-WebSocket-Accept: ' + accept + '\r\n'
        + '\r\n',
      )
      socketRef = socket
      // A client that drops the link (stop/rebind) resets the socket; that is
      // the client's business, not a fixture crash.
      socket.on('error', () => { socket.destroy() })
      socket.on('data', chunk => {
        buffer = Buffer.concat([buffer, chunk])
        for (;;) {
          const frame = decodeClientFrame(buffer)
          if (frame === null) break
          buffer = frame.rest
          if (frame.opcode === 0x8) { socket.destroy(); return } // close 帧 → 直接断开
          if (frame.opcode !== 0x1) continue // 只关心文本帧
          let msg: unknown
          try {
            msg = JSON.parse(frame.payload.toString('utf8'))
          } catch {
            continue
          }
          const record = msg !== null && typeof msg === 'object' ? msg as Record<string, unknown> : null
          if (record?.method !== 'ide/hello') continue
          const params = record.params !== null && typeof record.params === 'object'
            ? record.params as Record<string, unknown>
            : null
          const received = typeof params?.token === 'string' ? params.token : ''
          helloResolve({ token: received })
          // Protocol 2 server semantics: a wrong token gets no ack, the
          // socket is dropped (mirrors the extension's IdeServer).
          if (received !== token) {
            socket.destroy()
            return
          }
          socket.write(encodeTextFrame(JSON.stringify({
            method: 'ide/hello_ack',
            params: { protocolVersion: 2, workspaceFolders },
          })))
          // 握手完成后推一条非空选区，稍后再推一条空选区（验证清空路径）。
          // clearSelectionAfterMs: null = 永不推空（该夹具的选区在 stop 前恒有
          // 值，供「stop 清空缓存」这类断言做无时间窗的前置条件）。
          sendSelection(false)
          const clearAfter = options.clearSelectionAfterMs === undefined ? 50 : options.clearSelectionAfterMs
          if (clearAfter !== null) {
            void sleep(clearAfter).then(() => sendSelection(true)) // 固定窗:pacing 空选区第二条推送的间隔，无状态锚点可 settle
          }
        }
      })
    })
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = address !== null && typeof address === 'object' ? address.port : 0
      resolveFixture({
        port,
        helloPromise,
        close: () => {
          socketRef?.destroy()
          server.close()
        },
      })
    })
  })
}
