/**
 * Structural render-work counters (streaming performance gate).
 *
 * The code-frame performance gate (verify-markdown-codebox-performance)
 * drives a real StreamingMarkdown for many frames and asserts that work
 * attributable to ALREADY-SEALED blocks stays at zero per frame. These
 * counters are the probes: plain integer increments on the hot paths,
 * cheap enough to ship in production and useful for future profiling.
 *
 * - formatToken: one per markdown dispatch call (lexer->ANSI formatting).
 * - codeHighlight: one per cli-highlight invocation from formatCodeBody.
 * - wrapCompute: one per real text wrap (wrap-text cache MISS or bypass).
 * - measureCompute: one per text measurement beyond dom.ts' node cache.
 */

export type RenderWorkCounters = {
  formatToken: number
  codeHighlight: number
  wrapCompute: number
  measureCompute: number
}

export const renderWork: RenderWorkCounters = {
  formatToken: 0,
  codeHighlight: 0,
  wrapCompute: 0,
  measureCompute: 0,
}

export function resetRenderWork(): void {
  renderWork.formatToken = 0
  renderWork.codeHighlight = 0
  renderWork.wrapCompute = 0
  renderWork.measureCompute = 0
}

/**
 * Per-source format attribution. Only populated while enabled: the map
 * pins every formatted source string in memory, which is fine for a test
 * fixture and unacceptable as an always-on cost.
 */
export const formatSourceCounts = new Map<string, number>()

let trackSources = false

export function setTrackFormatSources(enabled: boolean): void {
  trackSources = enabled
  if (!enabled) formatSourceCounts.clear()
}

/** Count one markdown dispatch, optionally attributing it to its source. */
export function noteFormatToken(raw: string): void {
  renderWork.formatToken++
  if (trackSources) formatSourceCounts.set(raw, (formatSourceCounts.get(raw) ?? 0) + 1)
}

/** Count one real syntax-highlight invocation. */
export function noteCodeHighlight(): void {
  renderWork.codeHighlight++
}

/** Count one real text wrap computation (not served from cache). */
export function noteWrapCompute(): void {
  renderWork.wrapCompute++
}

/** Count one text measurement beyond the per-node cache. */
export function noteMeasureCompute(): void {
  renderWork.measureCompute++
}
