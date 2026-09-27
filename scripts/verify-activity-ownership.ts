/**
 * Structural proof: the working line has exactly ONE owner.
 *
 * The line used to be folded in-process by this app: a channel sidecar built a
 * `dsh-working-activity` tracker, drove it from its own listeners and a 500 ms
 * `setInterval`, and published the result on the channel. That duplication is
 * what let the tool phase freeze for minutes (the app's copy of the fold drifted
 * from the plugin's) and what made a background session able to overwrite the
 * line on screen.
 *
 * The plugin owns the semantics and publishes a `workingActivity` session
 * projection; this app only reads it. These assertions keep the duplication
 * from growing back — they are static, so they cost nothing at runtime and fail
 * in the build chain rather than in a user's session.
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const SRC = fileURLToPath(new URL('../src', import.meta.url))

/** Every TypeScript source under src/, recursively. */
function sources(dir: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) found.push(...sources(path))
    else if (/\.tsx?$/.test(entry)) found.push(path)
  }
  return found
}

const files = sources(SRC)

// 1. Nothing folds the line in-process: no tracker, no plugin status import.
const owners = files.filter(path => /ActivityTracker/.test(readFileSync(path, 'utf8')))
assert.deepEqual(
  owners.map(path => path.slice(SRC.length + 1)),
  [],
  'the app must not build its own activity tracker — the plugin folds the line',
)

const statusImporters = files.filter(path => /from 'dsh-working-activity\/status'/.test(readFileSync(path, 'utf8')))
assert.deepEqual(
  statusImporters.map(path => path.slice(SRC.length + 1)),
  [],
  'nothing may import the plugin\'s status module: the projection value is the only input',
)

// 2. The sidecar is gone, and its absence is the point.
assert.equal(
  existsSync(join(SRC, 'dsh-adapter/channel/activity.ts')),
  false,
  'the channel activity sidecar must stay deleted',
)

// 3. The read path exists and is the store; the channel port carries no line.
assert.equal(
  existsSync(join(SRC, 'dsh-adapter/activity-store.ts')),
  true,
  'the projection read path (activity-store) is the only line source',
)
for (const relative of ['adapter/ports/channel-ui.ts', 'dsh-adapter/channel/types.ts']) {
  const text = readFileSync(join(SRC, relative), 'utf8')
  assert.doesNotMatch(
    text,
    /workingActivity/,
    `${relative} must not carry the line: the UI reads the projection store per session`,
  )
}

// 4. The channel layer routes no activity events and owns no activity timer.
for (const relative of ['dsh-adapter/channel.ts', 'dsh-adapter/channel/binding-events.ts']) {
  const text = readFileSync(join(SRC, relative), 'utf8')
  assert.doesNotMatch(text, /onModelSwitch|onCompact\(|onGitBranch|onAgentStatus/, `${relative} forwards no activity signals`)
  assert.doesNotMatch(text, /setInterval\(/, `${relative} owns no activity tick`)
}

// 5. The store is created BEFORE the channel binds its agent. `createChannel`
//    binds synchronously while it is still being constructed, and that bind
//    seeds this store (`seedActivity`), so a store declared after the channel
//    is still in its temporal dead zone when the first seed arrives: the boot
//    dies with "Cannot access 'activityStore' before initialization" instead of
//    merely losing a line. The ordering IS the invariant, so assert the order.
const pluginSource = readFileSync(join(SRC, 'dsh-adapter/plugin.ts'), 'utf8')
const storeDeclaration = pluginSource.indexOf('const activityStore = createActivityStore(ctx, ')
const channelConstruction = pluginSource.indexOf('const rawChannel = createChannel(ctx, agent, {')
assert.notEqual(storeDeclaration, -1, 'plugin.ts declares the activity store')
assert.notEqual(channelConstruction, -1, 'plugin.ts constructs the channel')
assert.ok(
  storeDeclaration < channelConstruction,
  'the activity store must be declared before the channel: the channel seeds it synchronously during construction',
)

console.log('verify-activity-ownership: OK (one owner: the plugin projection; the app only reads it)')
