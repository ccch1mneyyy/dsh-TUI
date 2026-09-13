/**
 * Check maintainable source inputs and product naming. This is a regression
 * guard, not a license audit or a proof of independent implementation.
 * Run: node scripts/verify-source-hygiene.mjs
 */
import { readdirSync, readFileSync } from 'node:fs'
import { resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const ownPath = fileURLToPath(import.meta.url)
const collect = directory => readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
  const path = resolve(directory, entry.name)
  return entry.isDirectory() ? collect(path) : [path]
})
const rules = [
  ['private internal link', /anthropic\.slack\.com|slack\.com\/archives/],
  ['foreign runtime environment variable', /CLAUDE_CODE_[A-Z_]+/],
  ['embedded source map in source', /sourceMappingURL=data:/],
  ['compiler-generated component input', /(?:from\s*|import\s*\()['"]react\/compiler-runtime['"]|react\.early_return_sentinel|react\.memo_cache_sentinel/],
  ['retired helper namespace', /(?:src\/|\.\.\/|types\/)cc\/|cc\.d\.ts/],
  ['product comparison wording', /Claude Code[- ](?:style|风格)|mirroring Claude Code|ported CC|\bCC[- ](?:style|parity)|Claude-Code-identical/],
]
const files = ['src', 'scripts', 'docs'].flatMap(name => collect(resolve(root, name)))
  .filter(path => /\.(?:[cm]?[jt]sx?|md)$/.test(path) && path !== ownPath)
files.push(...['README.md', 'README_EN.md', 'AGENTS.md', 'ADAPTER.md', 'package.json'].map(name => resolve(root, name)))
// Retired env naming is code-only: launcher and config files are scanned
// as code, while docs may still mention the old names in migration history.
// (~/.dsh-cc as the *current* harness home is a functional pin in
// scripts/run.ts and sync-profile.mjs, not a legacy reference.)
const codeFiles = ['src', 'scripts'].flatMap(name => collect(resolve(root, name)))
  .filter(path => /\.(?:[cm]?[jt]sx?)$/.test(path))
codeFiles.push(...['bin/dsh-tui.js', 'dsh-tui.cmd', 'cordis.yml', 'cordis.patch.yml'].map(name => resolve(root, name)))
const retiredNaming = /\b(?:CC_TUI_[A-Z_]+|DSH_CC_[A-Z_]+)\b/
const failures = []
for (const file of files) {
  const lines = readFileSync(file, 'utf8').split(/\r?\n/)
  for (const [index, line] of lines.entries()) {
    for (const [label, pattern] of rules) {
      if (pattern.test(line)) failures.push(`${relative(root, file)}:${index + 1}: ${label}`)
    }
  }
}
for (const file of codeFiles) {
  const lines = readFileSync(file, 'utf8').split(/\r?\n/)
  for (const [index, line] of lines.entries()) {
    if (retiredNaming.test(line)) failures.push(`${relative(root, file)}:${index + 1}: retired env/dir naming`)
  }
}
if (failures.length) {
  console.error(failures.join('\n'))
  process.exitCode = 1
} else {
  console.log(`source hygiene passed (${files.length} files; provider IDs and documented migration aliases remain supported)`)
}
