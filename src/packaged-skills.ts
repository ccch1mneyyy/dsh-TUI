/**
 * Packaged skill self-registration. Mature harnesses (Claude Code plugins,
 * pi packages) ship skills inside the package and contribute them through the
 * host's skill registry seam — users never copy SKILL.md files into discovery
 * directories by hand. This module does the same for dsh-tui: every
 * `skills/<name>/SKILL.md` in the npm package is registered at boot, so the
 * `/audit`-style slash commands resolve out of the box.
 * @module @deepseek-harness-tui/dsh-tui/packaged-skills
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'

/** Minimal structural view of the official SkillRegistry this plugin uses. */
interface SkillRegistryLike {
  register(skill: {
    name: string
    description: string
    content: string
    path?: string
    provider?: string
    source?: string
  }): () => void
}

/**
 * Parse a SKILL.md into name/description/content. Dependency-free: the
 * packaged files use single-line scalar frontmatter fields only.
 *
 * @param raw - the raw SKILL.md text
 * @param fallbackName - directory name used when frontmatter omits `name`
 * @returns the parsed registration fields
 */
function parseSkillMarkdown(raw: string, fallbackName: string): { name: string; description: string; content: string } {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/)
  const frontmatter = match?.[1] ?? ''
  const content = (match?.[2] ?? raw).trim()
  const name = frontmatter.match(/^name:\s*(.+)$/m)?.[1]?.trim() ?? fallbackName
  const description = frontmatter.match(/^description:\s*(.+)$/m)?.[1]?.trim() ?? ''
  return { name, description, content }
}

/**
 * Register every `skills/<name>/SKILL.md` shipped in this package. No-op when
 * the composition mounts no skill registry (bare standalone boots); duplicate
 * or invalid entries are skipped so a skill can never take down the TUI boot.
 *
 * @param ctx - the plugin's cordis context
 */
export function registerPackagedSkills(ctx: Context): void {
  const registry = ctx.get('skills') as SkillRegistryLike | undefined
  if (!registry) return
  // import.meta.url is lib/types/packaged-skills.js — two levels up is the
  // package root, which is where `files` ships the skills/ directory.
  const skillsRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'skills')
  if (!existsSync(skillsRoot)) return
  for (const entry of readdirSync(skillsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const file = join(skillsRoot, entry.name, 'SKILL.md')
    if (!existsSync(file)) continue
    const { name, description, content } = parseSkillMarkdown(readFileSync(file, 'utf8'), entry.name)
    if (!description) continue
    try {
      registry.register({ name, description, content, path: file, provider: 'dsh-tui', source: 'bundled' })
    } catch (error) {
      // The registry itself warns and ignores duplicates; surface anything
      // else (bad name, empty description) instead of failing the boot.
      ctx.logger.warn(`packaged skill "${name}" skipped: ${(error as Error).message}`)
    }
  }
}
