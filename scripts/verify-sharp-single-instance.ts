/**
 * Regression guard for the single-libvips rule (issue #17).
 *
 * Two `sharp` copies in one process map two libvips dylibs; the macOS
 * Objective-C runtime then reports duplicate classes straight to fd 2, which
 * lands on the alternate screen and garbles the frame. The loader must reuse
 * an already-loaded copy instead of importing its own.
 *
 * Run: node --import tsx/esm scripts/verify-sharp-single-instance.ts
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import {
  loadSharp,
  nativeImageLibraryLoaded,
  sharpFromModuleCache,
} from '../src/dsh-adapter/sharp.js'

const entry = createRequire(import.meta.url).resolve('sharp')
const existing = await import(pathToFileURL(entry).href) as { default?: unknown }
const expected = existing.default ?? existing

const cached = sharpFromModuleCache()
assert.equal(cached, expected, 'module cache reuse must return the loaded copy')
assert.equal(await loadSharp(), expected, 'loadSharp must not import a second copy')

const report = process.report?.getReport?.() as { sharedObjects?: string[] } | undefined
const vips = (report?.sharedObjects ?? []).filter(path => /libvips-cpp[.-]/.test(path))
assert.equal(nativeImageLibraryLoaded(), true, 'libvips should be reported as mapped')
assert.equal(vips.length, 1, `expected one libvips image, found ${vips.length}`)

console.log('PASS sharp single instance')
