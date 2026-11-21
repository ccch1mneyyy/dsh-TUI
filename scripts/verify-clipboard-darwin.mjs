/** Exact JXA algorithm on every host; real AppKit + readClipboard on macOS.
 * Native cases replace only generalPasteboard with a private named pasteboard,
 * never read/write the user's clipboard. Run after normal pnpm compile. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { DARWIN_CLIPBOARD_SCRIPT, readClipboard, removeClipboardImageDir } from '../lib/types/utils/clipboard.js'

assert.equal(typeof DARWIN_CLIPBOARD_SCRIPT, 'string', 'single-pass JXA helper must exist')
let checks = 0
function check(name, actual, expected) {
  assert.deepEqual(actual, expected, name)
  checks++
  console.log(`PASS: ${name}`)
}

// This bridge only checks control flow; native binding behavior is checked
// separately below and is explicitly skipped outside macOS.
function probe({ file, images = {}, failWrites = [], paths = ['a.png', 'a.tiff'] } = {}) {
  const nil = { isNil: () => true }
  const wrap = value => value === undefined ? nil : { isNil: () => false, value }
  const reads = [], writes = []
  const context = {
    ObjC: { import() {}, unwrap: obj => obj.value },
    $: {
      NSPasteboard: { generalPasteboard: {
        stringForType: () => wrap(file),
        dataForType(type) {
          reads.push(type)
          return images[type] === undefined ? nil : {
            isNil: () => false, length: images[type].length,
            writeToFileAtomically(path, atomic) {
              writes.push({ type, path, atomic })
              return !failWrites.includes(type)
            },
          }
        },
      } },
      NSURL: { URLWithString: value => {
        const url = new URL(value.value)
        return { isNil: () => false, isFileURL: url.protocol === 'file:',
          host: wrap(url.hostname), path: wrap(decodeURIComponent(url.pathname)) }
      } },
    },
  }
  runInNewContext(DARWIN_CLIPBOARD_SCRIPT, context)
  return { content: JSON.parse(context.run(paths)), reads, writes }
}
const png = { 'public.png': Buffer.from('png'), 'public.tiff': Buffer.from('tiff') }
const file = probe({ file: 'file:///tmp/%E5%9B%BE%20%22%5C.png', images: png })
check('file wins without materializing bitmap representations', file, {
  content: { kind: 'files', paths: ['/tmp/图 "\\.png'] }, reads: [], writes: [],
})
check('PNG wins over TIFF, using only one in-place write', probe({ images: png }), {
  content: { kind: 'image', format: 'png' }, reads: ['public.png'],
  writes: [{ type: 'public.png', path: 'a.png', atomic: false }],
})
check('TIFF-only bitmap remains supported', probe({ images: { 'public.tiff': Buffer.from('tiff') } }).content,
  { kind: 'image', format: 'tiff' })
check('empty PNG falls back to TIFF', probe({ images: { ...png, 'public.png': Buffer.alloc(0) } }).content,
  { kind: 'image', format: 'tiff' })
check('failed PNG write falls back to TIFF', probe({ images: png, failWrites: ['public.png'] }).content,
  { kind: 'image', format: 'tiff' })
check('remote file URL does not become a local path', probe({ file: 'file://server/share', images: png }).content,
  { kind: 'image', format: 'png' })
check('no bitmap returns the text-fallback marker', probe().content, null)
check('unavailable image paths skip data reads', probe({ images: png, paths: [] }),
  { content: null, reads: [], writes: [] })
check('unavailable image paths still allow Finder files',
  probe({ file: 'file://localhost/tmp/file.png', paths: [] }).content,
  { kind: 'files', paths: ['/tmp/file.png'] })

if (process.platform !== 'darwin') {
  console.log(`SKIP: native NSPasteboard/JXA bindings and macOS orchestration (${process.platform})`)
} else {
  const root = mkdtempSync(join(tmpdir(), 'verify-darwin-paste-'))
  const board = `dsh-tui-verify-${process.pid}-${Date.now()}`
  const marker = join(root, 'calls.jsonl')
  const savedPath = process.env.PATH
  const namedBoard = `$.NSPasteboard.pasteboardWithName(${JSON.stringify(board)})`
  const runJxa = script => execFileSync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script],
    { encoding: 'utf8', timeout: 3000 })
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
  // Valid uncompressed 1x1 grayscale TIFF, kept distinct from the PNG bytes.
  const tiffBytes = Buffer.alloc(123)
  tiffBytes.write('II')
  tiffBytes.writeUInt16LE(42, 2)
  tiffBytes.writeUInt32LE(8, 4)
  const tags = [[256, 3, 1], [257, 3, 1], [258, 3, 8], [259, 3, 1], [262, 3, 1],
    [273, 4, 122], [277, 3, 1], [278, 4, 1], [279, 4, 1]]
  tiffBytes.writeUInt16LE(tags.length, 8)
  tags.forEach(([tag, type, value], i) => {
    const offset = 10 + i * 12
    tiffBytes.writeUInt16LE(tag, offset)
    tiffBytes.writeUInt16LE(type, offset + 2)
    tiffBytes.writeUInt32LE(1, offset + 4)
    tiffBytes.writeUInt32LE(value, offset + 8)
  })
  tiffBytes[122] = 255
  const seed = ({ file, png = false, tiff = false } = {}) => runJxa(`
    ObjC.import('AppKit');
    var pb = ${namedBoard}; pb.clearContents;
    ${file === undefined ? '' : `pb.setStringForType(${JSON.stringify(file)}, 'public.file-url');`}
    var data = $.NSData.alloc.initWithBase64EncodedStringOptions('${bytes.toString('base64')}', 0);
    ${png ? "pb.setDataForType(data, 'public.png');" : ''}
    ${tiff ? `var tiff = $.NSData.alloc.initWithBase64EncodedStringOptions('${tiffBytes.toString('base64')}', 0); pb.setDataForType(tiff, 'public.tiff');` : ''}
  `)
  // Execute the product's exact argv/script through real osascript. Only the
  // pasteboard identity changes; command count and retained bytes are asserted.
  writeFileSync(join(root, 'osascript'), `#!${process.execPath}
    const fs = require('node:fs');
    const cp = require('node:child_process');
    const args = process.argv.slice(2);
    fs.appendFileSync(${JSON.stringify(marker)}, JSON.stringify(args.slice(0, 3))+'\\n');
    if (args[0] !== '-l' || args[1] !== 'JavaScript' || args[2] !== '-e') process.exit(91);
    if (args[3].split('$.NSPasteboard.generalPasteboard').length !== 2) process.exit(92);
    args[3] = args[3].replace('$.NSPasteboard.generalPasteboard', ${JSON.stringify(namedBoard)});
    process.stdout.write(cp.execFileSync('/usr/bin/osascript', args, {timeout: 2500}));
  `, { mode: 0o755 })
  writeFileSync(join(root, 'pbpaste'), `#!${process.execPath}
    require('node:fs').appendFileSync(${JSON.stringify(marker)}, '"pbpaste"\\n');
    process.stdout.write('剪贴板\\ntext\\n');
  `, { mode: 0o755 })
  process.env.PATH = `${root}:${savedPath ?? ''}`
  const calls = () => existsSync(marker) ? readFileSync(marker, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : []
  const read = async () => {
    writeFileSync(marker, '')
    const result = await readClipboard()
    return { result, calls: calls() }
  }
  try {
    seed({ png: true, tiff: true })
    let actual = await read()
    check('native PNG uses one JXA process and no pbpaste', actual.calls, [['-l', 'JavaScript', '-e']])
    check('native PNG result', actual.result?.kind, 'image')
    const pngPath = actual.result.path
    check('native PNG bytes remain exact', readFileSync(pngPath), bytes)
    check('native exported PNG is 0600', statSync(pngPath).mode & 0o777, 0o600)
    check('native private image directory is 0700', statSync(join(pngPath, '..')).mode & 0o777, 0o700)
    check('native unused TIFF candidate was removed', existsSync(pngPath.replace(/\.png$/, '.tiff')), false)
    rmSync(pngPath)

    seed({ tiff: true })
    actual = await read()
    check('native TIFF uses one JXA process', actual.calls, [['-l', 'JavaScript', '-e']])
    check('native TIFF-only bytes remain exact', readFileSync(actual.result.path), tiffBytes)
    check('native TIFF keeps its extension', actual.result.path.endsWith('.tiff'), true)
    check('native unused PNG candidate was removed', existsSync(actual.result.path.replace(/\.tiff$/, '.png')), false)
    rmSync(actual.result.path)

    seed({ file: 'file:///tmp/%E5%9B%BE%20%22%5C.png', png: true, tiff: true })
    actual = await read()
    check('native Finder file precedes image, preserves decoded path', actual.result,
      { kind: 'files', paths: ['/tmp/图 "\\.png'] })
    check('native Finder file uses one JXA process', actual.calls, [['-l', 'JavaScript', '-e']])
    check('native file branch leaves no reserved image candidates', readdirSync(join(pngPath, '..')), [])

    seed()
    actual = await read()
    check('native no bitmap reaches unchanged pbpaste text fallback', actual.result,
      { kind: 'text', text: '剪贴板\ntext\n' })
    check('native text helper count', actual.calls, [['-l', 'JavaScript', '-e'], 'pbpaste'])
    check('native text branch leaves no image candidates', readdirSync(join(pngPath, '..')), [])

    const helper = join(root, 'osascript')
    const original = readFileSync(helper)
    writeFileSync(helper, `#!${process.execPath}\nprocess.exit(1)\n`)
    actual = await read()
    check('failed native helper still reaches text fallback', actual.result,
      { kind: 'text', text: '剪贴板\ntext\n' })
    check('failed helper leaves no image candidates', readdirSync(join(pngPath, '..')), [])
    writeFileSync(helper, original)

    removeClipboardImageDir()
    const savedTmp = process.env.TMPDIR
    const blockedTmp = join(root, 'not-a-directory')
    writeFileSync(blockedTmp, '')
    seed({ png: true })
    try {
      process.env.TMPDIR = blockedTmp
      actual = await read()
      check('native unavailable temp directory still reaches text', actual.result,
        { kind: 'text', text: '剪贴板\ntext\n' })
    } finally {
      if (savedTmp === undefined) delete process.env.TMPDIR
      else process.env.TMPDIR = savedTmp
    }
    actual = await read()
    check('native image export recovers after unavailable temp directory', actual.result?.kind, 'image')
    check('recovered native PNG bytes remain exact', readFileSync(actual.result.path), bytes)
  } finally {
    process.env.PATH = savedPath
    removeClipboardImageDir()
    runJxa(`ObjC.import('AppKit'); ${namedBoard}.releaseGlobally;`)
    rmSync(root, { recursive: true, force: true })
  }
}
console.log(`clipboard Darwin: ${checks} checks passed`)
