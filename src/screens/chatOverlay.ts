/**
 * The chat screen's transient-dialog layer (the pickers, dialogs and panels
 * that float above the prompt in `<OverlayAbove>`, plus /tips) as one
 * explicit state machine.
 *
 * Previously this layer lived in ~28 sibling `useState` booleans+indices in
 * Chat.tsx, with mutual exclusion emerging from "an open picker makes the
 * prompt inert, so no second open command can be typed", and with two
 * hand-maintained OR-aggregates (`promptSelectionActive`,
 * `dialogOverlayOpen`) whose comments warned they must stay exactly in sync
 * with the per-panel render conditions. A single discriminated union makes
 * the exclusion structural — one variable can only hold one variant — and
 * turns both aggregates into derivations that cannot drift.
 *
 * Design constraints, in order:
 *   1. Behavior-preserving: every keyboard path, open/close side effect and
 *      async-callback landing keeps its observable behavior. The one
 *      deliberate change: an async OPEN landing while another overlay is up
 *      (e.g. `/effort`'s listEfforts resolving after the user opened
 *      `/model`) now REPLACES it instead of stacking two panels — the
 *      stacked rendering was an unreachable-by-keyboard race, not a feature.
 *   2. Pure and total: the reducer is a plain function, unit-tested by
 *      scripts/verify-chat-overlay.ts without a renderer. Actions that no
 *      longer apply (an async result landing after the overlay changed) are
 *      ignored rather than writing orphan state.
 *   3. Async data caches (model list, preset roster, …) stay OUTSIDE the
 *      union in Chat.tsx: they persist across open/close so a reopened
 *      picker can paint the previous list while the fresh one loads,
 *      exactly as before.
 */
import type { BackendModeOption, ChatRow, PermissionPresetSnapshot } from '../dsh-adapter/channel.js'
import type { KernelBackendId } from '../kernelPrefs.js'
import type { TranscriptImage } from '../dsh-adapter/transcript-images.js'
import type { TuiRewindMode } from '../dsh-adapter/extension-events.js'
import type { TuiWorkspaceCommandResult } from '../workspaces.js'

/** The `kind: 'choices'` result a workspace command can return. */
export type WorkspaceFlowChoices = Extract<TuiWorkspaceCommandResult, { kind: 'choices' }>

/** Text-entry sub-state of the workspace flow (Tab into a choice's input). */
export type WorkspaceFlowInput = {
  choiceId: string
  value: string
  cursor: number
  placeholder?: string
}

export type ChatOverlay =
  | { kind: 'none' }
  | { kind: 'thinking'; focus: number }
  | { kind: 'workspace-picker'; index: number }
  | { kind: 'workspace-menu'; index: number }
  | {
      kind: 'workspace-flow'
      flow: WorkspaceFlowChoices
      index: number
      busy: boolean
      input: WorkspaceFlowInput | null
    }
  | { kind: 'model' }
  | { kind: 'skills'; index: number }
  | { kind: 'migrate'; index: number }
  | { kind: 'migrate-confirm' }
  | { kind: 'activity'; index: number }
  | { kind: 'color'; index: number }
  | { kind: 'effort'; index: number }
  | { kind: 'preset'; index: number }
  | { kind: 'theme'; index: number }
  | { kind: 'permission'; index: number; snapshot: PermissionPresetSnapshot }
  /** /permission over a backend's native permission modes (the typed
   * modes capability; a DSH session answers none and keeps the preset
   * variant above). The frozen mode list and the live current id ride the
   * open because the capability read is synchronous. */
  | { kind: 'mode'; index: number; modes: readonly BackendModeOption[]; currentId: string | undefined }
  /** 内核选择器（/kernel 与启动页「内核」入口）。只带焦点下标——目录是
   *  Chat 的派生值（buildKernelCatalog 的输出，含异步探测结果），每次渲染
   *  现算，所以探测落地后选择器自己就刷新了，不需要把名册冻进 overlay。 */
  | { kind: 'kernel'; index: number }
  /** SDK 安装向导（内核选择器的「未安装」行 Enter 进入）。与 kernel 同为
   *  「盖在落地页之上」的姿态；向导的步骤态（确认/安装中/结果）是异步进程
   *  状态，按本文件头注释第 3 条的分工留在 Chat.tsx，不冻进 overlay。
   *
   *  只带**后端 id**：装的是哪一行、就查哪一行的安装面——安装面在打开时按 id
   *  从宿主现查（Stage B / §6 第 12 条），与 kernel 一样不冻名册。 */
  | { kind: 'sdk-install'; backendId: KernelBackendId }
  | { kind: 'plan'; index: number }
  | { kind: 'lang'; index: number }
  /** `/panel` 无参的选择器：列出「已启用 ∩ 已注册」的面板（含插件）。 */
  | { kind: 'panel'; index: number }
  /** `/channel` 渠道档案选择器（仅 channels 能力的后端，即 Claude）：只带
   *  焦点下标——名册由后端渠道宿主派生，
   *  切换/导入后选择器自己就刷新成新状态，不需要把名册冻进 overlay。 */
  | { kind: 'channel'; index: number }
  | { kind: 'history'; query: string; cursor: number; focus: number }
  | {
      kind: 'rewind'
      index: number
      confirm: ChatRow | null
      modes: readonly TuiRewindMode[] | null
      modeIndex: number
      busy: boolean
    }
  // `/` transcript search: only the open/closed mode lives here. The query,
  // cursor and match counters stay in Chat.tsx — they survive the bar
  // closing so n/N keep walking the matches.
  | { kind: 'search' }
  | { kind: 'tips' }
  /**
   * 帮助菜单（第八版：用户实测——启动页点「帮助」直接进了聊天页 ✗）。这个
   * variant 只在**落地页**上打开：HelpMenu 经 Chat 的 pickerPanels 挂进
   * OverlayAbove，盖在启动页之上（与参数选择器/工作区菜单同一姿态），
   * Esc / 点空白 / 再点帮助入口收回，回到启动页（草稿/参数/焦点原样）。
   * 聊天页的 `?`//help` 不走这里：那边的 helpOpen 状态与 PromptInput 内
   * 渲染保持原样（另一个屏的事，刻意不改）。
   */
  | { kind: 'help' }
  /**
   * Click-to-act file menu: opened by clicking a file path in the
   * transcript (tool cards, markdown code spans / plain text, file://
   * links). `index` is the focused action row (0 = open, 1 = reveal in
   * file manager, 2 = copy absolute path). `isDir` tells the panel whether
   * the target is a directory (first row reads "open folder").
   */
  | { kind: 'file-actions'; path: string; index: number; isDir: boolean }
  /**
   * Modal image preview: opened by clicking a transcript thumbnail. Renders
   * as its own centered layer (not inside `<OverlayAbove>`); Esc /
   * click-outside closes. The composer's caret-driven preview (the caret on
   * a staged `[Image #N]`) is NOT an overlay: it is derived state in Chat,
   * shows only while this union is `none`, and leaves the keyboard with the
   * prompt.
   */
  | { kind: 'image-preview'; image: TranscriptImage; title?: string;
      gallery?: readonly { image: TranscriptImage; title?: string }[]; index?: number }

export const NO_OVERLAY: ChatOverlay = { kind: 'none' }

export type ChatOverlayAction =
  /** Open a variant, replacing whatever is up (including `none`). */
  | { type: 'open'; overlay: ChatOverlay }
  /** Close unconditionally (only dispatched from the open overlay's own keys). */
  | { type: 'close' }
  /** Navigate the frozen gallery without wrapping or changing another modal. */
  | { type: 'image-step'; delta: 1 | -1 }
  /** Close only if the given kind is still up — the safe form for async
   *  callbacks (a loader failing after the user already moved on). */
  | { type: 'close-if'; kind: ChatOverlay['kind'] }
  /**
   * Open only while the current kind is one of `when` — the safe form for an
   * OPEN that arrives from an async callback (`/effort`'s level list, the
   * workspace target list, a workspace command's choices). A user who opened
   * something else during the round trip keeps what they opened; the stale
   * open is dropped. Synchronous opens keep using plain `open`.
   */
  | { type: 'open-if'; overlay: ChatOverlay; when: readonly ChatOverlay['kind'][] }
  /**
   * Move the focused row by one with wrap-around, over a list of `count`
   * entries. On `rewind` this targets whichever cursor the sub-state focuses
   * (mode list when a plugin offered modes, else the candidate list). A
   * `count <= 0` move is a no-op (an empty list has no focus to move).
   */
  | { type: 'move'; delta: 1 | -1; count: number }
  /** Set the focused row to an absolute index — an async loader landing
   *  with the authoritative focus (preset roster), or a mouse
   *  click on a row of a panel that stays open (effort slider, workspace
   *  flow). Ignored unless that panel is still up. */
  | { type: 'set-index'; kind: 'preset' | 'effort' | 'permission' | 'mode' | 'kernel' | 'workspace-flow' | 'rewind' | 'file-actions' | 'panel' | 'channel'; index: number }
  /** Edit the history-search draft (query text, caret, focused match). */
  | { type: 'history-edit'; query?: string; cursor?: number; focus?: number }
  /** Workspace flow: an action is running (keys except Esc are swallowed). */
  | { type: 'flow-busy'; busy: boolean }
  /** Workspace flow: enter (object) or leave (null) the text-input state. */
  | { type: 'flow-input'; input: WorkspaceFlowInput | null }
  /** Workspace flow: edit the text-input draft in place. */
  | { type: 'flow-input-edit'; value: string; cursor: number }
  /** Rewind: the plugin decision round-trip started / was abandoned. */
  | { type: 'rewind-busy'; busy: boolean }
  /** Rewind: the plugin decision landed — show the confirm pane (modes turn
   *  it into a choice list). Stale decisions are dropped by the caller's
   *  request token before dispatch; a changed overlay drops them here. */
  | { type: 'rewind-decision'; confirm: ChatRow; modes: readonly TuiRewindMode[] | null }
  /** Rewind: Esc from the confirm/modes pane back to the candidate list. */
  | { type: 'rewind-back' }

/**
 * One-step wrap-around cursor move — the single source of the wrapping rule
 * every list overlay uses (Chat.tsx's effort slider reads it too, to apply
 * the newly focused level in the same keystroke that dispatches the move).
 */
export function wrapIndex(index: number, delta: 1 | -1, count: number): number {
  return delta === -1
    ? (index <= 0 ? count - 1 : index - 1)
    : (index >= count - 1 ? 0 : index + 1)
}

export function chatOverlayReducer(state: ChatOverlay, action: ChatOverlayAction): ChatOverlay {
  switch (action.type) {
    case 'open':
      return action.overlay
    case 'close':
      return NO_OVERLAY
    case 'image-step': {
      if (state.kind !== 'image-preview' || !state.gallery?.length) return state
      const index = Math.max(0, Math.min(state.gallery.length - 1, (state.index ?? 0) + action.delta))
      if (index === state.index) return state
      const entry = state.gallery[index]!
      return { kind: 'image-preview', image: entry.image, title: entry.title, gallery: state.gallery, index }
    }
    case 'close-if':
      return state.kind === action.kind ? NO_OVERLAY : state
    case 'open-if':
      return action.when.includes(state.kind) ? action.overlay : state
    case 'move': {
      if (action.count <= 0) return state
      if (state.kind === 'rewind') {
        // The confirm pane with plugin modes has its own cursor; the plain
        // confirm pane has none (Enter/Esc only — a move must not disturb
        // the list index behind it).
        if (state.confirm !== null) {
          return state.modes !== null
            ? { ...state, modeIndex: wrapIndex(state.modeIndex, action.delta, action.count) }
            : state
        }
        return { ...state, index: wrapIndex(state.index, action.delta, action.count) }
      }
      if (state.kind === 'thinking') {
        return { ...state, focus: wrapIndex(state.focus, action.delta, action.count) }
      }
      if (
        state.kind === 'workspace-picker'
        || state.kind === 'workspace-menu'
        || state.kind === 'workspace-flow'
        || state.kind === 'skills'
        || state.kind === 'migrate'
        || state.kind === 'activity'
        || state.kind === 'color'
        || state.kind === 'effort'
        || state.kind === 'preset'
        || state.kind === 'theme'
        || state.kind === 'permission'
        || state.kind === 'mode'
        || state.kind === 'plan'
        || state.kind === 'lang'
        || state.kind === 'panel'
        || state.kind === 'kernel'
        || state.kind === 'channel'
        || state.kind === 'file-actions'
      ) {
        return { ...state, index: wrapIndex(state.index, action.delta, action.count) }
      }
      if (state.kind === 'history') {
        return { ...state, focus: wrapIndex(state.focus, action.delta, action.count) }
      }
      return state
    }
    case 'set-index':
      return state.kind === action.kind ? { ...state, index: action.index } : state
    case 'history-edit':
      return state.kind === 'history'
        ? {
            ...state,
            ...(action.query === undefined ? {} : { query: action.query }),
            ...(action.cursor === undefined ? {} : { cursor: action.cursor }),
            ...(action.focus === undefined ? {} : { focus: action.focus }),
          }
        : state
    case 'flow-busy':
      return state.kind === 'workspace-flow' ? { ...state, busy: action.busy } : state
    case 'flow-input':
      return state.kind === 'workspace-flow' ? { ...state, input: action.input } : state
    case 'flow-input-edit':
      return state.kind === 'workspace-flow' && state.input !== null
        ? { ...state, input: { ...state.input, value: action.value, cursor: action.cursor } }
        : state
    case 'rewind-busy':
      return state.kind === 'rewind' ? { ...state, busy: action.busy } : state
    case 'rewind-decision':
      return state.kind === 'rewind'
        ? { ...state, busy: false, confirm: action.confirm, modes: action.modes, modeIndex: 0 }
        : state
    case 'rewind-back':
      return state.kind === 'rewind' ? { ...state, confirm: null, modes: null } : state
  }
}

/**
 * Whether the `<OverlayAbove>` wrapper mounts. Mounting is all-or-nothing:
 * the renderer's removed-absolute-node blit detection only fires when the
 * removed subtree itself is `position: absolute` (dom.ts
 * collectRemovedRects), so the whole overlay must leave the tree when its
 * last panel closes — see the mount-site comment in Chat.tsx.
 *
 * The per-kind data gates mirror the per-panel render conditions verbatim:
 * a picker whose async list has not landed (or came back trivially small)
 * paints nothing, so the wrapper must not mount for it either. `tips`
 * returns true even though the panel renders in the prompt slot rather than
 * inside the overlay — preserved verbatim from the boolean-era aggregate
 * (the empty absolute wrapper is zero-size and paints nothing).
 */
export function dialogOverlayVisible(
  overlay: ChatOverlay,
  gates: {
    workspaceTargetCount: number
    effortOptionCount: number
    presetOptionCount: number
    panelCount?: number
  },
): boolean {
  switch (overlay.kind) {
    case 'none':
      return false
    // The preview paints its own absolute layer; mounting the empty
    // `<OverlayAbove>` wrapper for it would only churn the prompt area.
    case 'image-preview':
      return false
    case 'workspace-picker':
      return gates.workspaceTargetCount > 0
    case 'effort':
      return gates.effortOptionCount > 1
    case 'preset':
      return gates.presetOptionCount > 0
    case 'panel':
      return (gates.panelCount ?? 1) > 0
    case 'permission':
      return overlay.snapshot.options.length > 0
    case 'mode':
      return overlay.modes.length > 0
    // The kernel roster always has at least the DSH row (the Claude row is
    // dim while its probe is in flight), so the wrapper always mounts.
    case 'kernel':
      return true
    default:
      return true
  }
}
