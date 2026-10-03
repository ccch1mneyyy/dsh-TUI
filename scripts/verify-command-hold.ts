/**
 * Regression for the mid-turn command impact table (issue #1072): the channel
 * gates and the `/` suggestion overlay must read ONE source of truth, so the
 * refusal notice and the "affects this conversation" grouping can never drift.
 *
 *  1. every gated command name is a real local command with a parseable line;
 *  2. every gate notice key exists in the i18n dictionary;
 *  3. the conversation-acting names are local commands and disjoint from
 *     the gated set;
 *  4. `workingHoldOf` classifies completion paths, root tokens, skills and the
 *     normal region as documented;
 *  5. no gate key is still written as a `t('<key>')` / `t("<key>")` literal
 *     anywhere in src/ — the 9 call sites have to go through the table;
 *  6. no `working`-conditioned rejection branch under `src/dsh-adapter/`
 *     notifies with a literal key of its own, so a NEW gate cannot bypass the
 *     table with a key that item 5 does not know yet (the dictionary → command
 *     direction alone is not enough).
 *
 * Run: node --import tsx/esm scripts/verify-command-hold.ts
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import ts from 'typescript'
import {
  LOCAL_COMMANDS,
  WORKING_CONVERSATION_COMMANDS,
  WORKING_GATE_NOTICES,
  parseCommandName,
  workingHoldOf,
} from '../src/commands.js'
import { i18nDict } from '../src/i18n.js'

const isLocal = (name: string): boolean => LOCAL_COMMANDS.some(command => command.name === name)

// ── 1+2: the gated set names real commands with real notices ───────────────
const gated = Object.keys(WORKING_GATE_NOTICES)
assert.deepEqual(gated, ['new', 'compact', 'fork', 'model', 'preset', 'workspace', 'update', 'restart'])
for (const name of gated) {
  assert.ok(isLocal(name), `gated command ${name} must exist in LOCAL_COMMANDS`)
  assert.equal(parseCommandName(`/${name}`)?.name, name, `/${name} must parse as a command line`)
  const key = WORKING_GATE_NOTICES[name as keyof typeof WORKING_GATE_NOTICES]
  assert.notEqual(i18nDict[key], undefined, `gate notice ${key} (${name}) must exist in the i18n dictionary`)
  assert.equal(workingHoldOf(name), 'gated', `${name} must classify as gated`)
}

// ── 3: the conversation-acting set is local and disjoint ───────────────────
for (const name of WORKING_CONVERSATION_COMMANDS) {
  assert.ok(isLocal(name), `conversation command ${name} must exist in LOCAL_COMMANDS`)
  assert.equal(workingHoldOf(name), 'conversation', `${name} must classify as conversation`)
  assert.ok(!gated.includes(name), `${name} cannot be both gated and conversation`)
}

// ── 4: classification, including completion paths and skills ───────────────
assert.equal(workingHoldOf('model deepseek/x'), 'gated', 'a completion path inherits its root hold')
assert.equal(workingHoldOf('/workspace rename w'), 'gated', 'a leading slash and arguments are tolerated')
assert.equal(workingHoldOf('MODEL'), 'gated', 'classification is case-insensitive')
assert.equal(workingHoldOf(' model '), 'gated', 'surrounding whitespace is tolerated')
assert.equal(workingHoldOf('audit', true), 'inject', 'a skill steers into the running turn')
assert.equal(workingHoldOf('model', true), 'inject', 'skill wins over the gated root (registry gesture)')
for (const name of ['status', 'btw', 'skills', 'resume', 'bg', 'theme', '/', '']) {
  assert.equal(workingHoldOf(name), undefined, `${JSON.stringify(name)} belongs to the normal region`)
}
// Browsing is NOT impact: `/tree` only calls `setTreeOpen(true)` and leaves the
// running turn untouched (measured on a real turn, issue #1072 review), so it
// stays in the normal region even though its per-node actions can cancel.
// `/rewind` is the opposite call: the cancel also lands on the confirmed target
// (`session-rewind.ts`), but replacing the conversation is its purpose, so it
// stays in the conversation family alongside `clear`.
assert.equal(workingHoldOf('tree'), undefined, '/tree inspects the session tree; it does not interrupt')
assert.equal(workingHoldOf('rewind'), 'conversation', '/rewind acts on the conversation itself')
assert.equal(workingHoldOf('clear'), 'conversation', '/clear acts on the conversation view itself')
for (const name of ['tree']) {
  assert.ok(!WORKING_CONVERSATION_COMMANDS.includes(name), `/${name} must not be listed as a hold`)
}

// ── 5: every gate goes through the table ────────────────────────────────────
const files = [...new Set(execFileSync(
  'git',
  ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', 'src'],
  { encoding: 'utf8' },
).split('\0'))]
  .filter(file => file.endsWith('.ts') || file.endsWith('.tsx'))
  .filter(file => file !== 'src/commands.ts' && file !== 'src/i18n.ts')
for (const key of new Set(Object.values(WORKING_GATE_NOTICES))) {
  for (const file of files) {
    if (!existsSync(file)) continue
    const source = readFileSync(file, 'utf8')
    assert.ok(
      !source.includes(`t('${key}')`) && !source.includes(`t("${key}")`),
      `${file}: ${key} must be read from WORKING_GATE_NOTICES, not a literal`,
    )
  }
}

// ── 6: a new gate cannot bypass the table ───────────────────────────────────
// Item 5 only knows the keys already in the dictionary, so a NINTH gate that
// invents its own notice — or any gate spelled with the other quote style —
// would slip through while the command is refused mid-turn yet still shown in
// the overlay's normal region, exactly the drift item 5 claims is impossible.
// So: every bail-out branch that POSITIVELY reads `…working` under
// `src/dsh-adapter/`, where the channel gates live, must take its notice from
// the table. `working` is not exclusive to command gates — the follow-up
// acknowledgement, the companion stats line and the provider wizard's own
// `working()` all read it, and `!working` guards are not refusals — so the rule
// is anchored on the bail-out and on the channel directory instead of on a
// blanket "any `working` branch", which would red five legitimate sites today.
// Coverage is deliberately partial and stated as such: the two `Chat.tsx`
// command gates are pinned by item 5 for the keys they already use, but a NEW
// gate added to that switch is not caught here.
const positiveWorking = (node: ts.Node, negated = false): boolean => {
  let inner = negated
  if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken) {
    inner = !negated
  }
  if (ts.isPropertyAccessExpression(node) && node.name.text === 'working') return !inner
  let found = false
  node.forEachChild(child => {
    if (!found && positiveWorking(child, inner)) found = true
  })
  return found
}
const literalNotice = (node: ts.Node): string | undefined => {
  if (
    ts.isCallExpression(node)
    && ts.isIdentifier(node.expression)
    && node.expression.text === 't'
  ) {
    const [first] = node.arguments
    if (first !== undefined && (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first))) {
      return first.text
    }
  }
  for (const child of node.getChildren()) {
    const found = literalNotice(child)
    if (found !== undefined) return found
  }
  return undefined
}
const bailsOut = (node: ts.Node): boolean => {
  if (ts.isReturnStatement(node)) return true
  let found = false
  node.forEachChild(child => {
    if (!found && bailsOut(child)) found = true
  })
  return found
}
let gateBranches = 0
for (const file of files) {
  if (!file.startsWith('src/dsh-adapter/')) continue
  const ast = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
  const visit = (node: ts.Node): void => {
    if (ts.isIfStatement(node) && positiveWorking(node.expression) && bailsOut(node.thenStatement)) {
      gateBranches += 1
      const literal = literalNotice(node.thenStatement)
      assert.equal(
        literal,
        undefined,
        `${file}: a \`working\` gate bails out with the literal ${JSON.stringify(literal)}; `
        + 'a refusal notice must come from WORKING_GATE_NOTICES',
      )
      assert.ok(
        node.thenStatement.getText(ast).includes('WORKING_GATE_NOTICES'),
        `${file}: a \`working\` bail-out must read its notice from WORKING_GATE_NOTICES`,
      )
    }
    node.forEachChild(visit)
  }
  visit(ast)
}

console.log(`verify-command-hold OK: ${gated.length} gated, ${WORKING_CONVERSATION_COMMANDS.length} conversation-acting, ${gateBranches} channel bail-outs inspected`)
