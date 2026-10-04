/**
 * Live-tree guard — the deploy-transition design's M0 "同轨风险止血".
 *
 * A worktree whose realpath is the CURRENT target of a profile junction is
 * a live runtime tree: any moment a `dsh-tui` start boots from its lib/,
 * and `npm run clean`/`compile` would empty that lib under a running
 * process or inside a restart window (ENOENT / mixed generations — design
 * §现状: "compile 清空 lib 会给活进程和重启窗口制造 ENOENT/混代").
 *
 * The guard refuses destructive build operations against such a tree and
 * prints the two legitimate ways out: build in a detached worktree (the
 * deploy track, via scripts/build-generation.mjs), or unlink/repoint the
 * profile junction first. DSH_TUI_ALLOW_LIVE_TREE_BUILD=1 is the explicit,
 * loudly-logged escape hatch for operators who know no TUI is running.
 *
 * DSH_HOME comes from the environment with the same fallback the launcher
 * uses — no hardcoded user directories.
 */
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export const TUI_PACKAGE_REL = join("node_modules", "@deepseek-harness-tui", "dsh-tui")

/**
 * Find profile installs whose TUI package currently links at `treeDir`.
 * Only link-type entries (junction/symlink) count: a REAL installed copy is
 * a different tree even when it carries the same version.
 * @returns {{ profileDir: string, linkPath: string }[]}
 */
export function findLiveJunctionReferences(treeDir) {
  const treeReal = realpathSync(treeDir)
  const dshHome = process.env.DSH_HOME || join(homedir(), ".dsh")
  const profilesDir = join(dshHome, "profiles")
  const references = []
  if (!existsSync(profilesDir)) return references
  for (const entry of readdirSync(profilesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const linkPath = join(profilesDir, entry.name, TUI_PACKAGE_REL)
    try {
      const stat = lstatSync(linkPath)
      if (!stat.isSymbolicLink()) continue
      const target = realpathSync(linkPath)
      if (target === treeReal) references.push({ profileDir: join(profilesDir, entry.name), linkPath })
    } catch {
      // Broken junction / unreadable: not a live reference for this tree.
    }
  }
  return references
}

/**
 * Throw when `treeDir` is junction-referenced by a profile (unless the
 * explicit env escape is set). The error message is operator guidance, not
 * just a refusal.
 */
export function assertBuildableTree(treeDir, action) {
  if (process.env.DSH_TUI_ALLOW_LIVE_TREE_BUILD === "1") return []
  const references = findLiveJunctionReferences(treeDir)
  if (references.length === 0) return []
  const lines = [
    "refusing to " + action + " in a LIVE runtime tree: " + realpathSync(treeDir),
    "the following dsh profiles currently boot from this exact tree via a junction:",
    ...references.map(ref => "  - " + ref.profileDir + "  (" + ref.linkPath + ")"),
    "",
    "cleaning/compiling here would empty or rewrite lib/ under a running TUI",
    "or inside a restart window (ENOENT / mixed generations).",
    "",
    "Do one of these instead:",
    "  1. build a generation from a DETACHED worktree:",
    "     node scripts/build-generation.mjs --deploy-root <profile>/.dsh-tui/deploy",
    "  2. unlink or repoint the profile junction, then retry here.",
    "",
    "If you are certain no TUI process is running from this tree, the explicit",
    "escape is:  DSH_TUI_ALLOW_LIVE_TREE_BUILD=1",
  ]
  throw new Error(lines.join("\n"))
}
