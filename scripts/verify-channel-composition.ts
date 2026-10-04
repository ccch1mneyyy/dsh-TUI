/**
 * L4-4e structural proof: the channel composes distinct owners, not a
 * replacement monolith.
 *
 * Phase 4a (docs/agent-backend-design.md §3.5) split the one composition root
 * into the backend-neutral core (`channel/core/compose.ts`) and the DSH
 * extensions (`channel/extensions.ts`), with `channel.ts` as the entry that
 * attaches the latter only to a DSH session. The structural regexes below
 * follow that layout: state construction and the feed live in the core, the
 * binding-events owner is composed by the DSH extension, and the one
 * session-batch writer (subscription + projector) is `core/binding-feed.ts`.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { compositionSource } from './lib/channel-composition.mjs'

const read = (path: string): string => readFileSync(new URL(`../src/dsh-adapter/${path}`, import.meta.url), 'utf8')
const entry = read('channel.ts')
const core = read('channel/core/compose.ts')
const extensions = read('channel/extensions.ts')
const root = compositionSource()

// The entry: core + DSH extensions, attached by capability only.
assert.match(entry, /createCoreChannel\(ctx, session, options, owner\)/u, 'the entry builds the core')
assert.match(entry, /attachDshExtensions\(core, ctx, native, options\)/u, 'DSH specialists attach to the core')
assert.match(entry, /session\.capabilities\.native\.dsh/u, 'the DSH extension is chosen by capability')
assert.match(entry, /return core\.start\(\)/u, 'the core starts the composed channel')

// The core: state construction and the feed are delegated owners.
assert.match(core, /from '\.\.\/state\.js'/u, 'the core composes ../state.js')
assert.match(core, /createInitialChannelView\(options/u, 'state construction is delegated')
assert.match(core, /createBindingFeed\(ctx, \{/u, 'the feed owns subscription routing')
assert.match(core, /releaseContributions\(\)[\s\S]*?owner\.dispose\(\)/u, 'explicit release revokes the channel owner')

// The DSH extension composes the binding-events owner and installs its hooks.
assert.match(extensions, /from '\.\/binding-events\.js'/u, 'the DSH extension composes ./binding-events.js')
assert.match(extensions, /createBindingEvents\(ctx, \{/u, 'binding events own the DSH listeners')
assert.match(extensions, /bindingEvents\.hooks/u, 'the DSH listeners run inside the core bind')

// Across every composition root: no activity sidecar, no direct routing.
assert.doesNotMatch(root, /new ActivityTracker\(/u, 'root does not own an activity tracker')
assert.doesNotMatch(root, /setInterval\(/u, 'root does not own activity ticks')
assert.doesNotMatch(root, /on\('session\/event'/u, 'root does not directly route session events')
// The activity line is the plugin's business now (see verify-activity-ownership):
// no sidecar module, no event forwarding, no per-channel tracker to clean up.
assert.doesNotMatch(root, /createChannelActivity/u, 'root does not mount an activity sidecar')

// The one session-batch writer path.
const feed = read('channel/core/binding-feed.ts')
const events = read('channel/binding-events.ts')
assert.match(feed, /binding\.subscribe/u, 'binding owns incremental subscription teardown')
assert.match(feed, /binding\.isCurrent\(capture\)/u, 'retained callbacks are generation/owner-revocation safe')
// Phase 1 (agent-backend): the binding holds an AgentSession, and the router
// subscribes to that captured session instead of filtering raw DSH events.
assert.match(feed, /const session = capture\.session/u, 'retained callbacks capture their original session identity')
assert.doesNotMatch(feed + events, /disposeClaimed|disposeDiscarded|disposeStart|disposeEnd/u, 'router registers every disposer exactly once')
assert.match(feed, /session\.subscribe\(/u, 'the router follows the bound session')
assert.match(feed, /projector\.apply\(/u, 'only router sends main events to projector')
assert.doesNotMatch(events, /projector\.apply\(/u, 'the DSH listeners never write the transcript')

console.log('verify-channel-composition: OK')
