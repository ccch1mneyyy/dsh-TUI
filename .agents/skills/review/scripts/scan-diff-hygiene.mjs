#!/usr/bin/env node

import { readFileSync } from 'node:fs'
import process from 'node:process'

const PATTERNS = [
  {
    id: 'merge-conflict-marker',
    regex: /^(?:<{7}|={7}|>{7})(?:\s|$)/,
    signal: 'Unresolved merge-conflict marker on an added line',
    confidence: 'high-signal',
  },
  {
    id: 'debugger-statement',
    regex: /(^|\s)debugger\s*;?(?:\s|$)/,
    signal: 'Debugger statement added',
    confidence: 'high-signal',
  },
  {
    id: 'stdout-debug-output',
    regex: /\bconsole\.(?:log|info|debug)\s*\(/,
    signal: 'Potential stdout/debug output added; dsh-TUI must stay quiet while rendering',
    confidence: 'high-signal',
  },
  {
    id: 'type-check-suppression',
    regex: /@ts-(?:ignore|nocheck)|eslint-disable(?:-next-line|-line)?/,
    signal: 'Type/lint suppression added; verify whether it hides a contract problem',
    confidence: 'context-required',
  },
  {
    id: 'disabled-test',
    regex: /\b(?:describe|it|test)\.skip\s*\(|\b(?:xdescribe|xit|xtest)\s*\(/,
    signal: 'Disabled test added',
    confidence: 'high-signal',
  },
  {
    id: 'placeholder-marker',
    regex: /\b(?:TODO|FIXME|HACK|XXX)\b|not[ -]?implemented|coming soon|placeholder/i,
    signal: 'Placeholder or deferred-work marker added; check reachability and merge readiness',
    confidence: 'context-required',
  },
  {
    id: 'empty-catch',
    regex: /\bcatch\s*(?:\([^)]*\))?\s*\{\s*\}/,
    signal: 'Empty catch block added; check whether failure is intentionally and observably ignored',
    confidence: 'context-required',
  },
  {
    id: 'swallowed-promise',
    regex: /\.catch\s*\(\s*\(?(?:[^)=]*)\)?\s*=>\s*\{\s*\}\s*\)/,
    signal: 'Promise rejection appears to be swallowed',
    confidence: 'context-required',
  },
  {
    id: 'any-escape',
    regex: /\bas\s+any\b|:\s*any\b|<any>/,
    signal: 'New any escape; check whether unknown can be narrowed at the boundary',
    confidence: 'context-required',
  },
]

const SKIP_FILE_PATTERNS = [
  /(^|\/)node_modules\//,
  /(^|\/)(?:pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lockb?)$/,
  /\.min\.[^.]+$/,
]

function parseArgs(argv) {
  const args = { input: null, format: 'json', selfTest: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--input') args.input = argv[++i]
    else if (arg === '--format') args.format = argv[++i]
    else if (arg === '--self-test') args.selfTest = true
    else if (arg === '--help' || arg === '-h') {
      console.log(`Usage:
  git diff <range> | node scan-diff-hygiene.mjs [--format json|markdown]
  node scan-diff-hygiene.mjs --input <patch.diff> [--format json|markdown]
  node scan-diff-hygiene.mjs --self-test

This scanner emits candidates only. Every candidate requires repository-context proof before it becomes a finding or fix.`)
      process.exit(0)
    } else throw new Error(`unknown argument: ${arg}`)
  }
  if (!['json', 'markdown'].includes(args.format)) {
    throw new Error('--format must be json or markdown')
  }
  return args
}

function shouldSkipFile(path) {
  return SKIP_FILE_PATTERNS.some(pattern => pattern.test(path))
}

function candidateForFile(path, line, text) {
  const candidates = []

  if (path === 'lib' || path.startsWith('lib/')) {
    return [{
      file: path,
      line,
      kind: 'generated-lib-change',
      signal: 'Added line under lib/; verify current generated-artifact policy and source projection',
      confidence: 'high-signal',
      excerpt: text.trim().slice(0, 240),
      requiresContext: true,
    }]
  }

  for (const pattern of PATTERNS) {
    if (!pattern.regex.test(text)) continue
    candidates.push({
      file: path,
      line,
      kind: pattern.id,
      signal: pattern.signal,
      confidence: pattern.confidence,
      excerpt: text.trim().slice(0, 240),
      requiresContext: true,
    })
  }

  return candidates
}

function parseUnifiedDiff(diffText) {
  const results = []
  const seenFileLevel = new Set()
  let currentFile = null
  let newLine = null

  for (const rawLine of diffText.split(/\r?\n/)) {
    if (rawLine.startsWith('diff --git ')) {
      currentFile = null
      newLine = null
      continue
    }

    if (rawLine.startsWith('+++ ')) {
      const value = rawLine.slice(4).trim()
      if (value === '/dev/null') currentFile = null
      else currentFile = value.startsWith('b/') ? value.slice(2) : value
      continue
    }

    const hunk = rawLine.match(/^@@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/)
    if (hunk) {
      newLine = Number(hunk[1])
      continue
    }

    if (currentFile == null || newLine == null) continue

    if (rawLine.startsWith('+') && !rawLine.startsWith('+++')) {
      const added = rawLine.slice(1)
      if (!shouldSkipFile(currentFile)) {
        for (const candidate of candidateForFile(currentFile, newLine, added)) {
          if (candidate.kind === 'generated-lib-change') {
            const key = `${candidate.file}:${candidate.kind}`
            if (seenFileLevel.has(key)) continue
            seenFileLevel.add(key)
          }
          results.push(candidate)
        }
      }
      newLine += 1
      continue
    }

    if (rawLine.startsWith('-') && !rawLine.startsWith('---')) {
      continue
    }

    if (rawLine.startsWith(' ') || rawLine === '') {
      newLine += 1
    }
  }

  return results
}

function renderJson(candidates) {
  return JSON.stringify({
    schemaVersion: 1,
    verdict: 'candidates-only',
    warning: 'Regex/static hits are not findings or safe fixes. Validate reachability, ownership, side effects, public API, dynamic registration, generated sources, and tests.',
    candidateCount: candidates.length,
    candidates,
  }, null, 2)
}

function renderMarkdown(candidates) {
  const lines = [
    '# Hygiene candidates',
    '',
    '> Candidates only. Do not report or modify until repository-context proof is complete.',
    '',
  ]
  if (candidates.length === 0) {
    lines.push('No configured added-line candidates found.')
    return lines.join('\n')
  }
  lines.push('| File | Line | Kind | Signal | Confidence |')
  lines.push('|---|---:|---|---|---|')
  for (const item of candidates) {
    const signal = item.signal.replace(/\|/g, '\\|')
    lines.push(`| \`${item.file}\` | ${item.line} | \`${item.kind}\` | ${signal} | ${item.confidence} |`)
  }
  return lines.join('\n')
}

function selfTest() {
  const fixture = `diff --git a/src/demo.ts b/src/demo.ts
index 1111111..2222222 100644
--- a/src/demo.ts
+++ b/src/demo.ts
@@ -1,3 +1,10 @@
 export const keep = true
-console.log('removed')
+console.log('added')
+debugger
+// TODO: replace fixture
+tryWork().catch(() => {})
+const value = input as any
+test.skip('later', () => {})
+const literal = 'console.log is text only'
 return keep
diff --git a/lib/generated.js b/lib/generated.js
new file mode 100644
--- /dev/null
+++ b/lib/generated.js
@@ -0,0 +1,2 @@
+export const generated = true
+console.log('generated output')
`
  const candidates = parseUnifiedDiff(fixture)
  const kinds = candidates.map(item => item.kind)
  for (const expected of [
    'stdout-debug-output',
    'debugger-statement',
    'placeholder-marker',
    'swallowed-promise',
    'any-escape',
    'disabled-test',
    'generated-lib-change',
  ]) {
    if (!kinds.includes(expected)) throw new Error(`missing expected candidate: ${expected}`)
  }
  if (kinds.filter(kind => kind === 'generated-lib-change').length !== 1) {
    throw new Error('generated lib candidate was not deduplicated per file')
  }
  if (candidates.some(item => item.file === 'lib/generated.js' && item.kind !== 'generated-lib-change')) {
    throw new Error('generated lib lines must collapse to the file-level policy candidate')
  }
  if (candidates.some(item => item.excerpt.includes('removed'))) {
    throw new Error('removed lines must not be scanned')
  }
  console.log(`scan-diff-hygiene self-test: OK (${candidates.length} candidates)`)
}

async function readInput(path) {
  if (path) return readFileSync(path, 'utf8')
  if (process.stdin.isTTY) throw new Error('provide --input <patch> or pipe a unified diff on stdin')
  let text = ''
  for await (const chunk of process.stdin) text += chunk
  return text
}

async function main() {
  try {
    const args = parseArgs(process.argv.slice(2))
    if (args.selfTest) return selfTest()
    const text = await readInput(args.input)
    const candidates = parseUnifiedDiff(text)
    console.log(args.format === 'markdown' ? renderMarkdown(candidates) : renderJson(candidates))
  } catch (error) {
    console.error(`scan-diff-hygiene: ${error.message}`)
    process.exit(1)
  }
}

await main()
