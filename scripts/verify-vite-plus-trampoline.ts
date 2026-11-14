/** Copied Windows Vite+ trampolines and versioned sidecars, on real files.
 * Tests filename dispatch with win32 selection on every platform; no exe runs.
 * Run: node --import tsx/esm scripts/verify-vite-plus-trampoline.ts --compiled
 */
import './lib/fake-home.mjs'
import assert from 'node:assert/strict'
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const { findHostDsh } = await import(process.argv.includes('--compiled')
  ? '../lib/types/dsh-adapter/host-dsh.js'
  : '../src/dsh-adapter/host-dsh.js') as typeof import('../src/dsh-adapter/host-dsh.js')
let passed = 0
const root = realpathSync(mkdtempSync(join(tmpdir(), 'verify-vp-trampoline-')))
const check = (label: string, ok: boolean, detail?: unknown): void => {
  assert.ok(ok, `${label}: ${JSON.stringify(detail)}`)
  passed += 1
  console.log(`PASS ${label}`)
}
for (const layout of ['single-root', 'split'] as const) {
  const data = join(root, layout, 'data')
  const bin = layout === 'single-root' ? join(data, 'bin') : join(root, layout, 'custom-tools')
  const cache = join(data, 'cache')
  const payload = join(data, 'current', 'bin')
  for (const dir of [bin, cache, payload, join(data, 'bins')]) mkdirSync(dir, { recursive: true })
  const trampoline = join(payload, 'vp-shim.exe')
  const exe = join(bin, 'dsh.exe')
  // Different files and different bytes from vp.exe, just as the native copy.
  writeFileSync(trampoline, Buffer.from('MZ\0owned opaque trampoline fixture'))
  writeFileSync(join(payload, 'vp.exe'), Buffer.from('MZ\0different dispatcher fixture'))
  copyFileSync(trampoline, exe)
  const id = '987e6543-e21b-42d3-a456-426614174000'
  const packageDir = join(data, 'packages', '@deepseek-ai', 'dsh', id, 'node_modules', '@deepseek-ai', 'dsh')
  mkdirSync(join(packageDir, 'lib'), { recursive: true })
  writeFileSync(join(packageDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.2-rc.2', bin: { dsh: 'lib/bin.js' } }))
  writeFileSync(join(packageDir, 'lib', 'bin.js'), '#!/usr/bin/env node\n')
  writeFileSync(join(data, 'bins', 'dsh.json'), JSON.stringify({ name: 'dsh', package: '@deepseek-ai/dsh', version: '0.2.2-rc.2', source: 'vp' }))
  writeFileSync(join(data, 'packages', '@deepseek-ai', 'dsh.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.2-rc.2', installId: id, bins: ['dsh'] }))
  const pointer = `vite-plus-shim-v1\nlayout=${layout}\ndata=${data}\ncache=${cache}\nbin=${bin}\n`
  const sidecar = join(bin, 'dsh.shim')
  const found = (): ReturnType<typeof findHostDsh> => findHostDsh({ PATH: bin }, 'win32')
  writeFileSync(sidecar, pointer)
  const good = found()
  check(`${layout}: copied trampoline follows its active data root`, 'packageDir' in good && good.packageDir === realpathSync(packageDir) && good.via === 'vite-plus', good)
  writeFileSync(sidecar, '\uFEFF' + pointer.replaceAll('\n', '\r\n'))
  check(`${layout}: UTF-8 BOM and CRLF sidecar is accepted`, 'packageDir' in found(), found())
  for (const [label, content] of [
    ['unknown header', pointer.replace('vite-plus-shim-v1', 'other-shim-v1')],
    ['unknown layout', pointer.replace(`layout=${layout}`, 'layout=other')],
    ['relative data root', pointer.replace(`data=${data}`, 'data=../data')],
    ['wrong bin owner', pointer.replace(`bin=${bin}`, `bin=${cache}`)],
    ['missing field', pointer.replace(`cache=${cache}\n`, '')],
    ['duplicate field', pointer + `data=${data}\n`],
    ['oversized record', pointer + ' '.repeat(65537)],
  ]) {
    writeFileSync(sidecar, content)
    check(`${layout}: ${label} is refused`, 'reason' in found(), found())
  }
  writeFileSync(sidecar, pointer)
  writeFileSync(exe, Buffer.from('MZ\0unrelated executable'))
  check(`${layout}: matching sidecar cannot prove different program bytes`, 'reason' in found(), found())
  copyFileSync(trampoline, exe)
  writeFileSync(join(payload, 'vp-shim.exe'), Buffer.from('MZ\0changed installed trampoline'))
  check(`${layout}: stale copied trampoline is refused`, 'reason' in found(), found())
}
console.log(`verify-vite-plus-trampoline: ${passed} checks passed`)
