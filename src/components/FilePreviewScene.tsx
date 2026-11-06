/**
 * FilePreviewScene — the host-owned read-only file preview behind the plugin
 * surface verb `host.openFile(path, { line? })` (docs/plugin-ui-kit-design.md
 * 二期).
 *
 * No in-app text viewer existed: the file-action menu hands a path to the OS
 * default handler and the image preview only takes transcript images. So this
 * is a scene of its own, rendered through the plugin-scene outlet (full
 * screen, AlternateScreen in inline mode, the scene keyboard guard), with the
 * request read from its scene params.
 *
 * - Reads only: stat, then one bounded read through a non-blocking handle (a
 *   FIFO or device can never park the threadpool). Directories, non-regular
 *   files, binaries (a NUL in the first 8000 bytes, git's heuristic) and
 *   files over 2 MiB show a notice instead of content. Nothing is executed.
 * - Renders only the visible window: a 2 MiB file costs one split and one
 *   highlight pass (skipped above 256 KiB), never a frame per line.
 * - File bytes are untrusted render-path text: tabs expand to 4-column stops
 *   and every other C0/C1 control becomes its visible control picture
 *   (`␛`), so a log full of escape sequences cannot drive the terminal.
 * - Keys: ↑/↓ (j/k) line, PgUp/PgDn (space/b) page, Home/End (g/G) ends,
 *   ←/→ (h/l) sideways, wheel scrolls; Esc/q closes back to the previous
 *   screen (the scene that opened it, when one did).
 */
import React from 'react'
import { constants as fsConstants } from 'node:fs'
import { open as openHandle, stat as statPath } from 'node:fs/promises'
import { extname } from 'node:path'
import { Box, Text, useInput, useTerminalSize } from '../ui.js'
import type { Color } from '../ink/styles.js'
import { stringWidth } from '../ink/stringWidth.js'
import { getGraphemeSegmenter } from '../utils/intl.js'
import { truncateMiddle } from '../utils/truncateMiddle.js'
import { flattenInline } from '../channel/sanitize.js'
import { getCliHighlightPromise, type CliHighlight } from '../terminal-utils/cliHighlight.js'
import { highlightLines, syntaxThemeSignature, type SyntaxRun } from '../terminal-utils/syntaxRuns.js'
import { formatBytes } from '../sessions/format.js'
import { getTheme } from '../theme.js'
import { useTheme } from './design-system/ThemeProvider.js'
import { t } from '../i18n.js'
import type { TuiSceneProps } from '../dsh-adapter/scenes.js'

/** Files above this size show a notice instead of content. */
export const FILE_PREVIEW_MAX_BYTES = 2 * 1024 * 1024
/** Above this many characters the preview stays plain (one highlight pass is synchronous). */
export const FILE_PREVIEW_HIGHLIGHT_MAX_CHARS = 256 * 1024
/** Bytes sniffed for a NUL (git's binary heuristic). */
const BINARY_SNIFF_BYTES = 8000
/** First read size when the stat'd size says less (procfs reports 0). */
const READ_CHUNK_BYTES = 64 * 1024
const TAB_SIZE = 4
/** Source code units {@link displayRuns} may read per cell it was asked for
 *  (plus a floor): far above real text (an emoji ZWJ sequence is ~10 per
 *  cell), so only zero-width floods — one huge combining cluster, a run of
 *  ZWSP — reach it, and they cost a bounded walk instead of the whole line. */
const SOURCE_UNITS_PER_CELL = 32
/** Furthest horizontal scroll, in cells (a multiple of the 8-cell step):
 *  every render segments a line from its start up to the window, so the
 *  offset is bounded rather than growing with each Right press. */
export const FILE_PREVIEW_MAX_LEFT = 4096
const SOURCE_UNITS_FLOOR = 256
/** Header + footer rows around the body. */
const CHROME_ROWS = 2

export type FilePreviewLoad =
  | { readonly kind: 'text'; readonly lines: readonly string[]; readonly size: number }
  | { readonly kind: 'directory' }
  | { readonly kind: 'special' }
  | { readonly kind: 'binary'; readonly size: number }
  | { readonly kind: 'too-large'; readonly size: number }
  | { readonly kind: 'error'; readonly message: string }

function errorMessage(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code
  if (typeof code === 'string') return code
  return error instanceof Error ? error.message : String(error)
}

/** Split file text into lines (CRLF, LF and lone CR all break). */
export function splitPreviewLines(text: string): string[] {
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  if (body === '') return []
  const lines = body.split(/\r\n|\r|\n/u)
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

/** Read a file for the preview: bounded, read-only, never blocking on special files. */
export async function loadFilePreview(path: string, maxBytes: number = FILE_PREVIEW_MAX_BYTES): Promise<FilePreviewLoad> {
  let info
  try {
    info = await statPath(path)
  } catch (error) {
    return { kind: 'error', message: errorMessage(error) }
  }
  if (info.isDirectory()) return { kind: 'directory' }
  if (!info.isFile()) return { kind: 'special' }
  if (info.size > maxBytes) return { kind: 'too-large', size: info.size }
  let handle
  try {
    // O_NONBLOCK: a path swapped for a FIFO after the stat must not park the read.
    handle = await openHandle(path, fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK ?? 0))
  } catch (error) {
    return { kind: 'error', message: errorMessage(error) }
  }
  try {
    const opened = await handle.stat()
    if (!opened.isFile()) return { kind: 'special' }
    if (opened.size > maxBytes) return { kind: 'too-large', size: opened.size }
    // Read to EOF, never to the stat'd size: procfs/sysfs files report 0 and
    // a log can grow between the stat and the read. One byte past the cap
    // proves the file is over it; the buffer starts at the stat'd size (one
    // read for an ordinary file) and doubles up to that limit.
    const limit = maxBytes + 1
    let buffer = Buffer.allocUnsafe(Math.min(limit, Math.max(opened.size + 1, READ_CHUNK_BYTES)))
    let length = 0
    for (;;) {
      if (length === buffer.length) {
        if (length >= limit) break
        const grown = Buffer.allocUnsafe(Math.min(limit, buffer.length * 2))
        buffer.copy(grown, 0, 0, length)
        buffer = grown
      }
      // Position null: sequential reads, so non-seekable pseudo-files work too.
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null)
      if (bytesRead === 0) break
      length += bytesRead
    }
    if (length > maxBytes) {
      const now = await handle.stat().catch(() => opened)
      return { kind: 'too-large', size: Math.max(length, now.size) }
    }
    const head = buffer.subarray(0, Math.min(length, BINARY_SNIFF_BYTES))
    if (head.includes(0)) return { kind: 'binary', size: length }
    return { kind: 'text', lines: splitPreviewLines(buffer.toString('utf8', 0, length)), size: length }
  } catch (error) {
    return { kind: 'error', message: errorMessage(error) }
  } finally {
    await handle.close().catch(() => {})
  }
}

/** One display character for a control code: its Unicode control picture. */
function controlPicture(code: number): string {
  if (code < 0x20) return String.fromCharCode(0x2400 + code)
  if (code === 0x7f) return '␡'
  return '�'
}

const BIDI_CONTROLS = /[‪-‮⁦-⁩]/u

/**
 * Make one line of file runs safe and measurable: tabs expand to stops of
 * {@link TAB_SIZE} cells, C0/C1 controls become control pictures, and bidi
 * overrides/isolates become U+FFFD (a code viewer must show, not obey, them).
 * Work stops once `maxCells` are produced, or once the source budget for them
 * is read (zero-width content produces no cells): a minified one-line file
 * must not cost a full grapheme walk per keypress when only a window of it is
 * shown.
 */
export function displayRuns(runs: readonly SyntaxRun[], maxCells: number = Number.POSITIVE_INFINITY): SyntaxRun[] {
  const out: SyntaxRun[] = []
  let column = 0
  let budget = Number.isFinite(maxCells) ? Math.max(0, maxCells) * SOURCE_UNITS_PER_CELL + SOURCE_UNITS_FLOOR : Number.POSITIVE_INFINITY
  for (const run of runs) {
    if (column >= maxCells || budget <= 0) break
    let source = run.text
    if (source.length > budget) {
      // Never end on half a surrogate pair.
      const end = source.charCodeAt(budget - 1) >= 0xd800 && source.charCodeAt(budget - 1) <= 0xdbff ? budget - 1 : budget
      source = source.slice(0, end)
    }
    budget -= source.length
    let text = ''
    for (const { segment } of getGraphemeSegmenter().segment(source)) {
      if (column >= maxCells) break
      const code = segment.codePointAt(0) ?? 0
      if (segment === '\t') {
        const spaces = TAB_SIZE - (column % TAB_SIZE)
        text += ' '.repeat(spaces)
        column += spaces
        continue
      }
      let shown = segment
      if (segment.length === 1 && (code < 0x20 || (code >= 0x7f && code <= 0x9f))) shown = controlPicture(code)
      else if (BIDI_CONTROLS.test(segment)) shown = '�'
      text += shown
      column += stringWidth(shown)
    }
    if (text !== '') out.push(run.color === undefined ? { text } : { text, color: run.color })
  }
  return out
}

/** The header's path, neutralized exactly like the body: controls become
 *  control pictures and bidi overrides/isolates U+FFFD (a file name can carry
 *  them too, and the header sits right next to the line count). */
export function previewPathText(path: string): string {
  return displayRuns([{ text: path }]).map(run => run.text).join('')
}

/** Display width of display runs. */
export function runsWidth(runs: readonly SyntaxRun[]): number {
  let width = 0
  for (const run of runs) width += stringWidth(run.text)
  return width
}

/**
 * The cells `[start, start + width)` of display runs. A wide grapheme cut by
 * either edge becomes a space, so the window never spills a half character.
 */
export function sliceRuns(runs: readonly SyntaxRun[], start: number, width: number): SyntaxRun[] {
  const out: SyntaxRun[] = []
  const end = start + Math.max(0, width)
  let column = 0
  for (const run of runs) {
    if (column >= end) break
    let text = ''
    for (const { segment } of getGraphemeSegmenter().segment(run.text)) {
      const cells = stringWidth(segment)
      const from = column
      column += cells
      if (column <= start) continue
      if (from >= end) break
      if (from < start || column > end) text += ' '.repeat(Math.min(column, end) - Math.max(from, start))
      else text += segment
    }
    if (text !== '') out.push(run.color === undefined ? { text } : { text, color: run.color })
  }
  return out
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max))
}

/** The scene params the opener writes (`openHostFilePreview`). */
function previewRequest(params: unknown): { readonly path: string; readonly line: number | undefined } | undefined {
  if (typeof params !== 'object' || params === null) return undefined
  const { path, line } = params as { path?: unknown; line?: unknown }
  if (typeof path !== 'string' || path === '') return undefined
  return { path, line: typeof line === 'number' && Number.isInteger(line) && line >= 1 ? line : undefined }
}

function noticeText(load: FilePreviewLoad): string {
  switch (load.kind) {
    case 'directory': return t('file-preview-directory')
    case 'special': return t('file-preview-special')
    case 'binary': return t('file-preview-binary', { size: formatBytes(load.size) ?? '' })
    case 'too-large': return t('file-preview-too-large', { size: formatBytes(load.size) ?? '', max: formatBytes(FILE_PREVIEW_MAX_BYTES) ?? '' })
    case 'error': return t('file-preview-error', { err: flattenInline(load.message) })
    case 'text': return ''
  }
}

export function FilePreviewScene({ close, host }: Pick<TuiSceneProps, 'close' | 'host'>): React.ReactNode {
  const request = previewRequest(host.useParams())
  const path = request?.path ?? ''
  const target = request?.line
  const { columns, rows } = useTerminalSize()
  // The result is tagged with the path it was read for: a frame rendered for a
  // new path shows "loading", never the previous file under the new name.
  const [loaded, setLoaded] = React.useState<{ readonly path: string; readonly result: FilePreviewLoad } | undefined>(undefined)
  const load = loaded?.path === path ? loaded.result : undefined

  React.useEffect(() => {
    if (path === '') return
    let alive = true
    void loadFilePreview(path).then(result => { if (alive) setLoaded({ path, result }) })
    return () => { alive = false }
  }, [path])

  const [highlighter, setHighlighter] = React.useState<CliHighlight | null>(null)
  React.useEffect(() => {
    let alive = true
    void getCliHighlightPromise().then(value => { if (alive) setHighlighter(value) })
    return () => { alive = false }
  }, [])
  const [themeName] = useTheme()
  const theme = getTheme(themeName)
  const themeSig = React.useMemo(() => syntaxThemeSignature(theme), [theme])
  const lines = load?.kind === 'text' ? load.lines : undefined
  const language = extname(path).slice(1).toLowerCase()
  const syntax = React.useMemo(() => {
    if (lines === undefined || language === '') return undefined
    const text = lines.join('\n')
    if (text.length > FILE_PREVIEW_HIGHLIGHT_MAX_CHARS) return undefined
    return highlightLines(text, language, highlighter, theme, themeSig)
  }, [lines, language, highlighter, theme, themeSig])

  const total = lines?.length ?? 0
  const viewport = Math.max(1, rows - CHROME_ROWS)
  const maxTop = Math.max(0, total - viewport)
  const gutter = String(Math.max(1, total)).length
  // Row = paddingX 1 + gutter + one space + content + paddingX 1.
  const contentWidth = Math.max(1, columns - 2 - gutter - 1)

  // Land on the requested line (a third down the page) whenever the file or
  // the target changes, otherwise at the top. Derived during render (not in
  // an effect) so the first painted frame is already at the target; the
  // viewport is read, not tracked: a resize must not yank the reader back.
  const [view, setView] = React.useState<{
    readonly lines: readonly string[] | undefined
    readonly target: number | undefined
    readonly top: number
    readonly left: number
  }>({ lines: undefined, target: undefined, top: 0, left: 0 })
  if (view.lines !== lines || view.target !== target) {
    const landing = lines === undefined || target === undefined
      ? 0
      : clamp(target - 1 - Math.floor(viewport / 3), 0, Math.max(0, lines.length - viewport))
    setView({ lines, target, top: landing, left: 0 })
  }
  const top = view.top
  const left = view.left
  const setTop = (next: (value: number) => number): void => { setView(current => ({ ...current, top: next(current.top) })) }
  const setLeft = (next: (value: number) => number): void => { setView(current => ({ ...current, left: next(current.left) })) }

  const scrollBy = (delta: number): void => { setTop(value => clamp(value + delta, 0, maxTop)) }
  useInput((input, key, event) => {
    const stop = (): void => { event.stopImmediatePropagation() }
    if (key.escape || (input === 'q' && !key.ctrl && !key.meta)) { stop(); close(); return }
    if (key.upArrow || input === 'k' || key.wheelUp) { stop(); scrollBy(key.wheelUp ? -3 : -1); return }
    if (key.downArrow || input === 'j' || key.wheelDown) { stop(); scrollBy(key.wheelDown ? 3 : 1); return }
    if (key.pageUp || input === 'b') { stop(); scrollBy(-viewport); return }
    if (key.pageDown || input === ' ') { stop(); scrollBy(viewport); return }
    if (key.home || input === 'g') { stop(); setTop(() => 0); return }
    if (key.end || input === 'G') { stop(); setTop(() => maxTop); return }
    if (key.leftArrow || input === 'h') { stop(); setLeft(value => Math.max(0, value - 8)); return }
    if (key.rightArrow || input === 'l') { stop(); setLeft(value => Math.min(FILE_PREVIEW_MAX_LEFT, value + 8)); return }
  })

  const shownPath = React.useMemo(() => previewPathText(path), [path])
  const headerPath = truncateMiddle(shownPath, Math.max(8, columns - 2 - 24))
  const headerInfo = load?.kind === 'text'
    ? ' · ' + t('file-preview-lines', { count: total }) + (target === undefined ? '' : ' · L' + String(target))
    : ''

  let body: React.ReactNode
  if (path === '') {
    body = <Text dimColor>{t('file-preview-error', { err: '—' })}</Text>
  } else if (load === undefined) {
    body = <Text dimColor>{t('file-preview-loading')}</Text>
  } else if (load.kind !== 'text') {
    body = <Text color="warning" wrap="wrap">{noticeText(load)}</Text>
  } else if (total === 0) {
    body = <Text dimColor>{t('file-preview-empty')}</Text>
  } else {
    const visible: React.ReactNode[] = []
    const start = clamp(top, 0, maxTop)
    for (let index = start; index < Math.min(total, start + viewport); index += 1) {
      const raw = syntax?.[index] ?? [{ text: lines![index]! }]
      // One cell past the window is enough to know whether the line overflows.
      const shown = displayRuns(raw, left + contentWidth + 1)
      const overflow = runsWidth(shown) > left + contentWidth
      const window = sliceRuns(shown, left, overflow ? contentWidth - 1 : contentWidth)
      const isTarget = target !== undefined && index === target - 1
      visible.push(
        <Box key={index} flexDirection="row" height={1} flexShrink={0}>
          <Text color={isTarget ? 'accent' : undefined} dimColor={!isTarget} bold={isTarget}>
            {String(index + 1).padStart(gutter)}{' '}
          </Text>
          <Text wrap="truncate-end">
            {window.map((run, at) => <Text key={at} color={run.color as Color | undefined}>{run.text}</Text>)}
            {overflow ? <Text dimColor>›</Text> : null}
          </Text>
        </Box>,
      )
    }
    body = visible
  }

  return (
    <Box flexDirection="column" width={columns} height={rows} paddingX={1}>
      <Box flexDirection="row" height={1} flexShrink={0}>
        <Text bold wrap="truncate-end">{headerPath}</Text>
        <Text dimColor wrap="truncate-end">{headerInfo}</Text>
      </Box>
      <Box flexDirection="column" flexGrow={1} overflow="hidden">
        {body}
      </Box>
      <Box height={1} flexShrink={0}>
        <Text dimColor wrap="truncate-end">{t('file-preview-hint')}</Text>
      </Box>
    </Box>
  )
}
