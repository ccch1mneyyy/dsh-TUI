#!/usr/bin/env node
/**
 * Write-side drift gate: every dsh-tui-private event type persisted through
 * `session.append('<type>', …)` must be registered for strict reads — either
 * in dsh-session's KNOWN_SESSION_EVENT_TYPES (upstream builtin) or in our
 * LEGACY_SESSION_EVENT_TYPES (compat/sessionLog.ts). The upstream append API
 * has no `ignorable` flag, so an unlisted own type makes /resume, rewind,
 * fork and --resume reject the whole log (the /color incident: session/color
 * shipped unlisted and every colored session became un-resumable).
 *
 * Static scan of src/ (source of truth for the npm package), so it fails in
 * CI the moment a new append lands without its registry entry.
 *
 * Run: node scripts/verify-session-append-registry.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const srcDir = join(root, 'src')

const { KNOWN_SESSION_EVENT_TYPES } = await import('@deepseek-ai/dsh-session')
const { LEGACY_SESSION_EVENT_TYPES } = await import('../lib/types/dsh-adapter/compat/sessionLog.js')

const appended = new Set()
function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) { walk(p); continue }
    if (!/\.tsx?$/.test(name)) continue
    const sf = ts.createSourceFile(p, readFileSync(p, 'utf8'), ts.ScriptTarget.ESNext, true)
    const visit = (node) => {
      // .append('ns/type', …) — string-literal first arg only; dynamic types
      // are out of scope for a static gate (none exist as of this writing).
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
        && node.expression.name.text === 'append' && node.arguments.length > 0
        && ts.isStringLiteral(node.arguments[0])) {
        const type = node.arguments[0].text
        // Session event types are namespaced ('ns/type'); other .append APIs
        // (promptController.append(''), injectController.append(text)) are
        // not session persistence and must not trip the gate.
        if (/^[a-z0-9-]+\/[a-z0-9/-]+$/.test(type)) appended.add(type)
      }
      ts.forEachChild(node, visit)
    }
    visit(sf)
  }
}
walk(srcDir)

const unregistered = [...appended].filter(
  (t) => !KNOWN_SESSION_EVENT_TYPES.has(t) && !LEGACY_SESSION_EVENT_TYPES.includes(t),
)
console.log(`session.append types: ${[...appended].sort().join(', ')}`)
console.log(`upstream builtin: ${[...appended].filter((t) => KNOWN_SESSION_EVENT_TYPES.has(t)).length}, TUI-registered: ${[...appended].filter((t) => LEGACY_SESSION_EVENT_TYPES.includes(t)).length}`)
assert.deepEqual(unregistered, [],
  `event types persisted by session.append but NOT registered for strict reads (add to LEGACY_SESSION_EVENT_TYPES in src/dsh-adapter/compat/sessionLog.ts or stop persisting them): ${unregistered.join(', ')}
An unlisted own type makes every strict read (/resume, rewind, fork, --resume) reject the whole session log — see the /color incident (session/color, fixed 2026-09-04).`)
console.log('verify-session-append-registry: OK')
