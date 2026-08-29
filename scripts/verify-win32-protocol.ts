/**
 * verify-win32-protocol — SGR/X10 鼠标序列与终端回复被 conhost 合成成
 * 逐字符 win32-input-mode 记录后的重组回归（PowerShell/ConPTY 路径）。
 *
 * 用法:node --import tsx/esm scripts/verify-win32-protocol.ts
 */
import { INITIAL_STATE, parseMultipleKeypresses } from '../src/ink/parse-keypress.js'
import type { ParsedInput } from '../src/ink/parse-keypress.js'

let failures = 0
function check(name: string, ok: boolean, extra = ''): void {
  const mark = ok ? 'ok  ' : 'FAIL'
  console.log(`${mark} ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failures++
}

/** 驱动状态机:按顺序喂入 chunks,可选在指定位置触发 flush(input=null)。 */
function drive(chunks: Array<string | null>): ParsedInput[] {
  let state = INITIAL_STATE
  const out: ParsedInput[] = []
  for (const c of chunks) {
    const [keys, ns] = parseMultipleKeypresses(state, c)
    state = ns
    out.push(...keys)
  }
  return out
}

function describe(k: ParsedInput): string {
  if (k.kind === 'mouse') return `mouse(${k.button},${k.action}@${k.col},${k.row})`
  if (k.kind === 'key') return `key(${k.name || JSON.stringify(k.sequence)})`
  return `response(${k.response.type})`
}

function win32Record(
  virtualKey: number,
  scanCode: number,
  codePoint: number,
): string {
  return `\x1b[${virtualKey};${scanCode};${codePoint};1;0;1_`
}

function synthesizedWin32(text: string): string[] {
  return [...text].map(ch => win32Record(0, 0, ch.codePointAt(0)!))
}

// ── 基线:完整序列单块到达 → 必须解析为鼠标事件 ──
{
  const out = drive(['\x1b[<0;32;5M'])
  check('A complete SGR click parses as mouse',
    out.length === 1 && out[0]!.kind === 'mouse',
    out.map(describe).join(','))
}

// ── B:ESC 被 50ms timer flush 成 lone Escape,完整尾巴后到 → 现有重合成应救回 ──
{
  const out = drive(['\x1b', null, '[<0;32;5M'])
  check('B orphaned complete tail resynthesized',
    out.some(k => k.kind === 'mouse'),
    out.map(describe).join(','))
}

// ── C:尾巴自身再被 ConPTY 拆碎(首块无终止符)→ 复现泄漏? ──
{
  const out = drive(['\x1b', null, '[<0;', '32;5M'])
  const leaked = out.filter(k =>
    k.kind === 'key' && k.name === '' && k.sequence && /[[<\d;]/.test(k.sequence))
  check('C fragmented tail recovered (no text leak)',
    out.some(k => k.kind === 'mouse') && leaked.length === 0,
    `leaked=${leaked.map(describe).join(',')} all=${out.map(describe).join(',')}`)
}

// ── D:ESC 缓冲期内碎片到达(无 flush),随后 flush,再下一块 ──
{
  const out = drive(['\x1b', '[<0;', null, '32;5M'])
  const leaked = out.filter(k =>
    k.kind === 'key' && k.name === '' && k.sequence && /[[<\d;]/.test(k.sequence))
  check('D buffered-then-flushed fragments recovered',
    out.some(k => k.kind === 'mouse') && leaked.length === 0,
    `leaked=${leaked.map(describe).join(',')} all=${out.map(describe).join(',')}`)
}

// ── E:尾终止符单独一块 ──
{
  const out = drive(['\x1b', null, '[<0;32;5', 'M'])
  const leaked = out.filter(k =>
    k.kind === 'key' && k.name === '' && k.sequence && /[[<\d;]/.test(k.sequence))
  check('E terminator-fragment recovered',
    out.some(k => k.kind === 'mouse') && leaked.length === 0,
    `leaked=${leaked.map(describe).join(',')} all=${out.map(describe).join(',')}`)
}

// ── 防误吞回归:手打文本不受影响 ──
{
  const out = drive(['[MAX]more'])
  const t = out[0]
  check('F typed [MAX] batch not swallowed',
    t !== undefined && t.kind === 'key' && (t.sequence === '[MAX]more' || t.name !== 'wheelup'),
    out.map(describe).join(','))
}
{
  const out = drive(['[', '<', '0', ';', '1'])
  check('G char-by-char typing never held',
    out.length === 5 && out.every(k => k.kind === 'key'),
    out.map(describe).join(','))
}

// ── 真实 ConPTY 路径:SGR 报告被合成成逐字符 win32-input-mode 记录 ──
{
  const records = synthesizedWin32('\x1b[<35;190;25m')
  const out = drive([records.join('')])
  check('H synthesized Win32 SGR report reassembled',
    out.length === 1 && out[0]!.kind === 'mouse' && out[0].action === 'release',
    out.map(describe).join(','))
}
{
  const records = synthesizedWin32('\x1b[<0;32;5M')
  const out = drive([records.slice(0, 4).join(''), records.slice(4).join('')])
  check('I synthesized Win32 SGR survives chunk boundary',
    out.length === 1 && out[0]!.kind === 'mouse' && out[0].action === 'press',
    out.map(describe).join(','))
}
{
  const records = synthesizedWin32('\x1b[?1;0c')
  const out = drive([records.slice(0, 3).join(''), records.slice(3).join('')])
  check('J synthesized Win32 DA1 response reassembled',
    out.length === 1 && out[0]!.kind === 'response' && out[0].response.type === 'da1',
    out.map(describe).join(','))
}
{
  const records = synthesizedWin32('\x1b[<64;74;16M')
  const out = drive([records.join('')])
  check('K synthesized Win32 wheel keeps coordinates',
    out.length === 1 && out[0]!.kind === 'key' && out[0].name === 'wheelup' &&
      out[0].mouseCol === 73 && out[0].mouseRow === 15,
    out.map(describe).join(','))
}
{
  const records = synthesizedWin32('\x1b[<0;32;')
  const out = drive([records.join(''), null])
  check('L truncated synthesized Win32 mouse report is discarded',
    out.length === 0,
    out.map(describe).join(','))
}
{
  const records = synthesizedWin32('\x1b[M ')
  const out = drive([records.join(''), null])
  check('M truncated synthesized Win32 X10 report is discarded',
    out.length === 0,
    out.map(describe).join(','))
}
{
  const records = synthesizedWin32('\x1b')
  const out = drive([records.join(''), null])
  check('N lone synthesized Win32 Escape is released',
    out.length === 1 && out[0]!.kind === 'key' && out[0].name === 'escape',
    out.map(describe).join(','))
}
{
  const records = synthesizedWin32('\x1b[?')
  const out = drive([records.join(''), null])
  check('O unknown synthesized Win32 CSI is released',
    out.length === records.length && out.every(k => k.kind === 'key'),
    out.map(describe).join(','))
}
{
  const physicallyTyped = [
    win32Record(219, 26, 91),
    win32Record(226, 86, 60),
    win32Record(48, 11, 48),
    win32Record(186, 39, 59),
    win32Record(51, 4, 51),
    win32Record(50, 3, 50),
    win32Record(186, 39, 59),
    win32Record(53, 6, 53),
    win32Record(77, 50, 77),
  ]
  const out = drive([physicallyTyped.join('')])
  check('P physical Win32 typing stays as text',
    out.length === physicallyTyped.length && out.every(k => k.kind === 'key'),
    out.map(describe).join(','))
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
