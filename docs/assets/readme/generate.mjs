// Run with Node 24 from the repository root: node docs/assets/readme/generate.mjs
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'
import icons from './lucide-icons.json' with { type: 'json' }
import { renderRuntime } from './runtime-svg.mjs'
import { withWelcomeCopy } from './welcome-copy.mjs'

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

await mkdir(directory, { recursive: true })
for (const language of ['zh', 'en']) {
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
console.log('Generated 4 captured terminal previews and 16 documentation tiles.')
