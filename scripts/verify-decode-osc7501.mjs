#!/usr/bin/env node
/**
 * decode-osc7501 回归 —— 取证 CLI（scripts/decode-osc7501.mjs）与它的解码核心
 * （scripts/lib/decode-osc7501.mjs）。
 *
 * Covers:
 * - 报告解码：正常报告、探测回复、被拒绝报告的原因
 * - **不可信输出**：`msg`/`title` 解码后含 C0/DEL/C1（清屏、换行、OSC 52 一类
 *   payload）时整条拒绝，绝不把解码结果写出去；`state`/`app`/`id`/未知键/探测
 *   文本等其他字段一律转义展示。CLI 的文件与 stdin 两个入口都实测 stdout 里
 *   不存在可执行控制字节。
 * - **增量读取**（`--follow` 的读取路径）：只读新增字节，追加普通渲染字节
 *   不会重放历史报告，跨读取边界的半条报告补齐后只多一条，文件被截断/轮换
 *   （unlink 后重建，fd 指向已删除的 inode）时位置与尾巴一起重置。
 *
 * Run: node scripts/verify-decode-osc7501.mjs
 * 非零退出即失败（CI 约定）。
 */

import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { appendFileSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createIncrementalTail,
  decodeBase64,
  escapeForDisplay,
  interpretReport,
  scanChunk,
} from './lib/decode-osc7501.mjs'

let failed = 0
function check(name, fn) {
  try {
    fn()
    console.log(`  ok - ${name}`)
  } catch (error) {
    failed++
    console.log(`  FAIL - ${name}`)
    console.log(`    ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function checkAsync(name, fn) {
  try {
    await fn()
    console.log(`  ok - ${name}`)
  } catch (error) {
    failed++
    console.log(`  FAIL - ${name}`)
    console.log(`    ${error instanceof Error ? error.message : String(error)}`)
  }
}

const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/u
const SEQ = body => `\x1b]7501;${body}\x07`
const B64 = text => Buffer.from(text, 'utf8').toString('base64')

/** 一条展示行（含拒绝原因）里不允许出现任何控制字符。 */
function assertSafe(entry, where) {
  assert.ok(!CONTROL_RE.test(entry.line ?? ''), `${where}: 展示行含控制字符 ${JSON.stringify(entry.line)}`)
  assert.ok(!CONTROL_RE.test(entry.reason ?? ''), `${where}: 拒绝原因含控制字符`)
  assert.ok(!CONTROL_RE.test(entry.detail ?? ''), `${where}: 证据含控制字符`)
}

// -----------------------------------------------------------------------------
console.log('报告解码')
// -----------------------------------------------------------------------------

check('正常报告解出状态、kind、app、msg', () => {
  const { entries } = scanChunk(SEQ(`state=blocked:kind=permission:app=terraform:msg=${B64('Apply 3?')}`))
  assert.equal(entries.length, 1)
  assert.equal(entries[0].ok, true)
  assert.match(entries[0].line, /◼ blocked/)
  assert.match(entries[0].line, /kind=permission/)
  assert.match(entries[0].line, /app=terraform/)
  assert.match(entries[0].line, /msg="Apply 3\?"/)
})

check('探测回复与查询走单独一行', () => {
  const { entries } = scanChunk(SEQ('? : states=idle,working'))
  assert.equal(entries.length, 1)
  assert.match(entries[0].line, /^探测回复\/查询：/)
})

check('完整序列之后的普通渲染字节不算报告', () => {
  const { entries, pending } = scanChunk(`${SEQ('state=done:app=dsh-tui')}\x1b[38;5;1m noise \x1b[0m`)
  assert.equal(entries.length, 1)
  assert.equal(pending, '')
})

check('半条报告的尾巴留到下一次，补齐后只出一条', () => {
  const first = scanChunk('\x1b]7501;state=work')
  assert.equal(first.entries.length, 0)
  assert.equal(first.pending, '\x1b]7501;state=work')
  const second = scanChunk(`${first.pending}ing:app=dsh-tui\x07`)
  assert.equal(second.entries.length, 1)
  assert.match(second.entries[0].line, /◐ working/)
})

check('超过整条序列上限的尾巴被丢掉（不会无限增长）', () => {
  const { entries, pending } = scanChunk(`\x1b]7501;${'x'.repeat(5000)}`)
  assert.equal(entries.length, 0)
  assert.equal(pending, '')
})

// -----------------------------------------------------------------------------
console.log('不可信输出：解码后含控制字符的报告整条拒绝')
// -----------------------------------------------------------------------------

check('base64 解码结果（清屏 / 换行 / 制表）被拒绝且不落进输出', () => {
  const cases = [
    ['\x1b[2J', 'G1sySg=='],
    ['a\nb', B64('a\nb')],
    ['a\tb', B64('a\tb')],
    ['\u0000', B64('\u0000')],
    ['\u007f', B64('\u007f')],
    ['\u0085', B64('\u0085')],
    ['\x1b]52;c;AAAA\x07', B64('\x1b]52;c;AAAA\x07')],
  ]
  for (const [payload, encoded] of cases) {
    for (const key of ['msg', 'title']) {
      const { entries } = scanChunk(SEQ(`state=error:app=dsh-tui:${key}=${encoded}`))
      assert.equal(entries.length, 1, `${key} ${JSON.stringify(payload)}`)
      assert.equal(entries[0].ok, false, `${key} ${JSON.stringify(payload)} 必须整条拒绝`)
      assert.match(entries[0].reason, /含控制字符/)
      assertSafe(entries[0], `${key} ${JSON.stringify(payload)}`)
    }
  }
  // 审查给出的那条正是清屏：解码成 ESC[2J。
  assert.equal(decodeBase64('G1sySg=='), '\x1b[2J')
})

check('非 base64 与非法 UTF-8 也被拒绝', () => {
  for (const bad of ['msg=!!!', `msg=${Buffer.from([0xff, 0xfe]).toString('base64')}`, 'msg=AAAAA']) {
    const { entries } = scanChunk(SEQ(`state=error:app=dsh-tui:${bad}`))
    assert.equal(entries[0].ok, false, bad)
    assert.match(entries[0].reason, /不是合法 base64/)
    assertSafe(entries[0], bad)
  }
})

check('state / app / id / 未知键 / 探测文本里的控制字符被转义展示', () => {
  const { entries } = scanChunk(SEQ('state=work\x01ing:app=a\x02b:id=c\x03d:nu\x04ll=1\x05'))
  assert.equal(entries.length, 1)
  assert.equal(entries[0].ok, true)
  assertSafe(entries[0], '未解码字段')
  assert.match(entries[0].line, /\\x01/)
  assert.match(entries[0].line, /\\x02/)
  assert.match(entries[0].line, /\\x03/)
  assert.match(entries[0].line, /未知键: nu\\x04ll/)

  const probe = scanChunk(SEQ('? providers\x1f'))
  assert.equal(probe.entries.length, 1)
  assertSafe(probe.entries[0], '探测文本')
  assert.match(probe.entries[0].line, /\\x1f/)
})

check('转义表覆盖 C0/DEL/C1 的每一个码位', () => {
  for (let code = 0; code <= 0x9f; code++) {
    const char = String.fromCodePoint(code)
    const escaped = escapeForDisplay(char)
    assert.ok(!CONTROL_RE.test(escaped), `U+${code.toString(16).padStart(4, '0')} 未被转义`)
    if (code < 0x20 || code === 0x7f) assert.ok(!(code >= 0x20 && code < 0x7f))
  }
  // 可打印字符原样通过。
  assert.equal(escapeForDisplay('a b'), 'a b')
  assert.equal(escapeForDisplay('世界'), '世界')
})

check('恶意语料的每一条输出都不含可执行控制字节', () => {
  const corpus = [
    SEQ(`state=error:app=dsh-tui:msg=${B64('\x1b[2J')}`),
    SEQ(`state=error:app=dsh-tui:msg=${B64('\x1b]52;c;' + B64('x') + '\x07')}`),
    SEQ('state=\x01\x02:app=\x7f:id=\u0085'),
    SEQ(`state=done:title=${B64('ok')}:msg=${B64('done')}`),
    SEQ('?'),
    '\x1b]7501;state=work',
    '渲染噪音 \x1b[?25l\x1b[2K\r',
  ].join('')
  const { entries } = scanChunk(corpus)
  assert.ok(entries.length >= 4)
  for (const [index, entry] of entries.entries()) assertSafe(entry, `corpus[${index}]`)
  assert.equal(interpretReport('state=idle:app=dsh-tui').ok, true)
})

// -----------------------------------------------------------------------------
console.log('增量读取（--follow 的读取路径）')
// -----------------------------------------------------------------------------

const controller = () => {
  let bytes = Buffer.alloc(0)
  return {
    write(text) { bytes = Buffer.from(text, 'utf8') },
    append(text) { bytes = Buffer.concat([bytes, Buffer.from(text, 'utf8')]) },
    read: (offset, length) => bytes.subarray(offset, offset + length).toString('utf8'),
    size: () => bytes.length,
  }
}

check('初始报告只出一次，重复 poll 与追加渲染字节都不再出', () => {
  const source = controller()
  const tail = createIncrementalTail(source)
  source.write(`${SEQ('state=idle:app=dsh-tui')}render`)
  assert.equal(tail.poll().length, 1)
  assert.equal(tail.poll().length, 0)
  source.append('\x1b[38;5;1mmore render\x1b[0m')
  assert.equal(tail.poll().length, 0)
})

check('追加半条报告再补齐，只新增一条', () => {
  const source = controller()
  const tail = createIncrementalTail(source)
  source.write(SEQ('state=idle:app=dsh-tui'))
  assert.equal(tail.poll().length, 1)
  source.append('\x1b]7501;state=work')
  assert.equal(tail.poll().length, 0)
  assert.notEqual(tail.pending(), '')
  source.append('ing:app=dsh-tui\x07')
  const added = tail.poll()
  assert.equal(added.length, 1)
  assert.match(added[0].line, /◐ working/)
})

check('截断/轮换后位置与尾巴一起重置，且不重放旧报告', () => {
  const source = controller()
  const tail = createIncrementalTail(source)
  source.write(`${SEQ('state=idle:app=dsh-tui')}tail-of-half:\x1b]7501;state=work`)
  assert.equal(tail.poll().length, 1)
  assert.notEqual(tail.pending(), '')
  // 文件被换掉：新的更短，旧的读取位置与半条尾巴都必须作废。
  source.write(SEQ('state=done:app=dsh-tui'))
  const after = tail.poll()
  assert.equal(after.length, 1)
  assert.match(after[0].line, /● done/)
  assert.equal(tail.pending(), '')
  assert.equal(tail.offset(), source.size())
})

check('reset() 丢弃位置与半条尾巴，让替换后的源从字节 0 重读', () => {
  const source = controller()
  const tail = createIncrementalTail(source)
  source.write(`${SEQ('state=idle:app=dsh-tui')}\x1b]7501;state=work`)
  assert.equal(tail.poll().length, 1)
  assert.notEqual(tail.pending(), '')
  // 换成一个**不比原来短**的文件：光看长度发现不了，只能由调用方复位。
  source.write(`${SEQ('state=error:app=dsh-tui')}${'pad'.repeat(8)}`)
  tail.reset()
  const after = tail.poll()
  assert.equal(after.length, 1)
  assert.match(after[0].line, /✗ error/)
  assert.equal(tail.pending(), '')
})

// -----------------------------------------------------------------------------
console.log('CLI 端到端：文件与 stdin 入口')
// -----------------------------------------------------------------------------

const SCRIPT = join(import.meta.dirname, 'decode-osc7501.mjs')
const NO_CONTROL = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/u

/** 一份含恶意 payload 的 pty 日志：合法报告 + 清屏 + 换行 + OSC 52 + 脏字段。 */
const hostileLog = () => [
  'junk before ',
  SEQ('state=working:app=dsh-tui:title=c2Vzcw=='),
  SEQ(`state=error:app=dsh-tui:msg=${B64('\x1b[2J')}`),
  SEQ(`state=error:app=dsh-tui:msg=${B64('line\nbreak')}`),
  SEQ(`state=error:app=dsh-tui:title=${B64('\x1b]52;c;AAAA\x07')}`),
  SEQ('state=work\x01ing:app=a\x02b'),
  '\x1b[2K\rmore render junk',
  SEQ(`state=done:app=dsh-tui:msg=${B64('All good')}`),
].join('')

const dir = mkdtempSync(join(tmpdir(), 'decode-osc7501-'))
try {
  const logPath = join(dir, 'pty.log')
  writeFileSync(logPath, hostileLog())

  const fileRun = spawnSync(process.execPath, [SCRIPT, logPath], { encoding: 'utf8' })
  check('文件入口：合法报告照常展示，非法报告被跳过', () => {
    assert.equal(fileRun.status, 0, fileRun.stderr)
    assert.match(fileRun.stdout, /◐ working/)
    assert.match(fileRun.stdout, /● done/)
    assert.match(fileRun.stdout, /✗ 跳过（解码后的 msg 含控制字符）：G1sySg==/)
    assert.ok(
      fileRun.stdout.includes(`✗ 跳过（解码后的 msg 含控制字符）：${B64('line\nbreak')}`),
      `换行 payload 未被拒绝：${fileRun.stdout}`,
    )
    assert.match(fileRun.stdout, /✗ 跳过（解码后的 title 含控制字符）：/)
    assert.match(fileRun.stdout, /跳过 3 条非法报告/)
  })

  check('文件入口：stdout 里没有任何可执行控制字节', () => {
    assert.ok(!fileRun.stdout.includes('\x1b'), 'stdout 出现了 ESC')
    assert.ok(!NO_CONTROL.test(fileRun.stdout), `stdout 出现控制字符：${JSON.stringify(fileRun.stdout)}`)
  })

  const stdinRun = spawnSync(process.execPath, [SCRIPT, '-'], { encoding: 'utf8', input: hostileLog() })
  check('stdin 入口：同样安全，且报告不因跨 chunk 断裂', () => {
    assert.equal(stdinRun.status, 0, stdinRun.stderr)
    assert.match(stdinRun.stdout, /◐ working/)
    assert.match(stdinRun.stdout, /● done/)
    assert.ok(!stdinRun.stdout.includes('\x1b'), 'stdout 出现了 ESC')
    assert.ok(!NO_CONTROL.test(stdinRun.stdout), `stdout 出现控制字符：${JSON.stringify(stdinRun.stdout)}`)
  })

  // --follow：只读新增字节；换掉文件（fd 指向已删除的 inode）后必须重新跟随。
  const followPath = join(dir, 'follow.log')
  const initialLog = SEQ('state=working:app=dsh-tui')
  writeFileSync(followPath, initialLog)
  const child = spawn(process.execPath, [SCRIPT, '--follow', followPath], { stdio: ['ignore', 'pipe', 'ignore'] })
  let output = ''
  const waiters = new Set()
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', chunk => {
    output += chunk
    for (const waiter of [...waiters]) waiter()
  })
  const waitFor = (predicate, label, timeoutMs = 10_000) =>
    new Promise((resolve, reject) => {
      const waiter = () => {
        if (!predicate(output)) return
        clearTimeout(timer)
        waiters.delete(waiter)
        resolve()
      }
      const timer = setTimeout(() => {
        waiters.delete(waiter)
        reject(new Error(`超时未见：${label}\n--- 已收到 ---\n${output}`))
      }, timeoutMs)
      waiters.add(waiter)
      waiter()
    })
  const occurrences = needle => output.split(needle).length - 1
  /** 轮转：删掉旧文件、写一份**长度可控**的新文件（旧 fd 指向已删除的 inode）。 */
  const rotate = (report, targetBytes) => {
    const padded = report + 'R'.repeat(Math.max(0, targetBytes - Buffer.byteLength(report)))
    unlinkSync(followPath)
    writeFileSync(followPath, padded)
  }

  try {
    await waitFor(text => text.includes('◐ working'), '第一条报告')

    await checkAsync('--follow 只读新增字节，轮换后重新跟随且不重放旧报告', async () => {
      appendFileSync(followPath, '\x1b[38;5;1mrender only\x1b[0m')
      await new Promise(resolve => setTimeout(resolve, 700))
      assert.equal(occurrences('◐ working'), 1, '追加渲染字节后历史报告被重放')
      assert.ok(!output.includes('\x1b'), 'stdout 出现了 ESC')

      appendFileSync(followPath, SEQ('state=done:app=dsh-tui'))
      await waitFor(text => text.includes('● done'), '追加的报告')
      assert.equal(occurrences('◐ working'), 1, '追加报告把旧报告也重放了一遍')

      // 轮换 1：新文件**与旧文件等长**。只看长度的实现（total < seenSize）发现
      // 不了它——长度没缩回，偏移却停在旧长度上，新文件的报告永远读不到。
      const grown = SEQ('state=working:app=dsh-tui') + '\x1b[38;5;1mrender only\x1b[0m' + SEQ('state=done:app=dsh-tui')
      rotate(SEQ('state=error:app=dsh-tui'), Buffer.byteLength(grown))
      await waitFor(text => text.includes('✗ error'), '等长轮换后的报告')
      assert.equal(occurrences('◐ working'), 1, '等长轮换后重放了旧报告')
      assert.equal(occurrences('● done'), 1, '等长轮换后重放了旧报告')

      // 轮换 2：新文件**比旧文件更长**。此时长度只会变大，同样绕开长度检测；
      // 只看长度的实现会从旧偏移读起，漏掉新文件开头那条报告。
      const previous = SEQ('state=error:app=dsh-tui') + 'R'.repeat(Math.max(0, Buffer.byteLength(grown) - Buffer.byteLength(SEQ('state=error:app=dsh-tui'))))
      const longer = SEQ('state=blocked:kind=question:app=dsh-tui') + 'R'.repeat(Buffer.byteLength(previous))
      rotate(SEQ('state=blocked:kind=question:app=dsh-tui'), Buffer.byteLength(longer))
      await waitFor(text => text.includes('◼ blocked'), '变长轮换后的报告')
      assert.equal(occurrences('✗ error'), 1, '变长轮换后重放了旧报告')
      assert.ok(!NO_CONTROL.test(output), `stdout 出现控制字符：${JSON.stringify(output)}`)
    })
  } finally {
    child.kill('SIGTERM')
  }
} finally {
  rmSync(dir, { recursive: true, force: true })
}

console.log(failed === 0 ? '\nall decode-osc7501 checks passed' : `\n${failed} check(s) failed`)
process.exit(failed === 0 ? 0 : 1)
