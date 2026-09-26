/** L4-4e structural proof: channel.ts composes distinct owners, not a replacement monolith. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const root = readFileSync(new URL('../src/dsh-adapter/channel.ts', import.meta.url), 'utf8')
for (const module of ['./channel/state.js', './channel/binding-events.js']) {
  assert.match(root, new RegExp(`from '${module.replace(/[./]/g, '\\$&')}'`, 'u'), `root composes ${module}`)
}
assert.match(root, /createInitialChannelView\(options/, 'state construction is delegated')
assert.match(root, /createBindingEvents\(ctx, \{/, 'binding events own subscription routing')
assert.doesNotMatch(root, /new ActivityTracker\(/, 'root does not own an activity tracker')
assert.doesNotMatch(root, /setInterval\(/, 'root does not own activity ticks')
assert.doesNotMatch(root, /on\('session\/event'/, 'root does not directly route session events')
assert.match(root, /releaseContributions\(\)[\s\S]*?owner\.dispose\(\)/, 'explicit release revokes the channel owner')
// The activity line is the plugin's business now (see verify-activity-ownership):
// no sidecar module, no event forwarding, no per-channel tracker to clean up.
assert.doesNotMatch(root, /createChannelActivity/, 'root does not mount an activity sidecar')

const events = readFileSync(new URL('../src/dsh-adapter/channel/binding-events.ts', import.meta.url), 'utf8')
assert.match(events, /binding\.subscribe/, 'binding owns incremental subscription teardown')
assert.match(events, /binding\.isCurrent\(capture\)/, 'retained callbacks are generation/owner-revocation safe')
assert.match(events, /const session = capture\.agent\.session/, 'retained callbacks capture their original session identity')
assert.doesNotMatch(events, /disposeClaimed|disposeDiscarded|disposeStart|disposeEnd/, 'router registers every disposer exactly once')
assert.match(events, /projector\.renderEvent/, 'only router sends main events to projector')

console.log('verify-channel-composition: OK')
