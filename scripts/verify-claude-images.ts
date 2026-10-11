/**
 * Image input on a Claude session, over a fake SDK (no CLI, no network):
 *
 *  - the channel core stages composer images without the DSH attachments
 *    service when the session declares the `images` capability: bytes held
 *    in memory (local-images.ts) under the session's limits (the same limit
 *    model: media types, per-image and per-message bytes, count, pixel
 *    caps), content-addressed, bounded (oldest dropped, its facade then
 *    reports itself unavailable);
 *  - `submit` sends `{type:'image', source:{type:'base64', media_type, data}}`
 *    blocks after the text, read back from the staged facades; the limits
 *    (PNG/JPEG/GIF/WebP, 5 MiB each, 20 per message, 20 MiB together) are
 *    enforced; an image block without its facade refuses the message;
 *  - the user row shows `TranscriptImage` facades backed by the staged
 *    bytes; an `@`-mentioned image file is staged and sent the same way;
 *  - the content wins over the label: a renamed file (a real WebP named
 *    .jpg) is staged and sent as its sniffed format (magic bytes only: no
 *    decode, no re-encode, animations untouched), so the backend's
 *    media_type always matches the bytes; unmeasurable bytes are refused;
 *  - replay: base64 image blocks from `getSessionMessages` become lazy
 *    facades (size probed on first access, bytes decoded on read; no
 *    pixels in the projection); an image-only prompt is a row;
 *  - a session without the capability (DSH) still needs the attachments
 *    service, exactly as before;
 *  - a submit whose image read straddles a credential reconnect: the
 *    input waits for the replacement CLI and is delivered exactly once
 *    (never into the closed old inbox, never dropped); a deferred /login
 *    reconnect still leaves the old CLI serving it; a failed reconnect or
 *    a dispose during the read refuses it.
 *
 * Run: node --import tsx/esm scripts/verify-claude-images.ts
 */
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'

const home = mkdtempSync(join(tmpdir(), 'dsh-tui-claude-images-'))
process.env.HOME = home
process.env.USERPROFILE = home

const [
  { openClaudeSession },
  { memoryClaudePrefs },
  { createChannel },
  { createLocalImageStore, LOCAL_IMAGE_LIMIT },
  { CLAUDE_IMAGE_LIMITS, claudeImageBlocks, transcriptImages },
  { replayClaudeTranscript },
  { setLang, t },
  { settled },
  fakes,
  { claudeText },
] = await Promise.all([
  import('../src/backends/claude/session.js'),
  import('../src/backends/claude/prefs.js'),
  import('../src/dsh-adapter/channel.js'),
  import('../src/dsh-adapter/channel/core/local-images.js'),
  import('../src/backends/claude/images.js'),
  import('../src/backends/claude/replay.js'),
  import('../src/i18n.js'),
  import('./lib/term-test.mjs'),
  import('./lib/claude-fake-sdk.js'),
  import('../src/backends/claude/text.js'),
])

setLang('en')
let passed = 0
const check = (label: string, ok: boolean, detail?: unknown): void => {
  assert.ok(ok, detail === undefined ? label : `${label}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`)
  passed += 1
  console.log(`PASS ${label}`)
}
/** A promise's outcome, or 'timed out' (a hang fails loudly, not forever). */
const within = <T>(promise: Promise<T>, ms = 3000): Promise<T | 'timed out'> =>
  Promise.race([promise, new Promise<'timed out'>(resolve => { setTimeout(() => resolve('timed out'), ms) })])
const { fakeClaudeSdk, claudeDeps, tick } = fakes
const ctx = { on: () => () => undefined, get: () => undefined, logger: { warn: () => undefined, info: () => undefined, debug: () => undefined } } as never

/** A solid-colour RGB PNG, built by hand (no image library needed). */
function png(width: number, height: number, rgb: readonly [number, number, number]): Uint8Array {
  const table = new Uint32Array(256).map((_, n) => {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  })
  const crc = (bytes: Uint8Array): number => {
    let c = 0xffffffff
    for (const byte of bytes) c = table[(c ^ byte) & 0xff]! ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type: string, data: Uint8Array): Buffer => {
    const head = Buffer.alloc(8)
    head.writeUInt32BE(data.length, 0)
    head.write(type, 4, 'ascii')
    const tail = Buffer.alloc(4)
    tail.writeUInt32BE(crc(Buffer.concat([head.subarray(4), data])), 0)
    return Buffer.concat([head, data, tail])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr.set([8, 2, 0, 0, 0], 8)
  const rows = Buffer.alloc((width * 3 + 1) * height)
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) rows.set(rgb, y * (width * 3 + 1) + 1 + x * 3)
  return new Uint8Array(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(rows)), chunk('IEND', new Uint8Array())]))
}
const RED = png(4, 3, [255, 0, 0])
const BLUE = png(5, 5, [0, 0, 255])

// ── the local store ────────────────────────────────────────────────────
{
  const store = createLocalImageStore(() => CLAUDE_IMAGE_LIMITS)
  const ref = await store.saveImage({ data: RED, mediaType: 'image/png', name: 'red.png' })
  check('a staged image gets a local, content-addressed id and its measured size', String(ref.attachmentId).startsWith('local-') && ref.width === 4 && ref.height === 3 && ref.bytes === RED.byteLength && ref.name === 'red.png')
  const again = await store.saveImage({ data: RED, mediaType: 'image/png' })
  check('the same bytes are the same image', again.attachmentId === ref.attachmentId)
  const view = store.facade(ref)!
  check('its facade reads the staged bytes back (one stable object per id)', Buffer.compare(Buffer.from(await view.read()), Buffer.from(RED)) === 0 && store.facade(ref) === view)
  check('the store exposes the backend\'s limits', store.imageLimits.maxImageBytes === 5 * 1024 * 1024 && store.imageLimits.mediaTypes.join() === 'image/png,image/jpeg,image/webp,image/gif')
  let refused = false
  try { await createLocalImageStore(() => ({ ...CLAUDE_IMAGE_LIMITS, maxImageBytes: 10 })).saveImage({ data: RED, mediaType: 'image/png' }) } catch { refused = true }
  check('an image over the per-image limit is refused', refused)
  for (let index = 0; index < LOCAL_IMAGE_LIMIT; index += 1) await store.saveImage({ data: png(1, 1, [index, 0, 0]), mediaType: 'image/png' })
  let gone = false
  try { await view.read() } catch { gone = true }
  check(`bounded: past ${LOCAL_IMAGE_LIMIT} images the oldest is dropped, its facade reports it`, gone && store.facade(ref) === undefined)
}

// ── content wins over the label (a renamed image stages as its real format) ──
{
  // A real 8×8 lossless WebP (built with sharp offline, embedded so the
  // test needs no encoder): renaming it .jpg must not send image/jpeg.
  const WEBP = new Uint8Array(Buffer.from('UklGRhwAAABXRUJQVlA4TBAAAAAvB8ABAAdQrSho/wMR0f8A', 'base64'))
  const store = createLocalImageStore(() => CLAUDE_IMAGE_LIMITS)
  const renamed = await store.saveImage({ data: WEBP, mediaType: 'image/jpeg', name: 'photo.jpg' })
  check('a real WebP named .jpg is staged as image/webp', renamed.mediaType === 'image/webp', renamed.mediaType)
  check('… measured at its real dimensions (no decode)', renamed.width === 8 && renamed.height === 8)
  check('… its facade reports the sniffed type', store.facade(renamed)?.mediaType === 'image/webp')
  check('… and the bytes are untouched (magic sniff only)', Buffer.compare(Buffer.from(store.bytes(renamed.attachmentId) ?? ''), Buffer.from(WEBP)) === 0)
  // The mismatch matrix, each against a different declared label.
  const minimalJpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x08, 0x00, 0x08, 0x00, 0x00, 0x00])
  const minimalGif = new Uint8Array(Buffer.concat([Buffer.from('GIF89a'), Buffer.from([0x08, 0x00, 0x08, 0x00, 0x00])]))
  const cases: readonly [string, Uint8Array, Parameters<typeof store.saveImage>[0]['mediaType'], string][] = [
    ['a PNG named .webp', RED, 'image/webp', 'image/png'],
    ['a JPEG named .gif', minimalJpeg, 'image/gif', 'image/jpeg'],
    ['a GIF named .png', minimalGif, 'image/png', 'image/gif'],
  ]
  for (const [label, data, declared, actual] of cases) {
    const ref = await store.saveImage({ data, mediaType: declared, name: 'renamed' })
    check(`content sniff: ${label} is staged as ${actual}`, ref.mediaType === actual, ref.mediaType)
    check(`content sniff: ${label} keeps its bytes`, Buffer.compare(Buffer.from(store.bytes(ref.attachmentId) ?? ''), Buffer.from(data)) === 0)
  }
  check('content sniff: a truthfully declared image is unchanged', (await store.saveImage({ data: RED, mediaType: 'image/png', name: 'plain.png' })).mediaType === 'image/png')
  // Unmeasurable bytes are still refused, whatever the label says.
  const refusal = async (data: Uint8Array, mediaType: Parameters<typeof store.saveImage>[0]['mediaType']): Promise<string | undefined> => {
    try { await store.saveImage({ data, mediaType }); return undefined } catch (error) { return error instanceof Error ? error.message : String(error) }
  }
  check('content sniff: bytes with no image magic are refused (not relabeled)', (await refusal(new Uint8Array([0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08]), 'image/png'))?.startsWith('the image could not be measured') === true)
  check('content sniff: a truncated header fragment is refused', (await refusal(new Uint8Array([0x52, 0x49, 0x46, 0x46]), 'image/png'))?.startsWith('the image could not be measured') === true)
}

// ── the image blocks of a message and their limits ─────────────────────
{
  const store = createLocalImageStore(() => CLAUDE_IMAGE_LIMITS)
  const facade = store.facade(await store.saveImage({ data: RED, mediaType: 'image/png' }))!
  const blocks = await claudeImageBlocks([facade])
  check('an image becomes a base64 block with its media type', blocks.length === 1 && blocks[0]!.type === 'image' && blocks[0]!.source.media_type === 'image/png' && blocks[0]!.source.data === Buffer.from(RED).toString('base64'))
  const refusal = async (images: Parameters<typeof claudeImageBlocks>[0], limits = CLAUDE_IMAGE_LIMITS): Promise<string | undefined> => {
    try { await claudeImageBlocks(images, limits); return undefined } catch (error) { return error instanceof Error ? error.message : String(error) }
  }
  check('more than 20 images are refused', await refusal(Array.from({ length: 21 }, () => facade)) === claudeText('claude-images-too-many', { n: 20 }))
  check('an image over the per-image limit (5 MiB) is refused', await refusal([facade], { ...CLAUDE_IMAGE_LIMITS, maxImageBytes: 10 }) === claudeText('claude-image-too-large', { name: facade.id, mb: 0 }))
  check('images over the per-message total are refused', await refusal([facade, facade], { ...CLAUDE_IMAGE_LIMITS, maxMessageImageBytes: RED.byteLength + 1 }) === claudeText('claude-images-too-large', { mb: 0 }))
  check('a format Claude does not take is refused', await refusal([{ ...facade, mediaType: 'image/bmp' }]) === claudeText('claude-image-type-refused', { name: facade.id, type: 'image/bmp' }))
}

// ── submit, the user row, @-mentions — through the channel ─────────────
{
  const cwd = mkdtempSync(join(home, 'project-'))
  writeFileSync(join(cwd, 'blue.png'), BLUE)
  const fake = fakeClaudeSdk(() => ({ capabilities: ['msg_lifecycle_v1'] }))
  const session = await openClaudeSession(claudeDeps(fake.sdk, { cwd, prefs: memoryClaudePrefs() }))
  const channel = createChannel(ctx, session, { model: 'Claude Agent', provider: 'claude', cwd, activity: false, backendLabel: 'Claude Agent' })
  const query = fake.queries[0]!
  try {
    check('the composer offers image staging under the backend\'s limits (no attachments service)', channel.stagedImageLimits()?.maxImageBytes === 5 * 1024 * 1024)
    const handle = await channel.stageComposerImage({ data: RED, mediaType: 'image/png', name: 'red.png' }, channel.stagedImageGeneration())
    channel.submit('what color is this square? [Image #1]', [{ token: '[Image #1]', stageId: handle.stageId }])
    await settled(() => query.inputs.length === 1)
    const content = (query.inputs[0]!.message as { content: unknown }).content as { type: string; text?: string; source?: { type: string; media_type: string; data: string } }[]
    check('the message is the text, then the base64 image block', Array.isArray(content) && content[0]?.type === 'text' && content[0].text === 'what color is this square? [Image #1]' && content[1]?.type === 'image' && content[1].source?.type === 'base64' && content[1].source.media_type === 'image/png' && content[1].source.data === Buffer.from(RED).toString('base64'), content)
    query.emit({ type: 'command_lifecycle', command_uuid: String(query.inputs[0]!.uuid), state: 'started' })
    const row = await settled(() => channel.rows.some(item => item.kind === 'user' && (item.images?.length ?? 0) === 1)) ? channel.rows.find(item => item.kind === 'user')! : undefined
    check('the user row shows the staged image', row !== undefined && row.images![0]!.width === 4 && row.images![0]!.height === 3)
    check('… backed by the staged bytes', row !== undefined && Buffer.compare(Buffer.from(await row.images![0]!.read()), Buffer.from(RED)) === 0)
    query.emit({ type: 'result', subtype: 'success', is_error: false, result: 'red', total_cost_usd: 0.001, modelUsage: {} })
    await settled(() => !channel.working)
    channel.submit('and this one? @blue.png')
    await settled(() => query.inputs.length === 2)
    const mentioned = (query.inputs[1]!.message as { content: unknown }).content as { type: string; source?: { data: string } }[]
    check('an @-mentioned image file is staged and sent the same way', Array.isArray(mentioned) && mentioned.some(block => block.type === 'image' && block.source?.data === Buffer.from(BLUE).toString('base64')), mentioned)
  } finally {
    channel.releaseContributions()
    await session.dispose()
  }
  // An image block whose facade is gone refuses the whole message.
  const lone = await openClaudeSession(claudeDeps(fakeClaudeSdk().sdk, { prefs: memoryClaudePrefs() }))
  let refused: string | undefined
  try {
    await lone.submit({ text: 'look', blocks: [{ type: 'text', text: 'look' }, { type: 'image' }], clientMessageId: 'x1' }, 'turn')
  } catch (error) {
    refused = error instanceof Error ? error.message : String(error)
  }
  check('an image block without its staged image refuses the message (never text alone)', refused === claudeText('claude-image-unreadable', { name: '#1', err: claudeText('claude-image-gone') }), refused)
  await lone.dispose()
}

// ── end to end: a renamed image is sent as its sniffed format ──────────
{
  const cwd = mkdtempSync(join(home, 'project-sniff-'))
  const fake = fakeClaudeSdk(() => ({ capabilities: ['msg_lifecycle_v1'] }))
  const session = await openClaudeSession(claudeDeps(fake.sdk, { cwd, prefs: memoryClaudePrefs() }))
  const channel = createChannel(ctx, session, { model: 'Claude Agent', provider: 'claude', cwd, activity: false, backendLabel: 'Claude Agent' })
  const query = fake.queries[0]!
  const WEBP = new Uint8Array(Buffer.from('UklGRhwAAABXRUJQVlA4TBAAAAAvB8ABAAdQrSho/wMR0f8A', 'base64'))
  try {
    // The composer hands the store a .jpg paste/mention: the declared
    // type is image/jpeg while the bytes are a real WebP.
    const handle = await channel.stageComposerImage({ data: WEBP, mediaType: 'image/jpeg', name: 'photo.jpg' }, channel.stagedImageGeneration())
    channel.submit('what format is [Image #1]?', [{ token: '[Image #1]', stageId: handle.stageId }])
    await settled(() => query.inputs.length === 1)
    const content = (query.inputs[0]!.message as { content: unknown }).content as { type: string; source?: { type: string; media_type: string; data: string } }[]
    const block = Array.isArray(content) ? content.find(item => item.type === 'image') : undefined
    check('the base64 block carries the sniffed media_type (webp bytes are never sent as image/jpeg)', block?.source?.type === 'base64' && block.source.media_type === 'image/webp' && block.source.data === Buffer.from(WEBP).toString('base64'), block?.source?.media_type)
  } finally {
    channel.releaseContributions()
    await session.dispose()
  }
}

// ── replay: lazy facades over the transcript's base64 ──────────────────
{
  const data = Buffer.from(BLUE).toString('base64')
  const at = (n: number): string => `2026-10-02T13:00:0${n}.000Z`
  const replay = replayClaudeTranscript([
    { type: 'user', uuid: 'u1', message: { role: 'user', content: [{ type: 'text', text: 'what color?' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data } }] }, timestamp: at(0) },
    { type: 'assistant', uuid: 'a1', message: { id: 'm1', content: [{ type: 'text', text: 'blue' }] }, timestamp: at(1) },
    { type: 'user', uuid: 'u2', message: { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data } }] }, timestamp: at(2) },
  ], { cwd: '/fixture/project' })
  const users = replay.events.filter(event => event.type === 'user.message')
  check('a replayed prompt carries its image as a facade', users.length === 2 && users[0]?.type === 'user.message' && users[0].images?.length === 1 && users[0].images[0]!.id === 'u1#1')
  check('… an image-only prompt is a row too', users[1]?.type === 'user.message' && users[1].text === '' && users[1].images?.length === 1)
  const facade = users[0]?.type === 'user.message' ? users[0].images![0]! : undefined
  check('the facade knows its type and byte size without decoding', facade?.mediaType === 'image/png' && facade.bytes === BLUE.byteLength)
  check('its size is probed lazily from the data', facade?.width === 5 && facade.height === 5)
  check('its bytes decode on read', facade !== undefined && Buffer.compare(Buffer.from(await facade.read()), Buffer.from(BLUE)) === 0)
  check('non-base64 sources are not shown', transcriptImages([{ type: 'image', source: { type: 'url', url: 'https://example.com/x.png' } }], 'p').length === 0)
}

// ── a session without the capability keeps the attachments service ────
{
  const listeners = new Set<() => void>()
  const plain = {
    ref: { backendId: 'other', sessionId: 'plain-1' },
    cwd: '/fixture/project',
    status: 'idle' as const,
    capabilities: { native: {} },
    history: () => Promise.resolve([]),
    subscribe: () => { const off = (): void => undefined; listeners.add(off); return off },
    submit: () => Promise.resolve({ accepted: true }),

    cancel: () => Promise.resolve({ stillQueued: [] }),
    dispose: () => Promise.resolve(),
  }
  const channel = createChannel(ctx, plain as never, { model: 'm', provider: '', cwd: '/fixture/project', activity: false })
  try {
    let message: string | undefined
    try { await channel.stageComposerImage({ data: RED, mediaType: 'image/png' }, channel.stagedImageGeneration()) } catch (error) { message = error instanceof Error ? error.message : String(error) }
    check('without the capability, staging still needs the attachments service (unchanged)', message === 'image attachments are unavailable in this profile' && channel.stagedImageLimits() === undefined, message)
  } finally {
    channel.releaseContributions()
  }
}

// ── a submit whose image read straddles a credential reconnect ──────────
// The read of the staged bytes is async: an authentication failure can
// stop the old CLI (closing its inbox) and be renewing while the read is
// still pending. The input is legitimate: it must wait for the
// replacement CLI, never be mistaken for a closed session.
{
  const fake = fakeClaudeSdk()
  let releaseRenew: (() => void) | undefined
  const plan = { source: 'dsh-auth' as const, expiresAt: 1, env: { PATH: '/usr/bin', CLAUDE_CODE_OAUTH_TOKEN: 'tok' }, settings: { env: { ANTHROPIC_BASE_URL: 'https://api.anthropic.com' } } }
  const session = await openClaudeSession(claudeDeps(fake.sdk, {
    auth: { plan, renew: () => new Promise(resolve => { releaseRenew = () => resolve(plan) }) },
  }))
  session.subscribe(() => undefined)
  await tick()
  let releaseImage: (() => void) | undefined
  const imageGate = new Promise<void>(resolve => { releaseImage = () => resolve() })
  const facade = { id: 'gate-1', width: 4, height: 3, mediaType: 'image/png', bytes: RED.byteLength, read: () => imageGate.then(() => RED) }
  const submitting = session.submit({ text: 'look', images: [facade as never], clientMessageId: 'u-img' }, 'turn').then(() => 'accepted', (error: unknown) => `refused: ${error instanceof Error ? error.message : String(error)}`)
  await tick()
  // While the read is pending, the credential is refused: the reconnect
  // stops the old CLI (its inbox closes) and waits on the renewal.
  fake.queries[0]!.emit({ type: 'result', subtype: 'success', is_error: true, result: 'Not logged in · Please run /login' })
  for (let i = 0; i < 4; i += 1) await tick()
  check('the read is pending and the reconnect stopped the old CLI (renewing)', !fake.queries[1] && fake.queries[0]!.closed && releaseRenew !== undefined)
  // The read completes mid-reconnect, then the renewal and handshake do.
  releaseImage!()
  await tick()
  releaseRenew!()
  const outcome = await within(submitting)
  check('a read straddling the renew is accepted once the replacement is live', outcome === 'accepted', outcome)
  const replacement = fake.queries[1]
  const delivered = replacement?.inputs.find(input => input.uuid === 'u-img')
  const content = delivered === undefined ? undefined : (delivered.message as { content?: unknown[] }).content
  check('the replacement CLI received the input exactly once, images and all', replacement !== undefined && replacement.inputs.length === 1 && Array.isArray(content) && content.some(block => (block as { type?: string; source?: { media_type?: string; data?: string } }).type === 'image' && (block as { source: { media_type: string; data: string } }).source?.data === Buffer.from(RED).toString('base64')), content)
  check('the closed old inbox never saw it', !fake.queries[0]!.inputs.some(input => input.uuid === 'u-img'))
  await session.dispose()
}
// The reconnect may also complete while the read is still pending: the
// input then goes to the already-live replacement, exactly once.
{
  const fake = fakeClaudeSdk()
  const plan = { source: 'dsh-auth' as const, expiresAt: 1, env: { PATH: '/usr/bin', CLAUDE_CODE_OAUTH_TOKEN: 'tok' }, settings: { env: { ANTHROPIC_BASE_URL: 'https://api.anthropic.com' } } }
  const session = await openClaudeSession(claudeDeps(fake.sdk, { auth: { plan, renew: () => Promise.resolve(plan) } }))
  session.subscribe(() => undefined)
  await tick()
  let releaseImage: (() => void) | undefined
  const imageGate = new Promise<void>(resolve => { releaseImage = () => resolve() })
  const facade = { id: 'gate-2', width: 4, height: 3, mediaType: 'image/png', bytes: RED.byteLength, read: () => imageGate.then(() => RED) }
  const submitting = session.submit({ text: 'late', images: [facade as never], clientMessageId: 'u-late' }, 'turn').then(() => 'accepted', (error: unknown) => `refused: ${error instanceof Error ? error.message : String(error)}`)
  await tick()
  fake.queries[0]!.emit({ type: 'result', subtype: 'success', is_error: true, result: 'Not logged in · Please run /login' })
  for (let i = 0; i < 6; i += 1) await tick()
  check('the reconnect completed while the read was pending', fake.queries.length === 2)
  releaseImage!()
  const outcome = await within(submitting)
  check('a read outlasting the reconnect goes to the live replacement', outcome === 'accepted' && fake.queries[1]!.inputs.some(input => input.uuid === 'u-late') && !fake.queries[0]!.inputs.some(input => input.uuid === 'u-late'), outcome)
  await session.dispose()
}
// A reconnect whose replacement cannot start, and a dispose during the
// read, still refuse the input (a temporarily closed inbox is not those).
{
  const fake = fakeClaudeSdk(index => {
    if (index > 0) throw new Error('spawn failed')
    return { capabilities: ['msg_lifecycle_v1'] }
  })
  const plan = { source: 'dsh-auth' as const, expiresAt: 1, env: { PATH: '/usr/bin', CLAUDE_CODE_OAUTH_TOKEN: 'tok' }, settings: { env: { ANTHROPIC_BASE_URL: 'https://api.anthropic.com' } } }
  const session = await openClaudeSession(claudeDeps(fake.sdk, { auth: { plan, renew: () => Promise.resolve(plan) } }))
  session.subscribe(() => undefined)
  await tick()
  let releaseImage: (() => void) | undefined
  const imageGate = new Promise<void>(resolve => { releaseImage = () => resolve() })
  const facade = { id: 'gate-3', width: 4, height: 3, mediaType: 'image/png', bytes: RED.byteLength, read: () => imageGate.then(() => RED) }
  const submitting = session.submit({ text: 'doomed', images: [facade as never], clientMessageId: 'u-doomed' }, 'turn').then(() => 'accepted', (error: unknown) => `refused: ${error instanceof Error ? error.message : String(error)}`)
  await tick()
  fake.queries[0]!.emit({ type: 'result', subtype: 'success', is_error: true, result: 'Not logged in · Please run /login' })
  for (let i = 0; i < 8; i += 1) await tick()
  releaseImage!()
  const outcome = await within(submitting)
  check('a failed reconnect still refuses the pending input', outcome !== 'accepted' && outcome !== 'timed out' && String(outcome).includes('closed'), outcome)
  check('… and nothing was delivered anywhere', ![fake.queries[0], fake.queries[1]].some(query => query !== undefined && query.inputs.some(input => input.uuid === 'u-doomed')))
  await session.dispose().catch(() => undefined)
}
{
  const fake = fakeClaudeSdk()
  const session = await openClaudeSession(claudeDeps(fake.sdk))
  session.subscribe(() => undefined)
  await tick()
  let releaseImage: (() => void) | undefined
  const imageGate = new Promise<void>(resolve => { releaseImage = () => resolve() })
  const facade = { id: 'gate-4', width: 4, height: 3, mediaType: 'image/png', bytes: RED.byteLength, read: () => imageGate.then(() => RED) }
  const submitting = session.submit({ text: 'gone', images: [facade as never], clientMessageId: 'u-gone' }, 'turn').then(() => 'accepted', (error: unknown) => `refused: ${error instanceof Error ? error.message : String(error)}`)
  await tick()
  await session.dispose()
  releaseImage!()
  const outcome = await within(submitting)
  check('a dispose during the read refuses the input', outcome !== 'accepted' && outcome !== 'timed out' && String(outcome).includes('closed'), outcome)
}
// A deferred /login reconnect leaves the old CLI serving submits: the
// read's completion must not wait behind the running turn (self-deadlock).
{
  const fake = fakeClaudeSdk()
  const plan = { source: 'dsh-auth' as const, expiresAt: 1, env: { PATH: '/usr/bin', CLAUDE_CODE_OAUTH_TOKEN: 'tok' }, settings: { env: { ANTHROPIC_BASE_URL: 'https://api.anthropic.com' } } }
  const session = await openClaudeSession(claudeDeps(fake.sdk, { auth: { plan, renew: () => Promise.resolve(plan) } }))
  session.subscribe(() => undefined)
  await tick()
  await session.submit({ text: 'running turn', clientMessageId: 'u-1' }, 'followup')
  fake.queries[0]!.emit({ type: 'command_lifecycle', command_uuid: 'u-1', state: 'started' })
  await tick()
  const login = session.capabilities.auth!.reconnect().catch(() => undefined)
  for (let i = 0; i < 4; i += 1) await tick()
  check('the /login reconnect is deferred behind the running turn', fake.queries.length === 1 && !fake.queries[0]!.closed)
  let releaseImage: (() => void) | undefined
  const imageGate = new Promise<void>(resolve => { releaseImage = () => resolve() })
  const facade = { id: 'gate-5', width: 4, height: 3, mediaType: 'image/png', bytes: RED.byteLength, read: () => imageGate.then(() => RED) }
  const submitting = session.submit({ text: 'meanwhile', images: [facade as never], clientMessageId: 'u-2' }, 'followup').then(() => 'accepted', (error: unknown) => `refused: ${error instanceof Error ? error.message : String(error)}`)
  await tick()
  releaseImage!()
  const outcome = await within(submitting)
  check('a read under a DEFERRED reconnect goes to the serving CLI at once', outcome === 'accepted' && fake.queries[0]!.inputs.some(input => input.uuid === 'u-2'), outcome)
  fake.queries[0]!.emit({ type: 'result', subtype: 'success', is_error: false, result: 'done' })
  await tick()
  // The old CLI starts the queued input too; only then is the session idle
  // enough for the deferred swap (nothing is left to re-push).
  fake.queries[0]!.emit({ type: 'command_lifecycle', command_uuid: 'u-2', state: 'started' })
  fake.queries[0]!.emit({ type: 'result', subtype: 'success', is_error: false, result: 'done too' })
  await login
  await tick()
  check('… and the deferred reconnect swaps once the queue drained (nothing to re-push)', fake.queries.length === 2 && fake.queries[1]!.inputs.length === 0, fake.queries[1]?.inputs.map(input => input.uuid))
  await session.dispose()
}

console.log(`\nverify-claude-images OK (${passed} checks)`)
process.exit(0)
