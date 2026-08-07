/**
 * Strip ANSI sequences and cursor moves from a PTY capture for readable
 * inspection. Usage: node strip.mjs <file>
 */
import { readFileSync } from 'node:fs'

const raw = readFileSync(process.argv[2], 'utf8')
const text = raw
  .replace(/\x1b\[1C/g, ' ')
  .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
  .replace(/\x1b\][^\x07]*\x07/g, '')
  .replace(/\r/g, '\n')
  .replace(/\x1b[()][0-9A-Z]/g, '')
const lines = text.split('\n').map(line => line.replace(/[ \t]+$/g, ''))
const seen = new Set()
for (const line of lines) {
  const key = line.trim()
  if (!key || seen.has(key)) continue
  seen.add(key)
  process.stdout.write(line + '\n')
}
