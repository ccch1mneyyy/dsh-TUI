#!/usr/bin/env node
/**
 * Terminal size has one source outside the renderer (verify:build gate).
 *
 * Everything above src/ink/ sizes itself from useTerminalSize()
 * (TerminalSizeContext). That context is what makes layouts composable:
 * PageMargin narrows it to the content area, and a split layout narrows it
 * again per column, so wrap widths, tool cards, tables, the prompt budget and
 * image slots all follow their container without knowing it exists. A
 * component that reads the real terminal instead — process.stdout.columns,
 * useStdout().stdout.rows, a stdout 'resize' listener — silently lays out for
 * the whole screen and overflows the moment it is put in a narrower box.
 *
 * So outside src/ink/ (the renderer, which owns the terminal) this gate
 * rejects, by syntax tree rather than text (comments and strings never
 * match):
 *   - `.columns` / `.rows` / `.getWindowSize` on anything named stdout/stderr
 *     (process.stdout, a destructured stdout, this.stdout, opts.stderr, …),
 *     dotted, optional-chained or bracketed;
 *   - `.on|once|addListener|prependListener('resize', …)` on stdout/stderr and
 *     `process.on('SIGWINCH', …)`;
 *   - any use of a `useStdoutDimensions` hook.
 * Fix: read useTerminalSize() in components; pass sizes down as arguments to
 * non-React code; anything that genuinely needs the physical terminal
 * belongs in src/ink/.
 *
 * ALLOWED lists the few reads outside src/ink/ that are physical on purpose,
 * each with its reason. An entry matches one file and one exact expression,
 * so a new read in the same file still fails, and an entry whose read is gone
 * fails too — the list can only shrink.
 *
 * The matcher checks itself against known-bad and known-good snippets first,
 * so a gate that silently stopped matching fails instead of passing.
 *
 * Run: node scripts/verify-terminal-size-source.mjs
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SRC = join(ROOT, 'src')
const RENDERER = join(SRC, 'ink')
const SIZE_MEMBERS = new Set(['columns', 'rows', 'getWindowSize'])
const STREAMS = new Set(['stdout', 'stderr'])
const LISTEN = new Set(['on', 'once', 'addListener', 'prependListener'])

const ALLOWED = [
  {
    file: 'src/components/OverlayAbove.tsx',
    text: 'stdout.rows',
    reason: 'compares the Ink root height (page margin and scrollback included) with the physical rows to find the visible space above the anchor',
  },
  {
    file: 'src/components/ImagePreviewOverlay.tsx',
    text: 'stdout.rows',
    reason: "anchors the inline layer to the parent's visible tail: root height against physical rows, same as OverlayAbove",
  },
]

/** The member name of `a.b`, `a?.b` or `a['b']`, else undefined. */
function memberName(node) {
  if (ts.isPropertyAccessExpression(node)) return node.name.text
  if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)) {
    return node.argumentExpression.text
  }
  return undefined
}

/** Whether an expression names a stdio stream: `stdout`, `process.stdout`, `this.stderr`, … */
function isStream(node) {
  if (ts.isIdentifier(node)) return STREAMS.has(node.text)
  const name = memberName(node)
  return name !== undefined && STREAMS.has(name)
}

/** Every direct terminal-size read in one source text, as { line, text, why }. */
function findReads(fileName, text) {
  const kind = fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, kind)
  const hits = []
  const report = (node, why) => {
    const { line } = source.getLineAndCharacterOfPosition(node.getStart(source))
    hits.push({ line: line + 1, text: node.getText(source).replace(/\s+/g, ' ').slice(0, 80), why })
  }
  const visit = node => {
    const name = memberName(node)
    if (name !== undefined && SIZE_MEMBERS.has(name) && isStream(node.expression)) {
      report(node, `reads the real terminal's ${name}`)
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression
      const event = node.arguments[0]
      const listener = memberName(callee)
      if (listener !== undefined && LISTEN.has(listener) && event && ts.isStringLiteralLike(event)) {
        const target = callee.expression
        if (event.text === 'resize' && isStream(target)) report(node, 'listens for terminal resize itself')
        if (event.text === 'SIGWINCH' && ts.isIdentifier(target) && target.text === 'process') {
          report(node, 'listens for SIGWINCH itself')
        }
      }
    }
    if (ts.isIdentifier(node) && node.text === 'useStdoutDimensions') report(node, 'uses a stdout dimensions hook')
    ts.forEachChild(node, visit)
  }
  visit(source)
  return hits
}

// ── Self-check: the matcher must still tell bad from good ─────────────────

const MUST_FLAG = [
  'const w = process.stdout.columns',
  'const h = process.stderr.rows',
  'const { stdout } = useStdout(); const w = stdout.columns',
  'const w = stdout?.columns ?? 80',
  "const w = this.stdout['rows']",
  'const [w, h] = process.stdout.getWindowSize()',
  "process.stdout.on('resize', relayout)",
  "stdout.once('resize', relayout)",
  "process.on('SIGWINCH', relayout)",
  'const { columns } = useStdoutDimensions()',
]
const MUST_PASS = [
  'const { columns, rows } = useTerminalSize()',
  'const w = size.columns - 2',
  'const w = table.rows.length',
  '// process.stdout.columns is the real terminal width',
  "const doc = 'never read process.stdout.columns here'",
  "process.on('exit', cleanup)",
  "emitter.on('resize', relayout)",
  "const isTty = process.stdout.isTTY",
]
const selfCheck = [
  ...MUST_FLAG.filter(snippet => findReads('probe.tsx', snippet).length !== 1).map(s => `not flagged: ${s}`),
  ...MUST_PASS.filter(snippet => findReads('probe.tsx', snippet).length !== 0).map(s => `wrongly flagged: ${s}`),
]
if (selfCheck.length > 0) {
  console.error('verify-terminal-size-source: the matcher itself is broken:')
  for (const line of selfCheck) console.error(`  - ${line}`)
  process.exit(1)
}

// ── Scan src/ outside the renderer ────────────────────────────────────────

function sources(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (path !== RENDERER) sources(path, out)
    } else if (/\.(?:ts|tsx|mts|cts)$/.test(entry.name)) {
      out.push(path)
    }
  }
  return out
}

const files = sources(SRC)
const violations = []
const usedAllowances = new Set()
for (const file of files) {
  const rel = relative(ROOT, file).split(sep).join('/')
  for (const hit of findReads(rel, readFileSync(file, 'utf8'))) {
    const allowance = ALLOWED.find(entry => entry.file === rel && entry.text === hit.text)
    if (allowance) usedAllowances.add(allowance)
    else violations.push({ rel, ...hit })
  }
}
const stale = ALLOWED.filter(entry => !usedAllowances.has(entry))
if (stale.length > 0) {
  console.error('verify-terminal-size-source: ALLOWED entries no longer match any read — remove them:')
  for (const { file, text } of stale) console.error(`  ${file}  ${text}`)
  process.exit(1)
}

if (violations.length > 0) {
  console.error(`verify-terminal-size-source: ${violations.length} direct terminal size read(s) outside src/ink/:`)
  for (const { rel, line, text, why } of violations) console.error(`  ${rel}:${line}  ${text}  — ${why}`)
  console.error('Read useTerminalSize() instead (it is narrowed to the surrounding layout: page margin, split')
  console.error('columns); pass sizes into non-React code; physical-terminal logic belongs in src/ink/.')
  process.exit(1)
}
console.log(`verify-terminal-size-source: OK (${files.length} files outside src/ink/, ${ALLOWED.length} allowed physical reads, matcher self-check ${MUST_FLAG.length}+${MUST_PASS.length})`)
