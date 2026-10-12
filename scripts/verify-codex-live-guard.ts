/** Static and no-spend executable gates for the formal Codex live smoke.
 * Does not claim a real model/API turn. Uses isolated dummy env/temporary prefs.
 * Run: node --import tsx/esm scripts/verify-codex-live-guard.ts */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import ts from 'typescript'
import { assertCheapRequest } from './lib/codex-cheap-only.mjs'

let passed = 0
const check = (label: string, ok: boolean): void => { assert.ok(ok, label); passed += 1; console.log('PASS ' + label) }
const root = resolve(import.meta.dirname, '..')
const path = join(root, 'scripts', 'verify-codex-live.ts')
const source = readFileSync(path, 'utf8')
const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
const imports = ast.statements.filter(ts.isImportDeclaration)
check('live gate: no value imports can cache production DATA_DIR before isolation', imports.every(statement => !statement.moduleSpecifier.getText(ast).includes('../src/') || statement.importClause?.isTypeOnly === true))
check('live gate: real session is created by production codexBackend.open only', source.includes('session = await codexBackend.open(') && !source.includes('await openCodexSession(') && !source.includes('acquireCodexHub('))
check('live gate: HOME and USERPROFILE precede every production dynamic import', source.indexOf('process.env.HOME = isolatedHome') < source.indexOf("await fromSource('utils/paths.js')") && source.indexOf('process.env.USERPROFILE = isolatedHome') < source.indexOf("await fromSource('utils/paths.js')"))
check('live gate: cheap prefs check sees isolated directory, not os.homedir', source.includes("pinCheapOrExit('verify-codex-live', join(isolatedHome, '.dsh-tui'))") && !source.includes('homedir('))
check('live gate: real relay URL and token are never passed to a file store', !source.includes('fileCodexChannels') && !source.includes('channels.save(') && !source.includes('tokenStore.write(') && source.includes('...live.appServerArgs'))
check('live gate: stdin cost rule executes before real write and counts native starts', source.indexOf("assertCheapRequest('verify-codex-live', request.method, params)") < source.indexOf('Reflect.apply(originalWrite') && source.includes('turnsUsed >= 3'))
check('live gate: all runtime modules share CODEX_TEST_SOURCE_ROOT plane', source.includes('const fromSource =') && source.includes('CODEX_TEST_SOURCE_ROOT') && !imports.some(statement => statement.moduleSpecifier.getText(ast).includes('../src/') && statement.importClause?.isTypeOnly !== true))

const dir = mkdtempSync(join(tmpdir(), 'codex-live-guard-'))
const apiKey = 'dummy-cost-guard-sentinel'
const baseUrl = 'https://relay.invalid/v1'
const child = (options: Record<string, string | undefined>) => {
  const env = { ...process.env, HOME: dir, USERPROFILE: dir, DSH_TUI_CODEX_LIVE: '', CODEX_TEST_BASE_URL: '', CODEX_TEST_API_KEY: '', CODEX_TEST_MODEL: 'gpt-5.6-terra', CODEX_TEST_EFFORT: 'low', ...options }
  return spawnSync(process.execPath, ['--import', 'tsx/esm', path], { cwd: root, env, encoding: 'utf8', timeout: 15_000 })
}
const combined = (result: ReturnType<typeof child>): string => String(result.stdout ?? '') + String(result.stderr ?? '')
try {
  const skip = child({})
  check('live gate: absent opt-in skips without a PASS or live OK claim', skip.status === 0 && combined(skip).includes('skipped') && !/PASS|verify-codex-live OK/u.test(combined(skip)))
  const missing = child({ DSH_TUI_CODEX_LIVE: '1' })
  check('live gate: opted-in but missing credentials is explicit skip, not live success', missing.status === 0 && combined(missing).includes('CODEX_TEST_BASE_URL / CODEX_TEST_API_KEY are not set') && !/PASS|verify-codex-live OK/u.test(combined(missing)))
  const noncheap = child({ DSH_TUI_CODEX_LIVE: '1', CODEX_TEST_BASE_URL: baseUrl, CODEX_TEST_API_KEY: apiKey, CODEX_TEST_MODEL: 'expensive-model', CODEX_EXECUTABLE: join(dir, 'must-not-start.exe') })
  check('live gate: non-cheap model rejects before native executable discovery', noncheap.status === 2 && combined(noncheap).includes('refusing non-cheap') && !combined(noncheap).includes('must-not-start'))
  const effort = child({ DSH_TUI_CODEX_LIVE: '1', CODEX_TEST_BASE_URL: baseUrl, CODEX_TEST_API_KEY: apiKey, CODEX_TEST_EFFORT: 'high' })
  check('live gate: non-low effort rejects before production runtime import', effort.status === 2 && combined(effort).includes('refusing non-cheap'))
  check('live gate: failure messages never expose dummy credential or relay URL', [noncheap, effort].every(result => !combined(result).includes(apiKey) && !combined(result).includes(baseUrl)))
  const personalFixture = join(dir, '.dsh-tui', 'backends', 'codex')
  mkdirSync(personalFixture, { recursive: true })
  writeFileSync(join(personalFixture, 'prefs.json'), JSON.stringify({ model: 'expensive-personal-fixture', effort: 'high' }))
  const absentBinary = child({ DSH_TUI_CODEX_LIVE: '1', CODEX_TEST_BASE_URL: baseUrl, CODEX_TEST_API_KEY: apiKey, CODEX_EXECUTABLE: join(dir, 'absent-codex.exe') })
  check('live gate: formal runtime ignores outer HOME prefs and fails before any paid turn', absentBinary.status === 1 && combined(absentBinary).includes('verify-codex-live FAILED') && combined(absentBinary).includes('0 turns') && !combined(absentBinary).includes('refusing non-cheap') && !combined(absentBinary).includes('expensive-personal-fixture'))
  check('live gate: formal startup errors do not expose dummy relay or credential', !combined(absentBinary).includes(apiKey) && !combined(absentBinary).includes(baseUrl))
  const guard = join(dir, 'guard.mjs')
  const guardUrl = new URL('./lib/codex-cheap-only.mjs', import.meta.url).href
  writeFileSync(guard, 'import { pinCheapOrExit } from ' + JSON.stringify(guardUrl) + '; pinCheapOrExit("direct-cost-guard", process.argv[2])')
  const refused = spawnSync(process.execPath, [guard, dir], { cwd: root, env: { ...process.env, HOME: dir, USERPROFILE: dir, CODEX_TEST_BASE_URL: '', CODEX_TEST_API_KEY: '', CODEX_TEST_MODEL: 'gpt-5.6-terra', CODEX_TEST_EFFORT: 'low' }, encoding: 'utf8', timeout: 15_000 })
  check('cost guard: direct missing credentials still refuse with exit 2', refused.status === 2 && String(refused.stderr).includes('CODEX_TEST_BASE_URL / CODEX_TEST_API_KEY are not set'))
} finally { rmSync(dir, { recursive: true, force: true }) }
let refused = 0
for (const [method, params] of [['thread/start', { model: 'expensive-model' }], ['turn/start', { effort: 'high' }], ['thread/settings/update', { collaborationMode: { settings: { model: 'gpt-5.6-terra', reasoning_effort: 'xhigh' } } }], ['thread/resume', { config: { model_reasoning_effort: 'high' } }]] as const) {
  try { assertCheapRequest('guard-test', method, params) } catch { refused += 1 }
}
check('RPC guard: model, effort, collaboration and config overrides all refuse non-cheap values', refused === 4)
assertCheapRequest('guard-test', 'turn/start', { model: 'gpt-5.6-terra', effort: 'low' })
assertCheapRequest('guard-test', 'thread/start', { model: 'gpt-6-sol', config: { model_reasoning_effort: 'low' } })
check('RPC guard: terra and fallback sol at low remain accepted', true)
console.log('\nverify-codex-live-guard OK (' + passed + ' no-spend checks)')
