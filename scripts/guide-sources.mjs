/**
 * guide-sources.mjs — 随包用户手册（`guide/`）的清单与漂移检测。
 *
 * 为什么有这一层：npm 包不发布用户文档（旧的 `skills/` 开发技能在 #613 之后
 * 也不再打包），装在用户机器上的 dsh-tui 里没有手册，会话里的 AI 也就无从
 * "查文档回答"。这里把面向用户的 `docs/` 逐字节复制进 `guide/dsh-tui-guide/`，
 * 由 `bin/dsh-tui.js` 以 `DSH_BUNDLED_SKILL_DIR` 声明成内核
 * `dsh-skill-filesystem` 的随包技能根（rank 600 `bundledSkillDir`）。
 * 于是模型常驻只多一行技能目录；用户真问到 dsh-tui 时才加载 SKILL.md 索引，
 * 再按需读具体章节——手册正文不占常驻上下文。
 *
 * 单一真源是 `docs/`：本文件只声明清单，`build-guide.mjs` 负责复制，
 * `verify-guide.mjs` 负责断言逐字节一致。要增删一篇：改 GUIDE_DOCS、
 * 改 SKILL.md 的路由表，再跑 `node scripts/build-guide.mjs`。
 *
 * @module scripts/guide-sources
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 仓库根（脚本所在目录的上一级）。 */
export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
/** 发布面里的技能根目录名（package.json 的 files 条目）。 */
export const GUIDE_ROOT = 'guide'
/** 技能名：目录名、frontmatter `name` 与内核目录里显示的名字三处必须一致。 */
export const GUIDE_SKILL = 'dsh-tui-guide'
/** 技能包目录（相对仓库根）。 */
export const GUIDE_DIR = `${GUIDE_ROOT}/${GUIDE_SKILL}`
/** 手写索引：不参与同步，也不允许被当作残留删掉。 */
export const GUIDE_INDEX = 'SKILL.md'
/**
 * 面向用户的手册基名——`docs/<name>.md`（中文）与 `docs/<name>.en.md`（英文）。
 * 实现向/社区向文档（architecture、contributing、roadmap…）不进包：用户问不到，
 * 也没必要让每个安装多背一份。
 */
export const GUIDE_DOCS = [
  'getting-started',
  'user-guide',
  'interaction',
  'configuration',
  'themes',
  'migrate',
  'vscode',
  'plugins',
]
/** 清单里的全部文件名（中英各一份），稳定排序。 */
export function guideFiles() {
  return GUIDE_DOCS.flatMap(name => [`${name}.md`, `${name}.en.md`]).sort()
}
/** 文件字节的 sha256（十六进制）。 */
export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}
/**
 * 比对 `docs/`（真源）与 `guide/`（副本）。
 * @param root - 仓库根，测试可指向别处。
 * @returns 四类差异：真源缺失、副本缺失、内容不同、技能目录里的清单外残留。
 */
export function guideDrift(root = repoRoot) {
  const files = guideFiles()
  const missingSource = []
  const missingCopy = []
  const differing = []
  for (const file of files) {
    const source = join(root, 'docs', file)
    if (!existsSync(source)) {
      missingSource.push(file)
      continue
    }
    const copy = join(root, GUIDE_DIR, file)
    if (!existsSync(copy)) {
      missingCopy.push(file)
      continue
    }
    if (sha256(readFileSync(source)) !== sha256(readFileSync(copy))) differing.push(file)
  }
  const dir = join(root, GUIDE_DIR)
  const extra = existsSync(dir)
    ? readdirSync(dir)
      .filter(name => name.endsWith('.md') && name !== GUIDE_INDEX && !files.includes(name))
      .sort()
    : []
  return { missingSource, missingCopy, differing, extra }
}
