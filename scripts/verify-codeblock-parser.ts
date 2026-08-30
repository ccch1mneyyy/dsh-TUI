/**
 * CodeBlock parser and status annotation test suite.
 *
 * Verifies that:
 * 1. Standard executable bash code blocks render with opening fences (```bash) and indented code.
 * 2. Pseudo-code status blocks containing only comments/reports (# or Key: value or - item)
 *    render as clean status annotations without raw unexecuted code fences.
 *
 * Run: node --import tsx/esm scripts/verify-codeblock-parser.ts
 */

import stripAnsi from 'strip-ansi'
import { applyMarkdown } from '../src/cc/markdown.js'

let checks = 0
let failures = 0

function check(name: string, ok: boolean, detail = ''): void {
  checks += 1
  if (!ok) failures += 1
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || detail === '' ? '' : `: ${detail}`}`)
}

// ── Test 1: Standard executable bash block ──────────────────────────────────
{
  const bashCode = '```bash\necho "hello"\nls -la\n```'
  const rendered = applyMarkdown(bashCode)
  const plain = stripAnsi(rendered)

  check(
    'Test 1.1: Standard executable bash block includes opening ```bash fence',
    plain.includes('```bash'),
    JSON.stringify(plain),
  )
  check(
    'Test 1.2: Standard executable bash block includes code content',
    plain.includes('echo "hello"') && plain.includes('ls -la'),
    JSON.stringify(plain),
  )
}

// ── Test 2: Pseudo-code status block with only comments/reports ──────────────
{
  const statusBlock = '```bash\n# Memory & Harness Health Status\nMemory Hygiene: 0 active frictions\n```'
  const rendered = applyMarkdown(statusBlock)
  const plain = stripAnsi(rendered)

  check(
    'Test 2.1: Status block does NOT contain raw ```bash code fence',
    !plain.includes('```bash') && !plain.includes('```'),
    JSON.stringify(plain),
  )
  check(
    'Test 2.2: Status block contains header text',
    plain.includes('Memory & Harness Health Status'),
    JSON.stringify(rendered),
  )
  check(
    'Test 2.3: Status block contains key-value status item',
    plain.includes('Memory Hygiene: 0 active frictions'),
    JSON.stringify(rendered),
  )
  check(
    'Test 2.4: Status block contains gutter/annotation styling',
    rendered.includes('│') || rendered.includes('▎'),
    JSON.stringify(rendered),
  )
}

// ── Test 3: Mixed bash block with comment and executable command ─────────────
{
  const mixedCode = '```bash\n# Setup step\nnpm install\n```'
  const rendered = applyMarkdown(mixedCode)
  const plain = stripAnsi(rendered)

  check(
    'Test 3: Mixed bash block with executable command keeps ```bash fence',
    plain.includes('```bash') && plain.includes('npm install'),
    JSON.stringify(plain),
  )
}

// ── Test 4: Status block with bullet list and key-value items ────────────────
{
  const bulletStatus = '```sh\n# System Overview\nStatus: Operational\n- Worker 1: Active\n- Worker 2: Idle\n```'
  const rendered = applyMarkdown(bulletStatus)
  const plain = stripAnsi(rendered)

  check(
    'Test 4: Sh status block with bullets renders cleanly without fence',
    !plain.includes('```sh') &&
      plain.includes('System Overview') &&
      plain.includes('Status: Operational') &&
      plain.includes('Worker 1: Active'),
    JSON.stringify(plain),
  )
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures > 0) {
  process.exit(1)
} else {
  console.log('✓ CodeBlock parser tests passed')
}
