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
    await sleep(20)
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

function startWsFixture(token: string): Promise<WsFixture> {
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
        params: { path: 'src/a.ts', startLine: 2, endLine: 4, isEmpty },
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
          helloResolve({
            token: typeof params?.token === 'string' ? params.token : '',
          })
          // 握手完成后推一条非空选区，稍后再推一条空选区（验证清空路径）
          sendSelection(false)
          void sleep(50).then(() => sendSelection(true))
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
    picked.length === 2 && picked.every(c => c.token !== ''))
  check('pickLockCandidates: workspace 匹配者排第一', picked[0]?.token === 't-a')
  check('pickLockCandidates: 不匹配者仍在候选中', picked.some(c => c.token === 't-other'))
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
  check('pickLockCandidates: /repo/a 声明不匹配 /repo/abc 会话（前缀边界）',
    pickedBoundary[0]?.token === 't-z-z')
  check('pickLockCandidates: 精确等于 workspace 根仍匹配', (() => {
    const computed = mod.pickLockCandidates(boundaryDir, '/repo/a', process.pid)
    return computed[0]?.token === 't-sub'
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
    check('loopback·env 直连：握手后 connected=true', channel.connected)
    const gotSelection = await waitFor(() => seen.length >= 1, 2000)
    check('loopback·env 直连：selection_changed 到达 listener',
      gotSelection && seen[0]?.path === 'src/a.ts' && seen[0]?.startLine === 2 && seen[0]?.endLine === 4)
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
  }
  lockFixture.close()

  // ── 8. 选区消费注入（T05 · AC-5 前半）：块构造与钳制 ──────────────────────
  {
    const channelMod = await import('../src/dsh-adapter/channel.js')
    const build = (channelMod as {
      buildSelectionBlock: (
        selection: { path: string; startLine: number; endLine: number; isEmpty: boolean },
        content: string,
      ) => { text: string; lines: number } | undefined
    }).buildSelectionBlock

    // 正常切片：0-based [2,4] → 1-based 第 3~5 行。
    const normal = build({ path: 'src/my file.ts', startLine: 2, endLine: 4, isEmpty: false }, FIVE_LINE_CONTENT)
    check('selectionBlock: 0-based [2,4] 切出第 3~5 行且带 selection 属性',
      normal !== undefined
      && normal.text === '<attached-file path="src/my file.ts" selection>\nline3\nline4\nline5\n</attached-file>'
      && normal.lines === 3)

    // 含空格路径不经文本解析——直接构造必须原样保留。
    const spaced = build({ path: 'my dir/a b.ts', startLine: 0, endLine: 0, isEmpty: false }, FIVE_LINE_CONTENT)
    check('selectionBlock: 含空格路径原样保留（D7 不走文本解析）',
      spaced !== undefined
      && spaced.text.startsWith('<attached-file path="my dir/a b.ts" selection>')
      && spaced.text.includes('\nline1\n</attached-file>'))

    // endLine 超界钳制到实际行数（0-based 99 → 1-based 100 > 5 → 全部剩余行）。
    const clampedEnd = build({ path: 'src/a.ts', startLine: 3, endLine: 99, isEmpty: false }, FIVE_LINE_CONTENT)
    check('selectionBlock: endLine 越界钳制到末行',
      clampedEnd !== undefined
      && clampedEnd.text === '<attached-file path="src/a.ts" selection>\nline4\nline5\n</attached-file>'
      && clampedEnd.lines === 2)

    // startLine 越过 EOF → sliceLines 返回 undefined → 无块（静默跳过）。
    const pastEof = build({ path: 'src/a.ts', startLine: 50, endLine: 60, isEmpty: false }, FIVE_LINE_CONTENT)
    check('selectionBlock: 起行越过 EOF → undefined（静默跳过）', pastEof === undefined)

    // isEmpty 快照守卫：调用侧不会传入，但纯函数自身也拒绝。
    check('selectionBlock: isEmpty=true → undefined',
      build({ path: 'src/a.ts', startLine: 0, endLine: 0, isEmpty: true }, FIVE_LINE_CONTENT) === undefined)

    // loopback 端到端：第 6 节 env 直连收到的真实快照（非空那条）构造出合法块；
    // isEmpty 清空后 selection getter 已为 undefined，消费守卫不产块。
    const liveSnapshot = seenLive[0]
    const fromLive = liveSnapshot === undefined
      ? undefined
      : build(liveSnapshot, FIVE_LINE_CONTENT)
    check('selectionBlock: loopback 真实快照构造 <attached-file … selection> 块',
      liveSnapshot !== undefined
      && fromLive !== undefined
      && fromLive.text.startsWith('<attached-file path="src/a.ts" selection>')
      && fromLive.lines === 3)
    check('selectionBlock: isEmpty 清空后 selection getter 为 undefined（消费守卫不产块）',
      liveCleared)

    // 路径属性转义（coderabbit C-2）：POSIX 合法文件名可含 `"` `&` `<` `>`,
    // 插进 `path="…"` 属性前必须转义,防属性逃逸/标记注入到模型侧块。
    const evil = build({ path: 'a&b"c<d>e.ts', startLine: 0, endLine: 0, isEmpty: false }, 'line1\n')
    check('selectionBlock: 含引号/&/尖括号路径被 HTML 转义（escapeSnippetAttr）',
      evil !== undefined
        && evil.text.startsWith('<attached-file path="a&amp;b&quot;c&lt;d&gt;e.ts" selection>')
        && evil.text.includes('\nline1\n</attached-file>'))
    const plain = build({ path: 'plain.ts', startLine: 0, endLine: 0, isEmpty: false }, 'line1\n')
    check('selectionBlock: 普通路径不转义（行为不变）',
      plain?.text.startsWith('<attached-file path="plain.ts" selection>'))
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
