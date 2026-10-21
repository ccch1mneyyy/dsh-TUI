/** Capability-depth checks for raw sprite, title and status emitters. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const cases = [
  { name: 'off', env: { FORCE_COLOR: '0' }, level: 0 },
  { name: 'ansi16', env: { FORCE_COLOR: '1' }, level: 1 },
  { name: 'ansi256', env: { FORCE_COLOR: '2' }, level: 2 },
  { name: 'truecolor', env: { FORCE_COLOR: '3' }, level: 3 },
  { name: 'no-color', env: { NO_COLOR: '1' }, level: 0 },
  { name: 'apple-terminal', env: { TERM_PROGRAM: 'Apple_Terminal', FORCE_COLOR: '2' }, level: 2 },
  { name: 'tmux', env: { TMUX: '/fixture', FORCE_COLOR: '3' }, level: 2 },
  { name: 'tmux-explicit', env: { TMUX: '/fixture', FORCE_COLOR: '3', DSH_TUI_TMUX_TRUECOLOR: '1' }, level: 3 },
]
const selected = process.argv[2]
if (selected === undefined) {
  const outputs = []
  for (const fixture of cases) {
    const env = { ...process.env }
    for (const key of ['FORCE_COLOR', 'NO_COLOR', 'TERM_PROGRAM', 'TERM_PROGRAM_VERSION', 'COLORTERM', 'TMUX', 'DSH_TUI_TMUX_TRUECOLOR', 'CI']) delete env[key]
    const result = spawnSync(process.execPath, ['--import', 'tsx/esm', fileURLToPath(import.meta.url), fixture.name], {
      env: { ...env, ...fixture.env }, encoding: 'utf8', timeout: 30_000,
    })
    assert.equal(result.status, 0, `${fixture.name}: ${result.stderr}`)
    outputs.push(JSON.parse(result.stdout))
  }
  for (const output of outputs) assert.deepEqual(output, outputs[0], 'color depth must not change glyphs, spacing or display widths')
  console.log('PASS raw emitters share color depth; glyphs and widths are unchanged')
} else {
  const fixture = cases.find(value => value.name === selected)
  assert.ok(fixture)
  const [{ default: chalk }, { default: stripAnsi }, { renderCellRows }, { renderBigText }, { splashFontById }, metrics, { stringWidth }] = await Promise.all([
    import('chalk'), import('strip-ansi'), import('../src/components/Whale.js'),
    import('../src/components/bigfont.js'), import('../src/components/splashFonts.js'),
    import('../src/screens/StatusMetrics.js'), import('../src/ink/stringWidth.js'),
  ])
  assert.equal(chalk.level, fixture.level)
  const red = [255, 0, 0]
  const blue = [0, 0, 255]
  const rows = renderCellRows(4, 2, (x, y) => x === 0 ? (y === 0 ? red : blue) : x === 1 && y === 0 ? red : x === 2 && y === 1 ? blue : undefined)
  assert.equal(stripAnsi(rows[0]), '▀▀▄ ')
  if (fixture.level > 0) {
    assert.ok(rows[0].includes('\x1b[49m'), 'transparent half restores the default background')
    assert.ok(rows[0].endsWith('\x1b[0m\x1b[K'), 'row closes style before erase')
  }
  const rgb = { r: 78, g: 111, b: 255 }
  const font = splashFontById('bold')
  const samples = [
    ...rows, ...renderBigText(font, 'DEEPSEEK', 0, rgb, rgb, rgb),
    metrics.pressureColor(50, '正常'), metrics.pressureColor(90, 'warning'), metrics.pressureColor(99, 'high'),
    metrics.speedColor(10, 'slow'), metrics.speedColor(30, 'medium'), metrics.speedColor(100, 'fast'),
    metrics.renderContextBar({ system: 10, prompt: 20, assistant: 30, thinking: 10, tools: 10 }, 80, 200, 30),
  ]
  for (const sample of samples) {
    if (fixture.level < 3) assert.doesNotMatch(sample, /\x1b\[(?:38|48);2;/)
    if (fixture.level < 2) assert.doesNotMatch(sample, /\x1b\[(?:38|48);5;/)
    if (fixture.level === 0) assert.doesNotMatch(sample, /\x1b\[[\d;]*m/)
  }
  if (fixture.level === 3) assert.match(rows[0], /\x1b\[38;2;255;0;0m/)
  process.stdout.write(JSON.stringify(samples.map(sample => ({ text: stripAnsi(sample), width: stringWidth(sample) }))))
}
