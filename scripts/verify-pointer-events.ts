/**
 * verify-pointer-events — pointer 事件管线回归（审计后新增）。
 *
 * 覆盖：
 *   1. 解析层：SGR 滚轮坐标/修饰位保留、水平滚轮（66/67）、X10 点击/拖拽
 *      兜底解析、X10 无按钮 motion 吞掉、孤儿 SGR/X10 尾巴重合成；
 *   2. 事件模型：PointerEvent 修饰位解码、ClickEvent 规格化（低按钮位清零、
 *      修饰位保留）、_prepareForTarget 本地坐标；
 *   3. 派发层：dispatchClick 错误隔离（一个 handler 抛错不中断冒泡）、
 *      dispatchWheel 命中 onWheel / 无 handler 返回 false、dispatchHover
 *      携带事件参数；
 *   4. 边界防护：handleMouseEvent 越界坐标 clamp；App.resetPointerState
 *      清理多击链/hover 去重/挂起超链接并收尾拖拽。
 *
 * 运行：node --import tsx/esm scripts/verify-pointer-events.ts
 */
import {
  INITIAL_STATE,
  parseMultipleKeypresses,
} from '../src/ink/parse-keypress.js'
import { ClickEvent } from '../src/ink/events/click-event.js'
import { PointerEvent } from '../src/ink/events/pointer-event.js'
import { dispatchClick, dispatchHover, dispatchWheel, clearHovered, hitTest } from '../src/ink/hit-test.js'
import { nodeCache } from '../src/ink/node-cache.js'
import type { DOMElement } from '../src/ink/dom.js'
import { createNode } from '../src/ink/dom.js'
import { handleMouseEvent, default as AppComponent } from '../src/ink/components/App.js'
import { createSelectionState, hasSelection } from '../src/ink/selection.js'
import React from 'react'

let failures = 0
function check(name: string, ok: boolean, extra = ''): void {
  const mark = ok ? 'ok  ' : 'FAIL'
  console.log(`${mark} ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failures++
}

function parse(seq: string) {
  const [keys] = parseMultipleKeypresses(INITIAL_STATE, seq)
  return keys
}

// ── 1. 解析层 ──────────────────────────────────────────────
{
  // SGR wheel up at col 74 row 16 (1-indexed) — CSI < 64;74;16 M
  const [k] = parse('\x1b[<64;74;16M')
  check('SGR wheelup name', k.kind === 'key' && k.name === 'wheelup')
  check('SGR wheelup coords kept (0-indexed)', k.kind === 'key' && k.mouseCol === 73 && k.mouseRow === 15,
    `${(k as { mouseCol?: number }).mouseCol},${(k as { mouseRow?: number }).mouseRow}`)

  const [kd] = parse('\x1b[<65;5;6M')
  check('SGR wheeldown coords', kd.kind === 'key' && kd.name === 'wheeldown' && kd.mouseCol === 4 && kd.mouseRow === 5)

  // Modifier bits: Shift(0x04) Ctrl(0x10) on wheel-up → button 64+4+16=84
  const [km] = parse('\x1b[<84;10;10M')
  check('SGR wheel modifiers decoded', km.kind === 'key' && km.shift === true && km.ctrl === true && km.meta === false)

  // Horizontal wheel: 66=left, 67=right
  const [kl] = parse('\x1b[<66;3;4M')
  check('SGR wheelleft parsed', kl.kind === 'key' && kl.name === 'wheelleft' && kl.mouseCol === 2)
  const [kr] = parse('\x1b[<67;3;4M')
  check('SGR wheelright parsed', kr.kind === 'key' && kr.name === 'wheelright')

  // SGR click press/release still ParsedMouse with coords
  const [p] = parse('\x1b[<0;10;5M')
  check('SGR press stays mouse', p.kind === 'mouse' && p.action === 'press' && p.col === 10 && p.row === 5)
  const [r] = parse('\x1b[<0;10;5m')
  check('SGR release stays mouse', r.kind === 'mouse' && r.action === 'release')

  // X10 click: Cb=32(left)+32=64'@', col=33('!')… col 5 → 5+32=37 '&', row 6+32=38 '''
  const seq = `\x1b[M${String.fromCharCode(0 + 32)}${String.fromCharCode(5 + 32)}${String.fromCharCode(6 + 32)}`
  const [x] = parse(seq)
  check('X10 click parsed as mouse', x.kind === 'mouse' && x.action === 'press' && x.col === 5 && x.row === 6,
    x.kind === 'mouse' ? `${x.col},${x.row}` : String(x.name))

  // X10 drag (motion bit 0x20 + left = 0x20): Cb=0x20+32=64 '@'
  const dragSeq = `\x1b[M${String.fromCharCode(0x20 + 32)}${String.fromCharCode(8 + 32)}${String.fromCharCode(9 + 32)}`
  const [xd] = parse(dragSeq)
  check('X10 drag parsed (button carries motion bit)', xd.kind === 'mouse' && (xd.button & 0x20) !== 0)

  // X10 wheel up: code 0x40 → Cb 0x40+32=0x60 '`'
  const x10Wheel = `\x1b[M${String.fromCharCode(0x40 + 32)}${String.fromCharCode(3 + 32)}${String.fromCharCode(4 + 32)}`
  const [xw] = parse(x10Wheel)
  check('X10 wheel → key with coords', xw.kind === 'key' && xw.name === 'wheelup' && xw.mouseCol === 2 && xw.mouseRow === 3)

  // X10 no-button motion without drag bit (unsupported hover) → swallowed as inert key
  const x10Hover = `\x1b[M${String.fromCharCode(3 + 32)}${String.fromCharCode(3 + 32)}${String.fromCharCode(4 + 32)}`
  const [xh] = parse(x10Hover)
  check('X10 no-button motion swallowed', xh.kind === 'key' && xh.name === 'mouse')

  // Orphan SGR tail (ESC flushed separately) resynthesized — wheel survives
  const [o] = parse('[<64;74;16M')
  check('orphan SGR wheel tail resynthesized', o.kind === 'key' && o.name === 'wheelup' && o.mouseCol === 73)

  // Plain text that resembles a tail is NOT swallowed (typed [MAX] batch)
  const [t] = parse('[MAX]more')
  check('text not misparsed as mouse', t.kind === 'key' && (t.sequence === '[MAX]more' || t.name !== 'wheelup'))
}

// ── 2. 事件模型 ────────────────────────────────────────────
{
  const e = new PointerEvent('pointermove', 5, 6, { button: 0x04 | 0x08 | 0x10 })
  check('PointerEvent modifiers', e.shift && e.alt && e.ctrl && !e.meta)

  const c = new ClickEvent(3, 4, false, { button: 0x01 | 0x04 })
  check('ClickEvent normalizes button bits, keeps shift', c.button === 0x04 && c.shift === true && !c.ctrl)
  check('ClickEvent is a release action', c.action === 'release')

  // local coords via _prepareForTarget (nodeCache rect)
  const node = createNode('ink-box')
  nodeCache.set(node, { x: 10, y: 20, width: 5, height: 3 })
  const e2 = new PointerEvent('click', 12, 21)
  e2._prepareForTarget(node)
  check('local coords from nodeCache rect', e2.localCol === 2 && e2.localRow === 1)
}

// ── 3. 派发层（手工 DOM 树）────────────────────────────────
function makeTree(): { root: DOMElement; parent: DOMElement; child: DOMElement } {
  const root = createNode('ink-root')
  const parent = createNode('ink-box')
  const child = createNode('ink-box')
  root.childNodes.push(parent)
  parent.parentNode = root
  parent.childNodes.push(child)
  child.parentNode = parent
  nodeCache.set(root, { x: 0, y: 0, width: 40, height: 12 })
  nodeCache.set(parent, { x: 2, y: 2, width: 20, height: 5 })
  nodeCache.set(child, { x: 2, y: 2, width: 6, height: 1 })
  return { root, parent, child }
}

{
  const { root, parent, child } = makeTree()
  const calls: string[] = []
  child._eventHandlers = {
    onClick: () => {
      calls.push('child')
      throw new Error('handler boom')
    },
  }
  parent._eventHandlers = {
    onClick: (e: ClickEvent) => {
      calls.push(`parent local=${e.localCol},${e.localRow}`)
    },
  }
  const handled = dispatchClick(root, 4, 2, false)
  check('dispatchClick error isolation: bubble continues past throwing child',
    calls.length === 2 && calls[1]!.startsWith('parent'),
    calls.join(' | '))
  check('dispatchClick reports handled', handled === true)
  check('parent sees local coords', calls[1] === 'parent local=2,0')
}

{
  const { root, child } = makeTree()
  let wheelEvent: InstanceType<typeof import('../src/ink/events/wheel-event.js').WheelEvent> | undefined
  child._eventHandlers = {
    onWheel: (e) => {
      wheelEvent = e
    },
  }
  const consumed = dispatchWheel(root, 4, 2, -3, 0)
  check('dispatchWheel routes to onWheel under pointer', consumed && wheelEvent !== undefined)
  check('WheelEvent carries deltas + coords',
    wheelEvent !== undefined && wheelEvent.deltaY === -3 && wheelEvent.col === 4 && wheelEvent.row === 2)

  const missRoot = createNode('ink-root')
  nodeCache.set(missRoot, { x: 0, y: 0, width: 40, height: 12 })
  check('dispatchWheel false without handler', dispatchWheel(missRoot, 4, 2, 3) === false)
  check('hitTest misses outside rect', hitTest(missRoot, 100, 100) === null)
}

{
  const { root, parent } = makeTree()
  let enterArg: PointerEvent | undefined
  parent._eventHandlers = {
    onMouseEnter: (e) => {
      enterArg = e
    },
    onMouseLeave: (e) => {
      enterArg = e
    },
  }
  const hovered = new Set<DOMElement>()
  dispatchHover(root, 10, 5, hovered)
  check('hover enter fired with pointer event arg', enterArg !== undefined && enterArg.col === 10)
  check('hover set populated', hovered.has(parent))
  enterArg = undefined
  dispatchHover(root, 1, 1, hovered) // outside parent → leave
  check('hover leave fired', enterArg !== undefined && !hovered.has(parent))
}

{
  // clearHovered（resize / 换屏时的指针态重置）：必须先派发 leave 再清空，
  // 否则被划过的行 hovered=true 永远滞留（用户报告：resume 页高亮不消失）
  const { root } = makeTree()
  const rowA = createNode('ink-box')
  const rowB = createNode('ink-box')
  root.childNodes.push(rowA, rowB)
  rowA.parentNode = root
  rowB.parentNode = root
  nodeCache.set(rowA, { x: 0, y: 2, width: 20, height: 1 })
  nodeCache.set(rowB, { x: 0, y: 3, width: 20, height: 1 })
  let aLeft = 0
  let bLeft = 0
  rowA._eventHandlers = { onMouseLeave: () => { aLeft++ } }
  rowB._eventHandlers = { onMouseLeave: () => { bLeft++ } }
  const hovered = new Set<DOMElement>()
  dispatchHover(root, 4, 2, hovered)
  dispatchHover(root, 4, 3, hovered)
  check('moving between rows leaves the old row', aLeft === 1 && hovered.has(rowB) && !hovered.has(rowA))
  clearHovered(hovered)
  check('clearHovered fires leave on every tracked row', aLeft === 1 && bLeft === 1, `a=${aLeft} b=${bLeft}`)
  check('clearHovered empties the set', hovered.size === 0)
  // 再移动到新行：旧行不再重放 leave（恰好一次），新行正常 enter
  let bEnter = 0
  rowB._eventHandlers = { onMouseEnter: () => { bEnter++ }, onMouseLeave: () => { bLeft++ } }
  dispatchHover(root, 4, 3, hovered)
  check('post-clear motion re-enters cleanly', bEnter === 1 && bLeft === 1 && hovered.has(rowB))
}

// ── 4. App 边界防护（最小 fake app）─────────────────────────
type FakeApp = Parameters<typeof handleMouseEvent>[0]

function makeFakeApp(): FakeApp {
  const app = {
    props: {
      selection: createSelectionState(),
      terminalColumns: 20,
      terminalRows: 10,
      onSelectionChange: () => {},
      onClickAt: () => false,
      onHoverAt: () => {},
      getHyperlinkAt: () => undefined,
      onOpenHyperlink: () => {},
      onMultiClick: () => {},
      onSelectionDrag: () => {},
      onWheelAt: () => false,
    },
    clickCount: 0,
    lastClickTime: 0,
    lastClickCol: -1,
    lastClickRow: -1,
    lastHoverCol: -1,
    lastHoverRow: -1,
    pendingHyperlinkTimer: null,
    // drag 协议新增的实例面：mock 镜像真实 App（resetPointerState 会调
    // finishDragSession 收尾 drag 会话；本脚本的 press 无 onDragTargetAt，
    // 会话恒为 null，真实原型方法自然 no-op）。
    dragSession: null,
    finishDragSession: AppComponent.prototype.finishDragSession,
  } as unknown as FakeApp
  return app
}

{
  // Clamp: terminal reports col 99 row 99 on a 20x10 frame
  const app = makeFakeApp()
  handleMouseEvent(app, { kind: 'mouse', button: 0, action: 'press', col: 99, row: 99, sequence: '' })
  const sel = (app.props as { selection: import('../src/ink/selection.js').SelectionState }).selection
  check('out-of-bounds press clamped to frame', sel.anchor !== null && sel.anchor.col === 19 && sel.anchor.row === 9,
    sel.anchor ? `${sel.anchor.col},${sel.anchor.row}` : 'null')

  // In-bounds click unaffected
  const app2 = makeFakeApp()
  handleMouseEvent(app2, { kind: 'mouse', button: 0, action: 'press', col: 5, row: 5, sequence: '' })
  const sel2 = (app2.props as { selection: import('../src/ink/selection.js').SelectionState }).selection
  check('in-bounds press passes through', sel2.anchor !== null && sel2.anchor.col === 4 && sel2.anchor.row === 4)
}

{
  // resetPointerState: multi-click chain + interrupted drag settle
  const App = (await import('../src/ink/components/App.js')).default
  const app = makeFakeApp() as never as InstanceType<typeof App>
  const sel = (app.props as { selection: import('../src/ink/selection.js').SelectionState }).selection
  // Click 1: press + release (chain starts)
  handleMouseEvent(app, { kind: 'mouse', button: 0, action: 'press', col: 5, row: 5, sequence: '' })
  handleMouseEvent(app, { kind: 'mouse', button: 0, action: 'release', col: 5, row: 5, sequence: '' })
  // Click 2 at the same cell → multi-click chain reaches 2 (onMultiClick is
  // a no-op stub here; the real one selects the word)
  handleMouseEvent(app, { kind: 'mouse', button: 0, action: 'press', col: 5, row: 5, sequence: '' })
  const hadChain = (app as unknown as { clickCount: number }).clickCount === 2
  // A press far away starts a FRESH chain → startSelection runs → the
  // screen swaps BEFORE the release arrives (interrupted drag)
  handleMouseEvent(app, { kind: 'mouse', button: 0, action: 'press', col: 8, row: 8, sequence: '' })
  const dragging = sel.isDragging === true
  App.prototype.resetPointerState.call(app)
  check('click chain existed before reset', hadChain)
  check('drag was active before reset', dragging)
  check('resetPointerState clears clickCount', (app as unknown as { clickCount: number }).clickCount === 0)
  check('resetPointerState settles interrupted drag', sel.isDragging === false)
  check('resetPointerState clears hover dedupe', (app as unknown as { lastHoverCol: number }).lastHoverCol === -1)
}

if (failures > 0) {
  console.error(`\nverify-pointer-events: ${failures} check(s) FAILED`)
  process.exit(1)
}
console.log('\nverify-pointer-events: all checks passed')
