/**
 * Markdown 文件链接 ANSI 完整性回归。
 *
 * renderCodeSpan 曾把【已上色的】路径代码段直接作为 content 传给
 * createHyperlink——其防注入消毒会把合法 `\x1b` 剥掉，SGR 参数文本
 * （`[38;2;…m` / `[39m`）原样上屏（浅色主题 permission `#3F6CC4` 场景）。
 * 回归断言：路径代码段输出要么带完整 `\x1b` 序列、要么无任何参数残片；
 * 样式化链接标签（加粗等）同样不得残留 `[1m` 等裸参数。
 *
 * Run: node --import tsx/esm scripts/verify-markdown-filelink-ansi.ts
 */

// supportsHyperlinks 在模块加载时缓存 stdout 探测结果；TERM_PROGRAM=kitty
// 走 wrapper 的附加终端名单，保证 OSC 8 路径被覆盖且不依赖运行环境。
process.env.TERM_PROGRAM = 'kitty'

const { default: chalk } = await import('chalk')
const { applyMarkdown } = await import('../src/cc/markdown.js')
const { createHyperlink } = await import('../src/cc/hyperlink.js')

let failures = 0
let checks = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  checks += 1
  if (!ok) failures += 1
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || detail === '' ? '' : `: ${detail}`}`)
}

const prevLevel = chalk.level
chalk.level = 3 // truecolor（38;2;r;g;b）；level 2 会把 rgb 降级成 256 色

try {
  // ── renderCodeSpan 端到端：路径内联代码 ─────────────────────────────
  const out = applyMarkdown('看 `src/dsh-adapter/plugin.ts` 这个文件')
  const bareSgr = (out.match(/\[38;2;/g) ?? []).length
  const escSgr = (out.match(/\u001b\[38;2;/g) ?? []).length
  check(
    '路径代码段不残留裸 SGR 参数文本（每个 [38;2; 都必须带 ESC 前缀）',
    bareSgr === escSgr,
    JSON.stringify(out),
  )
  check(
    '路径代码段保留完整真彩色 ESC 序列',
    out.includes('\u001b[38;2;') && out.includes('src/dsh-adapter/plugin.ts\u001b[39m'),
    JSON.stringify(out),
  )
  check(
    '路径代码段带 OSC 8 超链接（kitty 环境）',
    out.includes('\u001b]8;;dsh-file:'),
    JSON.stringify(out),
  )

  // ── renderLink：带样式的链接标签 ───────────────────────────────────
  const linkOut = applyMarkdown('去 [**加粗链接**](https://example.com/x) 看看')
  check(
    '样式化链接标签不残留 [1m/[22m 裸参数',
    !linkOut.includes('[1m') && !linkOut.includes('[22m'),
    JSON.stringify(linkOut),
  )

  // ── createHyperlink 直接契约 ────────────────────────────────────────
  const paint = (text: string): string => `\u001b[38;2;63;108;196m${text}\u001b[39m`
  const withPainted = createHyperlink('dsh-file:///x', paint('src/dsh-adapter/plugin.ts'), {
    supportsHyperlinks: true,
    style: (text: string) => text,
  })
  check(
    '已上色 content 被完整消毒：SGR 序列全剥、仅剩 OSC 8 包裹与纯文本',
    !withPainted.includes('\u001b[38;') &&
      !withPainted.includes('[38;2;') &&
      withPainted.includes('src/dsh-adapter/plugin.ts'),
    JSON.stringify(withPainted),
  )
  const withStyle = createHyperlink('dsh-file:///x', 'src/dsh-adapter/plugin.ts', {
    supportsHyperlinks: true,
    style: paint,
  })
  check(
    'style 回调在消毒后上色：ESC 完整、OSC 8 包裹',
    withStyle.includes(
      '\u001b]8;;dsh-file:///x\u0007\u001b[38;2;63;108;196msrc/dsh-adapter/plugin.ts\u001b[39m\u001b]8;;\u0007',
    ),
    JSON.stringify(withStyle),
  )
} finally {
  chalk.level = prevLevel
}

console.log(`${checks - failures}/${checks} checks passed`)
if (failures > 0) process.exit(1)
