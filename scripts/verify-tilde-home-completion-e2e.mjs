#!/usr/bin/env node
/**
 * verify-tilde-home-completion-e2e — issue #1706 的独立端到端回归。
 *
 * 钉住的契约（全部走真实 fs 服务形状 + 真临时目录，不信桩数据）：
 *   C1 `~/`                      → 列出 home 一级目录
 *   C2 `~/Downloads/`            → 列出该子目录内容（本 issue 的核心 RED）
 *   C3 `~/Downloads/sub/`        → 逐级补全到第三层
 *   C4 `~`（无斜杠）              → 与 `~/` 同义
 *   C5 `~\Downloads\`（Windows 分隔符形态）→ 与 `~/Downloads/` 等价
 *   C6 cwd 里真的存在名为 `~` 的目录时：`~/Downloads/` 仍按 home 展开（组长口径：
 *      与 shell 一致）；字面目录要走 `@./~` 形式，不能被这里误当 home。
 *   A1 `@~/Downloads/note.txt`   → 真附加（不是 missing）
 *   A2 `@~\Downloads\note.txt`   → 同义（Windows 分隔符）
 *   A3 `@~/Downloads/nothere.txt`→ 仍然 missing（不许把“什么都当命中”）
 *
 * 运行：node --import tsx/esm scripts/verify-tilde-home-completion-e2e.mjs
 * 退出码：0 = 全过；1 = 有失败（修前预期为 1）。
 */

// HOME 必须在 import src 之前定死：paths.ts 的 DATA_DIR 在模块加载时算。
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'dsh-tui-tilde-home-'))
process.env.HOME = home
process.env.USERPROFILE = home

const { readdir, readFile, stat } = await import('node:fs/promises')

const fixture = {
  home,
  // 主 cwd 里**没有**字面 `~` 目录：C2/C3/C5 要的是「解析失败 → 空」这个原始症状。
  cwd: mkdtempSync(join(tmpdir(), 'dsh-tui-tilde-cwd-')),
  // 陷阱 cwd：里面有字面 `~` 目录，只给 C6/C7 用，免得把两个缺陷混在一起。
  trapCwd: mkdtempSync(join(tmpdir(), 'dsh-tui-tilde-trap-')),
}

// home：Downloads/note.txt、Downloads/sub/deep.txt
mkdirSync(join(home, 'Downloads', 'sub'), { recursive: true })
writeFileSync(join(home, 'Downloads', 'note.txt'), 'note\n')
writeFileSync(join(home, 'Downloads', 'sub', 'deep.txt'), 'deep\n')
mkdirSync(join(home, 'Documents'), { recursive: true })

// cwd 里放一个**字面**叫 `~` 的目录（C6 的陷阱）
mkdirSync(join(fixture.trapCwd, '~', 'Downloads'), { recursive: true })
writeFileSync(join(fixture.trapCwd, '~', 'Downloads', 'trap.txt'), 'trap\n')

/** 真实 fs 服务：形状与 channel 的 FileSuggestionFs / MentionFs 一致。 */
const fsService = {
  async resolve(path) {
    return { displayPath: path }
  },
  async stat(target) {
    try {
      const info = await stat(target.displayPath)
      return { type: info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'other' }
    } catch {
      return undefined
    }
  },
  async readText(target) {
    return readFile(target.displayPath, 'utf8')
  },
  async listDir(target) {
    const entries = await readdir(target.displayPath, { withFileTypes: true })
    return entries
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(entry => ({
        name: entry.name,
        type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other',
      }))
  },
}

const { listPathCandidates } = await import('../src/dsh-adapter/channel/paths.js')
const { expandMentions } = await import('../src/dsh-adapter/channel/mentions.js')

let failures = 0
let checks = 0
function check(name, ok, detail = '') {
  checks += 1
  if (ok) console.log(`ok   ${name}`)
  else {
    failures += 1
    console.error(`FAIL ${name}${detail === '' ? '' : `\n      ${detail}`}`)
  }
}

const ids = async (query, cwd = fixture.cwd) => {
  const candidates = await listPathCandidates(fsService, cwd, query, undefined, 20)
  return candidates.map(candidate => candidate.path)
}

// ── 补全侧 ────────────────────────────────────────────────────────────────
{
  const list = await ids('~/')
  check('C1 `~/` 列出 home 一级目录', list.some(path => path === '~/Downloads/'), JSON.stringify(list))
}
{
  const list = await ids('~/Downloads/')
  check('C2 `~/Downloads/` 列出该子目录（核心 RED）',
    list.includes('~/Downloads/note.txt') && list.some(path => path.startsWith('~/Downloads/sub')),
    JSON.stringify(list))
}
{
  const list = await ids('~/Downloads/sub/')
  check('C3 `~/Downloads/sub/` 逐级补全到第三层',
    list.includes('~/Downloads/sub/deep.txt'), JSON.stringify(list))
}
{
  const list = await ids('~')
  check('C4 `~`（无斜杠）与 `~/` 同义', list.some(path => path === '~/Downloads/'), JSON.stringify(list))
}
{
  const list = await ids('~\\Downloads\\')
  check('C5 `~\\Downloads\\`（Windows 分隔符）与 `~/Downloads/` 等价',
    list.some(path => path.includes('note.txt')), JSON.stringify(list))
}
{
  const list = await ids('~/Downloads/', fixture.trapCwd)
  check('C6 cwd 里有字面 `~` 目录时仍按 home 展开（不得命中 cwd 陷阱）',
    list.includes('~/Downloads/note.txt') && !list.some(path => path.includes('trap.txt')),
    JSON.stringify(list))
}

{
  // 字面目录必须仍可达（否则修「home 优先」会把 cwd 里的 `~` 目录彻底封死）：
  // `./~/Downloads/` 明确是 cwd 相对路径，不能被当作 home 展开。
  const list = await ids('./~/Downloads/', fixture.trapCwd)
  check('C7 `./~/Downloads/` 仍走 cwd 字面目录（修 home 优先不许封死字面访问）',
    list.some(path => path.includes('trap.txt')), JSON.stringify(list))
}

// ── 附加侧 ────────────────────────────────────────────────────────────────
const attach = async text => {
  const result = await expandMentions(fsService, fixture.cwd, text)
  return {
    attached: result.attached ?? [],
    missing: result.missing ?? [],
    blocks: result.blocks ?? [],
  }
}
{
  const result = await attach('@~/Downloads/note.txt 请读这个')
  check('A1 `@~/Downloads/note.txt` 真附加、不进 missing',
    result.attached.includes('~/Downloads/note.txt') && result.missing.length === 0,
    JSON.stringify({ attached: result.attached, missing: result.missing }))
}
{
  const result = await attach('@~\\Downloads\\note.txt 请读这个')
  check('A2 `@~\\Downloads\\note.txt`（Windows 分隔符）同样附加',
    result.attached.length === 1 && result.missing.length === 0,
    JSON.stringify({ attached: result.attached, missing: result.missing }))
}
{
  const result = await attach('@~/Downloads/nothere.txt')
  check('A3 不存在的 `@~/…` 仍然 missing（不许“什么都当命中”）',
    result.missing.length === 1 && result.attached.length === 0,
    JSON.stringify({ attached: result.attached, missing: result.missing }))
}

// ── R-1（提交前 review）：模型侧路径必须是展开后的绝对路径 ────────────────
{
  const result = await attach('@~/Downloads/note.txt 请读这个')
  const blockText = result.blocks.map(block => block.text ?? '').join('\n')
  const expanded = join(home, 'Downloads', 'note.txt')
  check('A4 模型侧 `<attached-file path>` 是展开后的绝对路径（R-1）',
    blockText.includes(`path="${expanded}"`), blockText.slice(0, 200))
  check('A5 用户可见 attached 仍是原串（R-1 只改模型侧）',
    result.attached.includes('~/Downloads/note.txt'), JSON.stringify(result.attached))
}
{
  const result = await attach('@~/Downloads/sub/')
  const blockText = result.blocks.map(block => block.text ?? '').join('\n')
  const expanded = join(home, 'Downloads', 'sub')
  check('A6 目录型 `@~/…` 的 `<attached-directory path>` 同样展开（R-1）',
    blockText.includes(`path="${expanded}"`) || blockText.includes(`path="${expanded}/"`),
    blockText.slice(0, 200))
}

if (failures === 0) console.log(`\nverify-tilde-home-completion-e2e: ${checks} checks, all passed`)
else console.error(`\nverify-tilde-home-completion-e2e: ${failures} of ${checks} checks FAILED`)
process.exit(failures === 0 ? 0 : 1)
