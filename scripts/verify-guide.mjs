#!/usr/bin/env node
/**
 * verify-guide.mjs — 随包用户手册（guide/）门禁，无需构建、无需依赖。
 *
 * 为什么是门禁：手册副本是**生成物**（真源在 docs/），而 SKILL.md 是它能否被内核
 * 加载、被模型按需读取的关键。任何一处漂移都表现为"AI 答不上来"这种静默故障，
 * 所以这里把四件事钉死：
 *   1. guide/dsh-tui-guide/ 的每个副本与 docs/ 真源逐字节一致，且没有清单外残留；
 *   2. SKILL.md 是内核认的技能：目录名 = frontmatter name、描述非空且不超过常驻预算、
 *      没有会被内核拒绝的旧式驼峰键、模型调用没有被关掉；
 *   3. SKILL.md 的路由表覆盖清单里每个文件，且不引用清单外的 `*.md`；
 *   4. 发布面真的带上了它：package.json 的 files 含 guide，bin/dsh-tui.js 把它作为
 *      DSH_BUNDLED_SKILL_DIR 交给 dsh（用户自己设过则保留用户的值）。
 *
 * 运行：node scripts/verify-guide.mjs
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { GUIDE_DIR, GUIDE_INDEX, GUIDE_ROOT, GUIDE_SKILL, guideDrift, guideFiles, repoRoot } from './guide-sources.mjs'

let failures = 0
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${ok || detail === undefined ? '' : ` — ${detail}`}`)
  if (!ok) failures++
}

// --- 1. 副本与真源 ------------------------------------------------------------
const drift = guideDrift(repoRoot)
check('copies match docs/ byte-for-byte', drift.missingCopy.length === 0 && drift.differing.length === 0,
  `missing [${drift.missingCopy.join(', ')}] differing [${drift.differing.join(', ')}]`)
check('every source doc exists', drift.missingSource.length === 0, drift.missingSource.join(', '))
check('no stray files in the skill bundle', drift.extra.length === 0, drift.extra.join(', '))

// --- 2. SKILL.md 是内核认的技能 ------------------------------------------------
const index = readFileSync(join(repoRoot, GUIDE_DIR, GUIDE_INDEX), 'utf8')
const front = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/u.exec(index)
check('SKILL.md opens with frontmatter', front !== null)
const head = front === null ? '' : front[1]
const declaredName = /^name:\s*(.+)$/mu.exec(head)?.[1]?.trim()
const description = /^description:\s*(.+)$/mu.exec(head)?.[1]?.trim() ?? ''
check('frontmatter name matches the directory', declaredName === GUIDE_SKILL, String(declaredName))
check('frontmatter description is not empty', description.length > 0)
// 常驻成本就是内核技能目录里的这一行：`- \`name\`: description`。想加长描述的人
// 必须先把这里改掉——它出现在每一次请求里（catalogDescriptionMaxLength 上限 500）。
const CATALOG_LINE_BUDGET = 200
const catalogLine = `- \`${GUIDE_SKILL}\`: ${description}`
check(`catalog line stays within ${CATALOG_LINE_BUDGET} chars`, catalogLine.length <= CATALOG_LINE_BUDGET,
  `${catalogLine.length} chars`)
// 内核拒绝旧式驼峰键（dsh-skill-filesystem 的 rejectLegacyInvocationKey），
// 写错会让整个技能被丢弃——而且只在日志里留一行警告。
check('no legacy camelCase invocation keys', !/(disableModelInvocation|modelInvocable|userInvocable)/u.test(head))
check('model invocation stays enabled', !/^disable-model-invocation:/mu.test(head))
check('user invocation stays enabled', !/^user-invocable:\s*false\s*$/mu.test(head))

// --- 3. 路由表与清单一致 -------------------------------------------------------
const body = front === null ? index : index.slice(front[0].length)
const files = guideFiles()
const referenced = new Set([...body.matchAll(/`([^`\s]+\.md)`/gu)].map(match => match[1]))
// SKILL.md 自己与"加后缀"这类通用写法不是路由条目，显式放行。
const allowed = new Set([...files, GUIDE_INDEX, '.en.md'])
const missingDocs = files.filter(file => !file.endsWith('.en.md') && !referenced.has(file))
const unknownRefs = [...referenced].filter(file => !allowed.has(file))
// 英文副本不逐条列（索引本身也要读进上下文，宁可短）：路由表列中文篇，
// 正文声明"接上后缀"的规则并给一个真实存在的例子。
const englishExamples = [...referenced].filter(file => file.endsWith('.en.md') && files.includes(file))
check('routing table names every bundled doc', missingDocs.length === 0, missingDocs.join(', '))
check('English suffix rule is documented with a real example',
  /`\.en\.md`/u.test(body) && englishExamples.length > 0, englishExamples.join(', '))
check('routing table references no unbundled file', unknownRefs.length === 0, unknownRefs.join(', '))

// --- 4. 发布面 -----------------------------------------------------------------
const manifest = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))
check('package.json files ships the guide root', (manifest.files ?? []).includes(GUIDE_ROOT))
const launcher = readFileSync(join(repoRoot, 'bin', 'dsh-tui.js'), 'utf8')
check('launcher declares the packaged guide dir',
  /DSH_BUNDLED_SKILL_DIR/u.test(launcher) && /join\(ownDir, 'guide'\)/u.test(launcher))
check('launcher passes it into the dsh spawn env', /env:\s*withGuideSkillDir\(env\)/u.test(launcher))
check('launcher keeps an explicit user value', /DSH_BUNDLED_SKILL_DIR !== undefined/u.test(launcher))

console.log(failures === 0 ? `\nALL PASS (${files.length} guide files)` : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
