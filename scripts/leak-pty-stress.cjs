/**
 * leak-pty-stress.cjs — spawn the REAL dsh-cc in a PTY, auto-send realistic
 * tool-heavy prompts, watch child RSS from outside until it blows or stabilizes.
 *
 * Usage: node packages/ui/cc-tui/scripts/leak-pty-stress.cjs [rounds] [intervalSec]
 */
const { spawn } = require('D:/code/projects/test-ccch1mneyyy/packages/pty/pty-local/node_modules/node-pty')
const { execSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

const ROUNDS = Number(process.argv[2] ?? 25)
const INTERVAL_SEC = Number(process.argv[3] ?? 75)
const WORKSPACE = 'D:/code/projects/test-ccch1mneyyy'
const LOG = path.join(os.homedir(), '.dsh-cc', 'pty-stress-rss.log')

const PROMPTS = [
  'run bash: git log --oneline -15, then make a markdown table summarizing each commit in detail',
  'read packages/ui/cc-tui/package.json and explain every dependency category with markdown headers',
  'run bash: git diff HEAD~3 --stat, then analyze the change distribution with a detailed breakdown',
  'explain the rendering pipeline architecture of this TUI in depth, with code examples',
  'run bash: git branch -a, then explain the branch strategy with a mermaid-style ascii diagram',
  'read packages/ui/cc-tui/src/channel.ts first 100 lines and explain the event flow in detail',
  'write a detailed tutorial on how the cordis plugin system works, with examples',
  'run bash: git log --since=yesterday --oneline, then write a detailed changelog in markdown',
]

function totalRss(_rootPid) {
  // Sum WorkingSetSize of every process whose command line mentions run.ts
  // (covers the cmd wrapper + node child without tree enumeration).
  try {
    const out = execSync(
      `powershell -NoProfile -Command "(Get-CimInstance Win32_Process | Where-Object {$_.CommandLine -like '*cc-tui*run.ts*'} | Measure-Object WorkingSetSize -Sum).Sum"`,
      { encoding: 'utf8', timeout: 10000 },
    ).trim()
    return Number(out) || 0
  } catch { return 0 }
}

async function main() {
  fs.mkdirSync(path.dirname(LOG), { recursive: true })
  fs.writeFileSync(LOG, `# pty stress: ${ROUNDS} rounds x ${INTERVAL_SEC}s\n`)

  const runScript = 'packages/ui/cc-tui/scripts/run.ts'
  // V8-native OOM snapshot via NODE_OPTIONS (avoids cmd quoting hell).
  const snapDir = path.join(os.homedir(), '.dsh-cc').split('\\').join('/')
  const env = {
    ...process.env,
    DSH_CC_HEAP_WATCH: '1',
    NODE_OPTIONS: `--heapsnapshot-near-heap-limit=2 --diagnostic-dir=${snapDir}`,
  }
  const proc = spawn('cmd.exe', ['/c', `node --import tsx/esm ${runScript}`], {
    name: 'xterm-256color',
    cols: 120,
    rows: 40,
    cwd: WORKSPACE,
    env,
  })
  console.error(`[stress] spawned pid=${proc.pid}`)

  let output = ''
  proc.onData((d) => { output += d; if (output.length > 400000) output = output.slice(-200000) })

  // Wait for boot (banner / prompt)
  const t0 = Date.now()
  await new Promise((r) => {
    const iv = setInterval(() => {
      if (output.includes('❯') || output.includes('dsh-TUI') || Date.now() - t0 > 90000) { clearInterval(iv); r() }
    }, 500)
  })
  const bootOk = output.includes('❯') || output.includes('dsh-TUI')
  console.error(`[stress] boot ${bootOk ? 'OK' : 'TIMEOUT-BAILOUT'} after ${((Date.now() - t0) / 1000).toFixed(0)}s, output=${output.length}B`)
  if (!bootOk) {
    console.error('[stress] TUI did not render — aborting (check heap-watch.log / diagnostic)')
    try { proc.kill() } catch {}
    process.exit(1)
  }

  const samples = []
  const sampleTimer = setInterval(() => {
    const rss = totalRss(proc.pid)
    const mb = rss / 1048576
    samples.push({ t: Date.now() - t0, mb })
    fs.appendFileSync(LOG, `t=${((Date.now() - t0) / 1000).toFixed(0)}s rss=${mb.toFixed(0)}MB\n`)
    console.error(`[stress] t=${((Date.now() - t0) / 1000).toFixed(0)}s rss=${mb.toFixed(0)}MB`)
  }, 15000)

  for (let round = 1; round <= ROUNDS; round++) {
    const prompt = PROMPTS[(round - 1) % PROMPTS.length]
    console.error(`[stress] round ${round}: ${prompt.slice(0, 60)}...`)
    proc.write(prompt + '\r')
    await new Promise((r) => setTimeout(r, INTERVAL_SEC * 1000))
    const rss = totalRss(proc.pid) / 1048576
    console.error(`[stress] after round ${round}: rss=${rss.toFixed(0)}MB`)
    if (rss > 5200) {
      console.error('[stress] ❌ RSS>5.2GB — past V8 limit, should have OOM-snapshotted')
      break
    }
  }

  clearInterval(sampleTimer)
  const first = samples.find((s) => s.mb > 0)?.mb ?? 0
  const last = samples[samples.length - 1]?.mb ?? 0
  console.error(`[stress] done. rss ${first.toFixed(0)}MB -> ${last.toFixed(0)}MB`)
  console.error(`[stress] trend: ${samples.filter((_, i) => i % 4 === 0).map((s) => s.mb.toFixed(0)).join(' -> ')}`)
  try { proc.kill() } catch {}
  process.exit(0)
}

main().catch((e) => { console.error('[stress] fatal:', e); process.exit(1) })
