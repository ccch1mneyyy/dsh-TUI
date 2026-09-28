/**
 * Welcome-art regression: every registered header design renders through the
 * path its registry row declares, at the widths where the header swaps shape.
 *
 * Run after pnpm compile: node --import tsx/esm scripts/verify-welcome-art.mjs
 *
 * Both native pixels and PNG fallbacks use half-blocks. Verify graphics
 * placements separately; glyph counts alone cannot establish full quality.
 */
import assert from 'node:assert/strict'

const { WELCOME_ART_MODES } = await import('../lib/types/components/welcomeArt.js')
const { isWelcomeArtId, DEFAULT_WELCOME_ART, IMAGE_MIN_COLUMNS } = await import('../lib/types/components/welcomeArt.js')
const { captureWelcomeArt, captureText, artCells, glyphCells, markBand, warmWelcomeArt } = await import('./lib/welcome-art-preview.mjs')

const MIN_PNG_ART = 40
const MAX_PNG_BLOCK = 20
/** Scene modes paint the pixel header out entirely. */
const MIN_SCENE_ART = 150

let checks = 0
function check(label, condition) {
  assert.ok(condition, label)
  checks++
}

// ── registry / settings agreement ───────────────────────────────────────────
check('twelve modes ship', WELCOME_ART_MODES.length === 12)
check('mode ids are unique', new Set(WELCOME_ART_MODES.map(m => m.id)).size === 12)
check('the default id is a registered row', WELCOME_ART_MODES.some(m => m.id === DEFAULT_WELCOME_ART))
check('unknown ids are rejected', !isWelcomeArtId('nope') && !isWelcomeArtId(undefined))
check('every label is filled in',
  WELCOME_ART_MODES.every(m => m.label !== '' && m.labelZh !== '' && m.hint !== '' && m.hintZh !== ''))
check('every image mode names both PNG elements', WELCOME_ART_MODES.every(m => m.art !== 'image' || (m.whale !== undefined && m.wordmark !== undefined)))
check('the R1U and R3 studies share one whale element',
  WELCOME_ART_MODES.find(m => m.id === 'glitch').whale === WELCOME_ART_MODES.find(m => m.id === 'heavy').whale)
check('the three classic poses share one wordmark element',
  ['classic', 'spout', 'heart', 'sleep'].every(id => WELCOME_ART_MODES.find(m => m.id === id).wordmark === 'classic'))
check('the pinned poses differ',
  new Set(['spout', 'heart', 'sleep'].map(id => WELCOME_ART_MODES.find(m => m.id === id).whaleFrame)).size === 3)

// ── every mode renders its own shape at 110 columns ─────────────────────────
for (const mode of WELCOME_ART_MODES) {
  await warmWelcomeArt(mode.id, 'dark')
  const capture = await captureWelcomeArt({ welcomeArt: mode.id, theme: 'dark', columns: 110 })
  const [markFrom, markTo] = markBand(capture)
  const art = artCells(capture, markFrom, markTo)
  const block = glyphCells(capture, '█', markFrom, markTo)
  check(`${mode.id}: the header keeps the model line`, captureText(capture).includes('deepseek-v4-flash'))
  check(`${mode.id}: the header keeps the cwd line`, captureText(capture).includes('D:/projects/deepsea'))
  check(`${mode.id}: the header painted something`, capture.cells.length > 8)
  if (mode.art === 'cell') {
    check(`${mode.id}: square-pixel wordmark in the mark band`, art > 100)
    check(`${mode.id}: no stretched full-cell letters`, block === 0)
  } else {
    check(`${mode.id}: PNG art in the mark band`, art >= MIN_PNG_ART)
    check(`${mode.id}: no block font in the mark band`, block <= MAX_PNG_BLOCK)
  }
  if (mode.art === 'scene') {
    check(`${mode.id}: the scene spans the header`, artCells(capture, 2, 98) >= MIN_SCENE_ART)
  }
  console.log(`PASS  ${mode.id.padEnd(10)} art=${mode.art.padEnd(6)} mark-band █=${String(block).padStart(4)} ▀▄=${String(art).padStart(4)}`)
}

// ── the size boundaries ─────────────────────────────────────────────────────
{
  // An image mode below the PNG header's width falls back to the block font —
  // the mode's own fallback, never another mode's PNG. At 91 columns the
  // 40-column whale still leaves only 49 columns for the mark, which is under
  // DEEP SLEEP's 53, so the header drops to the plain-text title instead.
  const narrow = await captureWelcomeArt({ welcomeArt: 'glitch', theme: 'dark', columns: IMAGE_MIN_COLUMNS - 1 })
  check('narrow image mode draws no PNG art', artCells(narrow, ...markBand(narrow)) === 0)
  const narrowBlock = glyphCells(narrow, '█', ...markBand(narrow))
  check('narrow image mode falls back to a text title',
    captureText(narrow).includes('DeepSeek Harness'))
  console.log(`PASS  glitch @ ${IMAGE_MIN_COLUMNS - 1} cols → fallback (█=${narrowBlock})`)

  // Exactly at the boundary the PNG header is drawn.
  const wide = await captureWelcomeArt({ welcomeArt: 'glitch', theme: 'dark', columns: IMAGE_MIN_COLUMNS })
  check('at the boundary the image mode draws its PNG', artCells(wide, ...markBand(wide)) >= MIN_PNG_ART)
  console.log(`PASS  glitch @ ${IMAGE_MIN_COLUMNS} cols → PNG header`)

  // Hiding the whale is the other trigger for the fallback.
  const noWhale = await captureWelcomeArt({ welcomeArt: 'glitch', theme: 'dark', columns: 110, whale: false })
  check('whale=false preserves the pixel title', artCells(noWhale, ...markBand(noWhale)) > 100)
  check('whale=false draws no PNG art', !captureText(noWhale).includes('简化预览'))
  console.log('PASS  glitch with whale=false → pixel fallback')

  // The scene mode also honours whale=false.
  const sceneNoWhale = await captureWelcomeArt({ welcomeArt: 'rainbow', theme: 'dark', columns: 110, whale: false })
  check('whale=false preserves a readable pixel title', artCells(sceneNoWhale, ...markBand(sceneNoWhale)) > 100)
  console.log('PASS  rainbow with whale=false → pixel fallback')
}

// ── the theme picks the scene variant ───────────────────────────────────────
{
  const dark = await captureWelcomeArt({ welcomeArt: 'rainbow', theme: 'dark', columns: 110 })
  const light = await captureWelcomeArt({ welcomeArt: 'rainbow', theme: 'light', columns: 110 })
  check('the dark scene renders', artCells(dark, 2, 98) >= MIN_SCENE_ART)
  check('the light scene renders', artCells(light, 2, 98) >= MIN_SCENE_ART)
  // Restrict to the scene rows: the info lines below carry theme-dependent
  // text colours, so only the art band can prove the two files differ — the
  // hollow DSH mark is white in one variant and navy in the other.
  const ink = capture => new Set(
    capture.cells.slice(0, 8).flatMap(row => row.slice(40)).filter(c => c.fg !== null && c.text !== ' ').map(c => c.fg),
  )
  const darkInk = [...ink(dark)].sort()
  const lightInk = [...ink(light)].sort()
  check('the theme selects a different scene foreground', darkInk.join() !== lightInk.join())
  check('the dark scene draws light ink on the dark terminal',
    darkInk.some(color => parseInt(color.slice(1, 3), 16) > 180))
  check('the light scene draws dark ink on the light terminal',
    lightInk.some(color => parseInt(color.slice(1, 3), 16) < 80))
  console.log(`PASS  rainbow scene follows the theme (${darkInk.length} vs ${lightInk.length} scene inks)`)
}

// Exercise actual graphics payloads instead of declaring the degraded grid sharp.
for (const mode of WELCOME_ART_MODES.filter(mode => mode.art === 'image')) {
  const capture = await captureWelcomeArt({ welcomeArt: mode.id, theme: 'dark', graphics: true })
  check(`${mode.id}: two real PNG placements`, capture.graphicsImages.length === 2)
  check(`${mode.id}: both placements retain hundreds of physical pixels`, capture.graphicsImages.every(p => p.columns >= 40 && p.png.length > 1000))
}
const marks = []
for (const id of ['classic', 'spout', 'heart', 'sleep', 'deepsleep']) {
  const c = await captureWelcomeArt({ welcomeArt: id, theme: 'dark' })
  marks.push(JSON.stringify(c.cells.map(row => row.slice(42))))
}
check('five pixel modes have distinct wordmark/motif regions', new Set(marks).size === 5)
console.log(`\nPASS: ${checks} checks over 12 welcome-art modes`)
