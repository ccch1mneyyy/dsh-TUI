/**
 * repro-sgr-orphan-leak — 复现 PowerShell(ConPTY)下 SGR 鼠标序列
 * 被 50ms ESC flush 拆开后、碎片尾部漏进输入框的路径。
 *
 * 用法:node --import tsx/esm scripts/repro-sgr-orphan-leak.ts
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
  return `response(${k.type ?? '?'})`
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

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
