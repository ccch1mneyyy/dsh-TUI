import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { chromium, expect } from '@playwright/test'
import { startPreview } from './server.mjs'

const preview = await startPreview({ port: 0 })
let browser
const output = resolve(process.env.DSH_TUI_PREVIEW_ARTIFACTS ?? '.validation/web-preview')
await mkdir(output, { recursive: true })
try {
  browser = await chromium.launch({
    ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}),
  })
  for (const [name, viewport] of Object.entries({
    desktop: { width: 1440, height: 1000 },
    mobile: { width: 390, height: 844 },
  })) {
    const page = await browser.newPage({ viewport })
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(preview.url)
    await expect(page.locator('#status')).toHaveText('Live', { timeout: 25000 })
    const text = () => page.evaluate(async () => {
      const { terminal } = await import('/app.mjs')
      const buffer = terminal.buffer.active
      return Array.from({ length: terminal.rows }, (_, index) =>
        buffer.getLine(buffer.baseY + index)?.translateToString(true) ?? '').join('\n')
    })
    await page.screenshot({ path: `${output}/${name}-welcome.png` })
    await page.getByRole('button', { name: 'Run demo conversation', exact: true }).click()
    await expect.poll(text, { timeout: 15000 }).toContain('Preview result')
    await expect.poll(text, { timeout: 10000 }).toContain('temporary demo')
    await page.screenshot({ path: `${output}/${name}-conversation.png` })
    await page.getByRole('button', { name: 'Choose terminal theme', exact: true }).click()
    await expect.poll(text).toMatch(/light|dark/)
    await page.screenshot({ path: `${output}/${name}-themes.png` })
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: 'Reset demo session', exact: true }).click()
    await expect(page.locator('#status')).toHaveText('Live', { timeout: 25000 })
    await expect.poll(text).not.toContain('Preview result')
    const layout = await page.evaluate(() => ({
      width: innerWidth,
      scroll: document.documentElement.scrollWidth,
      terminal: document.getElementById('terminal').getBoundingClientRect().toJSON(),
    }))
    assert.ok(layout.scroll <= layout.width, `${name}: page overflows horizontally`)
    assert.ok(layout.terminal.width > 300 && layout.terminal.height > 400, `${name}: terminal is blank/collapsed`)
    assert.deepEqual(errors, [], `${name}: browser errors`)
    await page.close()
    console.log(`PASS ${name}: live renderer, streamed turn, theme menu, reset and layout`)
  }
} finally {
  await browser?.close()
  await preview.close()
}
