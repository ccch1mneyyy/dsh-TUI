// 运行：node --import tsx/esm scripts/verify-osc8-sanitize.tsx
// 安全回归：OSC 出口控制字符剥离（终端注入收口）。
//
// 背景（安全审查 2026-08-27）：模型输出/插件文本/本地命令输出中的裸
// OSC 8 序列会被 tokenize 提取进 cell.hyperlink，序列化回放时由 link()
// 原样重发——URL 内可携带任意转义序列（改标题、OSC 52 剪贴板劫持、
// iTerm2 文件写入），绕过渲染管线全部 C0/ESC 剥离层。
//
// 本脚本钉住三层防线：
//   1. osc() 出口：任何 OSC 构造（链接/标题/tab status）的 parts 不得
//      携带 C0/C1/DEL/空格——注入原语在公共出口被剥除。
//   2. link() 回放：携带转义 payload 的 URL 回放后不再有可执行序列。
//   3. 端到端：tokenize 提取 → extractHyperlinkFromStyles → link() 链路
//      对注入 payload 的最终字节无逃逸。

import assert from 'node:assert/strict'
import { styledCharsFromTokens, tokenize } from '@alcalzone/ansi-tokenize'
import { link, osc, OSC_PREFIX } from '../src/ink/termio/osc.js'
import { extractHyperlinkFromStyles } from '../src/ink/screen.js'
import { ESC, BEL } from '../src/ink/termio/ansi.js'

let failures = 0
function check(name: string, fn: () => void): void {
  try {
    fn()
    console.log(`  ok - ${name}`)
  } catch (error) {
    failures++
    console.log(`  FAIL - ${name}`)
    console.log(`    ${error instanceof Error ? error.message : String(error)}`)
  }
}

// C0 (0x00-0x1F)、DEL (0x7F)、C1 (0x80-0x9F) 与空格在 OSC payload 中
// 全部非法：BEL/ST 是定界符，ESC 开新序列，C1 在 8-bit 终端同义。
// 不带 /g 标志——.test() 在全局正则上是状态化的，会交替真假。
const OSC_UNSAFE = /[\x00-\x1f\x7f-\x9f\x20]/

const group = process.argv[2] ?? 'all'
const isRelevant = (g: string): boolean => group === 'all' || group === g

if (isRelevant('osc-exit')) {
  console.log('osc() 出口控制字符剥离')

  check('link() URL 内嵌 OSC 0（改标题）被剥除', () => {
    const out = link('http://evil.com/\x1b]0;PWNED')
    assert.ok(!out.includes('\x1b]0;'), `payload 逃逸: ${JSON.stringify(out)}`)
  })

  check('link() URL 内嵌 CSI 序列（擦屏）被剥除', () => {
    const out = link('http://evil.com/\x1b[2J\x1b[H')
    assert.ok(!out.includes('\x1b['), `payload 逃逸: ${JSON.stringify(out)}`)
  })

  check('link() URL 内嵌裸 BEL（提前终止 OSC）被剥除', () => {
    const out = link('http://evil.com/\x07;rm -rf ~')
    // 构造器自身的终止 BEL 之外不得再出现 BEL
    assert.equal(out.split(BEL).length, 2, `BEL 逃逸: ${JSON.stringify(out)}`)
  })

  check('link() URL 内嵌 C1 ST（0x9c 终止符）被剥除', () => {
    const out = link('http://evil.com/\x9ctitle')
    assert.ok(!out.includes('\x9c'), `C1 逃逸: ${JSON.stringify(out)}`)
  })

  check('link() params 值（id=）注入被剥除', () => {
    const out = link('http://ok.example', { id: 'a\x1b]52;c;AAAA\x07b' })
    assert.ok(!out.includes('\x1b]52;'), `params 注入逃逸: ${JSON.stringify(out)}`)
  })

  check('osc() 标题 payload 孤立 BEL 被剥除（sessionTitle 缝隙）', () => {
    const out = osc('0', 'title\x07ring\x1b[2J')
    // 构造器自身的终止 BEL 之外不得再有 BEL/ESC 序列
    const stripped = out.slice(OSC_PREFIX.length, -1)
    assert.ok(!OSC_UNSAFE.test(stripped), `标题 payload 逃逸: ${JSON.stringify(out)}`)
  })

  check('osc() 空格剥除不破坏合法 URL（无控制字符路径不变）', () => {
    const out = link('http://ok.example/docs?a=1&b=2')
    assert.ok(out.includes('http://ok.example/docs?a=1&b=2'), `合法 URL 被误改: ${JSON.stringify(out)}`)
  })
}

if (isRelevant('end-to-end')) {
  console.log('端到端：提取 → 回放链路注入封死')

  // 生产链路（log-update.ts / terminal.ts 序列化同款）：tokenize 解析
  // 文本流中的 OSC 8 → extractHyperlinkFromStyles 取出 URI → link() 重发。
  const replayHyperlink = (text: string): string => {
    const styled = styledCharsFromTokens(tokenize(text) as never)
    const first = styled.find(c => c.styles !== undefined && c.styles.length > 0)
    if (first === undefined) return ''
    const uri = extractHyperlinkFromStyles(first.styles as never)
    return typeof uri === 'string' && uri.length > 0 ? link(uri) : ''
  }

  check('端到端：markdown 载荷的注入 payload 回放后无逃逸序列', () => {
    const payload = `http://evil.com/${ESC}]0;PWNED`
    const out = replayHyperlink(`\x1b]8;;${payload}${BEL}click\x1b]8;;${BEL}`)
    assert.ok(!out.includes('\x1b]0;'), `逃逸: ${JSON.stringify(out)}`)
    assert.ok(out.length > 0, '回放产出为空（链路断裂）')
  })

  check('端到端：OSC 52 剪贴板劫持 payload 被剥除', () => {
    const payload = `http://evil.com/${ESC}]52;c;aGVsbG8=`
    const out = replayHyperlink(`\x1b]8;;${payload}${BEL}x\x1b]8;;${BEL}`)
    assert.ok(!out.includes('\x1b]52;'), `逃逸: ${JSON.stringify(out)}`)
  })

  check('端到端：合法链接回放仍完整', () => {
    const out = replayHyperlink(`\x1b]8;;http://ok.example${BEL}docs\x1b]8;;${BEL}`)
    assert.ok(out.includes('http://ok.example'), `合法链接损坏: ${JSON.stringify(out)}`)
  })
}

if (isRelevant('scheme-gate')) {
  console.log('scheme 门禁（入口降级 + 点击面拦截）')

  const { createHyperlink } = await import('../src/cc/hyperlink.js')
  const { classifyOpenTarget } = await import('../src/utils/urlGuard.js')

  check('createHyperlink 拒绝 javascript: scheme（降级纯文本）', () => {
    const out = createHyperlink('javascript:alert(1)', 'click', { supportsHyperlinks: true })
    assert.ok(!out.includes('\x1b]8;;'), `危险 scheme 未降级: ${JSON.stringify(out)}`)
    assert.ok(!out.includes('javascript:'), `危险 scheme 明文外泄: ${JSON.stringify(out)}`)
  })

  check('createHyperlink 拒绝 data: scheme', () => {
    const out = createHyperlink('data:text/html,<script>', 'click', { supportsHyperlinks: true })
    assert.ok(!out.includes('\x1b]8;;'), `危险 scheme 未降级: ${JSON.stringify(out)}`)
  })

  check('createHyperlink 拒绝大小写混淆（JaVaScRiPt:）', () => {
    const out = createHyperlink('JaVaScRiPt:alert(1)', 'click', { supportsHyperlinks: true })
    assert.ok(!out.includes('\x1b]8;;'), `大小写混淆绕过: ${JSON.stringify(out)}`)
  })

  check('createHyperlink 拒绝控制字符混淆（java\\x00script:）', () => {
    const out = createHyperlink('java\x00script:alert(1)', 'click', { supportsHyperlinks: true })
    assert.ok(!out.includes('\x1b]8;;'), `控制字符混淆绕过: ${JSON.stringify(out)}`)
  })

  check('createHyperlink 放行 http/https/dsh-file/file/mailto', () => {
    for (const url of ['http://ok.example', 'https://ok.example/x', 'dsh-file:///a/b.ts#L1', 'file:///tmp/x', 'mailto:a@b.c']) {
      const out = createHyperlink(url, 'x', { supportsHyperlinks: true })
      assert.ok(out.includes('\x1b]8;;'), `合法 scheme 被误拒: ${url} -> ${JSON.stringify(out)}`)
    }
  })

  check('classifyOpenTarget 拦截非白名单 scheme 的外开', () => {
    assert.equal(classifyOpenTarget('ssh://evil.example').kind, 'rejected')
    assert.equal(classifyOpenTarget('ftp://evil.example').kind, 'rejected')
    assert.equal(classifyOpenTarget('javascript:alert(1)').kind, 'rejected')
  })

  check('classifyOpenTarget 放行 http/https 与文件链接', () => {
    assert.equal(classifyOpenTarget('https://ok.example').kind, 'external')
    assert.equal(classifyOpenTarget('http://ok.example').kind, 'external')
    assert.equal(classifyOpenTarget('dsh-file:///a/b.ts#L1').kind, 'file-actions')
    assert.equal(classifyOpenTarget('file:///tmp/x').kind, 'file-actions')
  })
}

console.log(failures === 0 ? 'ALL PASS' : `${failures} FAIL`)
process.exit(failures === 0 ? 0 : 1)
