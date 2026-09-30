/**
 * usePanelInput（v2.1 键盘契约的实现）：同一份业务键逻辑，既能整屏、
 * 也能侧栏。
 *
 * - 侧栏形态（组件挂在 PanelHost 下，PanelContext 存在）：handler 注册
 *   进 PanelHost 的输入分发器；焦点在右栏时，宿主把按键先发给活动
 *   Panel 的 handler（返回 true = 消费，宿主回退键不再触发），Panel
 *   没吃的键才轮到宿主回退（←/→ 切面板、Esc 回聊天……）。
 * - 整屏形态（窄屏 / inline 回退、/jobs 早返回：没有 PanelContext）：
 *   退化为普通 useInput(handler, { isActive: active })，行为与现状一致。
 *
 * active 一般传 focused && visible（PanelProps 直接给），这样
 * mountPolicy=enabled 的面板在非 active 时保留注册但收不到键。
 */
import React from 'react'
import { useInput } from '../../ui.js'
import { PanelContext, SidePanelRuntimeContext } from './SidePanelRuntimeContext.js'
import type { PanelKeyHandler, SidePanelKeyFlags } from './types.js'

/** ink 的 Enter 是 input='' + key.return；v2.1 的 SidePanelKeyFlags 拼
 *  作 return_。在接缝处统一归一，两条路径（分发器 / 整屏回退）的
 *  handler 都只需要认 return_。 */
function normalizeKey(key: SidePanelKeyFlags & { readonly return?: boolean }): SidePanelKeyFlags {
  if (key.return === true && key.return_ !== true) return { ...key, return_: true }
  return key
}

export function usePanelInput(
  handler: PanelKeyHandler,
  opts?: { readonly active?: boolean },
): void {
  const panelCtx = React.useContext(PanelContext)
  const runtimeCtx = React.useContext(SidePanelRuntimeContext)
  const active = opts?.active ?? true
  const inPanel = panelCtx !== null && runtimeCtx !== null

  // Trampoline：handler 不必是稳定引用（内联书写也安全），注册只随
  // active / panelId 翻转而刷新。
  const handlerRef = React.useRef(handler)
  handlerRef.current = handler

  React.useEffect(() => {
    if (!inPanel) return undefined
    return runtimeCtx.runtime.registerInput(
      panelCtx.panelId,
      (input, key) => handlerRef.current(input, normalizeKey(key)),
      active,
    )
  }, [inPanel, runtimeCtx, panelCtx, active])

  // 整屏回退路径。面板形态下也挂着（isActive=false），保证 hook 顺序稳定。
  useInput((input, key) => {
    handlerRef.current(input, normalizeKey(key))
  }, { isActive: !inPanel && active })
}
