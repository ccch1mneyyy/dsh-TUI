/**
 * Verification for the cross-platform clipboard reader (compiled lib):
 *
 * Pure functions (all platforms):
 * - parseUriList() decodes text/uri-list via real URL parsing: CRLF/LF,
 *   comments, percent-escapes (space/CJK), localhost authority accepted,
 *   REMOTE authorities rejected, file:/path single-slash form, query/
 *   fragment stripped, malformed escapes kept raw, GNOME/KDE verb line and
 *   non-file URIs skipped
 * - pickImageMime() prefers image/png; pickTextMime() walks the UTF-8-first
 *   priority list and never picks text/uri-list as generic text
 * - formatClipboardInsert() quotes whitespace paths, joins files, and
 *   normalizes text line endings
 *
 * BMP → PNG (bmpToPng): 24-bit bottom-up, 32-bit top-down, BITFIELDS with
 * a live alpha mask kept as RGBA, a dead alpha byte kept opaque, headerless
 * DIB, and truncated/unsupported bitmaps → null
 *
 * Stubbed-tool integration (Linux only — PATH is pointed at a temp dir of
 * fake wl-paste/xclip binaries):
 * - CJK text survives multi-chunk stdout (byte split inside one character)
 * - text/uri-list and x-special/gnome-copied-files become file paths
 * - image/png is exported to a mode-0700 private dir, mode-0600 file,
 *   bytes intact (binary-safe)
 * - empty selection → null; no tools at all → 'unavailable'
 * - a dead Wayland session falls through to a working xclip — and so does
 *   an UNRECOGNIZED wl-paste failure (permission/protocol phrasing)
 * - a cached tool that vanishes from PATH is evicted and the next
 *   candidate takes over on the very next read
 * - an uncreatable image dir (bad TMPDIR) degrades an image offer to the
 *   text branch, and the failure is not cached (recovery works)
 * - an image/bmp offer (WSLg) is exported as a PNG file
 * - WSL (env marker): an empty/unreachable/BMP-undecodable Linux read falls
 *   through to powershell.exe — image bytes, files via wslpath, text — and
 *   everything unreachable → 'unavailable' with wsl:true; outside WSL
 *   powershell.exe is never spawned
 *
 * Run: node scripts/verify-clipboard.mjs
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { inflateSync } from 'node:zlib'

let failed = 0
function check(name, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed += 1
}

const {
  parseUriList,
  pickImageMime,
  pickTextMime,
  formatClipboardInsert,
  readClipboard,
  _resetLinuxPasteCache,
  _setWslOverride,
} = await import('../lib/types/utils/clipboard.js')
const { bmpToPng } = await import('../lib/types/utils/bmp.js')

// ---- parseUriList -------------------------------------------------------
check(
  'parseUriList decodes CRLF, comments, escapes, localhost authority',
  JSON.stringify(
    parseUriList(
      '# comment\r\nfile:///tmp/a%20b.png\r\nfile://localhost/etc/hostname\nfile:///tmp/%E5%89%AA%E8%B4%B4%E6%9D%BF.png\r\n',
    ),
  ) === JSON.stringify(['/tmp/a b.png', '/etc/hostname', '/tmp/剪贴板.png']),
)
check(
  'parseUriList rejects remote authorities instead of faking local paths',
  JSON.stringify(parseUriList('file://server/share/a.png\r\nfile:///local/ok')) ===
    JSON.stringify(['/local/ok']),
)
check(
  'parseUriList accepts the single-slash file:/path form',
  JSON.stringify(parseUriList('file:/tmp/single-slash')) === JSON.stringify(['/tmp/single-slash']),
)
check(
  'parseUriList strips query and fragment from file names',
  JSON.stringify(parseUriList('file:///tmp/a.png?download=1#frag')) === JSON.stringify(['/tmp/a.png']),
)
check(
  'parseUriList skips non-file URIs',
  JSON.stringify(parseUriList('https://example.com/x\r\nfile:///only/this')) ===
    JSON.stringify(['/only/this']),
)
check(
  'parseUriList skips the gnome-copied-files verb line',
  JSON.stringify(parseUriList('copy\nfile:///a\nfile:///b\n')) === JSON.stringify(['/a', '/b']),
)
check(
  'parseUriList keeps malformed percent-escapes raw',
  JSON.stringify(parseUriList('file:///tmp/100%.png')) === JSON.stringify(['/tmp/100%.png']),
)
check('parseUriList empty input yields no paths', parseUriList('').length === 0)

// ---- pickImageMime ------------------------------------------------------
check(
  'pickImageMime prefers image/png',
  pickImageMime(['text/plain', 'image/bmp', 'image/png']) === 'image/png',
)
check(
  'pickImageMime falls back to the first image offer',
  pickImageMime(['text/plain', 'image/jpeg', 'image/webp']) === 'image/jpeg',
)
check(
  'pickImageMime is case-insensitive on the MIME prefix',
  pickImageMime(['IMAGE/PNG']) === 'IMAGE/PNG',
)
check('pickImageMime returns null without image offers', pickImageMime(['text/plain', 'text/uri-list']) === null)

// ---- pickTextMime -------------------------------------------------------
check(
  'pickTextMime prefers charset=utf-8 over later entries',
  pickTextMime(['STRING', 'text/plain', 'text/plain;charset=utf-8']) === 'text/plain;charset=utf-8',
)
check(
  'pickTextMime accepts X11 atoms (UTF8_STRING / STRING / TEXT)',
  pickTextMime(['TARGETS', 'UTF8_STRING']) === 'UTF8_STRING',
)
check(
  'pickTextMime falls back to any other text/* offer',
  pickTextMime(['application/octet-stream', 'text/html']) === 'text/html',
)
check(
  'pickTextMime never treats text/uri-list as generic text',
  pickTextMime(['text/uri-list']) === null,
)
check('pickTextMime returns null without text offers', pickTextMime(['image/png']) === null)

// ---- formatClipboardInsert ----------------------------------------------
check(
  'formatClipboardInsert turns image files into @ references and joins files',
  formatClipboardInsert({ kind: 'files', paths: ['/tmp/a b.png', '/etc/hostname'] }) ===
    '@"/tmp/a b.png" /etc/hostname',
)
check(
  'formatClipboardInsert turns an exported image into an @ reference',
  formatClipboardInsert({ kind: 'image', path: '/tmp/dsh-tui-paste-1.png' }) === '@/tmp/dsh-tui-paste-1.png',
)
check(
  'formatClipboardInsert normalizes text line endings',
  formatClipboardInsert({ kind: 'text', text: 'a\r\nb\rc' }) === 'a\nb\nc',
)

// ---- bmpToPng -----------------------------------------------------------
/** Build a BMP file. `rows` are top-to-bottom arrays of [r,g,b,a] pixels. */
function makeBmp({ rows, bpp, topDown = false, bitfields = false, alphaMask = false, fileHeader = true, deadAlpha = false }) {
  const width = rows[0].length
  const height = rows.length
  const stride = Math.floor((bpp * width + 31) / 32) * 4
  const headerSize = bitfields && alphaMask ? 108 : 40
  const maskBytes = bitfields && headerSize === 40 ? 12 : 0
  const dib = Buffer.alloc(headerSize + maskBytes)
  dib.writeUInt32LE(headerSize, 0)
  dib.writeInt32LE(width, 4)
  dib.writeInt32LE(topDown ? -height : height, 8)
  dib.writeUInt16LE(1, 12)
  dib.writeUInt16LE(bpp, 14)
  dib.writeUInt32LE(bitfields ? 3 : 0, 16)
  if (bitfields) {
    dib.writeUInt32LE(0x00ff0000, 40)
    dib.writeUInt32LE(0x0000ff00, 44)
    dib.writeUInt32LE(0x000000ff, 48)
    if (alphaMask) dib.writeUInt32LE(0xff000000, 52)
  }
  const pixels = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y += 1) {
    const dst = (topDown ? y : height - 1 - y) * stride
    rows[y].forEach(([r, g, b, a], x) => {
      const p = dst + x * (bpp / 8)
      pixels[p] = b
      pixels[p + 1] = g
      pixels[p + 2] = r
      if (bpp === 32) pixels[p + 3] = deadAlpha ? 0 : a
    })
  }
  const file = Buffer.alloc(14)
  file.write('BM', 0, 'ascii')
  file.writeUInt32LE(14 + dib.length, 10)
  return Buffer.concat([...(fileHeader ? [file] : []), dib, pixels])
}

/** Minimal PNG reader for filter-0 rows: { width, height, channels, rows }. */
function readPng(png) {
  if (!png.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return null
  let width = 0
  let height = 0
  let channels = 0
  const idat = []
  for (let off = 8; off < png.length; ) {
    const len = png.readUInt32BE(off)
    const type = png.toString('ascii', off + 4, off + 8)
    const data = png.subarray(off + 8, off + 8 + len)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      channels = data[9] === 6 ? 4 : 3
    } else if (type === 'IDAT') idat.push(data)
    off += 12 + len
  }
  const raw = inflateSync(Buffer.concat(idat))
  const rows = []
  for (let y = 0; y < height; y += 1) {
    const start = y * (width * channels + 1)
    if (raw[start] !== 0) return null
    const row = []
    for (let x = 0; x < width; x += 1) {
      row.push([...raw.subarray(start + 1 + x * channels, start + 1 + (x + 1) * channels)])
    }
    rows.push(row)
  }
  return { width, height, channels, rows }
}

const R = [255, 0, 0, 255]
const G = [0, 255, 0, 255]
const B = [0, 0, 255, 255]
const W = [255, 255, 255, 255]
const sample = [[R, G, B], [W, [10, 20, 30, 255], [200, 100, 50, 255]]]
const rgb = rows => rows.map(row => row.map(([r, g, b]) => [r, g, b]))
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

{
  const cases = [
    ['24-bit bottom-up (odd width exercises row padding)', { rows: sample, bpp: 24 }],
    ['24-bit top-down', { rows: sample, bpp: 24, topDown: true }],
    ['32-bit BI_RGB', { rows: sample, bpp: 32 }],
    ['32-bit BITFIELDS', { rows: sample, bpp: 32, bitfields: true }],
    ['headerless DIB', { rows: sample, bpp: 24, fileHeader: false }],
  ]
  for (const [name, spec] of cases) {
    const png = await bmpToPng(makeBmp(spec))
    const decoded = png === null ? null : readPng(png)
    check(
      `bmpToPng: ${name}`,
      decoded !== null && decoded.channels === 3 && decoded.width === 3 && decoded.height === 2 &&
        same(decoded.rows, rgb(sample)),
      decoded === null ? 'null' : JSON.stringify(decoded.rows),
    )
  }

  const alphaRows = [[[255, 0, 0, 128], [0, 255, 0, 255]], [[0, 0, 255, 0], [9, 9, 9, 255]]]
  const alphaPng = await bmpToPng(makeBmp({ rows: alphaRows, bpp: 32, bitfields: true, alphaMask: true }))
  const alphaDecoded = alphaPng === null ? null : readPng(alphaPng)
  check(
    'bmpToPng: live V4 alpha mask is kept as RGBA',
    alphaDecoded !== null && alphaDecoded.channels === 4 && same(alphaDecoded.rows, alphaRows),
    alphaDecoded === null ? 'null' : JSON.stringify(alphaDecoded.rows),
  )

  const deadPng = await bmpToPng(makeBmp({ rows: sample, bpp: 32, bitfields: true, alphaMask: true, deadAlpha: true }))
  const deadDecoded = deadPng === null ? null : readPng(deadPng)
  check(
    'bmpToPng: an all-zero alpha channel stays opaque (RGB)',
    deadDecoded !== null && deadDecoded.channels === 3 && same(deadDecoded.rows, rgb(sample)),
  )

  const good = makeBmp({ rows: sample, bpp: 24 })
  check('bmpToPng: truncated pixel data → null', (await bmpToPng(good.subarray(0, good.length - 4))) === null)
  check('bmpToPng: garbage → null', (await bmpToPng(Buffer.from('BMgarbage'))) === null)
  const compressed = Buffer.from(good)
  compressed.writeUInt32LE(1, 14 + 16) // BI_RLE8
  check('bmpToPng: unsupported compression → null', (await bmpToPng(compressed)) === null)
  const paletted = Buffer.from(good)
  paletted.writeUInt16LE(8, 14 + 14)
  check('bmpToPng: 8-bit palette bitmap → null', (await bmpToPng(paletted)) === null)
  const huge = Buffer.from(good)
  huge.writeInt32LE(1_000_000, 14 + 4)
  huge.writeInt32LE(1_000_000, 14 + 8)
  check('bmpToPng: absurd dimensions → null without allocating', (await bmpToPng(huge)) === null)
}

// ---- Stubbed-tool integration (Linux only) ------------------------------
// Fake wl-paste/xclip binaries driven by per-tool env vars. Each scenario
// resets the module's cached tool and sets PATH to the stub dir.
if (process.platform === 'linux') {
  const stubDir = mkdtempSync(join(tmpdir(), 'verify-clipboard-stubs-'))
  const emptyDir = mkdtempSync(join(tmpdir(), 'verify-clipboard-empty-'))
  const savedEnv = {
    PATH: process.env.PATH,
    WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY,
    DISPLAY: process.env.DISPLAY,
    TMPDIR: process.env.TMPDIR,
    STUB_WL: process.env.STUB_WL,
    STUB_XCLIP: process.env.STUB_XCLIP,
    STUB_PS: process.env.STUB_PS,
    STUB_PS_MARK: process.env.STUB_PS_MARK,
    STUB_BMP_FILE: process.env.STUB_BMP_FILE,
    WSL_DISTRO_NAME: process.env.WSL_DISTRO_NAME,
    WSL_INTEROP: process.env.WSL_INTEROP,
  }
  // Each scenario pins WSL detection explicitly (the host itself may be WSL,
  // where /proc/sys/kernel/osrelease would otherwise leak in).
  delete process.env.WSL_DISTRO_NAME
  delete process.env.WSL_INTEROP
  const restoreEnv = () => {
    _setWslOverride(undefined)
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
  const scenario = (name, { wl, xclip, wayland = true, display = false, bare = false, ps, wsl = false }) => {
    _resetLinuxPasteCache()
    if (ps === undefined) delete process.env.STUB_PS
    else process.env.STUB_PS = ps
    _setWslOverride(wsl)
    if (wl === undefined) delete process.env.STUB_WL
    else process.env.STUB_WL = wl
    if (xclip === undefined) delete process.env.STUB_XCLIP
    else process.env.STUB_XCLIP = xclip
    if (wayland) process.env.WAYLAND_DISPLAY = 'wayland-verify'
    else delete process.env.WAYLAND_DISPLAY
    if (display) process.env.DISPLAY = ':verify'
    else delete process.env.DISPLAY
    process.env.PATH = bare ? emptyDir : stubDir
    return name
  }

  writeFileSync(
    join(stubDir, 'wl-paste'),
    `#!/bin/sh
if [ "$1" = "--version" ]; then echo "wl-paste stub 1.0"; exit 0; fi
case "$STUB_WL" in
  text)
    if [ "$1" = "--list-types" ]; then printf 'text/plain;charset=utf-8\\ntext/plain\\n'; exit 0; fi
    # 剪贴板 (E5 89 AA E8 B4 B4 E6 9D BF) split mid-character across writes.
    printf '\\345'; sleep 0.1; printf '\\211\\252\\350\\264\\264\\346\\235\\277'
    exit 0
    ;;
  uri)
    if [ "$1" = "--list-types" ]; then printf 'text/uri-list\\ntext/plain\\n'; exit 0; fi
    printf 'file://server/share/remote.png\\r\\nfile://localhost/etc/hostname\\r\\nfile:///tmp/%%E5%%89%%AA%%E8%%B4%%B4%%E6%%9D%%BF%%20test.png\\r\\n# comment\\r\\n'
    exit 0
    ;;
  gnome)
    if [ "$1" = "--list-types" ]; then printf 'x-special/gnome-copied-files\\n'; exit 0; fi
    printf 'cut\\nfile:///a\\nfile:///b\\n'
    exit 0
    ;;
  image)
    if [ "$1" = "--list-types" ]; then printf 'image/png\\ntext/plain\\n'; exit 0; fi
    printf 'PNG\\211\\252binary'
    exit 0
    ;;
  imagetext)
    if [ "$1" = "--list-types" ]; then printf 'image/png\\ntext/plain\\n'; exit 0; fi
    case "$*" in
      *image/png*) printf 'PNG\\211\\252binary'; exit 0;;
      *) printf 'fallback text'; exit 0;;
    esac
    ;;
  bmp)
    if [ "$1" = "--list-types" ]; then printf 'image/bmp\\ntext/plain\\n'; exit 0; fi
    /bin/cat "$STUB_BMP_FILE"
    exit 0
    ;;
  badbmp)
    if [ "$1" = "--list-types" ]; then printf 'image/bmp\\n'; exit 0; fi
    printf 'BMgarbage-not-a-bitmap'
    exit 0
    ;;
  denied)
    echo 'Authorization required, but no authorization protocol specified' >&2
    exit 1
    ;;
  empty)
    echo 'Nothing is copied' >&2; exit 1
    ;;
  dead)
    echo 'Failed to connect to a Wayland server' >&2; exit 1
    ;;
esac
exit 1
`,
    { mode: 0o755 },
  )
  writeFileSync(
    join(stubDir, 'xclip'),
    `#!/bin/sh
if [ "$1" = "-version" ]; then echo "xclip stub 0.13"; exit 0; fi
case "$STUB_XCLIP" in
  fallback)
    case "$*" in
      *TARGETS*) printf 'TARGETS\\ntext/plain\\n'; exit 0;;
      *text/plain*) printf 'x11 text'; exit 0;;
    esac
    ;;
  empty)
    echo 'Error: target TARGETS not available' >&2; exit 1
    ;;
esac
echo "Error: Can't open display" >&2
exit 1
`,
    { mode: 0o755 },
  )
  writeFileSync(
    join(stubDir, 'powershell.exe'),
    String.raw`#!/bin/sh
[ -n "$STUB_PS_MARK" ] && : > "$STUB_PS_MARK"
case "$STUB_PS" in
  image) printf 'IMAGE64:%s\r\n' "$(printf 'PNG\211\252binary' | /usr/bin/base64 | /usr/bin/tr -d '\n')";;
  files) printf '%s\r\n' 'FILE:C:\shots\a b.png' 'FILE:C:\notes\n.txt';;
  text) printf 'TEXT64:%s\r\n' "$(printf 'win text' | /usr/bin/base64 | /usr/bin/tr -d '\n')";;
  *) exit 1;;
esac
`,
    { mode: 0o755 },
  )
  writeFileSync(
    join(stubDir, 'wslpath'),
    String.raw`#!/bin/sh
[ "$1" = "-u" ] || exit 1
printf '%s\n' "$2" | /usr/bin/sed -e 's|^C:|/mnt/c|' -e 's|\\|/|g'
`,
    { mode: 0o755 },
  )
  // A second stub dir holding ONLY xclip: simulates the cached wl-paste
  // vanishing from PATH between reads.
  const xclipOnlyDir = mkdtempSync(join(tmpdir(), 'verify-clipboard-xcliponly-'))
  writeFileSync(
    join(xclipOnlyDir, 'xclip'),
    readFileSync(join(stubDir, 'xclip')),
    { mode: 0o755 },
  )

  const imageExpect = Buffer.from([0x50, 0x4e, 0x47, 0x89, 0xaa, 0x62, 0x69, 0x6e, 0x61, 0x72, 0x79]) // 'PNG' + 0x89 0xAA + 'binary'
  let imagePath = null
  try {
    // CJK text across a mid-character chunk split.
    scenario('text', { wl: 'text' })
    let r = await readClipboard()
    check(
      'integration: CJK text survives a mid-character chunk split',
      r !== null && r.kind === 'text' && r.text === '剪贴板',
      `got ${JSON.stringify(r)}`,
    )

    // text/uri-list: remote authority skipped, localhost + escapes decoded.
    scenario('uri', { wl: 'uri' })
    r = await readClipboard()
    check(
      'integration: uri-list → local files only',
      r !== null && r.kind === 'files' &&
        JSON.stringify(r.paths) === JSON.stringify(['/etc/hostname', '/tmp/剪贴板 test.png']),
      `got ${JSON.stringify(r)}`,
    )

    // x-special/gnome-copied-files: verb line skipped.
    scenario('gnome', { wl: 'gnome' })
    r = await readClipboard()
    check(
      'integration: gnome-copied-files verb line skipped',
      r !== null && r.kind === 'files' && JSON.stringify(r.paths) === JSON.stringify(['/a', '/b']),
      `got ${JSON.stringify(r)}`,
    )

    // Uncreatable image dir (bad TMPDIR): the image offer degrades to the
    // text branch instead of failing or rejecting the read. MUST run
    // before the first successful image export (the dir is cached after).
    scenario('imagetext', { wl: 'imagetext' })
    process.env.TMPDIR = '/nonexistent-verify-clipboard-xyz'
    r = await readClipboard()
    check(
      'integration: uncreatable image dir degrades image offer to text',
      r !== null && r.kind === 'text' && r.text === 'fallback text',
      `got ${JSON.stringify(r)}`,
    )
    // The failure is not cached: TMPDIR restored, the same read exports.
    delete process.env.TMPDIR
    r = await readClipboard()
    check(
      'integration: image dir failure is not cached (recovery exports)',
      r !== null && r.kind === 'image',
      `got ${JSON.stringify(r)}`,
    )
    if (r !== null && r.kind === 'image') imagePath = r.path

    // image/png: exported bytes intact, private dir 0700, file 0600.
    scenario('image', { wl: 'image' })
    r = await readClipboard()
    imagePath = r !== null && r.kind === 'image' ? r.path : null
    check(
      'integration: image exported with bytes intact',
      imagePath !== null && readFileSync(imagePath).equals(imageExpect),
      `got ${JSON.stringify(r)}`,
    )
    if (imagePath !== null) {
      const fileMode = statSync(imagePath).mode & 0o777
      const dirMode = statSync(dirname(imagePath)).mode & 0o777
      check('integration: exported image is mode 0600', fileMode === 0o600, `got ${fileMode.toString(8)}`)
      check('integration: image directory is mode 0700', dirMode === 0o700, `got ${dirMode.toString(8)}`)
    }

    // Empty selection reads as null, never as 'unavailable'.
    scenario('empty', { wl: 'empty' })
    r = await readClipboard()
    check('integration: empty selection → null', r === null, `got ${JSON.stringify(r)}`)

    // Dead Wayland session falls through to a working xclip.
    scenario('fallback', { wl: 'dead', xclip: 'fallback', display: true })
    r = await readClipboard()
    check(
      'integration: dead Wayland session falls back to xclip',
      r !== null && r.kind === 'text' && r.text === 'x11 text',
      `got ${JSON.stringify(r)}`,
    )

    // An UNRECOGNIZED wl-paste failure (permission/protocol phrasing) is a
    // backend error too — not "empty clipboard" — and falls through.
    scenario('denied-fallback', { wl: 'denied', xclip: 'fallback', display: true })
    r = await readClipboard()
    check(
      'integration: unrecognized wl-paste error falls back to xclip',
      r !== null && r.kind === 'text' && r.text === 'x11 text',
      `got ${JSON.stringify(r)}`,
    )

    // A cached tool that vanishes from PATH is evicted: first read caches
    // wl-paste, second read (wl-paste gone) falls through to xclip WITHOUT
    // a cache reset in between.
    scenario('vanished-cache-seed', { wl: 'text' })
    r = await readClipboard()
    check(
      'integration: seed read caches wl-paste',
      r !== null && r.kind === 'text' && r.text === '剪贴板',
      `got ${JSON.stringify(r)}`,
    )
    process.env.PATH = xclipOnlyDir
    process.env.STUB_XCLIP = 'fallback'
    delete process.env.STUB_WL
    r = await readClipboard()
    check(
      'integration: vanished cached tool is evicted, xclip takes over',
      r !== null && r.kind === 'text' && r.text === 'x11 text',
      `got ${JSON.stringify(r)}`,
    )

    // xclip's known empty-selection phrasing reads as null (after the dead
    // wl-paste falls through), never as 'unavailable'.
    scenario('xclip-empty', { wl: 'dead', xclip: 'empty', display: true })
    r = await readClipboard()
    check('integration: xclip empty selection → null', r === null, `got ${JSON.stringify(r)}`)

    // No tools installed at all → 'unavailable'.
    scenario('unavailable', { bare: true })
    r = await readClipboard()
    check(
      "integration: no paste tools → 'unavailable'",
      r !== null && r.kind === 'unavailable',
      `got ${JSON.stringify(r)}`,
    )

    // ---- image/bmp (WSLg) → PNG -----------------------------------------
    const bmpFile = join(stubDir, 'shot.bmp')
    writeFileSync(bmpFile, makeBmp({ rows: sample, bpp: 32, bitfields: true }))
    process.env.STUB_BMP_FILE = bmpFile
    scenario('bmp', { wl: 'bmp' })
    r = await readClipboard()
    const bmpPng = r !== null && r.kind === 'image' ? readFileSync(r.path) : null
    check(
      'integration: image/bmp offer is exported as a decodable .png',
      r !== null && r.kind === 'image' && r.path.endsWith('.png') && bmpPng !== null &&
        same(readPng(bmpPng)?.rows, rgb(sample)),
      `got ${JSON.stringify(r)}`,
    )

    // A bitmap that cannot be decoded keeps the raw export (existing
    // "format unsupported" path) outside WSL — no PowerShell involved.
    const psMark = join(stubDir, 'ps-called')
    process.env.STUB_PS_MARK = psMark
    scenario('badbmp', { wl: 'badbmp', ps: 'image' })
    r = await readClipboard()
    check(
      'integration: undecodable bmp stays a .bmp outside WSL',
      r !== null && r.kind === 'image' && r.path.endsWith('.bmp'),
      `got ${JSON.stringify(r)}`,
    )
    check('integration: powershell.exe is not spawned outside WSL', !existsSync(psMark))

    scenario('non-wsl-empty', { wl: 'empty', ps: 'image' })
    r = await readClipboard()
    check('integration: outside WSL an empty read stays null', r === null && !existsSync(psMark), `got ${JSON.stringify(r)}`)

    // ---- WSL fallback -----------------------------------------------------
    scenario('wsl-usable-no-fallback', { wl: 'text', ps: 'image', wsl: true })
    r = await readClipboard()
    check(
      'integration: WSL keeps a usable Linux read without spawning PowerShell',
      r !== null && r.kind === 'text' && r.text === '剪贴板' && !existsSync(psMark),
      `got ${JSON.stringify(r)}`,
    )

    scenario('wsl-image', { wl: 'empty', ps: 'image', wsl: true })
    r = await readClipboard()
    check(
      'integration: WSL empty read → PowerShell image exported as PNG, bytes intact',
      r !== null && r.kind === 'image' && r.path.endsWith('.png') && readFileSync(r.path).equals(imageExpect),
      `got ${JSON.stringify(r)}`,
    )

    scenario('wsl-badbmp', { wl: 'badbmp', ps: 'image', wsl: true })
    r = await readClipboard()
    check(
      'integration: WSL undecodable bmp → PowerShell PNG',
      r !== null && r.kind === 'image' && r.path.endsWith('.png') && readFileSync(r.path).equals(imageExpect),
      `got ${JSON.stringify(r)}`,
    )

    // The unstageable .bmp the Linux tool exported is unlinked once PowerShell
    // supersedes it (r is the previous scenario's image in the same dir).
    const exportDir = dirname(r.path)
    const bmpsIn = () => readdirSync(exportDir).filter(f => f.endsWith('.bmp'))
    const bmpsBefore = bmpsIn()
    scenario('wsl-badbmp-cleanup', { wl: 'badbmp', ps: 'image', wsl: true })
    r = await readClipboard()
    check(
      'integration: WSL fallback removes the superseded .bmp export',
      r !== null && r.kind === 'image' && r.path.endsWith('.png') && same(bmpsIn(), bmpsBefore),
      `before ${JSON.stringify(bmpsBefore)} after ${JSON.stringify(bmpsIn())}`,
    )

    scenario('wsl-files', { wl: 'empty', ps: 'files', wsl: true })
    r = await readClipboard()
    check(
      'integration: WSL Explorer files → wslpath-converted paths',
      r !== null && r.kind === 'files' &&
        same(r.paths, ['/mnt/c/shots/a b.png', '/mnt/c/notes/n.txt']),
      `got ${JSON.stringify(r)}`,
    )

    scenario('wsl-text', { wl: 'empty', ps: 'text', wsl: true })
    r = await readClipboard()
    check(
      'integration: WSL empty read → PowerShell text',
      r !== null && r.kind === 'text' && r.text === 'win text',
      `got ${JSON.stringify(r)}`,
    )

    // Real detection (no override): the WSL_DISTRO_NAME env marker alone.
    scenario('wsl-env-marker', { wl: 'empty', ps: 'text' })
    _setWslOverride(undefined)
    process.env.WSL_DISTRO_NAME = 'Ubuntu-verify'
    r = await readClipboard()
    delete process.env.WSL_DISTRO_NAME
    check(
      'integration: WSL_DISTRO_NAME marker enables the PowerShell fallback',
      r !== null && r.kind === 'text' && r.text === 'win text',
      `got ${JSON.stringify(r)}`,
    )

    scenario('wsl-tools-dead', { wl: 'dead', ps: 'image', wsl: true })
    r = await readClipboard()
    check(
      'integration: WSL with unreachable Linux tools uses PowerShell',
      r !== null && r.kind === 'image',
      `got ${JSON.stringify(r)}`,
    )

    scenario('wsl-nothing', { wl: 'dead', wsl: true })
    r = await readClipboard()
    check(
      "integration: WSL with no reachable backend → 'unavailable' + wsl:true",
      r !== null && r.kind === 'unavailable' && r.wsl === true,
      `got ${JSON.stringify(r)}`,
    )

    scenario('wsl-empty-both', { wl: 'empty', wsl: true })
    r = await readClipboard()
    check('integration: WSL empty everywhere → null', r === null, `got ${JSON.stringify(r)}`)

    scenario('plain-unavailable', { bare: true, ps: 'image' })
    r = await readClipboard()
    check(
      "integration: outside WSL 'unavailable' carries no wsl flag",
      r !== null && r.kind === 'unavailable' && r.wsl === undefined,
      `got ${JSON.stringify(r)}`,
    )
  } finally {
    restoreEnv()
    _resetLinuxPasteCache()
    rmSync(stubDir, { recursive: true, force: true })
    rmSync(emptyDir, { recursive: true, force: true })
    rmSync(xclipOnlyDir, { recursive: true, force: true })
    if (imagePath !== null) {
      rmSync(dirname(imagePath), { recursive: true, force: true })
    }
  }
} else {
  console.log('SKIP: stubbed-tool integration tests (Linux only)')
}

// execFileNoThrow chunk-boundary safety net (pure, all platforms): two
// writes separated by a macrotask arrive as two chunks; decoding must
// happen once over the concatenated bytes.
{
  const { execFileNoThrow } = await import('../lib/types/utils/execFileNoThrow.js')
  const r = await execFileNoThrow(process.execPath, [
    '-e',
    "process.stdout.write(Buffer.from([0xE5])); setTimeout(() => { process.stdout.write(Buffer.from([0x89, 0xAA])); }, 60)",
  ])
  check('execFileNoThrow decodes UTF-8 across chunk boundaries', r.stdout === '剪', `got ${JSON.stringify(r.stdout)}`)

  const closedStdin = await execFileNoThrow(
    process.execPath,
    ['-e', 'process.stdin.destroy(); setTimeout(() => process.exit(0), 50)'],
    { input: 'x'.repeat(16 * 1024 * 1024) },
  )
  check(
    'execFileNoThrow survives a child closing stdin before the input is written',
    closedStdin.code === 0,
    `got ${JSON.stringify(closedStdin)}`,
  )
}

if (failed > 0) {
  console.error(`verify-clipboard: ${failed} check(s) failed`)
  process.exit(1)
}
console.log('verify-clipboard: all checks passed')
