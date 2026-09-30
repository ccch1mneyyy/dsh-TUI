/**
 * 一键 star（`src/starAction.ts`）的回归：全部用假执行器，**不碰真的 gh、不联网**。
 *
 * 钉死四件事：
 *   ① 没装 `gh` → `no-gh`（且不会继续往下跑）；
 *   ② 装了但没登录 → `not-authed`（同样不会去 star）；
 *   ③ 成功 → `starred`，并且 argv **必须是** `api -X PUT user/starred/<owner>/<repo>`；
 *   ④ 失败/超时 → `failed` + 一句人能看懂的说明（超时单独认出来）。
 *
 * 运行：node --import tsx/esm scripts/verify-star-action.mjs
 */
import assert from 'node:assert/strict'

const { STAR_REPO, starRepo } = await import('../src/starAction.js')

let checks = 0
const failures = []
const check = (name, condition, detail = '') => {
  checks++
  if (condition) console.log(`  ok   ${name}`)
  else {
    failures.push(name)
    console.log(`  FAIL ${name}${detail === '' ? '' : `  (${detail})`}`)
  }
}

/** 记录每次调用，按脚本返回预设结果。 */
const fakeExec = script => {
  const calls = []
  const exec = async (file, args, options) => {
    calls.push({ file, args: [...args], timeout: options?.timeout })
    const key = args[0] === '--version' ? 'probe' : args[0] === 'auth' ? 'auth' : 'star'
    const result = script[key] ?? { code: 0, stdout: '', stderr: '' }
    return typeof result === 'function' ? result() : result
  }
  return { exec, calls }
}

const ok = { code: 0, stdout: '', stderr: '' }
const missing = { code: 1, stdout: '', stderr: '' }

// ── ① 没装 gh ────────────────────────────────────────────────────────────
{
  const { exec, calls } = fakeExec({ probe: missing })
  const outcome = await starRepo({ exec })
  check('没装 gh → no-gh', outcome.kind === 'no-gh', outcome.kind)
  check('没装 gh 时不再往下跑（只调用一次）', calls.length === 1, `${calls.length} 次`)
}

// ── ② 没登录 ─────────────────────────────────────────────────────────────
{
  const { exec, calls } = fakeExec({ auth: { code: 1, stdout: '', stderr: 'not logged in' } })
  const outcome = await starRepo({ exec })
  check('没登录 → not-authed', outcome.kind === 'not-authed', outcome.kind)
  check('没登录时不会去 star（不调用第三条）', calls.length === 2, `${calls.length} 次`)
}

// ── ③ 成功 ───────────────────────────────────────────────────────────────
{
  const { exec, calls } = fakeExec({})
  const outcome = await starRepo({ exec })
  check('成功 → starred', outcome.kind === 'starred', outcome.kind)
  const star = calls[2]
  check(
    'argv 必须是 gh api -X PUT user/starred/<owner>/<repo>（全版本 gh 可用；repo star 要 gh ≥ 2.63）',
    star?.file === 'gh' && star.args.join(' ') === `api -X PUT user/starred/${STAR_REPO}`,
    `${star?.file} ${star?.args.join(' ')}`,
  )
  check('每一步都带超时（不会卡死界面）', calls.every(call => typeof call.timeout === 'number' && call.timeout > 0))
}

// ── ④ 失败与超时 ─────────────────────────────────────────────────────────
{
  const { exec } = fakeExec({ star: { code: 1, stdout: '', stderr: 'HTTP 403: rate limit\nsecond line' } })
  const outcome = await starRepo({ exec })
  check('star 失败 → failed', outcome.kind === 'failed', outcome.kind)
  check('失败说明压成一行且带原因', outcome.kind === 'failed' && outcome.detail.includes('403') && !outcome.detail.includes('\n'), outcome.kind === 'failed' ? outcome.detail : '')
}
{
  const { exec } = fakeExec({ star: { code: null, stdout: '', stderr: '' } })
  const outcome = await starRepo({ exec })
  check('超时单独认出来（code=null）', outcome.kind === 'failed' && outcome.detail.includes('超时'), outcome.kind === 'failed' ? outcome.detail : outcome.kind)
}

// ── ⑤ 命令与文案接线（防"忘了注册命令"或"漏了某条文案"）────────────────────
{
  const { LOCAL_COMMANDS } = await import('../src/commands.js')
  const star = LOCAL_COMMANDS.find(command => command.name === 'star')
  check('/star 已注册进命令表（help 里能看到）', star !== undefined, star?.description ?? '缺失')
  const { t } = await import('../src/i18n.js')
  check(
    '四条结果文案齐全，且 {url}/{detail} 占位符真的会被替换',
    t('star-ok').length > 0 &&
      t('star-no-gh', { url: 'URL_X' }).includes('URL_X') &&
      t('star-not-authed', { url: 'URL_X' }).includes('URL_X') &&
      t('star-failed', { detail: 'DETAIL_X', url: 'URL_X' }).includes('DETAIL_X') &&
      t('star-failed', { detail: 'DETAIL_X', url: 'URL_X' }).includes('URL_X'),
    t('star-failed', { detail: 'DETAIL_X', url: 'URL_X' }),
  )
}

console.log(`\n一键 star：${checks - failures.length}/${checks} 通过`)
if (failures.length > 0) {
  console.error(`失败项：${failures.join('、')}`)
  process.exit(1)
}
assert.equal(failures.length, 0)
