/**
 * 工具卡渲染捕获辅助（PR 证据与断言共用）。
 *
 * `scripts/verify-toolcard-name-color.tsx` 需要「真实渲染出的 SGR 字节」来断言
 * 分类色；写 PR 描述时需要同一张卡的**可读画面**。两者都从这一个入口拿：用
 * xterm 无头终端跑一次真实 `AssistantToolUseMessage`，等写入回调排空后读出
 * 文本与写出的转义序列。
 *
 * 读屏必须等 `term.write` 的回调：xterm 异步分块解析，缓冲区只在回调触发后
 * 才反映写入（见 scripts/lib/term-test.mjs 的 writeParsed 说明）。
 *
 * 强制颜色级别**必须在这里**做，不能只靠调用方顶部的 `process.env.FORCE_COLOR`：
 * 本文件对 `../../src/ui.js` 用的是静态 import，ESM 的 import 提升会让 chalk
 * 先于调用方的 env 赋值载入，于是它以 NO_COLOR 环境的 level 0 载入、把全部
 * SGR 剥掉，色值断言与证据捕获一起变成空的（verify-theme-preview 记过同款
 * 假阴性）。这里自行设 env + chalk.level，调用方写不写都无所谓。
 */
process.env.FORCE_COLOR = '3'

import { Writable } from 'node:stream'
import React from 'react'
// @xterm/headless 的 CJS 互操作没有具名 ESM 导出——仓库脚本一律动态 import。
const [{ Terminal: XTerm }, { render }, { AssistantToolUseMessage }] = await Promise.all([
  import('@xterm/headless'),
  import('../../src/ui.js'),
  import('../../src/components/messages/AssistantToolUseMessage.js'),
])
// chalk 的 level 是全局单例：置 3 才能保证 rgb() 主题色真的写成 38;2 字节。
;(await import('chalk')).default.level = 3

export type ToolcardCapture = {
  /** 屏上文本（去掉尾部空行），用于放进取证块或文本断言。 */
  text: string
  /** 写出的原始字节：颜色断言读这里的 `38;2;r;g;b`。 */
  ansi: string
}

type CaptureOptions = {
  /** 工具行（ToolRow 的字段，`callId`/`status`/`startedAt` 有默认值）。 */
  tool: Record<string, unknown>
  cols?: number
  rows?: number
}

/** 渲染一张工具卡并返回它的画面与字节；组件在返回前卸载。 */
export async function captureToolcard({ tool, cols = 90, rows = 30 }: CaptureOptions): Promise<ToolcardCapture> {
  const term = new XTerm({ cols, rows, scrollback: 0, allowProposedApi: true })
  let ansi = ''
  let pending: Promise<void> = Promise.resolve()

  class FakeStdout extends Writable {
    columns = cols
    rows = rows
    isTTY = true
    _write(chunk: unknown, _e: BufferEncoding, cb: () => void): void {
      const written = String(chunk)
      ansi += written
      pending = pending.then(() => new Promise<void>(resolve => { term.write(written, () => resolve()) }))
      cb()
    }
  }

  const app = await render(
    React.createElement(AssistantToolUseMessage, {
      tool: { callId: 'capture', argsText: '', status: 'ok', startedAt: 0, durationMs: 5, ...tool },
      marginTopOnTurn: false,
      verbose: false,
    }),
    { stdout: new FakeStdout(), debug: true, exitOnCtrlC: false, patchConsole: false },
  )
  await pending
  // ink 的首帧可能拆成多个 commit（挂载、布局、样式补写），等在途写入排空后
  // 再放一个宏任务让下一批 commit 落到 stdout，最后把新的在途链也排空。
  await new Promise<void>(resolve => { setTimeout(() => resolve(), 0) })
  await pending
  app.unmount()

  const buffer = term.buffer.active
  const lines: string[] = []
  for (let y = 0; y < buffer.length; y++) lines.push(buffer.getLine(y)?.translateToString(true) ?? '')
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return { text: lines.join('\n'), ansi }
}
