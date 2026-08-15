/**
 * Session-cwd resolution and /resume filtering verification (issue #96).
 *
 * - resolveSessionCwd: explicit config wins; launch subdirectory resolves to
 *   the git worktree root (both `.git` DIRECTORY clones and `.git` FILE
 *   linked worktrees/submodules); outside any worktree the launch directory
 *   itself survives.
 * - sessionCwdMatches: exact match, pre-upgrade subdirectory sessions stay
 *   visible (recorded cwd is a descendant of the workspace root), sibling
 *   and parent directories stay hidden, Windows separators normalize, and
 *   case folding follows the platform's filesystem semantics (explicit third
 *   argument exercises both modes on any host).
 *
 * Run with plain node against the compiled lib: `node scripts/verify-session-cwd.mjs`
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sessionCwdMatches } from '../lib/types/channel.js'
import { resolveSessionCwd } from '../lib/types/utils/workspaceRoot.js'

let failed = 0
function check(name, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}

// --- resolveSessionCwd -----------------------------------------------------
const fixture = mkdtempSync(join(tmpdir(), 'dsh-tui-cwd-'))
try {
  // Plain clone layout: repo/.git is a directory, launch from repo/sub/dir.
  const repo = join(fixture, 'repo')
  mkdirSync(join(repo, '.git'), { recursive: true })
  mkdirSync(join(repo, 'sub', 'dir'), { recursive: true })
  // Linked worktree / submodule layout: .git is a FILE (`gitdir: ...`).
  const linked = join(fixture, 'linked')
  mkdirSync(join(linked, 'pkg'), { recursive: true })
  writeFileSync(join(linked, '.git'), 'gitdir: /elsewhere/main/.git/worktrees/linked\n')
  // Outside any worktree.
  const plain = join(fixture, 'plain')
  mkdirSync(plain)

  check('explicit config.cwd wins', resolveSessionCwd('/somewhere', repo) === '/somewhere')
  check('repo root resolves to itself', resolveSessionCwd(undefined, repo) === repo)
  check(
    'launch subdirectory resolves to the worktree root',
    resolveSessionCwd(undefined, join(repo, 'sub', 'dir')) === repo,
  )
  check(
    'linked worktree (.git file) resolves',
    resolveSessionCwd(undefined, join(linked, 'pkg')) === linked,
  )
  check('outside any worktree the launch directory survives', resolveSessionCwd(undefined, plain) === plain)
} finally {
  rmSync(fixture, { recursive: true, force: true })
}

// --- sessionCwdMatches (/resume filter) -------------------------------------
check('exact cwd match', sessionCwdMatches('/repo', '/repo'))
check('trailing slashes normalize', sessionCwdMatches('/repo/', '/repo//'))
check(
  'pre-upgrade subdirectory session stays visible',
  sessionCwdMatches('/repo', '/repo/packages/app'),
)
check('deep descendant stays visible', sessionCwdMatches('/repo', '/repo/a/b/c'))
check('sibling project stays hidden', !sessionCwdMatches('/repo', '/other/packages/app'))
check('parent directory stays hidden', !sessionCwdMatches('/repo/packages/app', '/repo'))
check(
  'prefix-but-not-descendant stays hidden',
  !sessionCwdMatches('/repo/app', '/repo/application'),
)
check('windows separators normalize', sessionCwdMatches('C:\\repo', 'C:/repo/packages/app'))
check('empty header cwd never matches', !sessionCwdMatches('/repo', ''))
// Case handling follows the platform's filesystem semantics; the explicit
// third argument lets both modes be exercised on any host.
check(
  'case-insensitive mode matches differing case',
  sessionCwdMatches('C:/Repo', 'c:\\repo\\packages\\app', true),
)
check(
  'case-sensitive mode keeps case-distinct dirs apart',
  !sessionCwdMatches('/Repo', '/repo/packages/app', false),
)

if (failed > 0) {
  console.error(`\n${failed} check(s) failed`)
  process.exit(1)
}
console.log('\nall checks passed')
