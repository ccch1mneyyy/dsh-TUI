/**
 * verify-session-tree — /tree 与 /fork 特性回归：
 *
 *  [模型层] sessionTree 纯函数：条目提取（用户/助手/工具/压缩/中断、
 *           chunk 合并与 aborted 标注）、回退/分叉边界（丢轮、步末切割、
 *           轮间条目）、家族拼接（fork 锚点、覆盖去重、活动路径）、
 *           扁平化/过滤（活动优先、user-only、搜索、活动叶存活）、
 *           整轮丢弃预警（coversBranch 陷阱）。
 *  [读取层] compat 预算读取器：临时 DSH_TUI_SESSION_ROOT 下写入 zstd 帧
 *           日志，验证全量读、事件预算截断、继承前缀跳过。
 *  [屏幕层] SessionTree 无头组装：树渲染（标题/连接线/分支徽标）、
 *           Enter 打开操作菜单、字母直达执行分叉（经 channel 记录）、
 *           Esc 退出。
 *
 * 运行：node --import tsx/esm scripts/verify-session-tree.tsx
 */
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_THEME = 'dark'
process.env.DSH_TUI_LANG = 'zh'

const tree = await import('../src/dsh-adapter/sessionTree.js')

let failed = 0
function check(name: string, ok: boolean, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}

// ── 合成事件（scripts 不进 tsc，宽塑形即可） ─────────────────────────────
type Ev = { type: string; seq: number; time: number; data: any }
const ev = (type: string, seq: number, data: unknown): Ev =>
  ({ type, seq, time: 1000 + seq, data }) as Ev
const turnStart = (seq: number, turn: number) => ev('turn/start', seq, { turn })
const turnEnd = (seq: number, turn: number, reason: unknown) => ev('turn/end', seq, { turn, reason })
const stepEnd = (seq: number) => ev('step/end', seq, {})
const userMsg = (seq: number, text: string) =>
  ev('user/message', seq, { source: { kind: 'user' }, content: [{ type: 'text', text }] })
const assistantMsg = (seq: number, turn: number, step: number, text: string) =>
  ev('assistant/message', seq, { turn, step, message: { role: 'assistant', content: [{ type: 'text', text }] } })
const chunk = (seq: number, turn: number, step: number, text: string) =>
  ev('assistant/chunk', seq, { turn, step, chunk: { type: 'text-delta', text } })
const toolCall = (seq: number, callId: string, name: string, args: string) =>
  ev('tool/call', seq, { callId, name, arguments: args })
const toolResult = (seq: number, callId: string, error?: unknown) =>
  ev('tool/result', seq, { message: { source: { callId } }, ...(error === undefined ? {} : { error }) })
const title = (seq: number, text: string) => ev('session/title', seq, { title: text })

/**
 * 根会话 R 的日志：两轮完整 + 轮间标题。
 *   0 turn/start t0 · 1 user u0 · 2 step/start · 3 tool/call · 4 tool/result
 *   5 step/end · 6 assistant a0 · 7 turn/end t0
 *   8 turn/start t1 · 9 user u1 · 10 assistant a1 · 11 turn/end t1
 *   12 session/title
 */
function rootLog(): Ev[] {
  return [
    turnStart(0, 0),
    userMsg(1, 'u0-问根'),
    ev('step/start', 2, {}),
    toolCall(3, 'c1', 'bash', '{"command":"ls"}'),
    toolResult(4, 'c1'),
    stepEnd(5),
    assistantMsg(6, 0, 1, 'a0-答根'),
    turnEnd(7, 0, { kind: 'completed' }),
    turnStart(8, 1),
    userMsg(9, 'u1-第二问'),
    assistantMsg(10, 1, 0, 'a1-第二答'),
    turnEnd(11, 1, { kind: 'completed' }),
    title(12, '根会话标题'),
  ]
}

// ── 模型层：条目提取 ──────────────────────────────────────────────────────
{
  const entries = tree.extractEntries('R', rootLog() as any)
  const kinds = entries.map(e => e.kind).join(',')
  check(
    'extractEntries: 5 个条目（用户/工具/助手×2/用户），标题不成条目',
    entries.length === 5 && entries.every(e => e.seq !== 12),
    kinds,
  )
  const user0 = entries[0]!
  check('extractEntries: 完整日志的首轮 user 带 firstTurn', user0.firstTurn === true && user0.text.includes('u0'))
  check(
    'extractEntries: 工具卡 settled 为 ok',
    entries[1]!.kind === 'tool' && entries[1]!.toolStatus === 'ok',
  )
  const user1 = entries.find(e => e.seq === 9)!
  check('extractEntries: 第二轮 user 不带 firstTurn', user1.firstTurn === undefined)
}
{
  // chunk-only 的中断轮：tentative 文本存活并标注 aborted
  const log: Ev[] = [
    turnStart(0, 0),
    userMsg(1, 'q'),
    chunk(2, 0, 0, '中途被打断的'),
    chunk(3, 0, 0, '流式文本'),
    turnEnd(4, 0, { kind: 'interrupted' }),
  ]
  const entries = tree.extractEntries('X', log as any)
  check(
    'extractEntries: chunk 合并为一条并标 aborted',
    entries.filter(e => e.kind === 'assistant').length === 1
      && entries.find(e => e.kind === 'assistant')?.label === 'aborted',
  )
}
{
  // 同步 assistant/message 落定后，tentative chunk 行被去重
  const log: Ev[] = [
    turnStart(0, 0),
    userMsg(1, 'q'),
    chunk(2, 0, 0, 'tentative'),
    assistantMsg(3, 0, 0, 'settled'),
    turnEnd(4, 0, { kind: 'completed' }),
  ]
  const entries = tree.extractEntries('X', log as any)
  check(
    'extractEntries: settled 落定后 tentative 去重',
    entries.filter(e => e.kind === 'assistant').length === 1
      && entries.find(e => e.kind === 'assistant')?.text.includes('settled') === true,
  )
}

// ── 模型层：回退/分叉边界 ────────────────────────────────────────────────
{
  const log = rootLog()
  const rUser0 = tree.rewindTarget(log as any, 1)
  check('rewindTarget: 首轮 user → boundary -1（首条消息不可回退）', rUser0.boundary === -1 && rUser0.closeTurn === undefined)
  const rTool = tree.rewindTarget(log as any, 3)
  check(
    'rewindTarget: 轮内工具 → 步末切割 + closeTurn',
    rTool.boundary === 5 && rTool.closeTurn === 0,
    JSON.stringify(rTool),
  )
  const rAssist = tree.rewindTarget(log as any, 6)
  check('rewindTarget: 步后助手 → 保留到 turn/end', rAssist.boundary === 7 && rAssist.closeTurn === undefined)
  const rTitle = tree.rewindTarget(log as any, 12)
  check('rewindTarget: 轮间条目 → 自身 seq', rTitle.boundary === 12)
  const fUser1 = tree.forkTarget(log as any, 9)
  check(
    'forkTarget: user → 保留该消息 + closeTurn',
    fUser1.boundary === 9 && fUser1.closeTurn === 1,
    JSON.stringify(fUser1),
  )
  check('turnUserText: user 回退取回该轮提示词', tree.turnUserText(log as any, 9) === 'u1-第二问')
  check('turnUserText: 保留式目标（助手）不取回文本', tree.turnUserText(log as any, 6) === '')
}

// ── 模型层：live 尾窗对齐整轮 ────────────────────────────────────────────
{
  const log = [...rootLog(), turnStart(13, 2), userMsg(14, 'u2'), assistantMsg(15, 2, 0, 'a2'), turnEnd(16, 2, { kind: 'completed' })]
  // 预算 5：窗口应从 seq 13 的 turn/start 对齐（丢掉 12/11/10…）
  const win = tree.liveTailWindow(log as any, 5)
  check(
    'liveTailWindow: 尾窗对齐到完整轮',
    win[0]?.type === 'turn/start' && win[0]?.seq === 13 && win.length === 4,
    `start=${win[0]?.seq} len=${win.length}`,
  )
}

// ── 模型层：家族拼接 + 扁平化/过滤 ──────────────────────────────────────
/**
 * 家族：R（根，两轮）→ F1（seedLength 8：turn0 之后分叉，live）、
 * F2（seedLength 12：两轮之后分叉，仅一轮自有内容）。
 */
function family() {
  const f1Own: Ev[] = [
    turnStart(8, 1), userMsg(9, 'f1-新方向'), assistantMsg(10, 1, 0, 'f1-回答'), turnEnd(11, 1, { kind: 'completed' }),
  ]
  // F1 的日志 = 继承前缀(R[0..7]) + 自有
  const f1Log = [...rootLog().slice(0, 8), ...f1Own]
  const f2Own: Ev[] = [
    title(12, 'F2 分支'), turnStart(13, 2), userMsg(14, 'f2-再试'), turnEnd(15, 2, { kind: 'aborted', reason: { kind: 'user' } }),
  ]
  const f2Log = [...rootLog(), ...f2Own]
  return tree.buildSessionTree(
    [
      { id: 'R', createdAt: 1, events: rootLog(), live: false, tailComplete: true },
      { id: 'F1', createdAt: 2, parentSession: 'R', seedLength: 8, events: f1Log, live: true, tailComplete: true },
      { id: 'F2', createdAt: 3, parentSession: 'R', seedLength: 12, events: f2Log, live: false, tailComplete: true },
    ] as any,
    'F1',
  )
}
{
  const rootEvents = rootLog().slice(0, 8)
  const detachedEvents = [
    ...rootEvents,
    turnStart(8, 1), userMsg(9, 'unknown-cut-child'), turnEnd(10, 1, { kind: 'completed' }),
  ]
  const data = tree.buildSessionTree(
    [
      { id: 'R-unknown', createdAt: 1, events: rootEvents, live: false, tailComplete: true },
      {
        id: 'F-unknown', createdAt: 2, parentSession: 'R-unknown',
        events: detachedEvents, live: true, tailComplete: true,
      },
    ] as any,
    'F-unknown',
  )
  check(
    'buildSessionTree: exact cut 缺失时切断无法证明的 parent edge',
    data.roots.length === 2
      && data.activePath.has('F-unknown:9')
      && !data.activePath.has('R-unknown:1'),
    `roots=${data.roots.length}`,
  )
}
{
  const data = family()
  check('buildSessionTree: 单根（R）', data.roots.length === 1)
  check('buildSessionTree: live 叶在 F1 链尾', data.activeLeafId === 'F1:10', data.activeLeafId ?? '')
  // 活动路径：R 的 seq<=7 条目 + F1 全链
  const onPath = (id: string) => data.activePath.has(id)
  check(
    'buildSessionTree: 活动路径含 R 的前缀条目与 F1 全链',
    onPath('R:1') && onPath('R:3') && onPath('R:6') && onPath('F1:9') && onPath('F1:10'),
  )
  check(
    'buildSessionTree: 死分支（R 自有尾、F2）不在活动路径',
    !onPath('R:9') && !onPath('F2:14'),
  )
  check('buildSessionTree: 会话元数据标题', data.sessions.get('F2')?.title === 'F2 分支')

  const flat = tree.flattenTree(data.roots, data.activeLeafId)
  const ids = flat.map(f => f.node.id)
  // 活动分支（F1 子树）在分支点排最前，随后 R 自有尾，最后 F2
  const f1Head = ids.indexOf('F1:9')
  const rOwn = ids.indexOf('R:9')
  const f2Head = ids.indexOf('F2:14')
  check(
    'flattenTree: 活动子树优先于死分支',
    f1Head >= 0 && rOwn > f1Head && f2Head > rOwn,
    `f1=${f1Head} rOwn=${rOwn} f2=${f2Head}`,
  )
  const f1Row = flat[f1Head]!
  check('flattenTree: fork 行带连接线', f1Row.showConnector === true)
  // F2 的 user + interrupted 中断行是其仅有的自有条目 → 整轮丢弃预警命中
  const f2User = flat.find(f => f.node.id === 'F2:14')!.node.entry!
  const drop = tree.droppedTurnInfo(data, f2User)
  check(
    'droppedTurnInfo: 单轮分支命中 coversBranch 陷阱',
    drop?.coversBranch === true && drop?.droppedEntries === 2,
  )
  // user-only 过滤：仅用户行 + 活动叶存活
  const userOnly = tree.filterTree(flat, data.activeLeafId, 'user-only', '')
  check(
    'filterTree: user-only 只剩用户行（活动叶除外）',
    userOnly.every(f => f.node.entry === null || f.node.entry.kind === 'user' || f.node.id === data.activeLeafId)
      && userOnly.some(f => f.node.id === data.activeLeafId),
  )
  // 搜索命中
  const searched = tree.filterTree(flat, data.activeLeafId, 'default', 'f1-新方向')
  check(
    'filterTree: 搜索命中目标行',
    searched.some(f => f.node.id === 'F1:9') && !searched.some(f => f.node.id === 'R:9'),
  )
  // 光标回退：目标被过滤掉时沿父链上溯
  const idx = tree.nearestVisibleIndex(userOnly, flat, 'R:10')
  const landed = userOnly[idx]?.node.id
  check(
    'nearestVisibleIndex: 沿父链上溯到可见祖先',
    landed === 'R:9' || landed === 'F1:9',
    landed ?? '',
  )
}

// ── 读取层：预算读取器 round-trip ────────────────────────────────────────
{
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { zstdCompressSync } = await import('node:zlib')
  const root = mkdtempSync(join(tmpdir(), 'dsh-tree-verify-'))
  process.env.DSH_TUI_SESSION_ROOT = root
  try {
    const dir = join(root, 'ws1', 'session-readerprobe')
    mkdirSync(dir, { recursive: true })
    const log = rootLog()
    // 每条事件一帧（后端按批 append 的形状）
    const frames = Buffer.concat(log.map(e => zstdCompressSync(Buffer.from(JSON.stringify(e) + '\n'))))
    writeFileSync(join(dir, 'session.jsonl.zstd'), frames)

    const { readSessionEventsFromLog, defaultMaxScanned } = await import('../src/dsh-adapter/compat/sessionLog.js')
    const full = readSessionEventsFromLog('session-readerprobe')
    check('reader: 全量读回 13 条事件', full?.events.length === 13 && full?.complete === true, `len=${full?.events.length}`)
    const capped = readSessionEventsFromLog('session-readerprobe', 5, defaultMaxScanned(5))
    check('reader: 事件预算截断', capped?.events.length === 5 && capped?.complete === false)
    const skipped = readSessionEventsFromLog('session-readerprobe', 100, defaultMaxScanned(100), 9)
    check(
      'reader: 继承前缀跳过（标题例外）',
      skipped !== undefined && skipped.events.length === 4
        && skipped.events.every((e: any) => (e.seq ?? 0) >= 9 || e.type === 'session/title'),
      `len=${skipped?.events.length}`,
    )
    const missing = readSessionEventsFromLog('session-nosuch')
    check('reader: 不存在的日志返回 undefined', missing === undefined)

    // alpha.4 的 list/listSnapshots 只给逻辑 header（isSeeded），精确 cut
    // 留在 JSONL 物理 header 或 non-file inspect 结果。用真实 channel tree
    // 锁住两条路径；同 cwd 但不在当前 family 的 U 不能触发 locate/inspect。
    const { createChannel } = await import('../src/dsh-adapter/channel.js')
    const { readInheritedCut } = await import('../src/dsh-adapter/sessions/header.js')
    const coldCwd = '/tmp/dsh-tree-alpha4-cold'
    const rootEvents: Ev[] = [
      title(0, 'cold inherited title'),
      turnStart(1, 0),
      userMsg(2, 'cold-root-question'),
      assistantMsg(3, 0, 0, 'cold-root-answer'),
      turnEnd(4, 0, { kind: 'completed' }),
      turnStart(5, 1),
      userMsg(6, 'cold-root-dead-question'),
      assistantMsg(7, 1, 0, 'cold-root-dead-answer'),
      turnEnd(8, 1, { kind: 'completed' }),
    ]
    const f1Events: Ev[] = [
      ...rootEvents.slice(0, 5),
      turnStart(5, 1),
      userMsg(6, 'f1-cold-question'),
      assistantMsg(7, 1, 0, 'f1-cold-answer'),
      turnEnd(8, 1, { kind: 'completed' }),
    ]
    const currentEvents: Ev[] = [
      ...f1Events,
      turnStart(9, 2),
      userMsg(10, 'current-question'),
      assistantMsg(11, 2, 0, 'current-answer'),
      turnEnd(12, 2, { kind: 'completed' }),
    ]
    const logicalHeaders = [
      { version: 0, id: 'R', createdAt: 1, cwd: coldCwd, isSeeded: false },
      { version: 0, id: 'F1', createdAt: 2, cwd: coldCwd, isSeeded: true, parentSession: 'R' },
      { version: 0, id: 'C', createdAt: 3, cwd: coldCwd, isSeeded: true, parentSession: 'F1' },
      { version: 0, id: 'U', createdAt: 4, cwd: coldCwd, isSeeded: false },
    ]
    const writePhysical = (id: string, header: Record<string, unknown>, events: readonly Ev[]): string => {
      const sessionDir = join(root, 'ws-cold', id)
      mkdirSync(sessionDir, { recursive: true })
      const path = join(sessionDir, 'session.jsonl.zstd')
      const records = [header, ...events]
      writeFileSync(path, Buffer.concat(records.map(record =>
        zstdCompressSync(Buffer.from(JSON.stringify(record) + '\n')),
      )))
      return path
    }
    const paths = new Map([
      ['R', writePhysical('R', {
        type: 'session', version: 0, id: 'R', createdAt: 1, cwd: coldCwd,
      }, rootEvents)],
      ['F1', writePhysical('F1', {
        type: 'session', version: 0, id: 'F1', createdAt: 2, cwd: coldCwd,
        parentSession: 'R', seedLength: 5,
      }, f1Events)],
    ])
    const makeLiveAgent = () => ({
      id: 'agent-current',
      status: 'idle',
      session: {
        id: 'C',
        seq: currentEvents.length,
        header: {
          version: 0, id: 'C', createdAt: 3, cwd: coldCwd,
          isSeeded: true, parentSession: 'F1',
        },
        inheritedEventCount: 9,
        snapshotEvents: () => currentEvents,
        requestHeader: () => undefined,
        append: () => undefined,
      },
      ctx: { on: () => () => {} },
      followup: () => undefined,
      steer: () => undefined,
      inbox: { remove: () => true },
    })
    const makeTreeChannel = (persistence: Record<string, unknown>) => {
      const services: Record<string, unknown> = { sessionPersistence: persistence }
      const ctx = {
        on: () => () => {},
        get: (name: string) => services[name],
        logger: { warn: () => undefined },
      }
      return createChannel(ctx as never, makeLiveAgent() as never, {
        model: 'model',
        cwd: coldCwd,
        provider: 'provider',
        activity: false,
      })
    }
    const assertColdTree = (name: string, data: Awaited<ReturnType<ReturnType<typeof makeTreeChannel>['buildSessionTree']>>) => {
      const flat = data === null ? [] : tree.flattenTree(data.roots, data.activeLeafId)
      const rootQuestionCopies = flat.filter(row => row.node.entry?.text.includes('cold-root-question') === true).length
      check(
        `${name}: inherited prefix dedup + exact active anchors`,
        data !== null
          && rootQuestionCopies === 1
          && data.activePath.has('R:2')
          && data.activePath.has('R:3')
          && !data.activePath.has('R:6')
          && data.activePath.has('F1:6')
          && data.activePath.has('F1:7')
          && data.activePath.has('C:10')
          && data.activeLeafId === 'C:11',
        `copies=${rootQuestionCopies} leaf=${data?.activeLeafId ?? 'null'}`,
      )
    }

    const located: string[] = []
    const fileChannel = makeTreeChannel({
      list: () => Promise.resolve(logicalHeaders),
      locate(raw: unknown) {
        const id = String((raw as { id?: unknown }).id ?? '')
        located.push(id)
        const path = paths.get(id)
        return path === undefined ? { kind: 'jsonl', path: join(root, 'missing', id) } : { kind: 'jsonl', path }
      },
    })
    const fileTree = await fileChannel.buildSessionTree()
    assertColdTree('cold tree JSONL physical cut', fileTree)
    check(
      'cold tree live path keeps inherited session title',
      fileTree?.sessions.get('C')?.title === 'cold inherited title',
      fileTree?.sessions.get('C')?.title ?? 'missing',
    )
    check('cold tree JSONL does not touch unrelated same-cwd session', !located.includes('U'), located.join(','))

    const inspected: string[] = []
    const logs = new Map<string, readonly Ev[]>([['R', rootEvents], ['F1', f1Events]])
    const memoryChannel = makeTreeChannel({
      list: () => Promise.resolve(logicalHeaders),
      locate: () => ({ kind: 'memory' }),
      inspect(id: unknown) {
        const key = String(id)
        inspected.push(key)
        const events = logs.get(key) ?? []
        return Promise.resolve({
          events,
          inheritedEventCount: key === 'F1' ? 5 : 0,
        })
      },
    })
    const memoryTree = await memoryChannel.buildSessionTree()
    assertColdTree('cold tree non-file inspect cut', memoryTree)
    check(
      'cold tree non-file inspect keeps inherited session title',
      memoryTree?.sessions.get('F1')?.title === 'cold inherited title',
      memoryTree?.sessions.get('F1')?.title ?? 'missing',
    )
    check('cold tree inspect does not touch unrelated same-cwd session', !inspected.includes('U'), inspected.join(','))

    const unknownMiddleChannel = makeTreeChannel({
      list: () => Promise.resolve(logicalHeaders),
      locate: () => ({ kind: 'memory' }),
      inspect(id: unknown) {
        const key = String(id)
        if (key === 'R') return Promise.resolve({ events: rootEvents, inheritedEventCount: 0 })
        throw new Error('middle log unavailable')
      },
    })
    const unknownMiddleTree = await unknownMiddleChannel.buildSessionTree()
    const unknownMiddleFlat = unknownMiddleTree === null
      ? []
      : tree.flattenTree(unknownMiddleTree.roots, unknownMiddleTree.activeLeafId)
    check(
      'cold tree unknown-cut unreadable middle cannot hide child prefix',
      unknownMiddleTree !== null
        && unknownMiddleTree.roots.length === 2
        && unknownMiddleTree.sessions.get('F1')?.unreadable === true
        && unknownMiddleTree.activePath.has('C:2')
        && unknownMiddleFlat.some(row => row.node.id === 'C:2'),
      `roots=${unknownMiddleTree?.roots.length ?? 0} active=${unknownMiddleTree?.activePath.has('C:2') ?? false}`,
    )
    check(
      'cold tree rejects invalid inherited cuts',
      readInheritedCut({ seedLength: -1 }) === undefined
        && readInheritedCut({ seedLength: 0.5 }) === undefined
        && readInheritedCut({ seedLength: -0 }) === undefined
        && readInheritedCut({ inheritedEventCount: Number.MAX_SAFE_INTEGER + 1 }) === undefined,
    )
  } finally {
    delete process.env.DSH_TUI_SESSION_ROOT
    rmSync(root, { recursive: true, force: true })
  }
}

// ── 屏幕层：无头组装 ─────────────────────────────────────────────────────
{
  const [{ PassThrough, Writable }, React, { Terminal: XTerm }, { render, AlternateScreen }, { SessionTree }, { settle, settled, sleep }] = await Promise.all([
    import('node:stream'),
    import('react'),
    import('@xterm/headless'),
    import('../src/ui.js'),
    import('../src/screens/SessionTree.js'),
    import('./lib/term-test.mjs'),
  ])

  const COLS = 120, ROWS = 32
  const term = new XTerm({ cols: COLS, rows: ROWS, scrollback: 0, allowProposedApi: true })
  class FakeStdout extends Writable {
    columns = COLS; rows = ROWS; isTTY = true
    _write(chunk: unknown, _e: BufferEncoding, cb: () => void) { term.write(String(chunk), cb) }
  }
  class FakeStderr extends Writable { isTTY = true; _write(_c: unknown, _e: BufferEncoding, cb: () => void) { cb() } }
  class FakeStdin extends PassThrough {
    isTTY = true
    setRawMode() { return this }
    ref() { return this }
    unref() { return this }
  }
  const stdin = new FakeStdin(), stdout = new FakeStdout(), stderr = new FakeStderr()
  const screen = (): string[] => {
    const buf = term.buffer.active
    return Array.from({ length: ROWS }, (_, y) => buf.getLine(buf.baseY + y)?.translateToString(true) ?? '')
  }
  const text = (): string => screen().join('\n')

  const data = family()
  const calls: Array<{ sessionId: string; seq: number; mode?: string }> = []
  let closed = false
  const channel: any = {
    agentId: 'F1',
    buildSessionTree: () => Promise.resolve(data),
    rewindToNode: (sessionId: string, seq: number, mode?: string) => {
      calls.push({ sessionId, seq, mode })
      return Promise.resolve(mode === 'fork' ? '' : 'f1-新方向')
    },
    notify: () => {},
  }

  const inst = await render(
    <AlternateScreen>
      <SessionTree
        channel={channel}
        currentSessionId="F1"
        onClose={() => { closed = true }}
        onRestoreText={() => {}}
      />
    </AlternateScreen>,
    { stdout: stdout as any, stdin: stdin as any, stderr: stderr as any, exitOnCtrlC: false, patchConsole: false },
  )
  check('screen: 标题渲染', await settled(() => text().includes('会话树')))
  check('screen: 树行渲染（根问句）', await settled(() => text().includes('u0-问根')))
  check('screen: fork 分支渲染（新方向）', await settled(() => text().includes('f1-新方向')))
  check('screen: 连接线渲染', await settled(() => text().includes('├─') || text().includes('└─')))
  check('screen: 预览面板渲染', await settled(() => text().includes('预览')))

  // 鼠标滚轮：SGR wheel-down 打在树区域 = 光标下移一行（光标居中窗口，
  // 滚动即跟随），wheel-up 回去——与真实全屏终端投递同构。
  {
    const wheelRow = screen().findIndex(line => line.includes('❯')) + 1 // SGR 1-indexed
    stdin.write(`\x1b[<65;10;${wheelRow}M`)
    await sleep(200)
    check('screen: 鼠标滚轮下移光标一行', screen().findIndex(line => line.includes('❯')) === wheelRow, screen().filter(line => line.includes('❯')).join('|'))
    stdin.write(`\x1b[<64;10;${wheelRow}M`)
    await sleep(200)
    check('screen: 鼠标滚轮上移回去', screen().findIndex(line => line.includes('❯')) === wheelRow - 1, screen().filter(line => line.includes('❯')).join('|'))
  }

  // Enter 打开操作菜单（焦点在活动叶 = live 会话，无切换选项）
  stdin.write('\r')
  check('screen: Enter 打开操作菜单', await settled(() => text().includes('回退到这里') && text().includes('从这分叉')))
  check('screen: live 会话不提供切换选项', !text().includes('切换到该分支'))
  // Esc 关菜单，移到死分支（F2:14）再开：切换选项出现
  stdin.write('\x1b')
  await settle(() => !text().includes('回退到这里'))
  stdin.write('\x1b[B\x1b[B\x1b[B')
  // 焦点移动只改高亮样式，translateToString 读不到——无可观测文本条件，
  // 保留固定 pacing 等按键被处理。
  await sleep(200)
  stdin.write('\r')
  check('screen: 死分支提供切换选项', await settled(() => text().includes('切换到该分支')))

  // 字母直达：f = 从这分叉（焦点在 F2:14，经 channel 记录并关屏）
  stdin.write('f')
  check(
    'screen: 字母直达执行分叉',
    await settled(() => calls.length === 1 && calls[0]!.sessionId === 'F2' && calls[0]!.mode === 'fork'),
    JSON.stringify(calls),
  )
  check('screen: 执行成功后关屏', await settled(() => closed === true))
  await inst.unmount()

  // 再开一次：Esc 退出（无查询时）
  closed = false
  const inst2 = await render(
    <AlternateScreen>
      <SessionTree
        channel={channel}
        currentSessionId="F1"
        onClose={() => { closed = true }}
        onRestoreText={() => {}}
      />
    </AlternateScreen>,
    { stdout: stdout as any, stdin: stdin as any, stderr: stderr as any, exitOnCtrlC: false, patchConsole: false },
  )
  // 等新实例的界面就绪再发 Esc（前一实例 unmount 已离开 alt-screen，
  // 标题只会出现在新帧里）。
  await settle(() => text().includes('会话树'))
  stdin.write('\x1b')
  check('screen: Esc 直接退出', await settled(() => closed === true))
  await inst2.unmount()
}

console.log(failed === 0 ? '\nverify-session-tree: ALL PASS' : `\nverify-session-tree: ${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
