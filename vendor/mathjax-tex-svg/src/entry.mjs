// TeX → SVG with MathJax 3, bundled into one file for dsh-tui (see NOTICE).
// Only the TeX input jax, the SVG output jax and the lite DOM adaptor are
// included. `noerrors` and `noundefined` are left out so malformed or
// unknown TeX throws instead of rendering as red error text: the caller
// turns the throw into a typed failure and falls back to Unicode. `html`
// (\href, \class, \style, \cssId, \data) is left out because the TeX comes
// from model output and those commands would carry links and CSS into the
// SVG handed to the rasterizer.
import { mathjax } from 'mathjax-full/js/mathjax.js'
import { TeX } from 'mathjax-full/js/input/tex.js'
import { SVG } from 'mathjax-full/js/output/svg.js'
import { liteAdaptor } from 'mathjax-full/js/adaptors/liteAdaptor.js'
import { RegisterHTMLHandler } from 'mathjax-full/js/handlers/html.js'
import { AllPackages } from 'mathjax-full/js/input/tex/AllPackages.js'

const EXCLUDED_PACKAGES = new Set(['noerrors', 'noundefined', 'html'])
const PACKAGES = AllPackages.filter(name => !EXCLUDED_PACKAGES.has(name))

/** Create one converter; loading MathJax is costly, so callers keep it. */
export function createTexToSvg() {
  const adaptor = liteAdaptor()
  RegisterHTMLHandler(adaptor)
  // A MathJax document keeps TeX state between conversions: \newcommand,
  // \def, \DeclareMathOperator and \label all outlive the formula that
  // made them. Each formula here stands alone (callers cache by its source),
  // so each one gets a fresh input jax and document — a few hundred µs.
  const freshDocument = () => mathjax.document('', {
    InputJax: new TeX({
      packages: PACKAGES,
      // By default MathJax typesets a TeX error as a red message; throw instead.
      formatError: (_jax, error) => { throw error },
    }),
    OutputJax: new SVG({ fontCache: 'local' }),
  })
  return {
    /** @returns the standalone `<svg>` and its size in ex; throws on bad TeX. */
    convert(tex, display) {
      const container = freshDocument().convert(tex, { display })
      const svg = adaptor.firstChild(container)
      if (svg === null || adaptor.kind(svg) !== 'svg') throw new Error('MathJax produced no <svg>')
      const width = parseEx(adaptor.getAttribute(svg, 'width'))
      const height = parseEx(adaptor.getAttribute(svg, 'height'))
      const style = adaptor.getAttribute(svg, 'style') ?? ''
      const verticalAlign = parseEx(/vertical-align:\s*([-\d.]+ex)/.exec(style)?.[1] ?? '0ex')
      return { svg: adaptor.outerHTML(svg), widthEx: width, heightEx: height, verticalAlignEx: verticalAlign }
    },
  }
}

function parseEx(value) {
  const match = /^(-?[\d.]+)ex$/.exec(value ?? '')
  if (match === null) throw new Error(`MathJax size is not in ex: ${value}`)
  return Number(match[1])
}
