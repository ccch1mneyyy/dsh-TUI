/**
 * 工具名分类色回归（issue #1555）：工具卡标题行的工具名必须与同一行的状态
 * 圆点属于**同一个分类家族**。
 *
 * 两处各有一张工具分类表：`AssistantToolUseMessage.toolNameColor`（id 启发式
 * 决定名称颜色）与 `ToolUseLoader.CATEGORY_BY_TOOL`（决定圆点颜色）。它们曾
 * 各自独立地补齐过 pwsh——圆点表先有（#258 的 category dots），名称表一直没有
 * （#1555），于是 Windows 上同一张卡的名字是普通工具的 accent 蓝、圆点是 exec 绿。
 *
 * 断言按家族成对写：圆点与名称都得画该家族的两个色，所以任何一张表漏了 id
 * 都会红——不管漏的是哪一张。`unmapped` 是对照组：未登记的工具走 success 圆点
 * + accent 名，而 accent 同时是 read 家族的名字色（lookup 工具刻意保留品牌蓝），
 * 两组一起断言，「名称是 accent」才不等于「名称漏网」。
 *
 * 渲染与字节捕获在 scripts/lib/toolcard-capture.tsx（真机 xterm，色值只能从写出的
 * `38;2;r;g;b` 里读——xterm 缓冲区不保留样式）。色值取自内置 dark 调色板。
 *
 * 运行：node --import tsx/esm scripts/verify-toolcard-name-color.tsx
 */
process.env.FORCE_COLOR = '3'
process.env.DSH_TUI_LANG = 'zh'

import assert from 'node:assert/strict'
import { toolNameColor } from '../src/components/messages/AssistantToolUseMessage.js'
import { getTheme } from '../src/theme.js'
import { captureToolcard } from './lib/toolcard-capture.js'

const palette = getTheme('dark')

/** 家族 → 圆点色与名称色（ToolUseLoader.CATEGORY_TOKEN + toolNameColor）。 */
const FAMILIES = {
  exec: { dot: palette.toolDotExec, name: palette.toolNameExec },
  write: { dot: palette.toolDotWrite, name: palette.toolNameMutate },
  // read/search 的圆点是 toolDotRead，名称刻意保留品牌蓝 accent。
  read: { dot: palette.toolDotRead, name: palette.accent },
  // 未登记的工具：圆点回退 success、名称回退 accent。
  unmapped: { dot: palette.success, name: palette.accent },
} as const
type Family = keyof typeof FAMILIES

/** 主题色（`rgb(r,g,b)` 或 `#rrggbb`）→ 前景 SGR 三元组。 */
function triple(color: string): string {
  const hex = /^#([0-9a-f]{6})$/iu.exec(color.trim())
  const value = hex === null ? undefined : Number.parseInt(hex[1]!, 16)
  const parts = value === undefined
    ? (/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/u.exec(color.trim())?.slice(1, 4).map(Number) ?? [])
    : [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff]
  assert.equal(parts.length, 3, `主题色不是可解析的 hex/rgb：${color}`)
  return `38;2;${parts[0]};${parts[1]};${parts[2]}`
}

const SCENARIOS: Array<{ id: string; family: Family; tool: Record<string, unknown> }> = [
  {
    id: 'pwsh',
    family: 'exec',
    tool: { name: 'pwsh', callView: { card: 'terminal', title: 'Get-ChildItem' }, resultView: { card: 'terminal', output: 'ok', exitCode: 0 }, resultFull: 'ok' },
  },
  {
    id: 'edit',
    family: 'write',
    tool: { name: 'edit', callView: { card: 'generic', title: 'Edit /tmp/a.ts' } },
  },
  {
    id: 'read',
    family: 'read',
    tool: { name: 'read', argsText: '{"file_path":"/tmp/a.ts"}' },
  },
  {
    id: 'unmapped',
    family: 'unmapped',
    tool: { name: 'frobnicate', argsText: '{"x":1}' },
  },
]

let failures = 0
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) {
    console.log(`ok   ${name}`)
    return
  }
  failures++
  console.error(`FAIL ${name}`)
  if (detail !== '') console.error(`      ${detail}`)
}

for (const scenario of SCENARIOS) {
  const captured = await captureToolcard({ tool: scenario.tool })
  const family = FAMILIES[scenario.family]
  const name = String((scenario.tool as { name: string }).name)

  check(`${scenario.id}: 圆点画 ${scenario.family} 家族色（${family.dot}）`,
    captured.ansi.includes(triple(family.dot)), `画面：\n${captured.text}`)
  check(`${scenario.id}: 工具名画 ${scenario.family} 家族色（${family.name}）`,
    captured.ansi.includes(triple(family.name)),
    `toolNameColor('${name}') 实际返回 ${toolNameColor(name)}`)
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
// exitCode（而非 exit()）：重定向下立即 exit 会截断尚未 flush 的 stdout。
process.exitCode = failures === 0 ? 0 : 1
