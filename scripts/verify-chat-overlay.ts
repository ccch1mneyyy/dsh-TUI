/**
 * verify-chat-overlay — transition tests for the chat transient-dialog
 * state machine (src/screens/chatOverlay.ts).
 *
 * Chat 底部瞬态浮层(picker/对话框/tips)收敛为一个判别联合后,互斥、环绕
 * 移动、异步回调的 kind 守卫、以及 OverlayAbove 的挂载谓词全部变成可以
 * 离线断言的纯函数——本脚本把布尔时代的行为表逐项钉死:
 *   - open 是替换语义(异步 open 迟到时顶掉当前浮层,不再叠开)
 *   - close-if 只关自己(加载失败的回调不能误关用户后来打开的浮层)
 *   - move 的环绕公式与旧逐 picker 手写公式逐点一致,空表 no-op
 *   - rewind 的 busy/confirm/modes 三段流转与键盘分支的语义相同
 *   - dialogOverlayVisible 与旧 dialogOverlayOpen 聚合(含数据门与 tips
 *     空浮层怪癖)逐 kind 等值
 */
import {
  NO_OVERLAY,
  chatOverlayReducer,
  dialogOverlayVisible,
  wrapIndex,
  type ChatOverlay,
  type ChatOverlayAction,
} from '../src/screens/chatOverlay.js'
import type { ChatRow } from '../src/dsh-adapter/channel.js'

let failures = 0

function check(name: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) {
    failures++
    console.error(`FAIL ${name}`)
    console.error(`      expected: ${e}`)
    console.error(`      actual:   ${a}`)
  } else {
    console.log(`ok   ${name}`)
  }
}

function reduce(state: ChatOverlay, ...actions: ChatOverlayAction[]): ChatOverlay {
  return actions.reduce(chatOverlayReducer, state)
}

const fakeRow = { id: 7, kind: 'user', text: 'prompt' } as unknown as ChatRow

// --- T1: open replaces, close resets -------------------------------------
check('T1a open from none', reduce(NO_OVERLAY, { type: 'open', overlay: { kind: 'model', index: 2 } }), { kind: 'model', index: 2 })
check(
  'T1b async open replaces the current overlay (effort landing over model)',
  reduce(
    { kind: 'model', index: 2 },
    { type: 'open', overlay: { kind: 'effort', index: 1 } },
  ),
  { kind: 'effort', index: 1 },
)
check('T1c close', reduce({ kind: 'tips' }, { type: 'close' }), { kind: 'none' })
check(
  'T1d open-if drops a stale async open when the user opened something else',
  reduce({ kind: 'model', index: 0 }, { type: 'open-if', overlay: { kind: 'effort', index: 1 }, when: ['none'] }),
  { kind: 'model', index: 0 },
)
check(
  'T1e open-if opens over an allowed kind (idle, and flow stage transitions)',
  [
    reduce(NO_OVERLAY, { type: 'open-if', overlay: { kind: 'effort', index: 1 }, when: ['none'] }),
    reduce(
      { kind: 'workspace-flow', flow: { kind: 'choices', title: 'a', choices: [] } as never, index: 2, busy: true, input: null },
      { type: 'open-if', overlay: { kind: 'workspace-flow', flow: { kind: 'choices', title: 'b', choices: [] } as never, index: 0, busy: false, input: null }, when: ['none', 'workspace-flow'] },
    ).kind,
  ],
  [{ kind: 'effort', index: 1 }, 'workspace-flow'],
)

// --- T2: close-if only closes its own kind -------------------------------
check('T2a close-if matching', reduce({ kind: 'preset', index: 0 }, { type: 'close-if', kind: 'preset' }), { kind: 'none' })
check(
  'T2b close-if mismatched is a no-op (stale loader must not close the picker the user opened later)',
  reduce({ kind: 'model', index: 1 }, { type: 'close-if', kind: 'preset' }),
  { kind: 'model', index: 1 },
)

// --- T3: move wrap parity with the boolean-era per-picker formulas --------
check('T3a up from 0 wraps to count-1', reduce({ kind: 'theme', index: 0 }, { type: 'move', delta: -1, count: 5 }), { kind: 'theme', index: 4 })
check('T3b down from count-1 wraps to 0', reduce({ kind: 'theme', index: 4 }, { type: 'move', delta: 1, count: 5 }), { kind: 'theme', index: 0 })
check('T3c empty list is a no-op (skills while the snapshot loads)', reduce({ kind: 'skills', index: 0 }, { type: 'move', delta: 1, count: 0 }), { kind: 'skills', index: 0 })
// The /plan and /lang branches hand-wrote two-entry toggles; the shared
// wrap must reproduce them exactly.
check('T3d two-entry up parity', [wrapIndex(0, -1, 2), wrapIndex(1, -1, 2)], [1, 0])
check('T3e two-entry down parity', [wrapIndex(0, 1, 2), wrapIndex(1, 1, 2)], [1, 0])
check('T3f thinking focus toggles on either arrow', reduce({ kind: 'thinking', focus: 0 }, { type: 'move', delta: 1, count: 2 }, { type: 'move', delta: 1, count: 2 }), { kind: 'thinking', focus: 0 })
// The /effort slider used a modulo formula; same fixed points.
check('T3g effort modulo parity', [wrapIndex(1, -1, 3), wrapIndex(2, 1, 3)], [0, 0])

// --- T4: set-index is kind-guarded ---------------------------------------
check('T4a set-index applies on its picker', reduce({ kind: 'model', index: 0 }, { type: 'set-index', kind: 'model', index: 3 }), { kind: 'model', index: 3 })
check(
  'T4b stale loader set-index ignored after the picker changed',
  reduce({ kind: 'theme', index: 1 }, { type: 'set-index', kind: 'model', index: 3 }),
  { kind: 'theme', index: 1 },
)
check(
  'T4c mouse pick sets an absolute index on panels that stay open (effort, rewind list)',
  [
    reduce({ kind: 'effort', index: 0 }, { type: 'set-index', kind: 'effort', index: 2 }),
    reduce(
      { kind: 'rewind', index: 0, confirm: null, modes: null, modeIndex: 0, busy: false },
      { type: 'set-index', kind: 'rewind', index: 2 },
    ).index,
  ],
  [{ kind: 'effort', index: 2 }, 2],
)

// --- T5: history draft edits ---------------------------------------------
check(
  'T5a partial patch keeps unnamed fields',
  reduce({ kind: 'history', query: 'ab', cursor: 2, focus: 3 }, { type: 'history-edit', cursor: 1 }),
  { kind: 'history', query: 'ab', cursor: 1, focus: 3 },
)
check(
  'T5b edit ignored outside history',
  reduce({ kind: 'search' }, { type: 'history-edit', query: 'x' }),
  { kind: 'search' },
)

// --- T6: workspace-flow sub-state ----------------------------------------
const flow = { kind: 'choices', title: 't', choices: [] } as never
const flowState: ChatOverlay = { kind: 'workspace-flow', flow, index: 0, busy: false, input: null }
check('T6a flow-busy applies', reduce(flowState, { type: 'flow-busy', busy: true }), { ...flowState, busy: true })
check('T6b flow-busy ignored elsewhere', reduce({ kind: 'tips' }, { type: 'flow-busy', busy: true }), { kind: 'tips' })
const flowInput = { choiceId: 'c', value: 'ab', cursor: 2 }
check('T6c flow-input enters editing', reduce(flowState, { type: 'flow-input', input: flowInput }), { ...flowState, input: flowInput })
check(
  'T6d flow-input-edit rewrites value+cursor',
  reduce({ ...flowState, input: flowInput }, { type: 'flow-input-edit', value: 'a', cursor: 1 }),
  { ...flowState, input: { choiceId: 'c', value: 'a', cursor: 1 } },
)
check('T6e flow-input-edit without an input is a no-op', reduce(flowState, { type: 'flow-input-edit', value: 'a', cursor: 1 }), flowState)

// --- T7: rewind three-stage flow -----------------------------------------
const rewindList: ChatOverlay = { kind: 'rewind', index: 1, confirm: null, modes: null, modeIndex: 0, busy: false }
check('T7a list move targets the candidate cursor', reduce(rewindList, { type: 'move', delta: 1, count: 3 }), { ...rewindList, index: 2 })
check('T7b busy set', reduce(rewindList, { type: 'rewind-busy', busy: true }), { ...rewindList, busy: true })
const modes = [{ id: 'files', label: 'files' }] as never
check(
  'T7c decision lands: busy clears, confirm+modes set, modeIndex reset',
  reduce({ ...rewindList, busy: true }, { type: 'rewind-decision', confirm: fakeRow, modes }),
  { ...rewindList, busy: false, confirm: fakeRow, modes, modeIndex: 0 },
)
check(
  'T7d move in the modes pane targets modeIndex, not the list index',
  reduce({ ...rewindList, confirm: fakeRow, modes }, { type: 'move', delta: 1, count: 2 }),
  { ...rewindList, confirm: fakeRow, modes, modeIndex: 1 },
)
check(
  'T7e move on the plain confirm pane is a no-op (Enter/Esc only)',
  reduce({ ...rewindList, confirm: fakeRow }, { type: 'move', delta: 1, count: 3 }),
  { ...rewindList, confirm: fakeRow },
)
check(
  // Boolean-era parity: Esc from the modes pane cleared confirm+modes but
  // left modeIndex as-is — the next rewind-decision resets it to 0.
  'T7f rewind-back returns to the list; modeIndex stays until the next decision',
  reduce({ ...rewindList, confirm: fakeRow, modes, modeIndex: 1 }, { type: 'rewind-back' }),
  { ...rewindList, modeIndex: 1 },
)
check('T7g decision ignored outside rewind', reduce({ kind: 'tips' }, { type: 'rewind-decision', confirm: fakeRow, modes: null }), { kind: 'tips' })

// --- T8: dialogOverlayVisible parity with the boolean-era aggregate ------
const gates = { workspaceTargetCount: 0, effortOptionCount: 0, presetOptionCount: 0 }
const loaded = { workspaceTargetCount: 2, effortOptionCount: 3, presetOptionCount: 2 }
check('T8a none never mounts', dialogOverlayVisible(NO_OVERLAY, loaded), false)
check('T8b plain picker mounts', dialogOverlayVisible({ kind: 'model', index: 0 }, gates), true)
check('T8c workspace picker gated on targets', [
  dialogOverlayVisible({ kind: 'workspace-picker', index: 0 }, gates),
  dialogOverlayVisible({ kind: 'workspace-picker', index: 0 }, loaded),
], [false, true])
check('T8d effort gated on >1 options', [
  dialogOverlayVisible({ kind: 'effort', index: 0 }, { ...loaded, effortOptionCount: 1 }),
  dialogOverlayVisible({ kind: 'effort', index: 0 }, loaded),
], [false, true])
check('T8e preset gated on >0 options', [
  dialogOverlayVisible({ kind: 'preset', index: 0 }, gates),
  dialogOverlayVisible({ kind: 'preset', index: 0 }, loaded),
], [false, true])
// Boolean-era quirk preserved verbatim: /tips mounts the (empty) wrapper.
check('T8f tips still counts as overlay-open', dialogOverlayVisible({ kind: 'tips' }, gates), true)
check('T8g search mounts the bar', dialogOverlayVisible({ kind: 'search' }, gates), true)

// --- T9: file-actions (click-to-act file menu) ---------------------------
const fileActions = (index: number, isDir = false): ChatOverlay =>
  ({ kind: 'file-actions', path: 'C:\\repo\\src\\a.ts', index, isDir })
check('T9a open from none', reduce(NO_OVERLAY, { type: 'open', overlay: fileActions(0) }), fileActions(0))
check(
  'T9b move wraps within the 3 actions',
  [
    reduce(fileActions(2), { type: 'move', delta: 1, count: 3 }),
    reduce(fileActions(0), { type: 'move', delta: -1, count: 3 }),
  ],
  [fileActions(0), fileActions(2)],
)
check('T9c empty count is a no-op', reduce(fileActions(1), { type: 'move', delta: 1, count: 0 }), fileActions(1))
check(
  'T9d mouse pick sets the absolute row',
  reduce(fileActions(1), { type: 'set-index', kind: 'file-actions', index: 2 }),
  fileActions(2),
)
check(
  'T9e stale set-index ignored after the menu closed',
  reduce({ kind: 'theme', index: 0 }, { type: 'set-index', kind: 'file-actions', index: 2 }),
  { kind: 'theme', index: 0 },
)
check('T9f close', reduce(fileActions(0), { type: 'close' }), { kind: 'none' })
check('T9g overlay mounts by default (no data gate)', dialogOverlayVisible(fileActions(0), gates), true)

// --- T10: image-preview — own layer, no OverlayAbove mount -----------------
const fakeImage = { id: 'sha256:x', width: 8, height: 4, read: () => Promise.reject(new Error('unused')) } as never
const imagePreview: ChatOverlay = { kind: 'image-preview', image: fakeImage }
check('T10a open from none', reduce(NO_OVERLAY, { type: 'open', overlay: imagePreview }), imagePreview)
check('T10b open replaces another picker (thumbnail click while /model up)',
  reduce({ kind: 'model', index: 1 }, { type: 'open', overlay: imagePreview }), imagePreview)
check('T10c close', reduce(imagePreview, { type: 'close' }), { kind: 'none' })
check('T10d close-if own kind', reduce(imagePreview, { type: 'close-if', kind: 'image-preview' }), { kind: 'none' })
check('T10e stale close-if is a no-op', reduce({ kind: 'tips' }, { type: 'close-if', kind: 'image-preview' }), { kind: 'tips' })
check('T10f preview never mounts the OverlayAbove wrapper', dialogOverlayVisible(imagePreview, gates), false)
check('T10g move is a no-op (no cursor)', reduce(imagePreview, { type: 'move', delta: 1, count: 3 }), imagePreview)

if (failures > 0) {
  console.error(`\n${failures} failure(s)`)
  process.exit(1)
}
console.log('\nverify-chat-overlay: all checks passed')
