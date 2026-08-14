// perf-probe.cjs — streaming-smoothness probe: real dsh-cc in a PTY, one
// long-streaming user message, COMMIT_LOG captures React commit frequency
// and slow reconciles. Usage:
//   node scripts/perf-probe.cjs [rounds]
// Env: PERF_MSG overrides the prompt.
const { spawn } = require('D:/code/projects/test-ccch1mneyyy/packages/pty/pty-local/node_modules/node-pty')
const fs = require('fs')
const path = require('path')

const CC = 'D:\\code\\projects\\test-ccch1mneyyy\\packages\\ui\\cc-tui'
const COMMIT_LOG = 'D:\\tmp\\commit-log.txt'
const HEAP_WATCH = process.env.USERPROFILE + '\\.dsh-cc\\heap-watch.log'
const ROUNDS = Number(process.argv[2] || 2)
const MSG =
  process.env.PERF_MSG ||
  '用 markdown 写一篇关于终端渲染管线优化的长文，至少 300 行，包含多个代码块（每个代码块至少 40 行 JS 代码）、表格、标题层级、列表。直接输出全文不要省略。'

fs.mkdirSync('D:\\tmp', { recursive: true })
fs.writeFileSync(COMMIT_LOG, '')
const heapBefore = fs.existsSync(HEAP_WATCH) ? fs.statSync(HEAP_WATCH).size : 0

const pty = spawn('cmd.exe', ['/c', 'dsh-tui.cmd'], {
  name: 'xterm-256color',
  cols: 120,
  rows: 36,
  cwd: CC,
  env: {
    ...process.env,
    CLAUDE_CODE_COMMIT_LOG: COMMIT_LOG,
    DSH_CC_HEAP_WATCH: '1',
  },
})

let outLen = 0
const frameGaps = []
let lastDataAt = 0
let bootBuf = ''
pty.onData(d => {
  const now = Date.now()
  outLen++
  if (bootBuf !== null) bootBuf += d
  if (lastDataAt > 0) frameGaps.push(now - lastDataAt)
  lastDataAt = now
})

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function waitFor(re, timeoutMs, label) {
  let buf = ''
  const t0 = Date.now()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      sub.dispose()
      reject(new Error(`TIMEOUT waiting ${label}; tail=${JSON.stringify(buf.slice(-300))}`))
    }, timeoutMs)
    const sub = pty.onData(d => {
      buf += d
      if (re.test(buf)) {
        clearTimeout(timer)
        sub.dispose()
        resolve()
      }
    })
  })
}

;(async () => {
  // Boot: wait for the prompt glyph (the logo animates in over ~1s of
  // incremental frames, so banner-text regexes are unreliable).
  {
    const t0 = Date.now()
    await new Promise(r => {
      const iv = setInterval(() => {
        if (bootBuf.includes('❯') || Date.now() - t0 > 90000) {
          clearInterval(iv)
          r()
        }
      }, 400)
    })
    if (!bootBuf.includes('❯')) throw new Error('boot timeout (no ❯ prompt); tail=' + JSON.stringify(bootBuf.slice(-200)))
    bootBuf = null
  }
  console.log('[perf] booted')
  await sleep(800)

  for (let round = 1; round <= ROUNDS; round++) {
    // Bracket this round in the commit log.
    fs.appendFileSync(COMMIT_LOG, `=== ROUND ${round} START ${Date.now()} ===\n`)
    pty.write(MSG.replace(/\r/g, '') + '\r')
    console.log(`[perf] round ${round}: message sent (${MSG.length} chars), streaming…`)
    const t0 = Date.now()
    // Turn ends when the working line disappears: status line shows the
    // context/price footer again. Cheap proxy: watch for 'esc to interrupt'
    // appearing then disappearing; simplest robust signal is a quiet period
    // after output stops — wait for /ctx .* left/ footer plus 3s silence.
    await waitFor(/left|%/i, 15000, 'statusline')
    let quiet = 0
    let last = outLen
    while (quiet < 4 && Date.now() - t0 < 240000) {
      await sleep(1000)
      if (outLen === last) quiet++
      else {
        quiet = 0
        last = outLen
      }
    }
    fs.appendFileSync(COMMIT_LOG, `=== ROUND ${round} END ${Date.now()} ===\n`)
    console.log(`[perf] round ${round} settled in ${((Date.now() - t0) / 1000).toFixed(0)}s`)
    await sleep(500)
  }

  pty.write('') // Ctrl-C
  await sleep(600)
  pty.kill()

  // --- analysis -----------------------------------------------------------
  const lines = fs.readFileSync(COMMIT_LOG, 'utf8').split('\n')
  const rateLines = lines.filter(l => /commits=\d+\/s/.test(l))
  const rates = rateLines.map(l => Number(l.match(/commits=(\d+)\/s/)[1]))
  const slow = lines.filter(l => /reconcile=(\d+(?:\.\d+)?)ms/.test(l) && Number(l.match(/reconcile=([\d.]+)ms/)[1]) > 20)
  const slowYoga = lines.filter(l => l.includes('SLOW_YOGA'))
  const bigCreates = lines.filter(l => /creates=(\d+)/.test(l) && Number(l.match(/creates=(\d+)/)[1]) > 50)

  const sorted = [...frameGaps].sort((a, b) => a - b)
  const pct = p => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : 0

  console.log('\n===== 流畅度分析 =====')
  console.log(`PTY 输出事件: ${outLen}, 间隔 p50=${pct(0.5)}ms p95=${pct(0.95)}ms p99=${pct(0.99)}ms max=${sorted[sorted.length - 1] || 0}ms`)
  console.log(`commit 速率样本: ${rates.length} 个秒级窗口`)
  if (rates.length) {
    const avg = rates.reduce((a, b) => a + b, 0) / rates.length
    const max = Math.max(...rates)
    console.log(`commits/s: avg=${avg.toFixed(1)} max=${max}  (修复前峰值 100-300/s; 帧对齐后应 ≤65)`)
  }
  console.log(`慢 reconcile (>20ms): ${slow.length} 次`)
  if (slow.length) console.log('  示例:', slow.slice(0, 3).join(' | '))
  console.log(`慢 yoga (>20ms): ${slowYoga.length} 次`)
  if (slowYoga.length) console.log('  示例:', slowYoga.slice(0, 2).join(' | '))
  console.log(`大批量节点创建 (>50): ${bigCreates.length} 次`)
  console.log('\n判定: ' + (rates.length && Math.max(...rates) <= 70 && slow.length <= rates.length * 0.2 ? 'PASS ✅ 帧对齐生效且慢 commit 可控' : '需人工看数据'))
})().catch(e => {
  console.error('[perf] FAIL:', e.message)
  pty.kill()
  process.exit(1)
})
