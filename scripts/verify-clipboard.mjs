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
 *
 * Run: node scripts/verify-clipboard.mjs
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

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
} = await import('../lib/types/utils/clipboard.js')

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
  'formatClipboardInsert quotes whitespace paths and joins files',
  formatClipboardInsert({ kind: 'files', paths: ['/tmp/a b.png', '/etc/hostname'] }) ===
    '"/tmp/a b.png" /etc/hostname',
)
check(
  'formatClipboardInsert inserts the exported image path',
  formatClipboardInsert({ kind: 'image', path: '/tmp/dsh-tui-paste-1.png' }) === '/tmp/dsh-tui-paste-1.png',
)
check(
  'formatClipboardInsert normalizes text line endings',
  formatClipboardInsert({ kind: 'text', text: 'a\r\nb\rc' }) === 'a\nb\nc',
)

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
  }
  const restoreEnv = () => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
  const scenario = (name, { wl, xclip, wayland = true, display = false, bare = false }) => {
    _resetLinuxPasteCache()
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
}

if (failed > 0) {
  console.error(`verify-clipboard: ${failed} check(s) failed`)
  process.exit(1)
}
console.log('verify-clipboard: all checks passed')
