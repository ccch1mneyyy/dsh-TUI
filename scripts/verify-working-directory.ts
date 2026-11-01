/**
 * Session working-directory moves (issue #1724): DSH 0.2.1's durable
 * `working-directory/change` must move the channel's current directory live
 * and after a cold resume, while project identity (`cwd`, fork headers) stays
 * the directory the session opened in. A `/resume` into a session that never
 * moved forgets the previous session's directory, and `@` completion follows
 * the move, and so do the skill slash commands (re-read on the move). Uses
 * the installed V4 Session/Agent/JSONL, fs and skill services and the real
 * channel; the events are appended directly (the `dsh-working-directory`
 * owner is not a dependency), so no model, network or user profile is used.
 * Run: node --import tsx/esm scripts/verify-working-directory.ts
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context as ContextType } from '@deepseek-ai/cordis'
import type { Session as SessionType } from '@deepseek-ai/dsh-session'
import type { ChannelState } from '../src/dsh-adapter/channel.js'

const root = mkdtempSync(join(tmpdir(), 'dsh-tui-working-directory-'))
const sessionsRoot = join(root, 'sessions')
const project = join(root, 'app')
const worktree = join(project, '.agents', 'worktrees', 'try')
mkdirSync(worktree, { recursive: true })
// The DSH skill filesystem anchors project roots on a `.git` marker. Without
// these, an ancestor checkout (a local TMPDIR can live inside one) becomes the
// project root and shadows this fixture; a real project and linked worktree
// both carry one.
mkdirSync(join(project, '.git'), { recursive: true })
writeFileSync(join(worktree, '.git'), '# fixture worktree marker\n')
writeFileSync(join(project, 'project-only.txt'), '')
writeFileSync(join(worktree, 'worktree-only.txt'), '')
mkdirSync(join(worktree, '.dsh', 'skills', 'worktree-only-skill'), { recursive: true })
writeFileSync(join(worktree, '.dsh', 'skills', 'worktree-only-skill', 'SKILL.md'), '---\nname: worktree-only-skill\ndescription: only in the worktree\n---\nbody\n')
process.env.HOME = root
process.env.USERPROFILE = root
process.env.DSH_HOME = join(root, 'home')
process.env.DSH_TUI_SESSION_ROOT = sessionsRoot
process.env.DSH_TUI_LANG = 'en'

const [
  { Context },
  { default: AgentRegistry },
  { default: AgentLoop },
  { default: LlmRuntime },
  { default: SessionStore, SessionId },
  { default: SessionProjectionRegistry },
  JsonlSessionPersistenceModule,
  { default: SystemPrompt },
  { default: ToolRuntime },
  { default: LocalFileSystem },
  { default: SkillRegistry },
  SkillFileSystem,
  { default: CommandRegistry },
  { createChannel },
  { compactWorkingDirectory },
] = await Promise.all([
  import('@deepseek-ai/cordis'),
  import('@deepseek-ai/dsh-agent'),
  import('@deepseek-ai/dsh-agent-loop'),
  import('@deepseek-ai/dsh-llm'),
  import('@deepseek-ai/dsh-session'),
  import('@deepseek-ai/dsh-session-projection'),
  import('@deepseek-ai/dsh-session-persistence-jsonl'),
  import('@deepseek-ai/dsh-system-prompt'),
  import('@deepseek-ai/dsh-tools'),
  import('@deepseek-ai/dsh-fs-local'),
  import('@deepseek-ai/dsh-skill'),
  import('@deepseek-ai/dsh-skill-filesystem'),
  import('@deepseek-ai/dsh-commands'),
  import('../src/dsh-adapter/channel.js'),
  import('../src/sessions/format.js'),
])

const JsonlSessionPersistence = 'default' in JsonlSessionPersistenceModule
  ? JsonlSessionPersistenceModule.default : JsonlSessionPersistenceModule

const contexts: ContextType[] = []
const channels: ChannelState[] = []

async function runtime(): Promise<ContextType> {
  const ctx = new Context()
  contexts.push(ctx)
  for (const plugin of [LlmRuntime, SessionStore, SessionProjectionRegistry, SystemPrompt, ToolRuntime, AgentRegistry, SkillRegistry, CommandRegistry]) {
    await ctx.plugin(plugin)
  }
  await ctx.plugin(SkillFileSystem, { dshHome: join(root, 'home'), agentsHome: join(root, 'agents'), watch: false })
  await ctx.plugin(JsonlSessionPersistence, { root: sessionsRoot })
  await ctx.plugin(LocalFileSystem, { cwd: project })
  await ctx.plugin(AgentLoop, { agents: [] })
  return ctx
}

const move = (session: SessionType, cwd: string): void => {
  session.append('working-directory/change' as never, { cwd } as never)
}
/** Skill commands refresh asynchronously after the move; poll briefly. */
const listsSkill = async (channel: ChannelState, expected: boolean): Promise<boolean> => {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (channel.commandList.some(command => command.name === 'worktree-only-skill') === expected) return true
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  return false
}
const completes = async (channel: ChannelState, name: string): Promise<boolean> =>
  (await channel.listFileCandidates(name)).some(candidate => candidate.path.endsWith(name))

try {
  const original = await runtime()
  const handle = await original.agents.create({ sessionId: SessionId('moved'), meta: { cwd: project } })
  const session = handle.agent.session
  const channel = createChannel(original, handle.agent, { handle, cwd: project, activity: false })
  channels.push(channel)
  assert.equal(channel.workingDirectory, undefined, 'a session that never moved records no directory')
  assert.equal(compactWorkingDirectory(channel, root), undefined, 'an unmoved session shows the bare project name')
  assert.ok(await completes(channel, 'project-only.txt'), '@ completion starts in the project')
  assert.ok(await listsSkill(channel, false), 'the project lists no worktree skill')

  // A change to the directory the session is already in moves nothing.
  move(session, project)
  assert.equal(channel.workingDirectory, project)
  assert.equal(channel.cwd, project)
  assert.equal(compactWorkingDirectory(channel, root), undefined, 'a move to the project root shows no breadcrumb')

  move(session, worktree)
  assert.equal(channel.workingDirectory, worktree, 'a live move reaches the channel')
  assert.equal(channel.cwd, project, 'project identity stays the opening directory')
  assert.deepEqual(compactWorkingDirectory(channel, root), {
    anchor: 'app', separator: '›', target: '.agents/worktrees/try',
  }, 'the compact footer anchors the worktree under its project')
  assert.ok(await completes(channel, 'worktree-only.txt'), '@ completion follows the move')
  assert.ok(!(await completes(channel, 'project-only.txt')), '@ completion no longer lists the project root')
  assert.ok(await listsSkill(channel, true), 'skill commands are re-read in the new directory')

  // /fork inside the worktree: the copy still belongs to the project. A
  // closed turn gives /fork a conversation to copy.
  session.append('turn/start', { turn: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  await original.sessionPersistence.flush()
  const before = new Set((await original.sessionPersistence.list()).map(row => row.header.id))
  assert.equal(await channel.forkSession(), true, channel.notifications.map(row => row.text).join('\n'))
  const copy = (await original.sessionPersistence.list()).find(row => !before.has(row.header.id))
  assert.ok(copy !== undefined, 'the fork is persisted')
  assert.equal(copy.header.cwd, project, 'a fork is registered under the project, not the worktree')
  assert.equal(channel.workingDirectory, worktree, '/fork keeps the foreground directory')
  await original.sessionPersistence.flush()

  // Cold resume: the move is replayed from the durable log. The first
  // runtime releases its write lease before another one resumes the session.
  channels.splice(channels.indexOf(channel), 1)
  channel.releaseContributions()
  contexts.splice(contexts.indexOf(original), 1)
  await original.fiber.dispose()
  const reopened = await runtime()
  const blank = await reopened.agents.create({ sessionId: SessionId('blank'), meta: { cwd: project } })
  const resumed = await reopened.agents.resume({ resumeSessionId: session.id })
  assert.equal(resumed.agent.session.header.cwd, project, 'the header keeps the original project')
  const resumedChannel = createChannel(reopened, resumed.agent, { handle: resumed, cwd: project, activity: false })
  channels.push(resumedChannel)
  assert.equal(resumedChannel.workingDirectory, worktree, 'a resumed session shows where it moved')
  assert.equal(resumedChannel.cwd, project)

  // /resume into a session that never moved forgets the previous directory.
  await reopened.sessionPersistence.flush()
  const switched = await resumedChannel.resumeTo(String(blank.agent.session.id))
  assert.equal(switched.ok, true, JSON.stringify(switched))
  assert.equal(resumedChannel.workingDirectory, undefined, 'the adopted session starts without a move')
  assert.equal(resumedChannel.cwd, project)
  console.log('PASS working-directory moves: live, same-directory, @ completion, skill refresh, fork identity, cold resume, adoption reset')
} finally {
  for (const channel of channels) channel.releaseContributions()
  for (const ctx of contexts.reverse()) await ctx.fiber.dispose()
  rmSync(root, { recursive: true, force: true })
}
