/**
 * TikZ source handling: fence detection and the guarded document assembled
 * around a model-written figure.
 *
 * Pure module — no Node built-ins and no rendering — so the Markdown
 * dispatcher, the UI component and the regression scripts all share one
 * definition of "this is a TikZ figure" and one wrapper.
 *
 * The wrapper never accepts a full document: `\documentclass` is refused and
 * every package beyond a small allowed set is rejected. What it does accept
 * is hoisted: `\usetikzlibrary` (into the document body, so a preloaded format
 * still sees it), the allowed `\usepackage` lines and a `\begin{document}`
 * body. The TeX run itself is hardened separately (see engine.ts); this filter
 * is defence in depth, not the security boundary.
 */

/** Bumped whenever the fixed preamble below changes; it is part of the cache key. */
export const TIKZ_TEMPLATE_VERSION = 2

/** Longer input is a paste, not a figure. Real commutative diagrams are far smaller. */
export const TIKZ_SOURCE_LIMIT = 16_384

/**
 * Common Unicode math characters models write instead of LaTeX commands.
 * pdfLaTeX's default inputenc rejects them ("Unicode character δ ... not set
 * up for use with LaTeX"), which used to make an otherwise valid diagram fall
 * back to source. Map the characters to base LaTeX commands; \ensuremath keeps
 * the replacement valid in both math cells and \text{...} labels.
 */
const UNICODE_MATH: readonly (readonly [string, string])[] = [
  // Greek, lower case.
  ['α', '\\alpha'], ['β', '\\beta'], ['γ', '\\gamma'], ['δ', '\\delta'],
  ['ε', '\\varepsilon'], ['ϵ', '\\epsilon'], ['ζ', '\\zeta'], ['η', '\\eta'],
  ['θ', '\\theta'], ['ϑ', '\\vartheta'], ['ι', '\\iota'], ['κ', '\\kappa'],
  ['λ', '\\lambda'], ['μ', '\\mu'], ['ν', '\\nu'], ['ξ', '\\xi'],
  ['π', '\\pi'], ['ρ', '\\rho'], ['ϱ', '\\varrho'], ['σ', '\\sigma'],
  ['ς', '\\varsigma'], ['τ', '\\tau'], ['υ', '\\upsilon'], ['φ', '\\varphi'],
  ['ϕ', '\\phi'], ['χ', '\\chi'], ['ψ', '\\psi'], ['ω', '\\omega'],
  // Greek, upper case (only the forms that have a distinct LaTeX command).
  ['Γ', '\\Gamma'], ['Δ', '\\Delta'], ['Θ', '\\Theta'], ['Λ', '\\Lambda'],
  ['Ξ', '\\Xi'], ['Π', '\\Pi'], ['Σ', '\\Sigma'], ['Υ', '\\Upsilon'],
  ['Φ', '\\Phi'], ['Ψ', '\\Psi'], ['Ω', '\\Omega'],
  // Arrows and relations.
  ['→', '\\rightarrow'], ['←', '\\leftarrow'], ['↔', '\\leftrightarrow'],
  ['⇒', '\\Rightarrow'], ['⇐', '\\Leftarrow'], ['⇔', '\\Leftrightarrow'],
  ['⟶', '\\longrightarrow'], ['⟵', '\\longleftarrow'], ['⟹', '\\Longrightarrow'],
  ['⟸', '\\Longleftarrow'], ['⟺', '\\Longleftrightarrow'], ['↦', '\\mapsto'],
  ['≤', '\\le'], ['≥', '\\ge'], ['≠', '\\ne'], ['≈', '\\approx'],
  ['∼', '\\sim'], ['≃', '\\simeq'], ['≅', '\\cong'], ['≡', '\\equiv'],
  ['≪', '\\ll'], ['≫', '\\gg'], ['∝', '\\propto'],
  // Sets, operators and delimiters.
  ['∈', '\\in'], ['∉', '\\notin'], ['∋', '\\ni'], ['⊂', '\\subset'],
  ['⊆', '\\subseteq'], ['⊃', '\\supset'], ['⊇', '\\supseteq'],
  ['∪', '\\cup'], ['∩', '\\cap'], ['∅', '\\emptyset'], ['∖', '\\setminus'],
  ['×', '\\times'], ['∗', '\\ast'], ['⋆', '\\star'], ['·', '\\cdot'],
  ['∘', '\\circ'], ['±', '\\pm'], ['∓', '\\mp'], ['−', '-'],
  ['∞', '\\infty'], ['∑', '\\sum'], ['∏', '\\prod'], ['∫', '\\int'],
  ['∮', '\\oint'], ['∂', '\\partial'], ['∇', '\\nabla'],
  ['∀', '\\forall'], ['∃', '\\exists'], ['¬', '\\neg'], ['∧', '\\wedge'],
  ['∨', '\\vee'], ['⊢', '\\vdash'], ['⊨', '\\models'], ['⊥', '\\perp'],
  ['∥', '\\parallel'], ['⟨', '\\langle'], ['⟩', '\\rangle'],
  ['…', '\\ldots'], ['⋯', '\\cdots'], ['′', '\\prime'],
  ['ℓ', '\\ell'], ['ℏ', '\\hbar'],
  ['ℤ', '\\mathbb{Z}'], ['ℝ', '\\mathbb{R}'], ['ℂ', '\\mathbb{C}'],
  ['ℕ', '\\mathbb{N}'], ['ℚ', '\\mathbb{Q}'], ['ℙ', '\\mathbb{P}'],
  ['ℍ', '\\mathbb{H}'],
]

function normalizeUnicodeMath(source: string): string {
  let normalized = source
  for (const [character, latex] of UNICODE_MATH) {
    if (!normalized.includes(character)) continue
    normalized = normalized.split(character).join(`\\ensuremath{${latex}}`)
  }
  return normalized
}

/**
 * Paper size for the isolated compile. `standalone` is not part of every TeX
 * Live subset, so the wrapper uses an oversized article page and lets
 * `dvisvgm --bbox=min` crop the ink. 4000 pt stays well below TeX's page
 * limits while leaving room for figures far wider than a terminal window.
 */
const TIKZ_PAPER_SIZE_PT = 4000

// NB: the Nix package preloads a format with this paper size (flake.nix
// `tikzFormat`); change both together or normal and format mode diverge.

/**
 * Libraries preloaded with every figure. They cover the overwhelming
 * majority of model-written TikZ without a `\usetikzlibrary` line:
 * `arrows.meta` for `-{Stealth}`, `positioning` for `right=of`,
 * `calc` for `($…$)` coordinates, `automata` for state machines and
 * `shapes.geometric` for the common node shapes. They are cheap in a
 * preloaded format and only ~0.2 s in a cold compile.
 */
// NB: keep in step with the format preamble in flake.nix (`tikzFormat`).
const TIKZ_DEFAULT_LIBRARIES: readonly string[] = [
  'arrows.meta',
  'positioning',
  'calc',
  'automata',
  'shapes.geometric',
]

/** Fence info strings routed to the TikZ renderer. */
const TIKZ_LANGUAGES: ReadonlySet<string> = new Set(['tikz', 'tikzpicture', 'tikzcd', 'tikz-cd'])

/** Environments that only make sense through TikZ. */
const TIKZ_ENVIRONMENTS: readonly string[] = ['tikzpicture', 'tikzcd', 'axis']

/**
 * Packages a figure may request explicitly. Anything else is refused rather
 * than loaded into the isolated run; a missing style is cheaper to diagnose
 * as "source fallback" than an arbitrary package from model output.
 */
// NB: every name here must be preloaded by the Nix format preamble too.
const ALLOWED_PACKAGES: ReadonlySet<string> = new Set([
  'amsmath',
  'amssymb',
  'amsfonts',
  'mathtools',
  'bm',
  'xcolor',
  'array',
  'multirow',
  'makecell',
])

export type TikzSourceFailure =
  | 'empty'
  | 'input-too-long'
  | 'unsafe'
  | 'unsupported-document'
  | 'no-figure'

export interface TikzDocument {
  /** Complete LaTeX source handed to `latex`. */
  readonly document: string
  /** Whether the body needs the `tikz-cd` package. */
  readonly usesTikzCd: boolean
  /** Whether the body needs `pgfplots` (and its compatibility level). */
  readonly usesPgfplots: boolean
  /** Hoisted `\usetikzlibrary` names, without the defaults. */
  readonly libraries: readonly string[]
}

export type TikzDocumentResult =
  | { readonly ok: true; readonly document: TikzDocument }
  | { readonly ok: false; readonly failure: TikzSourceFailure }

/** Whether a fenced code block's info string names TikZ. */
export function isTikzLang(lang: string | undefined): boolean {
  if (lang === undefined) return false
  const name = lang.trim().split(/\s+/, 1)[0]
  return name !== undefined && TIKZ_LANGUAGES.has(name.toLowerCase())
}

/** Whether a display-math token body contains a figure this renderer owns. */
export function isTikzSource(text: string): boolean {
  return /\\begin\s*\{(?:tikzpicture|tikzcd|axis)\*?\}/u.test(text) || /\\tikz\b/u.test(text)
}

/**
 * Whether every TikZ environment opened in `source` is closed. Used to start
 * a compile while the reply is still streaming: the closing fence may not
 * have arrived yet, but a balanced `\begin…\end` is enough to render.
 */
export function hasCompleteTikzFigure(source: string): boolean {
  let found = false
  for (const environment of TIKZ_ENVIRONMENTS) {
    const begins = countEnvironment(source, environment, 'begin')
    if (begins === 0) continue
    found = true
    if (countEnvironment(source, environment, 'end') < begins) return false
  }
  return found
}

/** Whether a ``` / ~~~ fence in `raw` has its closing fence. */
export function isClosedCodeFence(raw: string): boolean {
  const lines = raw.trimEnd().split('\n')
  const opener = /^ {0,3}(`{3,}|~{3,})/u.exec(lines[0] ?? '')?.[1]
  if (opener === undefined) return false
  const closer = (lines[lines.length - 1] ?? '').trim()
  if (closer.length < opener.length) return false
  const char = opener[0]!
  return [...closer].every(character => character === char)
}

function countEnvironment(source: string, environment: string, kind: 'begin' | 'end'): number {
  const pattern = new RegExp(`\\\\${kind}\\s*\\{${environment}\\*?\\}`, 'gu')
  let count = 0
  while (pattern.exec(source) !== null) count += 1
  return count
}

/**
 * Commands that can read files, write files, spawn processes or rewire TeX's
 * own parsing. `-no-shell-escape` + `openin_any=p` are the actual boundary;
 * this list keeps obviously hostile input from ever reaching the engine and
 * makes the rejected route easy to test.
 */
const FORBIDDEN_COMMAND =
  /\\(?:input|include|includeonly|openin|openout|read|write|write18|directlua|special|catcode|escapechar|endlinechar|newwrite|usepackage|RequirePackage)\b/u

const PACKAGE_COMMAND = /\\usepackage\s*(\[[^\]]*\])?\s*\{([^}]*)\}/gu
const LIBRARY_COMMAND = /\\usetikzlibrary\s*\{([^}]*)\}/gu
const DOCUMENT_CLASS = /\\documentclass\b/u

/**
 * Build the isolated document for one figure.
 *
 * Rejections are deliberately typed so the caller can fall back to the source
 * without parsing a TeX log. The source itself is never rewritten beyond
 * hoisting its preamble commands and stripping a document wrapper.
 */
export function buildTikzDocument(source: string): TikzDocumentResult {
  const trimmed = source.trim()
  if (trimmed === '') return { ok: false, failure: 'empty' }
  if (trimmed.length > TIKZ_SOURCE_LIMIT) return { ok: false, failure: 'input-too-long' }
  if (DOCUMENT_CLASS.test(trimmed)) return { ok: false, failure: 'unsupported-document' }

  // Hoist preamble commands out of the body. Run over the whole source so a
  // `\begin{document}` wrapper keeps its packages; the body extraction below
  // then removes the wrapper itself.
  const libraries: string[] = []
  const packages: string[] = []
  let body = trimmed

  body = body.replace(LIBRARY_COMMAND, (_match, names: string) => {
    for (const name of names.split(',')) {
      const library = name.trim()
      if (library === '') continue
      if (!/^[A-Za-z0-9._-]+$/u.test(library)) {
        libraries.push('\u0000invalid')
        continue
      }
      if (!libraries.includes(library)) libraries.push(library)
    }
    return ''
  })

  body = body.replace(PACKAGE_COMMAND, (_match, options: string | undefined, names: string) => {
    for (const name of names.split(',')) {
      const packageName = name.trim()
      if (packageName === '') continue
      if (!ALLOWED_PACKAGES.has(packageName)) {
        packages.push('\u0000invalid')
        continue
      }
      const optionText = options === undefined ? '' : options.trim()
      if (optionText !== '' && !/^\[[A-Za-z0-9,=._ -]*\]$/u.test(optionText)) {
        packages.push('\u0000invalid')
        continue
      }
      const command = `\\usepackage${optionText}${`{${packageName}}`}`
      if (!packages.includes(command)) packages.push(command)
    }
    return ''
  })

  if (libraries.includes('\u0000invalid') || packages.includes('\u0000invalid')) {
    return { ok: false, failure: 'unsafe' }
  }

  // A wrapper without \documentclass still contributes its body. The
  // \documentclass case was refused above, so there is no user-controlled
  // preamble to honour.
  const beginDocument = body.indexOf('\\begin{document}')
  if (beginDocument >= 0) {
    const brace = body.indexOf('}', beginDocument)
    body = body.slice(brace + 1)
    const endDocument = body.lastIndexOf('\\end{document}')
    if (endDocument >= 0) body = body.slice(0, endDocument)
  }
  body = body.replace(/\\end\{document\}/gu, '').trim()
  body = normalizeUnicodeMath(body)

  if (body === '') return { ok: false, failure: 'no-figure' }
  if (FORBIDDEN_COMMAND.test(body)) return { ok: false, failure: 'unsafe' }
  if (!isTikzSource(body)) return { ok: false, failure: 'no-figure' }

  const usesTikzCd = /\\begin\s*\{tikzcd\*?\}/u.test(body)
  const usesPgfplots = /\\begin\s*\{axis\*?\}|\\addplot\b|\\pgfplotsset\b/u.test(body)
  const allLibraries = [...new Set([...TIKZ_DEFAULT_LIBRARIES, ...libraries])]

  const preamble = [
    '\\documentclass{article}',
    `\\usepackage[paperwidth=${TIKZ_PAPER_SIZE_PT}pt,paperheight=${TIKZ_PAPER_SIZE_PT}pt,margin=0pt]{geometry}`,
    '\\usepackage{tikz}',
    ...(usesTikzCd ? ['\\usepackage{tikz-cd}'] : []),
    ...(usesPgfplots ? ['\\usepackage{pgfplots}', '\\pgfplotsset{compat=1.18}'] : []),
    // Always available so \operatorname, \mathbb and mathtools constructs in
    // model diagrams also work without the preloaded format.
    '\\usepackage{amsmath}',
    '\\usepackage{amssymb}',
    '\\usepackage{mathtools}',
    ...packages,
  ].join('\n')

  return {
    ok: true,
    document: {
      // The library line lives inside the document body on purpose: a
      // preloaded format (mylatexformat) skips the preamble entirely, so
      // model-requested libraries must be loadable after \begin{document}.
      // LaTeX accepts \usetikzlibrary there, and re-loading a library the
      // format already has is harmless.
      document: `${preamble}\n\\begin{document}\n\\thispagestyle{empty}\n\\usetikzlibrary{${allLibraries.join(',')}}\n${body}\n\\end{document}\n`,
      usesTikzCd,
      usesPgfplots,
      libraries,
    },
  }
}
