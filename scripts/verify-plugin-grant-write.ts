/**
 * 批 P1：授权文件写入器（`src/dsh-adapter/grant-file.ts` +
 * `rewriteGrantDocument`）+ 授权计划视图。
 *
 *   A. ensure：逐条补齐、重复执行幂等、未知权限不写、其它组件 / denies /
 *      legacy 字符串行逐字保留；
 *   B. revoke：按名字删任意 scope（含 activation-scoped）、删空数组即删键、
 *      denies 原样保留、别的组件不动；
 *   C. forget：删 grants/denies 两个键（含 legacy 字符串行）、其它 id 不受影响、
 *      不存在的 id 是 no-op、文件保持可解析；
 *   D. 拒写：语法错 / 根键多 / 规则多字段 / 零字节一律拒；缺文件视为空文档；
 *      写后自检、原子写不留临时文件、并发手改时 undo 拒绝覆盖；
 *   E. planGrants：未知权限只进 `unknown`、`granted` 与 store 同口径、
 *      id 用声明里的 component id（不是包名）；
 *   F. declaredGrants*：单一读者的投影校验、无声明 / 无 id / 非法声明都答 undefined。
 *
 * 这个脚本只碰临时目录里的 grants 文件，不挂 Cordis、不跑服务。
 *
 * Run via `node --import tsx/esm scripts/verify-plugin-grant-write.ts`.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pluginFootprintPaths, pluginFootprintSourcesOf, pluginFootprints } from '../src/dsh-adapter/plugins-info.js'
import { EXTENSION_GRANTS_FILE, parseGrantStore } from '../src/adapter/standard/grants.js'
import { applyGrantMutation, planGrants } from '../src/dsh-adapter/grant-file.js'
import { declaredGrantsIn, declaredGrantsOf } from '../src/dsh-adapter/plugin-declaration.js'
import { testManifest } from './lib/plugin-test-utils.js'

let passed = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) throw new Error(`${label}\n${detail}`)
  passed += 1
  console.log(`PASS ${label}`)
}

/** A fresh data directory per case; the grants file is the only file any case writes. */
function freshDir(): string {
  return mkdtempSync(join(tmpdir(), 'dsh-grant-write-'))
}
function read(dir: string): string {
  return readFileSync(join(dir, EXTENSION_GRANTS_FILE), 'utf8')
}
function seed(dir: string, text: string): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, EXTENSION_GRANTS_FILE), text)
}
function parsed(text: string): unknown {
  return JSON.parse(text)
}
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

// ── A. ensure ────────────────────────────────────────────────────────────────
{
  const dir = freshDir()
  seed(dir, JSON.stringify({
    grants: {
      'com.example.other': [{ name: 'storage.local.read', scope: 'com.example.other' }],
      // A legacy v0.15 row: name only, never authorizes, must survive.
      'com.example.legacy': ['messages.observe.read'],
    },
    denies: { 'com.example.denied': [{ name: 'commands.invoke', scope: 'other:status' }] },
  }, null, 2))
  const permissions = [
    { name: 'storage.local.read', scope: 'com.example.shared' },
    { name: 'session.input.intercept', scope: 'tui/input' },
  ]
  const first = await applyGrantMutation({ kind: 'ensure', id: 'com.example.shared', permissions }, { dataDir: dir })
  check('ensure succeeds on a readable file', first.ok === true, JSON.stringify(first))
  check('ensure reports a change', first.ok && first.changed)
  const doc = parsed(read(dir)) as { grants: Record<string, unknown>; denies: Record<string, unknown> }
  check('ensure copies the declared scope verbatim, without widening it',
    JSON.stringify(doc.grants['com.example.shared']) === JSON.stringify(permissions),
    JSON.stringify(doc.grants['com.example.shared']))
  check('ensure keeps other components untouched',
    JSON.stringify(doc.grants['com.example.other']) === '[{"name":"storage.local.read","scope":"com.example.other"}]')
  check('ensure keeps legacy string rows untouched',
    JSON.stringify(doc.grants['com.example.legacy']) === '["messages.observe.read"]')
  check('ensure keeps denies untouched',
    JSON.stringify(doc.denies) === '{"com.example.denied":[{"name":"commands.invoke","scope":"other:status"}]}')

  const second = await applyGrantMutation({ kind: 'ensure', id: 'com.example.shared', permissions }, { dataDir: dir })
  check('ensure is idempotent: the second run writes nothing', second.ok && second.changed === false, JSON.stringify(second))
  check('ensure is idempotent: no duplicate rules', (parsed(read(dir)) as { grants: Record<string, unknown[]> }).grants['com.example.shared'].length === 2)
  rmSync(dir, { recursive: true, force: true })
}

{
  const dir = freshDir()
  const result = await applyGrantMutation({
    kind: 'ensure',
    id: 'com.example.shared',
    permissions: [
      { name: 'storage.local.read', scope: 'com.example.shared' },
      { name: 'not.a.permission', scope: 'whatever' },
    ],
  }, { dataDir: dir })
  check('ensure succeeds when only some declarations are known', result.ok === true)
  const doc = parsed(read(dir)) as { grants: Record<string, unknown[]> }
  check('ensure skips a permission this host does not know',
    JSON.stringify(doc.grants['com.example.shared']) === '[{"name":"storage.local.read","scope":"com.example.shared"}]',
    JSON.stringify(doc.grants))
  rmSync(dir, { recursive: true, force: true })
}

{
  const dir = freshDir()
  const result = await applyGrantMutation({ kind: 'ensure', id: 'com.example.shared', permissions: [] }, { dataDir: dir })
  check('ensure with nothing to add creates no file', result.ok && result.changed === false && !existsSync(join(dir, EXTENSION_GRANTS_FILE)))
  rmSync(dir, { recursive: true, force: true })
}

// ── B. revoke ────────────────────────────────────────────────────────────────
{
  const dir = freshDir()
  seed(dir, JSON.stringify({
    grants: {
      'com.example.shared': [
        { name: 'storage.local.read', scope: 'com.example.shared' },
        { name: 'storage.local.read', scope: 'com.example.shared:deeper' },
        { name: 'session.input.intercept', scope: 'tui/input', activationId: 'act-1' },
        { name: 'commands.invoke', scope: 'com.example.shared:status' },
        'storage.local.read',
      ],
      'com.example.other': [{ name: 'storage.local.read', scope: 'com.example.other' }],
    },
    denies: { 'com.example.shared': [{ name: 'storage.local.write', scope: 'com.example.shared' }] },
  }, null, 2))
  const result = await applyGrantMutation({
    kind: 'revoke',
    id: 'com.example.shared',
    names: ['storage.local.read', 'session.input.intercept'],
  }, { dataDir: dir })
  check('revoke succeeds and reports a change', result.ok && result.changed)
  const doc = parsed(read(dir)) as { grants: Record<string, unknown[]>; denies: Record<string, unknown> }
  check('revoke removes every scope of the named permissions, activation-scoped included, legacy rows too',
    JSON.stringify(doc.grants['com.example.shared']) === '[{"name":"commands.invoke","scope":"com.example.shared:status"}]',
    JSON.stringify(doc.grants['com.example.shared']))
  check('revoke leaves other components alone',
    JSON.stringify(doc.grants['com.example.other']) === '[{"name":"storage.local.read","scope":"com.example.other"}]')
  check('revoke never touches denies',
    JSON.stringify(doc.denies) === '{"com.example.shared":[{"name":"storage.local.write","scope":"com.example.shared"}]}')
  rmSync(dir, { recursive: true, force: true })
}

{
  const dir = freshDir()
  seed(dir, JSON.stringify({
    grants: { 'com.example.shared': [{ name: 'storage.local.read', scope: 'com.example.shared' }] },
    denies: { 'com.example.shared': [{ name: 'storage.local.write', scope: 'com.example.shared' }] },
  }, null, 2))
  await applyGrantMutation({ kind: 'revoke', id: 'com.example.shared', names: ['storage.local.read'] }, { dataDir: dir })
  const doc = parsed(read(dir)) as { grants?: unknown; denies: unknown }
  check('revoke deletes the emptied grants key and keeps denies',
    doc.grants === undefined && doc.denies !== undefined, JSON.stringify(doc))
  rmSync(dir, { recursive: true, force: true })
}

{
  const dir = freshDir()
  seed(dir, '{"grants":{"com.example.shared":[{"name":"commands.invoke","scope":"x"}]}}')
  const result = await applyGrantMutation({ kind: 'revoke', id: 'com.example.shared', names: ['storage.local.read'] }, { dataDir: dir })
  check('revoke is a no-op when no rule carries a listed name', result.ok && result.changed === false)
  check('revoke no-op leaves the bytes alone', read(dir) === '{"grants":{"com.example.shared":[{"name":"commands.invoke","scope":"x"}]}}')
  rmSync(dir, { recursive: true, force: true })
}

// ── C. forget ────────────────────────────────────────────────────────────────
{
  const dir = freshDir()
  seed(dir, JSON.stringify({
    grants: {
      'com.example.shared': [
        { name: 'storage.local.read', scope: 'com.example.shared' },
        'messages.observe.read',
      ],
      'com.example.other': [{ name: 'commands.invoke', scope: 'other:status' }],
    },
    denies: {
      'com.example.shared': [{ name: 'storage.local.write', scope: 'com.example.shared' }],
      'com.example.other': ['session.rewind.intercept'],
    },
  }, null, 2))
  const result = await applyGrantMutation({ kind: 'forget', id: 'com.example.shared' }, { dataDir: dir })
  check('forget succeeds and reports a change', result.ok && result.changed)
  const doc = parsed(read(dir)) as { grants: Record<string, unknown>; denies: Record<string, unknown> }
  check('forget removes the component from grants (legacy rows included) and denies',
    !('com.example.shared' in doc.grants) && !('com.example.shared' in doc.denies), JSON.stringify(doc))
  check('forget leaves every other component exactly as it was',
    JSON.stringify(doc.grants['com.example.other']) === '[{"name":"commands.invoke","scope":"other:status"}]'
    && JSON.stringify(doc.denies['com.example.other']) === '["session.rewind.intercept"]')
  check('forget leaves a parseable file', parseGrantStore(read(dir)).corrupt === false)
  const again = await applyGrantMutation({ kind: 'forget', id: 'com.example.shared' }, { dataDir: dir })
  check('forget of a missing component is a no-op', again.ok && again.changed === false)
  rmSync(dir, { recursive: true, force: true })
}

// ── D. refuse / atomic / undo ────────────────────────────────────────────────
{
  const dir = freshDir()
  seed(dir, '')
  const result = await applyGrantMutation({ kind: 'forget', id: 'x.y' }, { dataDir: dir })
  check('a zero-byte grants file is refused as corrupt, never repaired',
    result.ok === false && result.reason === 'corrupt', JSON.stringify(result))
  check('the refused zero-byte file is left byte-identical', read(dir) === '')
  rmSync(dir, { recursive: true, force: true })
}
{
  const dir = freshDir()
  seed(dir, '{"grants":[],"x":1}')
  const result = await applyGrantMutation({ kind: 'forget', id: 'x.y' }, { dataDir: dir })
  check('an unknown root key is refused as corrupt', result.ok === false && result.reason === 'corrupt', JSON.stringify(result))
  rmSync(dir, { recursive: true, force: true })
}
{
  const dir = freshDir()
  seed(dir, '{"grants":{"x.y":[{"name":"storage.local.read","scope":"x.y","extra":1}]}}')
  const result = await applyGrantMutation({ kind: 'forget', id: 'x.y' }, { dataDir: dir })
  check('a rule with an unknown field is refused (the reader would call it corrupt)',
    result.ok === false && result.reason === 'corrupt', JSON.stringify(result))
  rmSync(dir, { recursive: true, force: true })
}
{
  const dir = freshDir()
  const result = await applyGrantMutation({
    kind: 'ensure',
    id: 'com.example.shared',
    permissions: [{ name: 'storage.local.read', scope: 'com.example.shared' }],
  }, { dataDir: dir })
  check('a missing file is the empty document, not corruption', result.ok === true)
  check('the new document round-trips through the reader', parseGrantStore(read(dir)).corrupt === false)
  check('the atomic write leaves no temporary behind',
    readdirSync(dir).filter(name => name !== EXTENSION_GRANTS_FILE).length === 0, readdirSync(dir).join(', '))
  // Hardcoded on purpose: this is the document format the reader must accept,
  // not a second call into the writer (which would only prove delegation).
  const expected = [
    '{',
    '  "grants": {',
    '    "com.example.shared": [',
    '      {',
    '        "name": "storage.local.read",',
    '        "scope": "com.example.shared"',
    '      }',
    '    ]',
    '  }',
    '}',
    '',
  ].join('\n')
  check('the written document is exactly the ensure result', read(dir) === expected, JSON.stringify(read(dir)))
  rmSync(dir, { recursive: true, force: true })
}
{
  const dir = freshDir()
  const result = await applyGrantMutation({
    kind: 'ensure',
    id: 'com.example.shared',
    permissions: [{ name: 'storage.local.read', scope: 'com.example.shared' }],
  }, { dataDir: dir })
  check('undo is available after a real write', result.ok && result.changed === true)
  if (result.ok) {
    check('undo restores the absent-file state', (await result.undo()) === true && !existsSync(join(dir, EXTENSION_GRANTS_FILE)))
  }
  rmSync(dir, { recursive: true, force: true })
}
{
  // The reader stays lock-free; the writer serializes through the sibling lock.
  // Hold it as a live pid and the read-modify-write must wait instead of race.
  const dir = freshDir()
  const file = join(dir, EXTENSION_GRANTS_FILE)
  const lock = `${file}.lock`
  writeFileSync(lock, `${process.pid}\n`)
  let settled = false
  const pending = applyGrantMutation({
    kind: 'ensure',
    id: 'com.example.shared',
    permissions: [{ name: 'storage.local.read', scope: 'com.example.shared' }],
  }, { dataDir: dir }).then(result => {
    settled = true
    return result
  })
  await sleep(60) // 固定窗:墙钟 给持锁的写入器一次重试窗口，确认它没有越过锁
  check('a held sibling lock delays the read-modify-write', !settled && !existsSync(file))
  rmSync(lock, { force: true })
  const result = await pending
  check('the write proceeds once the sibling lock is released',
    result.ok === true && result.changed === true && existsSync(file), JSON.stringify(result))
  rmSync(dir, { recursive: true, force: true })
}
{
  const dir = freshDir()
  seed(dir, '{"grants":{"com.example.other":[{"name":"commands.invoke","scope":"other:status"}]}}')
  const before = read(dir)
  const result = await applyGrantMutation({
    kind: 'ensure',
    id: 'com.example.shared',
    permissions: [{ name: 'storage.local.read', scope: 'com.example.shared' }],
  }, { dataDir: dir })
  check('undo restores the previous bytes', result.ok && result.changed === true && (await result.undo()) === true && read(dir) === before)
  rmSync(dir, { recursive: true, force: true })
}
{
  const dir = freshDir()
  const result = await applyGrantMutation({
    kind: 'ensure',
    id: 'com.example.shared',
    permissions: [{ name: 'storage.local.read', scope: 'com.example.shared' }],
  }, { dataDir: dir })
  if (!result.ok) throw new Error('fixture write failed')
  // A hand edit after the write: the writer must not overwrite it on undo.
  writeFileSync(join(dir, EXTENSION_GRANTS_FILE), '{"grants":{"hand.edited":[{"name":"commands.invoke","scope":"x"}]}}')
  check('undo refuses to overwrite a file that was edited after the write', (await result.undo()) === false)
  check('the later hand edit survives the refused undo',
    read(dir) === '{"grants":{"hand.edited":[{"name":"commands.invoke","scope":"x"}]}}')
  rmSync(dir, { recursive: true, force: true })
}
{
  const dir = freshDir()
  const mutation = {
    kind: 'ensure' as const,
    id: 'com.example.shared',
    permissions: [{ name: 'storage.local.read', scope: 'com.example.shared' }],
  }
  const first = await applyGrantMutation(mutation, { dataDir: dir })
  check('the fixture write for the no-op case landed', first.ok && first.changed === true)
  const result = await applyGrantMutation(mutation, { dataDir: dir })
  check('a no-op write exposes an undo that is a no-op', result.ok && result.changed === false && (await result.undo()) === true)
  rmSync(dir, { recursive: true, force: true })
}
{
  const dir = freshDir()
  const result = await applyGrantMutation({ kind: 'ensure', id: '', permissions: [] }, { dataDir: dir })
  check('an empty component id is refused: the reader would call the result corrupt',
    result.ok === false && result.reason === 'write-failed', JSON.stringify(result))
  rmSync(dir, { recursive: true, force: true })
}

// ── E. planGrants ────────────────────────────────────────────────────────────
{
  const grants = parseGrantStore(JSON.stringify({
    grants: { 'com.example.shared': [{ name: 'storage.local.read', scope: 'com.example.shared' }] },
  }))
  const plan = planGrants(grants, {
    id: 'com.example.shared',
    permissions: [
      { name: 'storage.local.read', scope: 'com.example.shared' },
      { name: 'storage.local.write', scope: 'com.example.shared' },
      { name: 'not.a.permission', scope: 'whatever' },
    ],
  })
  check('the plan is keyed by the declaration id, not a package name', plan.id === 'com.example.shared')
  check('unknown declarations are listed and kept out of the grantable entries',
    JSON.stringify(plan.unknown) === '["not.a.permission"]' && plan.entries.length === 2, JSON.stringify(plan))
  const readEntry = plan.entries.find(entry => entry.name === 'storage.local.read')
  const writeEntry = plan.entries.find(entry => entry.name === 'storage.local.write')
  check('the plan reports what is already granted, with its registry default',
    readEntry?.granted === true && readEntry.default === 'deny' && writeEntry?.granted === false,
    JSON.stringify(plan.entries))
}
{
  const grants = parseGrantStore('{"grants":{"com.example.shared":[{"name":"commands.invoke","scope":"com.example.status"}]}}')
  const plan = planGrants(grants, {
    id: 'com.example.shared',
    permissions: [{ name: 'commands.invoke', scope: 'com.example.status' }],
  })
  check('a granted default-allow permission shows up as granted',
    plan.entries[0]?.granted === true && plan.entries[0].default === 'allow', JSON.stringify(plan))
}

// ── F. one declaration reader ────────────────────────────────────────────────
{
  const source = testManifest({
    id: 'com.example.shared',
    permissions: [
      { name: 'storage.local.read', scope: 'com.example.shared' },
      { name: 'session.input.intercept', scope: 'tui/input' },
    ],
  })
  const declared = declaredGrantsIn(source)
  check('declaredGrantsIn reads id and both permissions',
    declared !== undefined && declared.id === 'com.example.shared'
    && JSON.stringify(declared.permissions) === JSON.stringify([
      { name: 'storage.local.read', scope: 'com.example.shared' },
      { name: 'session.input.intercept', scope: 'tui/input' },
    ]), JSON.stringify(declared))
  check('declaredGrantsOf and declaredGrantsIn agree on the same record',
    JSON.stringify(declaredGrantsOf(JSON.parse(source))) === JSON.stringify(declared))
  check('a declaration without permissions still answers with its id',
    declaredGrantsIn(testManifest({ id: 'com.example.empty' }))?.permissions.length === 0)
  check('an invalid declaration answers undefined, never a guess', declaredGrantsIn('{"id":"x"}') === undefined)
  check('a non-object record answers undefined', declaredGrantsOf(null) === undefined && declaredGrantsOf('id') === undefined)
}

// ── G. footprint sources: one implementation, three answers ─────────────────
{
  const dir = freshDir()
  seed(dir, JSON.stringify({
    grants: { 'com.example.grants': [{ name: 'storage.local.read', scope: 'com.example.grants' }] },
    denies: { 'com.example.denies': ['commands.invoke'] },
  }, null, 2))
  mkdirSync(join(dir, 'plugin-storage'), { recursive: true })
  writeFileSync(join(dir, 'plugin-storage', 'com.example.storage.json'), '{}')
  writeFileSync(join(dir, 'effect-ledger.jsonl'), [
    JSON.stringify({ sequence: 1, operation: 'storage.write', pluginId: 'com.example.ledger', result: 'applied' }),
    JSON.stringify({ sequence: 2, operation: 'storage.write', pluginId: 'host', result: 'applied' }),
  ].join('\n') + '\n')
  const paths = pluginFootprintPaths({ dataDir: dir })
  const footprints = pluginFootprints(paths)
  check('footprints: the matrix unions the three sources and drops host identities',
    JSON.stringify(footprints) === JSON.stringify([
      'com.example.denies', 'com.example.grants', 'com.example.ledger', 'com.example.storage',
    ]), JSON.stringify(footprints))
  check('footprints: a grants-only id is named by that source alone',
    JSON.stringify(pluginFootprintSourcesOf('com.example.grants', { dataDir: dir }))
      === JSON.stringify({ grants: true, ledger: false, storage: false }))
  check('footprints: a denies-only id counts as a grants-file source',
    pluginFootprintSourcesOf('com.example.denies', { dataDir: dir }).grants === true)
  check('footprints: a ledger-only id is named by the ledger alone',
    JSON.stringify(pluginFootprintSourcesOf('com.example.ledger', { dataDir: dir }))
      === JSON.stringify({ grants: false, ledger: true, storage: false }))
  check('footprints: a storage-only id is named by storage alone',
    JSON.stringify(pluginFootprintSourcesOf('com.example.storage', { dataDir: dir }))
      === JSON.stringify({ grants: false, ledger: false, storage: true }))
  check('footprints: an id with no footprint is named by nothing',
    JSON.stringify(pluginFootprintSourcesOf('com.example.absent', { dataDir: dir }))
      === JSON.stringify({ grants: false, ledger: false, storage: false }))
  // The removal path forgets the component; the matrix must stop naming it as
  // a grants source while the ledger/storage rows stay.
  await applyGrantMutation({ kind: 'forget', id: 'com.example.grants' }, { dataDir: dir })
  check('footprints: after forget the grants source drops the id',
    pluginFootprintSourcesOf('com.example.grants', { dataDir: dir }).grants === false
    && pluginFootprintSourcesOf('com.example.denies', { dataDir: dir }).grants === true,
    read(dir))
  check('footprints: both readers agree on the union after a write',
    JSON.stringify(pluginFootprints(pluginFootprintPaths({ dataDir: dir })))
      === JSON.stringify(footprints.filter(id => id !== 'com.example.grants')))
  rmSync(dir, { recursive: true, force: true })
}

console.log(`verify-plugin-grant-write OK (${passed} checks)`)
