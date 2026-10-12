/** C3 images with real lazy facades and a tiny fixture, no Codex/network.
 * Run: node --import tsx/esm scripts/verify-codex-images.ts */
import './lib/default-lang-zh.mjs'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ImageRef } from '../src/agent/events.js'
import { CODEX_IMAGE_LIMITS, codexImageInputs, dataUrlImageFacade, itemImages, pathImageFacade, transcriptImages } from '../src/backends/codex/session/images.js'

let passed = 0
const check = (label: string, ok: boolean) => { assert.ok(ok, label); passed += 1; console.log('PASS ' + label) }
const fails = async (operation: () => Promise<unknown>): Promise<boolean> => { try { await operation(); return false } catch { return true } }
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5xkAAAAASUVORK5CYII=', 'base64')
const url = 'data:image/png;base64,' + png.toString('base64')
const image = dataUrlImageFacade('image', url)!
check('limits expose the design byte/count/dimension budget', CODEX_IMAGE_LIMITS.maxImagesPerMessage === 20 && CODEX_IMAGE_LIMITS.maxImageBytes === 20 * 1024 * 1024 && CODEX_IMAGE_LIMITS.maxMessageImageBytes === 50 * 1024 * 1024 && CODEX_IMAGE_LIMITS.maxImageDimension === 2048)
check('data URL facade has stable identity and measured dimensions', image.id === 'image' && image.width === 1 && image.height === 1 && image.bytes === png.length)
check('data URL bytes decode only when read and preserve payload', Buffer.from(await image.read()).equals(png))
const inputs = await codexImageInputs([image])
check('send uses durable data URL rather than a staged local path', inputs.length === 1 && inputs[0]?.type === 'image' && 'url' in inputs[0] && inputs[0].url === url)
check('remote/file URLs never trigger a fetch', dataUrlImageFacade('remote', 'https://images.invalid/a.png') === undefined && dataUrlImageFacade('file', 'file:///TMP/a.png') === undefined)
check('invalid base64 and unsupported SVG are refused as facades', dataUrlImageFacade('bad', 'data:image/png;base64,%%%') === undefined && dataUrlImageFacade('svg', 'data:image/svg+xml;base64,AAAA') === undefined)
check('message count recheck rejects excess images', await fails(() => codexImageInputs([image, image], { ...CODEX_IMAGE_LIMITS, maxImagesPerMessage: 1 })))
check('message byte recheck rejects excess total', await fails(() => codexImageInputs([image, image], { ...CODEX_IMAGE_LIMITS, maxMessageImageBytes: png.length })))
check('per-image byte recheck uses actual read bytes', await fails(() => codexImageInputs([{ ...image, bytes: 1 }], { ...CODEX_IMAGE_LIMITS, maxImageBytes: png.length - 1 })))
check('unsupported facade format is explicit, never silently dropped', await fails(() => codexImageInputs([{ ...image, mediaType: 'image/svg+xml' }])))
check('unreadable facade is explicit, never silently dropped', await fails(() => codexImageInputs([{ ...image, read: async () => { throw new Error('fixture failed') } }])))
const oversized = Buffer.from(png)
oversized.writeUInt32BE(3000, 16)
const large = dataUrlImageFacade('large', 'data:image/png;base64,' + oversized.toString('base64'))!
check('pixel/dimension recheck probes bytes, not forged facade metadata', await fails(() => codexImageInputs([{ ...large, width: 1, height: 1 }])))
const controller = new AbortController()
controller.abort()
check('lazy embedded facade honors cancelled reads', await fails(() => image.read(controller.signal)))
const replayed = transcriptImages([{ type: 'text', text: 'question' }, { type: 'image', url }, { type: 'localImage', path: 'missing.png' }], 'user-item', tmpdir())
check('durable image order and item ids survive replay', replayed.length === 2 && replayed[0]?.id === 'user-item#1' && replayed[1]?.id === 'user-item#2')
check('missing path keeps a placeholder facade', replayed[1]?.width === 1 && replayed[1]?.height === 1 && await fails(() => replayed[1]!.read()))
const dir = mkdtempSync(join(tmpdir(), 'codex-images-'))
try {
  const path = join(dir, 'fixture.png')
  writeFileSync(path, png)
  const local = pathImageFacade('path', 'fixture.png', dir)
  check('path facade resolves cwd and measures just the image header', local.path === path && local.width === 1 && local.height === 1 && local.bytes === png.length)
  check('path facade read returns the actual local image bytes', Buffer.from(await local.read()).equals(png))
  check('imageView exposes a lazy tool-result image', itemImages({ type: 'imageView', path: 'fixture.png' }, 'view', dir)[0]?.path === path)
  const generated = itemImages({ type: 'imageGeneration', status: 'completed', savedPath: 'fixture.png', result: 'not-base64' }, 'generated', dir)
  check('generated savedPath wins before result decoding', generated.length === 1 && generated[0]?.path === path)
  check('generated base64 fallback becomes a PNG facade', itemImages({ type: 'imageGeneration', status: 'completed', result: png.toString('base64') }, 'generated-inline', dir)[0]?.mediaType === 'image/png')
  check('failed/in-progress generated items do not invent an image', itemImages({ type: 'imageGeneration', status: 'failed', result: url }, 'failed', dir).length === 0 && itemImages({ type: 'imageGeneration', status: 'inProgress', result: url }, 'working', dir).length === 0)
} finally { rmSync(dir, { recursive: true, force: true }) }
console.log('\nverify-codex-images OK (' + passed + ' checks)')
