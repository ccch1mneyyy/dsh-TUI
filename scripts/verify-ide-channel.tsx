/**
 * verify-ide-channel — AC-4 回归（IDE 选区通道，src/dsh-adapter/ide-channel.ts）。
 * 三层覆盖：
 *   1. 纯函数：envDirect（env 直连解析）、ideLockDir、pickLockCandidates
 *      （lock 目录扫描与 workspaceFolders 归一化排序）、parseSelectionChanged
 *      （selection_changed 通知坐标校验）；
 *   2. 无 IDE 降级：空 env + 不存在的 lock 目录 → 不抛错、connected=false、
 *      在连接预算内静默完成；
 *   3. loopback 对连：本脚本内起一个最小 RFC6455 服务端（http upgrade 应答
 *      + 单帧文本编解码），验证原生 WebSocket 客户端的 ide/hello 握手与
 *      selection_changed 到达 listener——分别走 env 直连与 lock 发现两条路径。
 *   4. 选区消费注入（T05 · AC-5 前半）：buildSelectionBlock 纯函数的正常切片 /
 *      坐标越界钳制 / 过期选区跳过断言，外加 loopback 收到的真实快照端到端
 *      构造 <attached-file … selection> 块、isEmpty 清空后守卫不产块。
 *
 * lock fixture 一律 mkdtempSync 临时目录，绝不写真实 ~/.dsh-tui（隔离策略，
 * DESIGN §7）。运行：node --import tsx/esm scripts/verify-ide-channel.tsx
 */
process.env.DSH_TUI_LANG = 'zh'

import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { Socket } from 'node:net'

const sleep = async (ms: number) => { await delay(ms) }

let failures = 0
const results: string[] = []
const check = (name: string, ok: boolean) => {
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
  if (!ok) failures++
}

async function waitFor(ready: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (ready()) return true
    await sleep(20) // 固定窗:pacing 20ms 轮询采样间隔，等待的是外部 fixture 推送无本地锚点可 settle
  }
  return ready()
}

// ── 最小 RFC6455 服务端 fixture（仅够本验证：upgrade 应答 + 掩码文本帧解码 +
//    非掩码文本帧编码；close 帧直接断开，其余非文本帧忽略）────────────────────
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

type WsFixture = {
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

function startWsFixture(
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
          // Protocol 2: the editor buffer's own text — 3 selected lines here,
          // deliberately DIFFERENT from any on-disk fixture so a test can
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
          // Protocol 2 server semantics: a wrong token gets NO ack — the
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

async function main(): Promise<void> {
  const mod = await import('../src/dsh-adapter/ide-channel.js')
  type Snapshot = NonNullable<ReturnType<typeof mod.parseSelectionChanged>>

  // 选区块构造断言共用的五行内容（与 mentions 验证脚本同款形态）。
  const FIVE_LINE_CONTENT = 'line1\nline2\nline3\nline4\nline5\n'

  const tmpRoot = mkdtempSync(join(tmpdir(), 'verify-ide-channel-'))

  // ── 1. envDirect：env 直连解析 ────────────────────────────────────────────
  const directFull = mod.envDirect({ DSH_TUI_IDE_PORT: '41234', DSH_TUI_IDE_TOKEN: 'tok' })
  check('envDirect: 完整 env → {port:41234, token:"tok"}',
    directFull !== undefined && directFull.port === 41234 && directFull.token === 'tok')
  check('envDirect: 空 env → undefined', mod.envDirect({}) === undefined)
  check('envDirect: 缺 token → undefined', mod.envDirect({ DSH_TUI_IDE_PORT: '41234' }) === undefined)
  check('envDirect: 非数字端口 → undefined',
    mod.envDirect({ DSH_TUI_IDE_PORT: 'abc', DSH_TUI_IDE_TOKEN: 'tok' }) === undefined)
  check('envDirect: 端口越界(0) → undefined',
    mod.envDirect({ DSH_TUI_IDE_PORT: '0', DSH_TUI_IDE_TOKEN: 'tok' }) === undefined)
  check('envDirect: 端口越界(70000) → undefined',
    mod.envDirect({ DSH_TUI_IDE_PORT: '70000', DSH_TUI_IDE_TOKEN: 'tok' }) === undefined)
  check('envDirect: 小数端口 → undefined',
    mod.envDirect({ DSH_TUI_IDE_PORT: '123.5', DSH_TUI_IDE_TOKEN: 'tok' }) === undefined)

  // ── 2. ideLockDir ─────────────────────────────────────────────────────────
  check('ideLockDir: 默认落在 DATA_DIR/ide', mod.ideLockDir().endsWith(join('.dsh-tui', 'ide')))
  check('ideLockDir: 可注入自定义 dataDir',
    mod.ideLockDir(join(tmpRoot, 'data')) === join(tmpRoot, 'data', 'ide'))

  // ── 3. pickLockCandidates：workspaceFolders 归一化匹配排序 ─────────────────
  const lockDir = join(tmpRoot, 'locks')
  rmSync(lockDir, { force: true, recursive: true })
  mkdirSync(lockDir, { recursive: true })
  writeFileSync(join(lockDir, '41111.lock'),
    JSON.stringify({ port: 41111, token: 't-a', workspaceFolders: ['/repo/a'], pid: process.pid }))
  writeFileSync(join(lockDir, '42222.lock'),
    JSON.stringify({ port: 42222, token: 't-other', workspaceFolders: ['/other'], pid: process.pid }))
  writeFileSync(join(lockDir, '43333.lock'), '{ broken json !!!')
  const picked = mod.pickLockCandidates(lockDir, '/repo/a', process.pid)
  check('pickLockCandidates: 坏 JSON lock 被跳过（不出现在候选中）',
    picked.length === 1 && picked[0]?.token === 't-a')
  check('pickLockCandidates: workspace 匹配者入选', picked[0]?.token === 't-a')
  check('pickLockCandidates: 不匹配 workspace 的 lock 不再是候选（维护者复审 #3：否则会连上别的窗口）',
    !picked.some(c => c.token === 't-other'))
  check('pickLockCandidates: 不存在的 lock 目录 → 空数组（不抛错）',
    JSON.stringify(mod.pickLockCandidates(join(tmpRoot, 'no-such-dir'), '/', process.pid)) === '[]')

  // Windows 归一化：扩展写 fsPath 风格（反斜杠 + 大盘符），会话 cwd 是小写正斜杠
  writeFileSync(join(lockDir, '44444.lock'),
    JSON.stringify({ port: 44444, token: 't-win', workspaceFolders: ['C:\\Repo\\A'], pid: process.pid }))
  // platformCaseInsensitive() 只在 win32/darwin 开启：这条断言锁的是 Windows
  // 扩展行为，其他平台直接 SKIP（照 verify-cli-subcommands 的平台守卫先例），
  // 否则 Linux 上常红（该脚本未入 CI，作者在 Windows 本机验证）。
  if (process.platform === 'win32') {
    const pickedWin = mod.pickLockCandidates(lockDir, 'c:/repo/a/sub/dir', process.pid)
    check('pickLockCandidates: Windows 反斜杠+盘符大小写归一化后匹配且排第一',
      pickedWin[0]?.token === 't-win')
  } else {
    check('pickLockCandidates: Windows 归一化断言（非 win32 平台 SKIP）', true)
  }
  const posixStillFirst = mod.pickLockCandidates(lockDir, '/repo/a', process.pid)
  check('pickLockCandidates: 原 POSIX 匹配顺序不受 Windows lock 干扰',
    posixStillFirst[0]?.token === 't-a')

  // 陈旧 pid 过滤（维护者复审 #1）：锁文件里记录的扩展进程已退出 → 该锁
  // 不再存活，不得参与发现（否则死锁能抢占并拿到 token 握手）。
  writeFileSync(join(lockDir, '49999.lock'),
    JSON.stringify({ port: 49999, token: 't-stale', workspaceFolders: ['/repo/a'], pid: 2147483647 }))
  const pickedStale = mod.pickLockCandidates(lockDir, '/repo/a', process.pid)
  check('pickLockCandidates: 陈旧 pid 锁被跳过（仅活锁参与发现）',
    pickedStale.every(c => c.token !== 't-stale'))

  // 前缀边界（coderabbit review）：/repo/a 声明不得匹配会话 cwd
  // `/repo/abc`——会连错窗口把别的 workspace 的选区附到这里。
  // 隔离目录 + 名字典序对比：都是不匹配锁时文件名小的（40401）排前；
  // 若 45555(/repo/a) 被误判匹配，就会越到 40401 前。
  const boundaryDir = join(tmpRoot, 'locks-boundary')
  rmSync(boundaryDir, { force: true, recursive: true })
  mkdirSync(boundaryDir, { recursive: true })
  writeFileSync(join(boundaryDir, '40401.lock'),
    JSON.stringify({ port: 40401, token: 't-z-z', workspaceFolders: ['/other2'], pid: process.pid }))
  writeFileSync(join(boundaryDir, '45555.lock'),
    JSON.stringify({ port: 45555, token: 't-sub', workspaceFolders: ['/repo/a'], pid: process.pid }))
  const pickedBoundary = mod.pickLockCandidates(boundaryDir, '/repo/abc', process.pid)
  check('pickLockCandidates: /repo/a 声明不匹配 /repo/abc 会话（前缀边界 + 无匹配即无候选）',
    pickedBoundary.length === 0)
  check('pickLockCandidates: 精确等于 workspace 根仍匹配', (() => {
    const computed = mod.pickLockCandidates(boundaryDir, '/repo/a', process.pid)
    return computed.length === 1 && computed[0]?.token === 't-sub'
  })())

  // stop 阻断在途拨号（维护者复审 #2）：stop() 必须递增 generation 并清空
  // pending/socket —— 否则 connecting 阶段的拨号会在 onopen 时把已停的通道
  // 复活。generation 单调性 + pending/socket 清空从机制上锁死「stop 后不复活」。
  {
    const stopCh = new mod.IdeChannel() as unknown as {
      generation: number
      socket: unknown
      pendingSocket: unknown
      stop(): void
      connected: boolean
    }
    const g0 = stopCh.generation
    stopCh.stop()
    check('stop·阻断：stop 递增 generation（在途拨号一律作废）', stopCh.generation === g0 + 1)
    check('stop·阻断：stop 清空 socket 与 pendingSocket', stopCh.socket === null && stopCh.pendingSocket === null)
  }

  // ── 4. parseSelectionChanged：通知解析与坐标校验 ───────────────────────────
  const good = mod.parseSelectionChanged({
    method: 'selection_changed',
    params: { path: 'a.ts', startLine: 2, endLine: 4, isEmpty: false },
  })
  check('parseSelectionChanged: 合法通知 → 坐标快照',
    good !== undefined && good.path === 'a.ts' && good.startLine === 2
    && good.endLine === 4 && good.isEmpty === false)
  check('parseSelectionChanged: 非 selection_changed 方法 → undefined',
    mod.parseSelectionChanged({ method: 'other', params: {} }) === undefined)
  check('parseSelectionChanged: 缺字段（无 endLine）→ undefined',
    mod.parseSelectionChanged({ method: 'selection_changed', params: { path: 'a.ts', startLine: 1, isEmpty: false } }) === undefined)
  check('parseSelectionChanged: 缺 params → undefined',
    mod.parseSelectionChanged({ method: 'selection_changed' }) === undefined)
  check('parseSelectionChanged: 非 object 输入 → undefined',
    mod.parseSelectionChanged('nope') === undefined)
  check('parseSelectionChanged: endLine < startLine → undefined',
    mod.parseSelectionChanged({ method: 'selection_changed', params: { path: 'a.ts', startLine: 4, endLine: 2, isEmpty: false } }) === undefined)
  check('parseSelectionChanged: 负 startLine → undefined',
    mod.parseSelectionChanged({ method: 'selection_changed', params: { path: 'a.ts', startLine: -1, endLine: 0, isEmpty: false } }) === undefined)
  check('parseSelectionChanged: 空 path → undefined',
    mod.parseSelectionChanged({ method: 'selection_changed', params: { path: '', startLine: 0, endLine: 0, isEmpty: false } }) === undefined)

  // ── 4b. parseHelloAck（协议 v2 握手 ACK）+ selection_changed 的 v2 可选字段 ──
  {
    const ack = mod.parseHelloAck({
      method: 'ide/hello_ack',
      params: { protocolVersion: 2, workspaceFolders: ['/repo/a', '/repo/b'] },
    })
    check('parseHelloAck: 合法 v2 ACK → 版本 + workspaceFolders',
      ack !== undefined && ack.protocolVersion === 2
      && JSON.stringify(ack.workspaceFolders) === '["/repo/a","/repo/b"]')
    check('parseHelloAck: 非 hello_ack 方法 → undefined',
      mod.parseHelloAck({ method: 'selection_changed', params: {} }) === undefined)
    check('parseHelloAck: 版本不匹配（3）→ undefined（两端同步发布，异版本即异服务）',
      mod.parseHelloAck({ method: 'ide/hello_ack', params: { protocolVersion: 3, workspaceFolders: [] } }) === undefined)
    check('parseHelloAck: 版本缺失/非整数 → undefined',
      mod.parseHelloAck({ method: 'ide/hello_ack', params: { workspaceFolders: [] } }) === undefined
      && mod.parseHelloAck({ method: 'ide/hello_ack', params: { protocolVersion: 2.5, workspaceFolders: [] } }) === undefined)
    check('parseHelloAck: workspaceFolders 缺失/非字符串数组 → undefined',
      mod.parseHelloAck({ method: 'ide/hello_ack', params: { protocolVersion: 2 } }) === undefined
      && mod.parseHelloAck({ method: 'ide/hello_ack', params: { protocolVersion: 2, workspaceFolders: ['/a', 3] } }) === undefined)
    check('parseHelloAck: 缺 params / 非 object → undefined',
      mod.parseHelloAck({ method: 'ide/hello_ack' }) === undefined
      && mod.parseHelloAck('nope') === undefined)

    const v2 = mod.parseSelectionChanged({
      method: 'selection_changed',
      params: { path: 'a.ts', startLine: 0, endLine: 2, isEmpty: false, text: 'l1\nl2\nl3', documentVersion: 9 },
    })
    check('parseSelectionChanged: v2 text/documentVersion 透传',
      v2 !== undefined && v2.text === 'l1\nl2\nl3' && v2.documentVersion === 9)
    const v1 = mod.parseSelectionChanged({
      method: 'selection_changed',
      params: { path: 'a.ts', startLine: 0, endLine: 2, isEmpty: false },
    })
    check('parseSelectionChanged: v1 推送（无 text 字段）仍合法且不带 text',
      v1 !== undefined && v1.text === undefined && v1.documentVersion === undefined)
    const badText = mod.parseSelectionChanged({
      method: 'selection_changed',
      params: { path: 'a.ts', startLine: 0, endLine: 2, isEmpty: false, text: 42, documentVersion: 'x' },
    })
    check('parseSelectionChanged: 类型不合法的 text/documentVersion 被丢弃（坐标仍有效）',
      badText !== undefined && badText.text === undefined && badText.documentVersion === undefined)
  }

  // ── 5. 无 IDE 场景：静默降级 ───────────────────────────────────────────────
  const degraded = new mod.IdeChannel()
  let degradedThrew: unknown
  const degradedStartAt = Date.now()
  try {
    await degraded.start({}, join(tmpRoot, 'no-such-locks'), '/nonexistent-cwd')
  } catch (error) {
    degradedThrew = error
  }
  const degradedElapsed = Date.now() - degradedStartAt
  check('无 IDE：start 不抛错', degradedThrew === undefined)
  check('无 IDE：connected=false', degraded.connected === false)
  check('无 IDE：selection 为 undefined', degraded.selection === undefined)
  check('无 IDE：在连接预算内静默完成（<2s）', degradedElapsed < 2000)

  // ── 5b. 断线清残留选区（复审修复）：degrade 必须清 current 并广播 isEmpty，
  // 否则徽标与提交自动附加会继续使用失联前的旧选区。
  {
    const ch = new mod.IdeChannel() as unknown as {
      current?: Snapshot
      socket: unknown
      listeners: Set<(s: Snapshot) => void>
      degradeToDisconnected(socket: unknown): void
      onSelection(cb: (s: Snapshot) => void): () => void
    }
    ch.current = { path: 'stale.ts', startLine: 3, endLine: 5, isEmpty: false }
    const fakeSocket = {}
    ch.socket = fakeSocket
    const seen: Snapshot[] = []
    ch.onSelection(s => seen.push(s))
    ch.degradeToDisconnected(fakeSocket)
    check('断线：current 清空', ch.current === undefined)
    check('断线：广播 isEmpty 快照', seen.length === 1 && seen[0]?.isEmpty === true && seen[0]?.path === 'stale.ts')
    // 陈旧 socket 的二次回调不得再次广播（generation 守卫由 socket 身份比较承担）
    ch.degradeToDisconnected({})
    check('断线：陈旧 socket 回调不再广播', seen.length === 1)
  }

  // ── 6. loopback 对连 · env 直连路径 ────────────────────────────────────────
  const envFixture = await startWsFixture('tok-env')
  let seenLive: Snapshot[] = []
  let liveCleared = false
  {
    const channel = new mod.IdeChannel()
    const seen: Snapshot[] = []
    channel.onSelection(snapshot => seen.push(snapshot))
    await channel.start(
      { DSH_TUI_IDE_PORT: String(envFixture.port), DSH_TUI_IDE_TOKEN: 'tok-env' },
      join(tmpRoot, 'unused-locks'),
      '/somewhere',
    )
    check('loopback·env 直连：ide/hello 携带正确 token 到达服务端',
      (await envFixture.helloPromise).token === 'tok-env')
    check('loopback·env 直连：hello_ack 后才算 connected（协议 v2）', channel.connected)
    check('loopback·env 直连：ACK 的 workspaceFolders 可查询',
      JSON.stringify(channel.workspaceFolders) === '["/fixture-ws"]')
    const gotSelection = await waitFor(() => seen.length >= 1, 2000)
    check('loopback·env 直连：selection_changed 到达 listener',
      gotSelection && seen[0]?.path === 'src/a.ts' && seen[0]?.startLine === 2 && seen[0]?.endLine === 4)
    check('loopback·env 直连：v2 推送携带编辑器缓冲区 text 与 documentVersion',
      gotSelection && seen[0]?.text === 'fa.ts\nfb.ts\nfc.ts' && seen[0]?.documentVersion === 7)
    check('loopback·env 直连：非空选区反映在 selection getter', channel.selection !== undefined)
    const cleared = await waitFor(() => channel.selection === undefined, 2000)
    check('loopback·env 直连：isEmpty=true 清空 selection getter', cleared)
    check('loopback·env 直连：两次通知都到达 listener（含空选区）',
      seen.length === 2 && seen[1]?.isEmpty === true)
    // 留给第 8 节（选区消费注入）：非空快照 + isEmpty 清空事实。
    seenLive = seen.filter(item => !item.isEmpty)
    liveCleared = channel.selection === undefined
    channel.stop()
    check('loopback·env 直连：stop 后 connected=false', channel.connected === false)
  }
  envFixture.close()

  // ── 6b. 错误 token 的候选被放弃 → 继续尝试下一候选（维护者复审 #3）─────
  // env 直连指向一个期望别的 token 的服务端：WS 能升级但收不到
  // hello_ack（服务端直接断开）。客户端不得把「socket 打开」当「已认证」，
  // 必须落到下一候选（这里用 lock 发现路径的 fixture 兜底连上）。
  {
    const wrongTokenFixture = await startWsFixture('tok-right')
    const fallbackFixture = await startWsFixture('tok-lock2')
    const dir = join(tmpRoot, 'wrong-token')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${fallbackFixture.port}.lock`), JSON.stringify({
      port: fallbackFixture.port,
      token: 'tok-lock2',
      workspaceFolders: ['/repo/fallback'],
      pid: process.pid,
    }))
    const channel = new mod.IdeChannel()
    await channel.start(
      { DSH_TUI_IDE_PORT: String(wrongTokenFixture.port), DSH_TUI_IDE_TOKEN: 'tok-wrong' },
      dir,
      '/repo/fallback',
    )
    check('错误 token：错误候选确实收到了 hello（token 不对）',
      (await wrongTokenFixture.helloPromise).token === 'tok-wrong')
    check('错误 token：未被拒候选冒充 connected，而是落到 lock 候选连上',
      channel.connected && (await fallbackFixture.helloPromise).token === 'tok-lock2')
    channel.stop()
    wrongTokenFixture.close()
    fallbackFixture.close()
  }

  // ── 6c. 无 workspace 匹配的 lock 不连接（维护者复审 #3）──────────────────
  // 会话 cwd 不在任何 lock 的 workspaceFolders 下：不得回退去连别的
  // workspace 的 IDE（那会把别的项目的选区附进来），而是静默禁用。
  {
    const foreignFixture = await startWsFixture('tok-foreign')
    const dir = join(tmpRoot, 'no-match')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${foreignFixture.port}.lock`), JSON.stringify({
      port: foreignFixture.port,
      token: 'tok-foreign',
      workspaceFolders: ['/somewhere-else'],
      pid: process.pid,
    }))
    const channel = new mod.IdeChannel()
    let threw: unknown
    try {
      await channel.start({}, dir, '/repo/a')
    } catch (error) {
      threw = error
    }
    check('无匹配：start 不抛错', threw === undefined)
    check('无匹配：connected=false（不连别的 workspace 的 IDE）', channel.connected === false)
    let foreignHello = false
    // 固定窗:pacing 负事件兜底窗口——pickLockCandidates 对不匹配 cwd 同步返回 []，start 在 targets.length===0 处无拨号直接返回，断言本身确定性，400ms 仅防御实现回归
    await Promise.race([foreignFixture.helloPromise.then(() => { foreignHello = true }), sleep(400)])
    check('无匹配：从未向外国 lock 发起 hello', foreignHello === false)
    channel.stop()
    foreignFixture.close()
  }

  // ── 7. loopback 对连 · lock 发现路径（端到端集成 pickLockCandidates）────────
  const lockFixture = await startWsFixture('tok-lock')
  {
    const discoverDir = join(tmpRoot, 'discover')
    mkdirSync(discoverDir, { recursive: true })
    writeFileSync(join(discoverDir, String(lockFixture.port) + '.lock'), JSON.stringify({
      port: lockFixture.port,
      token: 'tok-lock',
      workspaceFolders: [tmpRoot],
      pid: process.pid,
    }))
    const channel = new mod.IdeChannel()
    const seen: Snapshot[] = []
    channel.onSelection(snapshot => seen.push(snapshot))
    await channel.start({}, discoverDir, tmpRoot)
    check('loopback·lock 发现：握手 token 正确（lock 文件端到端）',
      (await lockFixture.helloPromise).token === 'tok-lock')
    check('loopback·lock 发现：connected=true', channel.connected)
    const got = await waitFor(() => seen.length >= 1, 2000)
    check('loopback·lock 发现：selection_changed 到达 listener',
      got && seen[0]?.path === 'src/a.ts' && seen[0]?.startLine === 2 && seen[0]?.endLine === 4)
    channel.stop()

    // ── 7b. rebind：cwd 变更后真正重绑 IDE（维护者复审 #3）─────────────────
    // 会话 cwd 从 /repo/a 切到 /repo/b：旧连接（fixture A）必须被丢弃，
    // 重新按新 cwd 发现并连上 fixture B —— 而不是保留 A 的旧链路。
    const fixtureA = await startWsFixture('tok-a', ['/repo/a'])
    const fixtureB = await startWsFixture('tok-b', ['/repo/b'], { clearSelectionAfterMs: null })
    const rebindDir = join(tmpRoot, 'rebind')
    mkdirSync(rebindDir, { recursive: true })
    writeFileSync(join(rebindDir, `${fixtureA.port}.lock`),
      JSON.stringify({ port: fixtureA.port, token: 'tok-a', workspaceFolders: ['/repo/a'], pid: process.pid }))
    writeFileSync(join(rebindDir, `${fixtureB.port}.lock`),
      JSON.stringify({ port: fixtureB.port, token: 'tok-b', workspaceFolders: ['/repo/b'], pid: process.pid }))
    const rebindCh = new mod.IdeChannel()
    // 非空选区的到达观察走 listener（消息处理里同步触发），配 fixtureB 的
    // clearSelectionAfterMs: null，前置条件与采样时机无关：不会因为 20ms 轮询
    // 落不进夹具那条 50ms 空推送前的窗口而在慢机上假红（终审轮 7）。
    const sawSelection = new Promise<void>(resolve => {
      const off = rebindCh.onSelection(snapshot => {
        if (snapshot.isEmpty) return
        off()
        resolve()
      })
    })
    await rebindCh.start({}, rebindDir, '/repo/a')
    check('rebind：初始按 /repo/a 连上 fixture A',
      rebindCh.connected && (await fixtureA.helloPromise).token === 'tok-a')
    check('rebind：A 的 workspaceFolders 来自 ACK',
      JSON.stringify(rebindCh.workspaceFolders) === '["/repo/a"]')
    await rebindCh.rebind('/repo/b')
    check('rebind：rebind(/repo/b) 后连上 fixture B',
      rebindCh.connected && (await fixtureB.helloPromise).token === 'tok-b')
    check('rebind：重绑后 workspaceFolders 换成 B 的',
      JSON.stringify(rebindCh.workspaceFolders) === '["/repo/b"]')
    // stop() 也必须带走缓存选区与 ACK 的 workspaceFolders（终审轮 6）：直接读
    // channel.selection / .workspaceFolders 的调用方在停止后不得再拿到上一个
    // 窗口的快照——degradeToDisconnected 早已清，stop 曾漏清（rebind 的注释
    // 却已承诺「clearing the live selection」）。
    await sawSelection
    const selectionBeforeStop = rebindCh.selection !== undefined
    const foldersBeforeStop = rebindCh.workspaceFolders !== undefined
    rebindCh.stop()
    check('stop：停止前确有缓存选区与 ACK 目录（前置条件成立）',
      selectionBeforeStop && foldersBeforeStop)
    check('stop：停止后清空缓存选区与 ACK 的 workspaceFolders',
      rebindCh.selection === undefined && rebindCh.workspaceFolders === undefined)
    fixtureA.close()
    fixtureB.close()
  }
  lockFixture.close()

  // ── 8. 选区消费注入（T05 · AC-5 前半）：块构造与钳制 ──────────────────────
  {
    // Block construction moved with the channel split: it now lives in the
    // dedicated ide-selection module, not the channel barrel.
    const selectionMod = await import('../src/dsh-adapter/channel/ide-selection.js')
    const build = (selectionMod as {
      buildSelectionBlock: (
        selection: { path: string; startLine: number; endLine: number; isEmpty: boolean },
        content: string,
      ) => { text: string; lines: number } | undefined
    }).buildSelectionBlock

    // 正常切片：0-based [2,4] → 1-based 第 3~5 行。
    const normal = build({ path: 'src/my file.ts', startLine: 2, endLine: 4, isEmpty: false }, FIVE_LINE_CONTENT)
    check('selectionBlock: 0-based [2,4] 切出第 3~5 行且带 selection 属性',
      normal !== undefined
      && normal.text === '<attached-file path="src/my file.ts" selection count="3">\nline3\nline4\nline5\n</attached-file>'
      && normal.lines === 3)

    // 含空格路径不经文本解析——直接构造必须原样保留。
    const spaced = build({ path: 'my dir/a b.ts', startLine: 0, endLine: 0, isEmpty: false }, FIVE_LINE_CONTENT)
    check('selectionBlock: 含空格路径原样保留（D7 不走文本解析）',
      spaced !== undefined
      && spaced.text.startsWith('<attached-file path="my dir/a b.ts" selection count="1">')
      && spaced.text.includes('\nline1\n</attached-file>'))

    // endLine 超界钳制到实际行数（0-based 99 → 1-based 100 > 5 → 全部剩余行）。
    const clampedEnd = build({ path: 'src/a.ts', startLine: 3, endLine: 99, isEmpty: false }, FIVE_LINE_CONTENT)
    check('selectionBlock: endLine 越界钳制到末行',
      clampedEnd !== undefined
      && clampedEnd.text === '<attached-file path="src/a.ts" selection count="2">\nline4\nline5\n</attached-file>'
      && clampedEnd.lines === 2)

    // startLine 越过 EOF → sliceLines 返回 undefined → 无块（静默跳过）。
    const pastEof = build({ path: 'src/a.ts', startLine: 50, endLine: 60, isEmpty: false }, FIVE_LINE_CONTENT)
    check('selectionBlock: 起行越过 EOF → undefined（静默跳过）', pastEof === undefined)

    // isEmpty 快照守卫：调用侧不会传入，但纯函数自身也拒绝。
    check('selectionBlock: isEmpty=true → undefined',
      build({ path: 'src/a.ts', startLine: 0, endLine: 0, isEmpty: true }, FIVE_LINE_CONTENT) === undefined)

    // 单个空行选区（终审轮 7）：三击一个空行 → 切出的就是一个空串，但那一行
    // 真的存在（徽标也报 1 行）——必须产块，否则 footer 说 1 行而提交什么都不带。
    const blankLine = build({ path: 'src/blank.ts', startLine: 1, endLine: 1, isEmpty: false }, 'L1\n\nL3')
    check('selectionBlock: 单个空行选区仍产块（count="1"、正文为空行）',
      blankLine !== undefined && blankLine.lines === 1
      && blankLine.text === '<attached-file path="src/blank.ts" selection count="1">\n\n</attached-file>')
    // 对照组：真正的空内容（起行越过 EOF 已在上一条）仍不产块，allowEmpty 只对
    // 「恰好一行」开放——多行选区切出空串只可能是越界。
    check('selectionBlock: 越界起行仍不产块（allowEmpty 不放宽越界）',
      build({ path: 'src/a.ts', startLine: 9, endLine: 9, isEmpty: false }, 'L1\nL2') === undefined)

    // loopback 端到端（复审轮 4 修正假绿）：真实快照钉的是「绝对坐标 + 选区
    // 自身 text」的扩展语义；块的构造在 8b 用 attach（text 分支）端到端验证，
    // 这里只钉快照字段——此前用磁盘 FIVE_LINE_CONTENT 重建，掩盖了
    // 「按绝对行号切 text」的 P1。
    const liveSnapshot = seenLive[0]
    check('selectionBlock: loopback 真实快照携带选区自身 text 与坐标',
      liveSnapshot !== undefined
        && liveSnapshot.startLine === 2 && liveSnapshot.endLine === 4
        && liveSnapshot.text === 'fa.ts\nfb.ts\nfc.ts')
    check('selectionBlock: isEmpty 清空后 selection getter 为 undefined（消费守卫不产块）',
      liveCleared)

    // 路径属性转义（coderabbit C-2）：POSIX 合法文件名可含 `"` `&` `<` `>`,
    // 插进 `path="…"` 属性前必须转义,防属性逃逸/标记注入到模型侧块。
    const evil = build({ path: 'a&b"c<d>e.ts', startLine: 0, endLine: 0, isEmpty: false }, 'line1\n')
    check('selectionBlock: 含引号/&/尖括号路径被 HTML 转义（escapeSnippetAttr）',
      evil !== undefined
        && evil.text.startsWith('<attached-file path="a&amp;b&quot;c&lt;d&gt;e.ts" selection count="1">')
        && evil.text.includes('\nline1\n</attached-file>'))
    const plain = build({ path: 'plain.ts', startLine: 0, endLine: 0, isEmpty: false }, 'line1\n')
    check('selectionBlock: 普通路径不转义（行为不变）',
      plain?.text.startsWith('<attached-file path="plain.ts" selection count="1">'))
    // 超大选区须按 @-提及同一策略截断（C-5，coderabbit review）——防撑爆
    // 上下文。构造远超 50k 的切片内容，断言正文被截断并带可见省略标记。
    const huge = ('x'.repeat(200) + '\n').repeat(300) // ~60k 字符，超 50k cap
    const capped = build(
      { path: 'huge.ts', startLine: 0, endLine: huge.split('\n').length - 1, isEmpty: false },
      huge,
    )
    check('selectionBlock: 超大选区按 MENTION_MAX_FILE_CHARS 截断并标记（C-5）',
      capped !== undefined
        && capped.text.includes('[… truncated]')
        && capped.text.length < huge.length + 400)
    const { MENTION_MAX_FILE_CHARS } = await import('../src/dsh-adapter/channel/mentions.js') as {
      MENTION_MAX_FILE_CHARS: number
    }
    check('selectionBlock: 截断后 lines = 模型实收行数（维护者复审 #3，不再报截断前总数）',
      capped !== undefined
        && capped.lines === huge.slice(0, MENTION_MAX_FILE_CHARS).split('\n').length
        && capped.lines < huge.split('\n').length - 1)

    // ── 8b. attachIdeSelection：v2 text 优先、不读盘；v1 才走磁盘 ──────────
    type FsLike = { resolve(p: string): Promise<string>; stat(p: string): Promise<{ type: string }>; readText(p: string): Promise<string> }
    const attach = (selectionMod as {
      attachIdeSelection: (
        blocks: Array<{ type: string; text: string }>,
        cwd: string,
        selection: { path: string; startLine: number; endLine: number; isEmpty: boolean; text?: string },
        fs: FsLike | undefined,
      ) => Promise<{ lines: number; path: string } | undefined>
    }).attachIdeSelection
    {
      let fsTouched = false
      const boobyFs: FsLike = {
        resolve: async () => { fsTouched = true; throw new Error('fs must not be touched') },
        stat: async () => { fsTouched = true; throw new Error('fs must not be touched') },
        readText: async () => { fsTouched = true; throw new Error('fs must not be touched') },
      }
      const blocks: Array<{ type: string; text: string }> = []
      const attached = await attach(
        blocks,
        '/repo',
        { path: 'src/unsaved.ts', startLine: 0, endLine: 1, isEmpty: false, text: 'editor view\nwith unsaved edits' },
        boobyFs,
      )
      check('attach·v2：编辑器 text 原样附加且完全不触碰文件系统',
        attached !== undefined && attached.lines === 2 && attached.path === 'src/unsaved.ts'
        && fsTouched === false
        && blocks[0]?.text === '<attached-file path="src/unsaved.ts" selection count="2">\neditor view\nwith unsaved edits\n</attached-file>')
    }
    {
      // 复审轮 4 回归（曾为 P1）：text 是选区自身文本，绝对行号不得参与
      // 切片——startLine>0 / 深处选区 / 坐标越界都必须原样附加成功。
      const boobyFs: FsLike = {
        resolve: async () => { throw new Error('fs must not be touched') },
        stat: async () => { throw new Error('fs must not be touched') },
        readText: async () => { throw new Error('fs must not be touched') },
      }
      const mkBlocks = () => [] as Array<{ type: string; text: string }>
      const mid = await attach(
        mkBlocks(), '/repo',
        { path: 'src/mid.ts', startLine: 5, endLine: 7, isEmpty: false, text: 'a\nb\nc' },
        boobyFs,
      )
      check('attach·v2 回归：startLine=5 的选区 text 原样附加 3 行（不再按绝对行号错切）',
        mid !== undefined && mid.lines === 3
        && (await attach(mkBlocks(), '/repo', { path: 'p', startLine: 5, endLine: 7, isEmpty: false, text: 'a\nb\nc' }, undefined)) !== undefined)
      const deep = await attach(
        mkBlocks(), '/repo',
        { path: 'src/deep.ts', startLine: 120, endLine: 122, isEmpty: false, text: 'L120\nL121\nL122' },
        boobyFs,
      )
      check('attach·v2 回归：坐标远超 text 行数（120+）仍附加完整 text（旧实现静默丢块）',
        deep !== undefined && deep.lines === 3 && deep.path === 'src/deep.ts')
      const single = await attach(
        mkBlocks(), '/repo',
        { path: 'one.ts', startLine: 41, endLine: 41, isEmpty: false, text: 'only line' },
        boobyFs,
      )
      check('attach·v2 回归：单行选区（start=end=41）附加 1 行',
        single !== undefined && single.lines === 1)
      // 单个空行（终审轮 7）：三击空行 getText="\n"，strip 后为空串——徽标仍报
      // 「1 line selected」，所以必须照样产块（count="1"、正文是那一空行），
      // 否则 footer 与实际附加/指示行自相矛盾。
      const blankBlocks = mkBlocks()
      const blankLine = await attach(
        blankBlocks, '/repo',
        { path: 'blank.ts', startLine: 5, endLine: 5, isEmpty: false, text: '\n' },
        boobyFs,
      )
      check('attach·v2 回归：单个空行选区仍附加 1 行（不再静默丢块）',
        blankLine !== undefined && blankLine.lines === 1
        && blankBlocks[0]?.text === '<attached-file path="blank.ts" selection count="1">\n\n</attached-file>')
      // 整行选区（终审轮 5）：getText 对跨行选区带一个尾换行（下一行行首
      // 收尾）——必须剥掉，否则计数 +1 且块体多一个空行。
      const fullLines = await attach(
        mkBlocks(), '/repo',
        { path: 'full.ts', startLine: 5, endLine: 7, isEmpty: false, text: 'L5\nL6\nL7\n' },
        boobyFs,
      )
      const fullBlocks = mkBlocks()
      await attach(fullBlocks, '/repo',
        { path: 'full.ts', startLine: 5, endLine: 7, isEmpty: false, text: 'L5\nL6\nL7\n' }, boobyFs)
      check('attach·v2 回归：整行选区尾换行被剥——3 行、无幻影空行',
        fullLines !== undefined && fullLines.lines === 3
        && fullBlocks[0]?.text === '<attached-file path="full.ts" selection count="3">\nL5\nL6\nL7\n</attached-file>')
      const { MENTION_MAX_FILE_CHARS: CAP } = await import('../src/dsh-adapter/channel/mentions.js') as { MENTION_MAX_FILE_CHARS: number }
      const bigText = ('y'.repeat(200) + '\n').repeat(300)
      const bigBlocks = mkBlocks()
      const big = await attach(
        bigBlocks, '/repo',
        { path: 'big.ts', startLine: 9, endLine: 308, isEmpty: false, text: bigText },
        boobyFs,
      )
      check('attach·v2 回归：超大 text 按 cap 截断，lines=实收行数',
        big !== undefined && big.lines === bigText.slice(0, CAP).split('\n').length
        && bigBlocks[0]?.text.includes('[… truncated]'))
      const blocksProbe = mkBlocks()
      const body = await attach(
        blocksProbe, '/repo',
        { path: 'src/deep.ts', startLine: 120, endLine: 122, isEmpty: false, text: 'L120\nL121\nL122' },
        boobyFs,
      )
      check('attach·v2 回归：正文就是 text 本身（首行保留、无错位）',
        body !== undefined && blocksProbe[0]?.text === '<attached-file path="src/deep.ts" selection count="3">\nL120\nL121\nL122\n</attached-file>')
      // loopback 端到端（原 fromLive 假绿的替代）：第 6 节真实推送快照
      // startLine=2 但 text 只有选区 3 行——attach 必须原样附加全部 3 行。
      const liveBlocks = mkBlocks()
      const liveAttach = seenLive[0] === undefined ? undefined : await attach(
        liveBlocks, '/repo', seenLive[0]!, boobyFs,
      )
      check('attach·loopback 端到端：真实推送快照（startLine=2, text=3 行）原样附加',
        liveAttach !== undefined && liveAttach.lines === 3
        && liveBlocks[0]?.text === '<attached-file path="src/a.ts" selection count="3">\nfa.ts\nfb.ts\nfc.ts\n</attached-file>')
    }
    {
      const calls: string[] = []
      const diskFs: FsLike = {
        resolve: async p => { calls.push(`resolve:${p}`); return p },
        stat: async p => { calls.push(`stat:${p}`); return { type: 'file' } },
        readText: async p => { calls.push(`read:${p}`); return 'disk line1\ndisk line2' },
      }
      const blocks: Array<{ type: string; text: string }> = []
      const attached = await attach(
        blocks,
        '/repo',
        { path: 'src/legacy.ts', startLine: 0, endLine: 1, isEmpty: false },
        diskFs,
      )
      check('attach·v1：无 text 时回退磁盘读取（相对路径按 cwd 解析）',
        attached !== undefined && attached.lines === 2
        && calls.some(c => c === `resolve:${join('/repo', 'src/legacy.ts')}`)
        && blocks[0]?.text.includes('disk line1'))
      const skipped = await attach([], '/repo', undefined, diskFs)
      check('attach：无选区/空选区 → undefined 且不读盘', skipped === undefined && calls.length === 3)
    }

    // ── 8c. replaySelectionAttachment：指示行从持久化事件回扫重建 ──────────
    const replay = (selectionMod as {
      replaySelectionAttachment: (
        content: ReadonlyArray<unknown> | undefined,
      ) => { lines: number; path: string } | undefined
    }).replaySelectionAttachment
    check('replay：普通块 → {lines, path} 与提交时记忆一致',
      (() => {
        const r = replay([{ type: 'text', text: normal?.text ?? '' }])
        return r !== undefined && r.lines === normal?.lines && r.path === 'src/my file.ts'
      })())
    check('replay：截断块的 lines 与截断后计数一致（排除省略标记行）',
      (() => {
        const r = replay([{ type: 'text', text: capped?.text ?? '' }])
        return r !== undefined && r.lines === capped?.lines && r.path === 'huge.ts'
      })())
    check('replay：转义路径还原成原始字符（&amp; 等逆向）',
      (() => {
        const r = replay([{ type: 'text', text: evil?.text ?? '' }])
        return r !== undefined && r.path === 'a&b"c<d>e.ts' && r.lines === 1
      })())
    check('replay：普通用户文本块（非选区）→ undefined',
      replay([{ type: 'text', text: 'just a question' }]) === undefined)
    check('replay：无选区块的多块内容 → undefined',
      replay([{ type: 'text', text: 'q' }, { type: 'image', source: '' } as unknown]) === undefined)
    check('replay：undefined 内容 → undefined', replay(undefined) === undefined)
    check('replay：选区块排在后面的内容也能命中',
      (() => {
        const r = replay([
          { type: 'text', text: 'why is this wrong?' },
          { type: 'text', text: normal?.text ?? '' },
        ])
        return r !== undefined && r.lines === 3 && r.path === 'src/my file.ts'
      })())
    // 复审 nit（终审轮 6）：行数不再从正文尾部猜——`count` 属性是唯一真相。
    // 正文末行恰好是截断标记字面时，旧启发式会把正常块少算一行。
    check('replay：正文末行恰为截断标记字面时仍按 count 计行（不再少算一行）',
      (() => {
        const literal = build(
          { path: 'lit.ts', startLine: 0, endLine: 2, isEmpty: false },
          'alpha\nbeta\n[… truncated]',
        )
        const r = replay([{ type: 'text', text: literal?.text ?? '' }])
        return literal !== undefined && literal.lines === 3
          && r !== undefined && r.lines === 3 && r.path === 'lit.ts'
      })())
    check('replay：无 count 的旧块回退尾标记启发式（历史会话仍可读）',
      (() => {
        const r = replay([{
          type: 'text',
          text: '<attached-file path="old.ts" selection>\na\nb\n[… truncated]\n</attached-file>',
        }])
        return r !== undefined && r.lines === 2 && r.path === 'old.ts'
      })())
    check('replay：build 的每个块都带 count 且等于 lines（含截断块）',
      [normal, capped, evil].every(block => block !== undefined
        && block.text.includes(`selection count="${block.lines}">`)))
    // 空行选区回放（终审轮 7）：count 让「正文为空」也能报回 1 行，旧启发式对
    // 空正文会数成 1 行纯属巧合（`''.split('\n').length === 1`），这里钉的是
    // 属性来源而非巧合：把 count 换成 2 就应报 2（证明没有被正文长度掩盖）。
    check('replay：空行选区块按 count 报行（不是被空正文凑对）',
      (() => {
        const one = replay([{ type: 'text', text: '<attached-file path="blank.ts" selection count="1">\n\n</attached-file>' }])
        const two = replay([{ type: 'text', text: '<attached-file path="blank.ts" selection count="2">\n\n</attached-file>' }])
        return one?.lines === 1 && two?.lines === 2 && one.path === 'blank.ts'
      })())
  }

  // ── 8.4. POSIX 根归一化（coderabbit review C-1）──
  // normalizeIdePath('/') 不得削成空串——根工作区锁否则丢掉优先级。
  {
    const ideMod = await import('../src/dsh-adapter/ide-channel.js') as {
      normalizeIdePath?: (p: string, ci: boolean) => string
    }
    check('normalizeIdePath: POSIX 根 / 保留为 /（C-1 回归）',
      ideMod.normalizeIdePath?.('/', false) === '/')
    check('normalizeIdePath: 普通路径仍去尾斜杠', ideMod.normalizeIdePath?.('/repo/', false) === '/repo')
  }

  // ── 8.5. 根工作区锁匹配 + 根前缀显示（coderabbit review C-6）──
  // 根 `/` 是每个绝对路径的前缀但不该拼出 `//`——锁匹配得把根当特例，
  // 指示行显示也要在根下把相对路径去单个前导斜杠。
  {
    const locksRoot = join(tmpRoot, 'locks-root')
    rmSync(locksRoot, { force: true, recursive: true })
    mkdirSync(locksRoot, { recursive: true })
    writeFileSync(join(locksRoot, '50101.lock'),
      JSON.stringify({ port: 50101, token: 't-root', workspaceFolders: ['/'], pid: process.pid }))
    writeFileSync(join(locksRoot, '50102.lock'),
      JSON.stringify({ port: 50102, token: 't-deep', workspaceFolders: ['/deeper'], pid: process.pid }))
    const rootPick = mod.pickLockCandidates(locksRoot, '/repo/sub', process.pid)
    check('pickLockCandidates: 根 / 声明匹配任何绝对 cwd（C-6）', rootPick.some(c => c.token === 't-root'))
  }
  {
    const listMod = await import('../src/components/MessageList.js') as {
      displaySelectionPath?: (path: string, cwd: string | undefined) => string
    }
    check('displaySelectionPath: cwd 为根 / 时相对路径去单个前导斜杠（C-6）',
      listMod.displaySelectionPath?.('/repo/file.ts', '/') === 'repo/file.ts')
    check('displaySelectionPath: cwd 为根 / 时非根内路径仍原样（C-6）',
      listMod.displaySelectionPath?.('/repo/file.ts', '/other') !== 'repo/file.ts')
  }

  // ── 8.6. 最具体优先排序（coderabbit review，最新一轮）──
  // 同时有 `/repo` 锁与根 `/` 锁时，二者都能匹配 cwd `/repo`——但 `/repo`
  // 应排在 `/` 之前（具体窗口优先于全局回退），根匹配本身仍保留。
  {
    const locksSpecific = join(tmpRoot, 'locks-specific')
    rmSync(locksSpecific, { force: true, recursive: true })
    mkdirSync(locksSpecific, { recursive: true })
    writeFileSync(join(locksSpecific, '60101.lock'),
      JSON.stringify({ port: 60101, token: 't-repo', workspaceFolders: ['/repo'], pid: process.pid }))
    writeFileSync(join(locksSpecific, '60102.lock'),
      JSON.stringify({ port: 60102, token: 't-root', workspaceFolders: ['/'], pid: process.pid }))
    const specific = mod.pickLockCandidates(locksSpecific, '/repo', process.pid)
    check('pickLockCandidates: 同匹配下 /repo 锁排在 / 根锁前（最具体优先）',
      specific[0]?.token === 't-repo')
    check('pickLockCandidates: 根 / 锁仍参与匹配（不因排序丢失）',
      specific.some(c => c.token === 't-root'))
  }

  // ── 9. 指示行显示相对化（T-FIX-01）：displaySelectionPath 纯函数 ───────────
  // UAT 实测根因：扩展基准（工作区根）与 TUI 基准（会话 cwd）不一致，指示行
  // 显示冗长绝对路径。修复为纯展示层前缀剥离——块内 path 保持绝对不动。
  {
    const listMod = await import('../src/components/MessageList.js') as {
      displaySelectionPath?: (
        path: string,
        sessionCwd: string | undefined,
        caseInsensitive?: boolean,
      ) => string
    }
    const dsp = listMod.displaySelectionPath
    check('displaySelectionPath: 导出存在（T-FIX-01）', typeof dsp === 'function')

    // ① cwd 前缀命中 → 去前缀的相对串（正斜杠形态，保留目录上下文）。
    check('displaySelectionPath: cwd 内文件 → 相对路径',
      dsp?.('/repo/src/my file.ts', '/repo') === 'src/my file.ts')

    // ② 不在 cwd 下 → 原样返回（不用 basename——同名歧义丢目录上下文）。
    check('displaySelectionPath: cwd 外文件 → 原样返回',
      dsp?.('/other/lib/a.ts', '/repo') === '/other/lib/a.ts')

    // ③ Windows UAT 场景：扩展推小盘符正斜杠、会话 cwd 大盘符反斜杠 →
    //    归一化（反斜杠→正斜杠、尾斜杠剥、大小写折叠）后仍命中。
    check('displaySelectionPath: Windows 盘符大小写+分隔符归一化命中（UAT d:/ vs D:\\）',
      dsp?.('d:/repo/src/a.ts', 'D:\\Repo', true) === 'src/a.ts')
    check('displaySelectionPath: Windows 反斜杠路径 vs 带尾斜杠 cwd 命中',
      dsp?.('D:\\Repo\\src\\b.ts', 'd:/repo/', true) === 'src/b.ts')

    // ④ 空/缺失 cwd → 原样返回（保住不传新 prop 的测试 harness 消费者）。
    check('displaySelectionPath: 空 cwd → 原样返回',
      dsp?.('/repo/a.ts', '') === '/repo/a.ts')
    check('displaySelectionPath: undefined cwd → 原样返回',
      dsp?.('/repo/a.ts', undefined) === '/repo/a.ts')

    // 边界：path 恰等于 cwd 本身 → 无相对语义可表达，原样返回。
    check('displaySelectionPath: path 即 cwd → 原样返回',
      dsp?.('/repo', '/repo') === '/repo')

    // 大小写敏感模式显式关闭折叠（caseInsensitive 参数化，任何主机可钉死行为）：
    // POSIX 敏感语义下大小写不同即不命中。
    check('displaySelectionPath: caseInsensitive=false 时大小写差异不命中',
      dsp?.('/Repo/src/a.ts', '/repo', false) === '/Repo/src/a.ts')
  }

  // ── 10. 发送前选区实时提示（T-FIX-02）：prompt footer 徽标纯函数 ──────────
  // 官方 Claude Code 形态：`⧉ N lines selected`（U+29C9），英文固定无本地化，
  // 单复数区分；行数 = 快照 0-based 含端区间长度；无 IDE（undefined）或空选区
  // 不渲染字段（手动启动永不显示占位）。字段本体由 StatusLine rightFields
  // 消费 channel.selection 投影（version bump 重渲染由 onSelection 接线负责，
  // 编译期类型锁定；此处钉死文案纯函数契约）。
  {
    const statusMod = await import('../src/screens/StatusLine.js') as {
      formatSelectionBadge?: (
        selection: { startLine: number; endLine: number; isEmpty?: boolean } | undefined,
      ) => string | undefined
    }
    const badge = statusMod.formatSelectionBadge
    check('selectionBadge: 导出存在（T-FIX-02）', typeof badge === 'function')
    check('selectionBadge: 多行选区 → ⧉ 3 lines selected',
      badge?.({ startLine: 2, endLine: 4 }) === '⧉ 3 lines selected')
    check('selectionBadge: 两行选区 → 复数 lines',
      badge?.({ startLine: 0, endLine: 1 }) === '⧉ 2 lines selected')
    check('selectionBadge: 单行选区 → 单数 line',
      badge?.({ startLine: 0, endLine: 0 }) === '⧉ 1 line selected')
    check('selectionBadge: undefined（无 IDE）→ 不渲染字段',
      badge?.(undefined) === undefined)
    check('selectionBadge: isEmpty 快照 → 不渲染字段（防御）',
      badge?.({ startLine: 0, endLine: 0, isEmpty: true }) === undefined)
    // 跨端契约回归（扩展侧 selectionLineRange 归一化）：整行选区推的是
    // 「含端」坐标（选中第 5~7 行 → startLine=5/endLine=7），徽标行数必须
    // 等于实际附加的正文行数——扩展曾推原始 end.line=8，footer 说 4 行而
    // transcript 指示行说 3 行（同一手势自相矛盾）。
    check('selectionBadge: 含端坐标下徽标行数 == text 实际行数（归一化契约）',
      (() => {
        const text = 'L5\nL6\nL7\n' // 扩展 getText() 对整行选区的返回（含尾换行）
        const counted = text.replace(/\n$/, '').split('\n').length
        return badge?.({ startLine: 5, endLine: 7, isEmpty: false }) === `⧉ ${counted} lines selected`
      })())
  }

  rmSync(tmpRoot, { recursive: true, force: true })

  console.log(results.join('\n'))
  if (failures > 0) {
    console.error(`\n${failures} check(s) failed`)
    process.exit(1)
  }
  console.log('\nall ide-channel checks passed')
}

await main()
