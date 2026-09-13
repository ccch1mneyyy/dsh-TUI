/**
 * zellij compatibility regression (DECSTBM withdrawal).
 *
 * Real-terminal report: inside zellij, ScrollBox scrolls leave stale rows —
 * tearing and leftover transcript lines that accumulate as content scrolls.
 * zellij's grid handling deviates from xterm in exactly the two sequences the
 * hardware-scroll optimization leans on:
 *
 *  - `CSI T` (grid.rs rotate_scroll_region_up) shifts rows only while the
 *    cursor sits inside the scroll region, and `CSI r` does not home the
 *    cursor outside origin mode — but the renderer parks the cursor on the
 *    last screen row, below every ScrollBox. The shift is silently dropped
 *    while the diff engine assumes it happened, so stale rows survive every
 *    scroll-up frame.
 *  - zellij DOES implement DEC 2026 synchronized output, so only DECSTBM is
 *    withdrawn: BSU/ESU stay on and frames remain atomic.
 *
 * Asserts (capability probe, same harness as verify-jediterm.tsx):
 *  1. isZellij() reads the ZELLIJ env var.
 *  2. Under ZELLIJ=1: sync output stays enabled (DEC 2026 kept).
 *  3. Under ZELLIJ=1: DECSTBM is excluded even though sync is on.
 *  4. Without ZELLIJ (plain xterm-ish env): sync + DECSTBM both stay on.
 *
 * Run: node --import tsx/esm scripts/verify-zellij.tsx
 */
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// Repo root, so `--import tsx/esm` resolves no matter where the script is
// invoked from.
const repoRoot = fileURLToPath(new URL('..', import.meta.url))

let failed = 0
function check(name: string, ok: boolean, extra = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}

// ---- capability wiring (SYNC_OUTPUT_SUPPORTED is computed at import) -------
function probeEnv(env: Record<string, string | undefined>): { zellij: boolean; sync: boolean; decstbm: boolean } {
  const terminalUrl = new URL('../src/ink/terminal.ts', import.meta.url).href
  const src = `
    const { isZellij, isSynchronizedOutputSupported, isDecstbmSafe } = await import(${JSON.stringify(terminalUrl)})
    console.log(JSON.stringify({
      zellij: isZellij(),
      sync: isSynchronizedOutputSupported(),
      decstbm: isDecstbmSafe(),
    }))
  `
  const res = spawnSync(process.execPath, ['--import', 'tsx/esm', '-e', src], {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  })
  if (res.status !== 0) throw new Error(`probe failed: ${res.stderr}`)
  return JSON.parse(res.stdout.trim().split('\n').at(-1) ?? '{}') as { zellij: boolean; sync: boolean; decstbm: boolean }
}

// zellij multiplexes the outer terminal instead of emulating it, so the sync
// probe describes the OUTER terminal's DEC 2026 support. Pin TERM_PROGRAM to
// a known-sync terminal (vscode) as the controlled premise: that isolates the
// zellij DECSTBM withdrawal from whatever terminal the script itself runs in.
const zellij = probeEnv({ ZELLIJ: '1', TERM_PROGRAM: 'vscode' })
check('zellij detected via ZELLIJ env', zellij.zellij)
check('sync output (DEC 2026) stays enabled under zellij', zellij.zellij && zellij.sync)
check('DECSTBM excluded under zellij', zellij.zellij && !zellij.decstbm)

const plain = probeEnv({ ZELLIJ: '', TERM_PROGRAM: 'vscode' })
check('same outer terminal without zellij keeps DECSTBM', plain.sync && plain.decstbm)

if (failed > 0) {
  console.error(`\n${failed} check(s) failed`)
  process.exit(1)
}
console.log('\nzellij DECSTBM regression: all checks passed')
