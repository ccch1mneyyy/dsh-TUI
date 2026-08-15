/**
 * Session-cwd resolution and /resume filtering verification (issue #96).
 *
 * - resolveSessionCwd: explicit config wins; launch subdirectory resolves to
 *   the git worktree root (both `.git` DIRECTORY clones and `.git` FILE
 *   linked worktrees/submodules); outside any worktree the launch directory
 *   itself survives.
 * - sessionCwdMatches: exact match, plus the symmetric descendant rule —
 *   pre-upgrade subdirectory sessions stay visible from the root, AND
 *   workspace-root sessions stay visible after resuming into a
 *   subdirectory-recorded session (review leftover); sibling subtrees stay
 *   hidden in both directions, root-recorded ('/') sessions never match,
 *   Windows separators normalize, and case folding follows the platform's
 *   filesystem semantics (explicit third argument exercises both modes on
 *   any host).
 * - resolveSessionCwd dotfiles guard: a ~/.git (dotfiles repo) must not
 *   promote $HOME to the workspace (review leftover).
 *
 * Run with plain node against the compiled lib: `node scripts/verify-session-cwd.mjs`
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sessionCwdMatches } from '../lib/types/dsh-adapter/channel.js'
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

  const explicit = join(fixture, 'somewhere')
  check('explicit config.cwd wins', resolveSessionCwd(explicit, repo) === explicit)
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
// Resumed-into-subdirectory (review leftover): state.cwd adopted a
// pre-upgrade session's recorded subdirectory; its workspace-root sessions
// must stay visible, or /resume looks like it lost them.
check(
  'resumed-into-subdirectory keeps workspace-root sessions visible',
  sessionCwdMatches('/repo/packages/app', '/repo'),
)
check(
  'deeply nested state still matches the workspace root',
  sessionCwdMatches('/repo/a/b/c', '/repo'),
)
// …but sibling subtrees stay hidden in BOTH directions.
check('sibling subtrees stay hidden (either direction)',
  !sessionCwdMatches('/repo/a', '/repo/b') && !sessionCwdMatches('/repo/b', '/repo/a'),
)
// A session recorded at the filesystem root normalizes to '' and must
// never match everything (the '/' edge).
check('root-recorded session never matches', !sessionCwdMatches('/repo', '/'))
check('root state matches only root-recorded (both empty)', !sessionCwdMatches('/', '/repo'))
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

// --- dotfiles guard (review leftover) --------------------------------------
// A dotfiles repo at $HOME (~/.git) must not make the whole home directory
// the session workspace: launching from a non-repo directory under home
// falls back to the launch directory, and the climb stops at $HOME.
const savedHome = process.env.HOME
const savedUserProfile = process.env.USERPROFILE
const homeFixture = mkdtempSync(join(tmpdir(), 'dsh-tui-home-'))
try {
  process.env.HOME = homeFixture
  process.env.USERPROFILE = homeFixture
  mkdirSync(join(homeFixture, '.git'))                 // dotfiles repo
  const proj = join(homeFixture, 'some', 'project')    // itself not a repo
  mkdirSync(proj, { recursive: true })
  const realProj = join(homeFixture, 'code', 'real')   // a real repo under home
  mkdirSync(join(realProj, '.git'), { recursive: true })

  check(
    'dotfiles ~/.git does not promote $HOME to the workspace',
    resolveSessionCwd(undefined, proj) === proj,
  )
  check(
    'launching from $HOME with a dotfiles repo keeps $HOME as plain cwd',
    resolveSessionCwd(undefined, homeFixture) === homeFixture,
  )
  check(
    'a real repo under $HOME still resolves normally',
    resolveSessionCwd(undefined, realProj) === realProj,
  )
} finally {
  if (savedHome === undefined) delete process.env.HOME
  else process.env.HOME = savedHome
  if (savedUserProfile === undefined) delete process.env.USERPROFILE
  else process.env.USERPROFILE = savedUserProfile
  rmSync(homeFixture, { recursive: true, force: true })
}

if (failed > 0) {
  console.error(`\n${failed} check(s) failed`)
  process.exit(1)
}
console.log('\nall checks passed')
