/**
 * Working-activity indicator presets, ported from the pi
 * working-activity extension (`FRAME_PRESETS`). The TUI renders the current
 * frame next to the live working line, tinted by the activity phase.
 * `\uFE0E` forces text rendering so Windows never paints the glyphs as
 * color emoji (the green-block problem).
 */

/** Text-variant selector: keep symbols monochrome on Windows. */
const TE = '\uFE0E'

export interface FramePreset {
  readonly frames: readonly string[]
  readonly intervalMs: number
}

export const FRAME_PRESETS: Record<string, FramePreset> = {
  // Claude Code's real sequence: · ✢ * ✶ ✻ ✽ forward + backward.
  claude: {
    frames: ['·', `✢${TE}`, '*', `✶${TE}`, `✻${TE}`, `✽${TE}`, `✻${TE}`, `✶${TE}`, '*', `✢${TE}`],
    intervalMs: 150,
  },
  star2: { frames: [`✶${TE}`, `✸${TE}`, `✹${TE}`, `✺${TE}`, `✹${TE}`, `✷${TE}`], intervalMs: 140 },
  sand: {
    frames: ['⠁', '⠂', '⠄', '⡀', '⡈', '⡐', '⡠', '⣀', '⣁', '⣂', '⣄', '⣌', '⣔', '⣤', '⣥', '⣦', '⣮', '⣶', '⣷', '⣿', '⡿', '⠿', '⢟', '⠟', '⡛', '⠛', '⠫', '⢋', '⠋', '⠍', '⡉', '⠉', '⠑', '⠡', '⢁'],
    intervalMs: 120,
  },
  triangle: { frames: ['◢', '◣', '◤', '◥'], intervalMs: 180 },
  box: { frames: ['▖', '▘', '▝', '▗'], intervalMs: 180 },
  box2: { frames: ['▌', '▀', '▐', '▄'], intervalMs: 180 },
  corners: { frames: ['◰', '◳', '◲', '◱'], intervalMs: 190 },
  point: { frames: ['∙∙∙', '●∙∙', '∙●∙', '∙∙●', '∙∙∙'], intervalMs: 190 },
  layer: { frames: ['-', '=', '≡'], intervalMs: 220 },
  flip: { frames: ['_', '_', '_', '-', '`', '`', "'", '´', '-', '_', '_', '_'], intervalMs: 140 },
  aesthetic: {
    frames: ['▰▱▱▱▱▱▱', '▰▰▱▱▱▱▱', '▰▰▰▱▱▱▱', '▰▰▰▰▱▱▱', '▰▰▰▰▰▱▱', '▰▰▰▰▰▰▱', '▰▰▰▰▰▰▰', '▰▱▱▱▱▱▱'],
    intervalMs: 140,
  },
  hamburger: { frames: ['☱', '☲', '☴'], intervalMs: 220 },
  moon: { frames: ['◐', '◓', '◑', '◒'], intervalMs: 240 },
  comet: {
    frames: ['●    ', ' ●   ', '  ●  ', '   ● ', '    ●', '   ● ', '  ●  ', ' ●   '],
    intervalMs: 160,
  },
  breathe: { frames: ['▁', '▃', '▅', '▇', '▅', '▃'], intervalMs: 210 },
  dots: { frames: ['⣾', '⣷', '⣯', '⣟', '⡿', '⢿', '⣻', '⣽'], intervalMs: 140 },
  arrow: { frames: ['←', '↖', '↑', '↗', '→', '↘', '↓', '↙'], intervalMs: 160 },
  spark: { frames: ['·', '∘', '°', '✧', '°', '∘'], intervalMs: 240 },
  bar: { frames: ['▏', '▎', '▍', '▌', '▋', '▊', '▉', '█', '▉', '▊', '▋', '▌', '▍', '▎'], intervalMs: 120 },
  braille: { frames: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'], intervalMs: 120 },
  arc: { frames: ['◜', '◠', '◝', '◞', '◡', '◟'], intervalMs: 160 },
  circle: { frames: ['◴', '◷', '◶', '◵'], intervalMs: 190 },
  grow: { frames: ['.', 'o', 'O', '0', 'O', 'o'], intervalMs: 210 },
  noise: { frames: ['▓', '▒', '░', '▒'], intervalMs: 160 },
  bounce: { frames: ['⠁', '⠂', '⠄', '⡀', '⢀', '⠠', '⠐', '⠈'], intervalMs: 140 },
  rainbow: {
    frames: ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█', '▇', '▆', '▅', '▄', '▃', '▂'],
    intervalMs: 120,
  },
  dqpb: { frames: ['d', 'q', 'p', 'b'], intervalMs: 210 },
  toggle: { frames: ['⊶', '⊷'], intervalMs: 300 },
}

/** The pi extension's default preset. */
export const DEFAULT_PRESET = 'moon'

/** Resolve a preset name (`random` picks one per process). */
export function resolvePreset(name: string | undefined): FramePreset {
  if (name === 'random') {
    const names = Object.keys(FRAME_PRESETS)
    const pick = names[Math.floor(Math.random() * names.length)]
    if (pick !== undefined) return FRAME_PRESETS[pick]!
  }
  return FRAME_PRESETS[name ?? ''] ?? FRAME_PRESETS[DEFAULT_PRESET]!
}
