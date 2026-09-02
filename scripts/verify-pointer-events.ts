/**
 * verify-pointer-events — pointer 事件管线回归（审计后新增）。
 *
 * 覆盖：
 *   1. 解析层：SGR 滚轮坐标/修饰位保留、水平滚轮（66/67）、X10 点击/拖拽
 *      兜底解析、X10 无按钮 motion 吞掉、孤儿 SGR/X10 尾巴重合成、
 *      mouseTailHold 拆段宽限窗（两轮静默 flush 后尾段仍可重合成）、
 *      hold 卫生（1s 硬超时顶每次调用、独立完整 tail/新 ESC 前缀/完整
 *      事件/非 continuation 文本均丢弃或替换陈旧 hold）；
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
  check('SGR wheel modifiers decoded + raw button kept',
    km.kind === 'key' && km.shift === true && km.ctrl === true && km.meta === false && km.mouseButton === 84)

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

  // Classic X10 release: low bits 3 with M framing (button identity unknown).
  const x10Release = `\x1b[M${String.fromCharCode(3 + 32)}${String.fromCharCode(3 + 32)}${String.fromCharCode(4 + 32)}`
  const [xh] = parse(x10Release)
  check('X10 generic release parsed',
    xh.kind === 'mouse' && xh.action === 'release' && xh.button === 3 && xh.col === 3 && xh.row === 4)

  // Orphan SGR tail (ESC flushed separately) resynthesized — wheel survives
  const [o] = parse('[<64;74;16M')
  check('orphan SGR wheel tail resynthesized', o.kind === 'key' && o.name === 'wheelup' && o.mouseCol === 73)

  // Plain text that resembles a tail is NOT swallowed (typed [MAX] batch)
  const [t] = parse('[MAX]more')
  check('text not misparsed as mouse', t.kind === 'key' && (t.sequence === '[MAX]more' || t.name !== 'wheelup'))
}

// ── 1b. mouseTailHold 拆段宽限窗（SSH 抖动现场回归）────────────
// 现场：SGR press 被 ConPTY/SSH 拆成两段，App 的 50ms flush 把 ESC 前缀
// 冲刷进 hold；hold 哨兵让 flush 计时器续臂，第二个静默 flush（旧代码）
// 以"本次调用没碰过 hold"为由直接丢弃——间隔 >~100ms 的拆段必死，尾段
// `18;34M` 随后以普通文本漏进输入框。修复：宽限按首次捕获时刻计时
// （MOUSE_TAIL_HOLD_GRACE_MS=1000），而非"撑过一次 flush"。
{
  let state = INITIAL_STATE
  const feed = (input: string | null) => {
    const [keys, next] = parseMultipleKeypresses(state, input)
    state = next
    return keys
  }
  // 段 1：截断的 press 前缀。tokenizer 缓存不完整序列，本轮不出 key。
  const k1 = feed('\x1b[<0;18')
  check('hold: 截断前缀无 key 且缓冲非空', k1.length === 0 && state.incomplete !== '')
  // flush #1（50ms 静默）：前缀作为 sequence token 出清，进 hold。
  const f1 = feed(null)
  check(
    'hold: flush#1 捕获前缀、零泄漏',
    f1.length === 0 && state.mouseTailHold === '[<0;18' && state.mouseTailHoldAt !== undefined,
    `keys=${f1.length} hold=${JSON.stringify(state.mouseTailHold)}`,
  )
  // flush #2（再 50ms 静默）：旧代码在此丢弃 hold——回归断言核心。
  const f2 = feed(null)
  check(
    'hold: flush#2 后 hold 仍存活（宽限窗）',
    f2.length === 0 && state.mouseTailHold === '[<0;18',
    `keys=${f2.length} hold=${JSON.stringify(state.mouseTailHold)}`,
  )
  // 段 2 终于到达：与 hold 重合成完整 press，而不是漏成文本。
  const k2 = feed(';34M')
  check(
    'hold: 两轮 flush 后尾段重合成 press',
    k2.length === 1 &&
      k2[0]!.kind === 'mouse' &&
      (k2[0] as { action?: string }).action === 'press' &&
      (k2[0] as { col?: number }).col === 18 &&
      (k2[0] as { row?: number }).row === 34,
    JSON.stringify(k2),
  )
  check('hold: 重合成后 hold 清空', state.mouseTailHold === undefined)

  // 宽限窗到期：死报告（终端丢了尾巴）必须被丢弃而非永驻——回填
  // 一个超出窗的捕获时刻，下一轮 flush 即清。
  feed('\x1b[<0;18')
  feed(null)
  state = { ...state, mouseTailHoldAt: Date.now() - 2000 }
  const f3 = feed(null)
  check(
    'hold: 超窗死报告被丢弃且哨兵解除',
    f3.length === 0 && state.mouseTailHold === undefined && state.incomplete === '',
    `keys=${f3.length} hold=${JSON.stringify(state.mouseTailHold)} incomplete=${JSON.stringify(state.incomplete)}`,
  )

  // hold 存活期间的普通打字（非数字/分号）不受影响，照样成 key。
  // 同时：非 continuation 文本证明报告已死——hold 必须当场清掉，否则
  // 迟到的 `;34M` 会被拼成 phantom press。
  feed('\x1b[<0;18')
  feed(null)
  const k3 = feed('ab')
  check(
    'hold: 存活期打字照常通过',
    k3.length === 1 && k3[0]!.kind === 'key' && (k3[0] as { sequence?: string }).sequence === 'ab',
    JSON.stringify(k3.map((k) => (k.kind === 'key' ? k.sequence : k.kind))),
  )
  check('hold: 非 continuation 打字后 hold 已清', state.mouseTailHold === undefined)
  const k4 = feed(';34M')
  check(
    'hold: 死报告的迟到尾段不再重合成（按文本通过）',
    k4.length === 1 && k4[0]!.kind === 'key' && (k4[0] as { sequence?: string }).sequence === ';34M',
    JSON.stringify(k4.map((k) => (k.kind === 'key' ? k.sequence : k.kind))),
  )

  // 陈旧 hold + 独立完整 SGR tail：tail 自身完整（孤儿），旧 hold 属另一份
  // 死报告——必须丢弃旧 hold 干净重合成 wheel，而不是拼成
  // ESC+hold+tail 的垃圾 key 把协议字节漏进输入框。
  feed('\x1b[<0;18')
  feed(null)
  const k5 = feed('[<64;74;16M')
  check(
    'hold: 陈旧 hold + 独立完整 tail → 干净 wheelup',
    k5.length === 1 &&
      k5[0]!.kind === 'key' &&
      (k5[0] as { name?: string }).name === 'wheelup' &&
      (k5[0] as { mouseCol?: number }).mouseCol === 73,
    JSON.stringify(k5.map((k) => (k.kind === 'key' ? k.name : k.kind))),
  )
  check('hold: 独立 tail 后 hold 已清', state.mouseTailHold === undefined)

  // 新 ESC 前缀 REPLACE 旧 hold（而非 append）：旧报告已死，新报告自己完成。
  feed('\x1b[<0;18')
  feed(null) // hold = '[<0;18'
  feed('\x1b[<0;5') // 新截断前缀（tokenizer 先缓冲）
  feed(null) // flush：新前缀出清为 sequence token → 替换 hold
  check(
    'hold: 新 ESC 前缀替换（而非拼接）陈旧 hold',
    state.mouseTailHold === '[<0;5',
    `hold=${JSON.stringify(state.mouseTailHold)}`,
  )
  const k6 = feed(';7M')
  check(
    'hold: 替换后的 hold 补全第二份报告',
    k6.length === 1 &&
      k6[0]!.kind === 'mouse' &&
      (k6[0] as { action?: string }).action === 'press' &&
      (k6[0] as { col?: number }).col === 5 &&
      (k6[0] as { row?: number }).row === 7,
    JSON.stringify(k6),
  )

  // 完整鼠标事件到达即清陈旧 hold：后续迟到尾段不得重合成。
  feed('\x1b[<0;18')
  feed(null)
  const k7 = feed('\x1b[<0;9;9M')
  check(
    'hold: 完整事件照常解析且清掉陈旧 hold',
    k7.length === 1 && k7[0]!.kind === 'mouse' && state.mouseTailHold === undefined,
    JSON.stringify(k7),
  )
  const k8 = feed(';34M')
  check(
    'hold: 完整事件后的迟到尾段按文本通过',
    k8.length === 1 && k8[0]!.kind === 'key' && (k8[0] as { sequence?: string }).sequence === ';34M',
    JSON.stringify(k8.map((k) => (k.kind === 'key' ? k.sequence : k.kind))),
  )

  // 硬超时不再依赖 flush：连续输入会持续重臂 50ms flush 计时器，超窗后的
  // 非 flush continuation 在旧代码里仍会被拼接——入口 deadline 检查先丢。
  feed('\x1b[<0;18')
  feed(null)
  state = { ...state, mouseTailHoldAt: Date.now() - 2000 }
  const k9 = feed(';34M') // 非 flush 调用
  check(
    'hold: 超窗后非 flush continuation 不再拼接',
    k9.length === 1 &&
      k9[0]!.kind === 'key' &&
      (k9[0] as { sequence?: string }).sequence === ';34M' &&
      state.mouseTailHold === undefined,
    JSON.stringify(k9),
  )

  // 连续数字输入：宽限窗内 digits/分号会被当作 continuation 吞进 hold
  // （固有歧义——无法与真实尾段区分——由 1s 硬超时封顶）；超窗后照常通过。
  feed('\x1b[<0;18')
  feed(null)
  const k10 = feed('123')
  check(
    'hold: 窗内连续数字按 continuation 吞并（歧义由硬超时封顶）',
    k10.length === 0 && state.mouseTailHold === '[<0;18123',
    `keys=${k10.length} hold=${JSON.stringify(state.mouseTailHold)}`,
  )
  state = { ...state, mouseTailHoldAt: Date.now() - 2000 }
  const k11 = feed('456')
  check(
    'hold: 超窗后数字照常通过',
    k11.length === 1 && (k11[0] as { sequence?: string }).sequence === '456',
    JSON.stringify(k11.map((k) => (k.kind === 'key' ? k.sequence : k.kind))),
  )
}

// ── 1c. P1-4 流式消费与边界场景（第四轮评审） ──
{
  // tail + text suffix：`;34Mabc` 从 token 开头切出完整报告，后缀按普通输入
  let state = INITIAL_STATE
  const feed = (s: string | null) => {
    const [keys, next] = parseMultipleKeypresses(state, s)
    state = next
    return keys
  }
  feed('\x1b[<0;18')
  feed(null) // flush → hold 捕获
  const k1 = feed(';34Mabc')
  check(
    'hold: tail+text 流式消费（;34Mabc → press + abc）',
    k1.length === 2 &&
      k1[0]!.kind === 'mouse' &&
      (k1[0] as { action?: string }).action === 'press' &&
      k1[1]!.kind === 'key' &&
      (k1[1] as { sequence?: string }).sequence === 'abc',
    JSON.stringify(k1.map((k) => (k.kind === 'key' ? k.sequence : k.kind))),
  )
  check('hold: 流式消费后 hold 清空', state.mouseTailHold === undefined)

  // tail + release suffix：`;34mxyz`
  state = INITIAL_STATE
  feed('\x1b[<0;18')
  feed(null)
  const k2 = feed(';34mxyz')
  check(
    'hold: tail+text 流式消费 release（;34mxyz → release + xyz）',
    k2.length === 2 &&
      k2[0]!.kind === 'mouse' &&
      (k2[0] as { action?: string }).action === 'release' &&
      k2[1]!.kind === 'key' &&
      (k2[1] as { sequence?: string }).sequence === 'xyz',
    JSON.stringify(k2.map((k) => (k.kind === 'key' ? k.sequence : k.kind))),
  )

  // tail + 后续未完成 CSI：`;34Mabc ESC[` —— suffix 里的未完成协议不损坏
  state = INITIAL_STATE
  feed('\x1b[<0;18')
  feed(null)
  const k3 = feed(';34Mabc\x1b[')
  check(
    'hold: tail+text+incomplete CSI（;34Mabc ESC[ → press + abc + incomplete）',
    k3.length === 2 &&
      k3[0]!.kind === 'mouse' &&
      k3[1]!.kind === 'key' &&
      (k3[1] as { sequence?: string }).sequence === 'abc' &&
      state.incomplete === '\x1b[',
    `keys=${k3.map((k) => (k.kind === 'key' ? k.sequence : k.kind)).join(',')} incomplete=${JSON.stringify(state.incomplete)}`,
  )
  // 后续输入完成 CSI
  const k4 = feed('A')
  check(
    'hold: 后续输入完成 CSI（ESC[A → Shift+Up）',
    k4.length === 1 && k4[0]!.kind === 'key' && (k4[0] as { name?: string }).name === 'up',
    JSON.stringify(k4.map((k) => (k.kind === 'key' ? k.name : k.kind))),
  )

  // 分段 wheel：ESC[<64;74 → flush → ;16M —— 解析为 wheelup，无永久闩锁
  state = INITIAL_STATE
  feed('\x1b[<64;74')
  feed(null)
  const k5 = feed(';16M')
  check(
    'hold: 分段 wheel 解析为 wheelup（无永久闩锁）',
    k5.length === 1 && k5[0]!.kind === 'key' && (k5[0] as { name?: string }).name === 'wheelup',
    JSON.stringify(k5.map((k) => (k.kind === 'key' ? k.name : k.kind))),
  )
  check('hold: 分段 wheel 后 hold 清空', state.mouseTailHold === undefined)

  // paste 边界：hold 后 paste 开始，迟到尾段不合成 phantom press
  state = INITIAL_STATE
  feed('\x1b[<0;18')
  feed(null)
  feed('\x1b[200~pasted text\x1b[201~')
  const k6 = feed(';34M')
  check(
    'hold: paste 边界后迟到尾段按文本通过（无 phantom press）',
    k6.length === 1 && k6[0]!.kind === 'key' && (k6[0] as { sequence?: string }).sequence === ';34M',
    JSON.stringify(k6.map((k) => (k.kind === 'key' ? k.sequence : k.kind))),
  )
  check('hold: paste 边界后 hold 清空', state.mouseTailHold === undefined)

  // P1-1 回归（第五轮评审）：stale hold + response/CSI/paste 先使 hold 失效，
  // 再出现 tail-shaped text —— 绝不能合成 phantom mouse。
  // DA1 response 边界
  state = INITIAL_STATE
  feed('\x1b[<0;18')
  feed(null)
  const k7 = feed('\x1b[?1;2c;34M[<1;19;35M')
  check(
    'hold: response 使 hold 失效后 tail-shaped text 不合成 phantom mouse',
    k7.length === 2 &&
      k7[0]!.kind === 'response' &&
      k7[1]!.kind === 'key' &&
      (k7[1] as { sequence?: string }).sequence === ';34M[<1;19;35M',
    JSON.stringify(k7.map((k) => (k.kind === 'key' ? k.sequence : k.kind))),
  )
  check('hold: response 边界后 hold 清空', state.mouseTailHold === undefined)

  // 普通 CSI（方向键）边界
  state = INITIAL_STATE
  feed('\x1b[<0;18')
  feed(null)
  const k8 = feed('\x1b[A;34M')
  check(
    'hold: 普通 CSI 使 hold 失效后 tail-shaped text 按文本通过',
    k8.length === 2 &&
      k8[0]!.kind === 'key' &&
      (k8[0] as { name?: string }).name === 'up' &&
      k8[1]!.kind === 'key' &&
      (k8[1] as { sequence?: string }).sequence === ';34M',
    JSON.stringify(k8.map((k) => (k.kind === 'key' ? (k.name || k.sequence) : k.kind))),
  )
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
  const consumed = dispatchWheel(root, 4, 2, -3, 0, 84)
  check('dispatchWheel routes to onWheel under pointer', consumed && wheelEvent !== undefined)
  check('WheelEvent carries deltas + coords + modifiers',
    wheelEvent !== undefined && wheelEvent.deltaY === -3 && wheelEvent.col === 4 && wheelEvent.row === 2 &&
      wheelEvent.shift && wheelEvent.ctrl && !wheelEvent.alt)

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
