/**
 * Mermaid fences → Unicode box-drawing art through `lovely-mermaid`.
 *
 * The engine is pure TypeScript: no browser, no SVG, no image protocol. It
 * lays a diagram out at whatever width it needs and reports that width;
 * fitting it to the viewport (or falling back to the fenced source) is the
 * component's decision. Parsing is best-effort by design, so a streaming
 * prefix keeps drawing instead of flipping between art and source.
 *
 * Like cli-highlight the module loads lazily on the first mermaid fence —
 * most sessions never pay for it.
 */
import type { MermaidArt, Role } from 'lovely-mermaid'
import { colorize } from '../ink/colorize.js'
import type { Theme } from '../theme.js'

export type { MermaidArt } from 'lovely-mermaid'

/** The lovely-mermaid surface dsh-tui consumes. */
export type MermaidEngine = Pick<typeof import('lovely-mermaid'), 'render'>

/**
 * Sources above this length skip the engine: the layout has its own node
 * and edge caps, but the parser still walks every character, and a fence
 * this long is a paste, not a diagram.
 */
const MERMAID_SOURCE_LIMIT = 20_000

let enginePromise: Promise<MermaidEngine | null> | undefined
let loadedEngine: MermaidEngine | null | undefined

async function loadMermaidEngine(): Promise<MermaidEngine | null> {
  try {
    const mod = await import('lovely-mermaid')
    return { render: mod.render }
  } catch {
    return null
  }
}

/**
 * Return the shared engine load promise, starting the lazy load on first call.
 * @returns A promise of the engine, or null when the dynamic import fails.
 */
export function getMermaidEnginePromise(): Promise<MermaidEngine | null> {
  enginePromise ??= loadMermaidEngine().then(engine => {
    loadedEngine = engine
    return engine
  })
  return enginePromise
}

/**
 * Synchronous view of the load: the engine once loaded, null after a failed
 * import, undefined while pending. Lets a mounting component draw the
 * diagram on its first render instead of flashing the source first.
 */
export function peekMermaidEngine(): MermaidEngine | null | undefined {
  return loadedEngine
}

/** Whether a fence info string names mermaid (`mermaid`, `Mermaid`, `mermaid title=…`). */
export function isMermaidLang(lang: string | undefined): boolean {
  return lang?.trim().split(/\s+/, 1)[0]?.toLowerCase() === 'mermaid'
}

/**
 * Lay out a mermaid source. `null` follows the engine's contract (blank,
 * unsupported diagram type, nothing parsed) and additionally covers the
 * source-length guard and any engine exception — a third-party parser
 * failing on model output must degrade to the fenced source, never take
 * the transcript down.
 */
export function renderMermaid(engine: MermaidEngine, source: string): MermaidArt | null {
  if (source.length > MERMAID_SOURCE_LIMIT) return null
  try {
    return engine.render(source)
  } catch {
    return null
  }
}

/**
 * Theme key per semantic role. `text` (node labels) is deliberately left
 * unpainted so it inherits the enclosing Text's color — body color in a
 * reply, the dim color inside a folded thinking block.
 */
const ROLE_COLOR: Readonly<Record<Role, keyof Theme | undefined>> = Object.freeze({
  border: 'subtle',
  text: undefined,
  edge: 'permission',
  edgeLabel: 'inactive',
  title: 'subtle',
  none: undefined,
})

/**
 * Paint the art's rows with the active theme, one string per row.
 * `styled[i]` joined is exactly `plain[i]`, so widths are unchanged.
 */
export function paintMermaidArt(art: MermaidArt, theme: Theme): string[] {
  return art.styled.map(row =>
    row
      .map(span => {
        const key = ROLE_COLOR[span.role]
        return key === undefined ? span.text : colorize(span.text, theme[key], 'foreground')
      })
      .join(''),
  )
}
