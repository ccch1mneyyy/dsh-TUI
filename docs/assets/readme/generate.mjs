// Run with Node 24 from the repository root: node docs/assets/readme/generate.mjs
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'
import icons from './lucide-icons.json' with { type: 'json' }
import { renderRuntime } from './runtime-svg.mjs'
import { withWelcomeCopy } from './welcome-copy.mjs'
import { WHALE_FRAMES } from '../../../src/components/whaleFrames.ts'

const directory = dirname(fileURLToPath(import.meta.url))
const root = resolve(directory, '../../..')
const xml = value => String(value).replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
})[character])
const repository = 'https://github.com/says693/dsh-TUI-693/blob/main/'
const docs = [
  ['start', 'Terminal', 'getting-started', '安装与快速开始', 'Getting started', '安装、启动与源码开发', 'Install, launch, develop', '#8bb6fb'],
  ['configuration', 'Settings2', 'configuration', '配置参考', 'Configuration', 'Cordis、模型、MCP 与环境变量', 'Cordis, models, MCP, environment', '#e5c07b'],
  ['interaction', 'MessagesSquare', 'interaction', '交互与命令', 'Interaction & commands', '快捷键、鼠标与会话工作流', 'Keys, mouse, sessions', '#65d4bc'],
  ['themes', 'Palette', 'themes', '主题系统', 'Themes', '内置主题、自动检测与自定义配色', 'Built-in and custom palettes', '#e697bc'],
  ['architecture', 'Workflow', 'architecture', '架构与限制', 'Architecture & limits', '运行链路、持久化与权限边界', 'Runtime, storage, permissions', '#8bb6fb'],
  ['vscode', 'PanelsTopLeft', 'vscode', 'VS Code 使用指南', 'VS Code guide', '集成终端、多会话与历史恢复', 'Terminal, sessions, history', '#65d4bc'],
  ['plugins', 'Blocks', 'https://github.com/T-Auto/dsh-ecosystem-spec/blob/main/docs/plugin-admission-and-development.md', '插件准入与开发', 'Plugin development', '准入规范、扩展接口与验证清单', 'Admission, contracts, verification', '#e5c07b'],
  ['contributing', 'GitPullRequest', 'contributing', '贡献与开发约定', 'Contributing', '仓库地图、构建与验证矩阵', 'Repository, builds, verification', '#e697bc'],
]
const href = (entry, language) => entry[2].startsWith('https:')
  ? entry[2]
  : `docs/${entry[2]}${language === 'en' && !['README', 'links'].includes(entry[2]) ? '.en' : ''}.md`
const icon = (name, x, y, color = '#98a4b5', size = 24) => {
  if (!icons[name]) throw new Error(`Unknown Lucide icon: ${name}`)
  const elements = icons[name].map(([tag, attributes]) =>
    `<${tag} ${Object.entries(attributes).map(([key, value]) => `${key}="${xml(value)}"`).join(' ')}/>`).join('')
  return `<g transform="translate(${x} ${y}) scale(${size / 24})" fill="none" stroke="${color}" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${elements}</g>`
}
const font = '"Cascadia Code","SFMono-Regular",Consolas,"Liberation Mono","Microsoft YaHei",monospace'
const text = (x, y, value, size = 18, fill = '#dde3ec', attributes = '') =>
  `<text x="${x}" y="${y}" font-size="${size}" fill="${fill}" ${attributes}>${xml(value)}</text>`
const svg = (width, height, title, description, content, styles = '') => `\
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title desc">
  <title id="title">${xml(title)}</title>
  <desc id="desc">${xml(description)}</desc>
  <style>
    text { font-family: ${font}; letter-spacing: 0; }
    a:hover .tile { fill: #1b2028; }
    a:focus-visible .tile { stroke: #8bb6fb; stroke-width: 3; }
    ${styles}
  </style>
  ${content}
</svg>
`

const whaleLogo = language => {
  const en = language === 'en'
  const palette = { D: '#142660', B: '#4e6fff', L: '#bee1ff', W: '#ffffff' }
  const logoPoseNames = new Set(['standard', 'blink', 'fin1', 'fin2', 'tail1', 'tail2', 'tail3', 'tail4'])
  const logoFrames = WHALE_FRAMES.filter(frame => logoPoseNames.has(frame.name))
  const frames = logoFrames.map((frame, index) => {
    const paths = new Map(Object.keys(palette).map(key => [key, '']))
    frame.rows.forEach((row, y) => [...row].forEach((pixel, x) => {
      if (pixel !== '.' && pixel !== 'H') paths.set(pixel, paths.get(pixel) + `M${x} ${y}h1v1h-1z`)
    }))
    const start = (index / logoFrames.length * 100).toFixed(5)
    const end = ((index + 1) / logoFrames.length * 100).toFixed(5)
    return {
      css: `.logo-whale-${index}{animation:logoWhale${index} 5200ms step-end infinite}@keyframes logoWhale${index}{${index === 0 ? '0%{visibility:visible}' : `0%{visibility:hidden}${start}%{visibility:visible}`}${end}%{visibility:hidden}}`,
      svg: `<g class="logo-whale-frame logo-whale-${index}" data-whale-frame="${index}" data-pose="${xml(frame.name)}">${[...paths].filter(([, d]) => d).map(([key, d]) => `<path fill="${palette[key]}" d="${d}"/>`).join('')}</g>`,
    }
  })
  const desireLabel = en ? 'I want' : '我想要'
  const thankLabel = en ? 'Thank you' : '感谢'
  const idleLabel = en ? 'Star this repo' : '点亮星标'
  const activeLabel = en ? 'Starred' : '已加星标'
  const star = 'M15 1.8l4.1 8.3 9.2 1.3-6.7 6.5 1.6 9.2L15 22.8 6.8 27.1l1.6-9.2-6.7-6.5 9.2-1.3z'
  return svg(760, 180, en ? 'dsh-TUI animated logo' : 'dsh-TUI 动态 Logo',
    en ? 'An animated whale with a GitHub star button.' : '带有 GitHub 星标按钮的动态鲸鱼 Logo。',
    `<style>
      .logo-whale-frame{visibility:hidden}.logo-desire,.logo-star-idle,.logo-thank,.logo-star-active{opacity:0}
      ${frames.map(frame => frame.css).join('')}
      .logo-desire{animation:logoDesire 5200ms ease-in-out infinite}
      .logo-star-idle{animation:logoStarIdle 5200ms ease-in-out infinite}
      .logo-thank{animation:logoThank 5200ms ease-in-out infinite}
      .logo-star-active{animation:logoStarActive 5200ms ease-in-out infinite}
      @keyframes logoDesire{0%{opacity:0;transform:translate(22px,28px) translateY(7px)}6%,19%{opacity:1;transform:translate(22px,28px) translateY(0)}25%,100%{opacity:0;transform:translate(22px,28px) translateY(-4px)}}
      @keyframes logoStarIdle{0%,25%{opacity:0;transform:translate(22px,28px) translateY(7px)}31%,44%{opacity:1;transform:translate(22px,28px) translateY(0)}50%,100%{opacity:0;transform:translate(22px,28px)}}
      @keyframes logoThank{0%,50%{opacity:0;transform:translate(22px,28px) translateY(7px)}56%,69%{opacity:1;transform:translate(22px,28px) translateY(0)}75%,100%{opacity:0;transform:translate(22px,28px) translateY(-4px)}}
      @keyframes logoStarActive{0%,75%{opacity:0;transform:translate(22px,28px) translateY(5px)}81%,94%{opacity:1;transform:translate(22px,28px) translateY(0)}100%{opacity:0;transform:translate(22px,28px)}}
      .logo-wordmark{fill:#263146}.logo-descriptor{fill:#687386}.logo-rule{stroke:#abc2ec}
      @media (prefers-color-scheme: dark){.logo-wordmark{fill:#e8e6e0}.logo-descriptor{fill:#abc2ec}.logo-rule{stroke:#5e88cc}}
      @media (prefers-reduced-motion: reduce){
        .logo-whale-frame{visibility:hidden;animation:none}
        .logo-whale-0{visibility:visible}
        .logo-desire,.logo-star-idle,.logo-thank,.logo-star-active{opacity:0;animation:none}
        .logo-star-active{opacity:1}
      }
    </style>
    <g transform="translate(8 48) scale(4.15)" shape-rendering="crispEdges">${frames.map(frame => frame.svg).join('')}</g>
    <g class="logo-desire" transform="translate(22 28)">
      <rect x="0" y="0" width="78" height="30" rx="8" fill="#263146"/>
      <path d="M16 30l7 7 7-7" fill="#263146"/>
      <text x="39" y="21" text-anchor="middle" font-size="15" font-weight="700" fill="#ffffff">${xml(desireLabel)}</text>
    </g>
    <g class="logo-thank" transform="translate(22 28)">
      <rect x="0" y="0" width="${en ? 147 : 96}" height="30" rx="8" fill="#263146"/>
      <path d="M16 30l7 7 7-7" fill="#263146"/>
      <text x="${en ? 73.5 : 48}" y="21" text-anchor="middle" font-size="15" font-weight="700" fill="#ffffff">${xml(thankLabel)}<tspan font-size="12" dx="6">≧∀≦</tspan></text>
    </g>
    <a href="https://github.com/says693/dsh-TUI-693/stargazers" aria-label="${xml(activeLabel)}">
      <g class="logo-star-idle" transform="translate(22 28)">
        <rect x="0" y="0" width="${en ? 142 : 126}" height="34" rx="8" fill="#f5f7fa" stroke="#c6d0dc" stroke-width="2"/>
        <path d="${star}" transform="translate(8 3) scale(.75)" fill="none" stroke="#65717f" stroke-width="2"/>
        <text x="${en ? 82 : 74}" y="${en ? 22 : 23}" text-anchor="middle" font-size="${en ? 11 : 15}" font-weight="700" fill="#263146">${xml(idleLabel)}</text>
      </g>
      <g class="logo-star-active" transform="translate(22 28)">
        <rect x="0" y="0" width="${en ? 142 : 126}" height="34" rx="8" fill="#fff8d9" stroke="#e1ad1b" stroke-width="2"/>
        <path d="${star}" transform="translate(8 3) scale(.75)" fill="#f2bf27" stroke="#e1ad1b" stroke-width="1"/>
        <text x="${en ? 82 : 74}" y="${en ? 22 : 23}" text-anchor="middle" font-size="${en ? 11 : 15}" font-weight="700" fill="#263146">${xml(activeLabel)}</text>
      </g>
    </a>
    <g transform="translate(225 31)">
      <text class="logo-wordmark" x="0" y="74" font-family="Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="72" font-weight="750"><tspan fill="#4b6fff">dsh</tspan><tspan>-TUI</tspan></text>
      <path class="logo-rule" d="M2 91H514" fill="none" stroke-width="2"/>
      <text class="logo-descriptor" x="2" y="121" font-family="ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', monospace" font-size="16" font-weight="600">DEEPSEEK HARNESS TERMINAL INTERFACE</text>
    </g>`).replace(/[ \t]+$/gm, '')
}

function tile(entry, language) {
  const en = language === 'en'
  const title = entry[en ? 4 : 3]
  const description = entry[en ? 6 : 5]
  const target = href(entry, language)
  const absolute = target.startsWith('https:') ? target : repository + target
  return svg(480, 96, title, description, `
    <a href="${xml(absolute)}">
      <rect class="tile" x="1" y="4" width="478" height="88" rx="6" fill="#111519" stroke="#303741"/>
      ${icon(entry[1], 20, 21, entry[7], 24)}
      ${text(58, 38, title, 21, '#edf1f6', 'font-weight="600"')}
      ${text(58, 68, description, 16, '#aeb8c6')}
      ${icon('ArrowUpRight', 434, 20, entry[7], 22)}
    </a>`)
}

function navigation(language) {
  const links = docs.map(entry =>
    `  <a href="${href(entry, language)}"><img src="docs/assets/readme/nav-${entry[0]}-${language}.svg" width="390" alt="${entry[language === 'en' ? 4 : 3]}"></a>`)
  return `<p align="center">\n${links.join('\n')}\n</p>`
}

function securityLink(language) {
  const en = language === 'en'
  const title = en ? 'Permissions & limits' : '权限规则与已知限制'
  const target = en ? 'docs/architecture.en.md#permissions-and-security-boundary' : 'docs/architecture.md#权限与安全边界'
  return svg(288, 44, title, en ? 'Read the full permission rules and limitations' : '查看完整权限规则与已知限制', `
    <a href="${xml(repository + target)}">
      <rect class="tile" x="1" y="1" width="286" height="42" rx="6" fill="#111519" stroke="#526174"/>
      ${icon('BookOpen', 14, 12, '#8bb6fb', 20)}
      ${text(46, 28, title, 16, '#edf1f6', 'font-weight="600"')}
      ${icon('ArrowUpRight', 252, 12, '#8bb6fb', 20)}
    </a>`.trim())
}

await mkdir(directory, { recursive: true })
for (const language of ['zh', 'en']) {
  await writeFile(resolve(directory, language === 'en' ? 'logo-en.svg' : 'logo.svg'), whaleLogo(language))
  await writeFile(resolve(directory, `security-link-${language}.svg`), securityLink(language))
  for (const mobile of [false, true]) {
    const recording = JSON.parse(await readFile(resolve(directory, 'runtime', `${language}-${mobile ? 'mobile' : 'desktop'}.json`), 'utf8'))
    await writeFile(resolve(directory, `preview-${language}${mobile ? '-mobile' : ''}.svg`), renderRuntime(withWelcomeCopy(recording)))
  }
  for (const entry of docs) {
    const target = href(entry, language)
    if (!target.startsWith('https:')) await readFile(resolve(root, target))
    await writeFile(resolve(directory, `nav-${entry[0]}-${language}.svg`), tile(entry, language))
  }
  const filename = resolve(root, language === 'en' ? 'README_EN.md' : 'README.md')
  const source = await readFile(filename, 'utf8')
  const start = '<!-- readme-svg-navigation:start -->'
  const end = '<!-- readme-svg-navigation:end -->'
  const first = source.indexOf(start)
  const last = source.indexOf(end)
  if (first < 0 || last < first) throw new Error(`Navigation markers missing: ${filename}`)
  const updated = source.slice(0, first + start.length) + '\n' + navigation(language) + '\n' + source.slice(last)
  if (source !== updated) await writeFile(filename, updated)
}
console.log('Generated 4 captured terminal previews, 16 documentation tiles and 2 security links.')
