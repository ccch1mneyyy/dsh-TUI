/** Run after pnpm compile:src: node --import tsx/esm scripts/verify-welcome-image-r1u.tsx */
import assert from 'node:assert/strict'
import { PassThrough, Writable } from 'node:stream'
import React from 'react'
import { AlternateScreen, render } from '../lib/types/ui.js'
import { ThemeProvider } from '../lib/types/components/design-system/ThemeProvider.js'
import { LogoV2 } from '../lib/types/components/LogoV2.js'
import { loadR1UWelcomeImages } from '../lib/types/components/welcomeImage.js'
import { kittyGraphics } from '../lib/types/ink/terminal-querier.js'
import { settled } from './lib/term-test.mjs'

class FakeStdout extends Writable {
  columns = 110
  rows = 35
  isTTY = true
  output = ''
  override _write(chunk: unknown, _encoding: BufferEncoding, callback: () => void): void {
    this.output += String(chunk)
    callback()
  }
}
class FakeStderr extends Writable {
  isTTY = true
  override _write(_chunk: unknown, _encoding: BufferEncoding, callback: () => void): void { callback() }
}
class FakeStdin extends PassThrough {
  isTTY = true
  isRaw = false
  setRawMode(enabled: boolean): this { this.isRaw = enabled; return this }
  override ref(): this { return this }
  override unref(): this { return this }
}

const images = await loadR1UWelcomeImages()
assert.deepEqual([images.whale.width, images.whale.height], [504, 312])
assert.deepEqual([images.wordmark.width, images.wordmark.height], [960, 480])
const stdout = new FakeStdout()
const stdin = new FakeStdin()
const instance = await render(
  <AlternateScreen><ThemeProvider>
    <LogoV2 model="deepseek-v4-flash" cwd="D:/work" skipIntro welcomeArt="glitch" whaleIdle={false} drift={null} />
  </ThemeProvider></AlternateScreen>,
  { stdout, stdin, stderr: new FakeStderr(), exitOnCtrlC: false, patchConsole: false },
)
try {
  assert.ok(await settled(() => stdout.output.includes(kittyGraphics(31).request)),
    'welcome must request terminal graphics capability')
  stdin.write('\x1b_Gi=31;OK\x1b\\\x1b[6;16;8t\x1b[4;560;880t\x1b[?61;4c\x1b[?61;4c\x1b[?61;4c')
  assert.ok(await settled(() => [...stdout.output.matchAll(/\x1b_Ga=p,/gu)].length >= 2),
    'R1U whale and wordmark must both reach Kitty image placement')
  assert.equal([...stdout.output.matchAll(/\x1b_Ga=p,/gu)].length, 2)
  assert.ok(stdout.output.includes('deepseek-v4-flash'), 'model line remains visible')
} finally {
  stdout.isTTY = false
  instance.unmount()
}
console.log('PASS: R1U welcome PNGs load and place through terminal graphics')
