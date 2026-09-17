// Run with Node 24 from the repository root: node docs/assets/readme/generate.mjs
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'
import icons from './lucide-icons.json' with { type: 'json' }
import { WHALE_FRAMES } from '../../../src/components/whaleFrames.ts'

const directory = dirname(fileURLToPath(import.meta.url))
const root = resolve(directory, '../../..')
const xml = value => String(value).replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
})[character])
const repository = 'https://github.com/says693/dsh-TUI-693/blob/main/'
const docs = [
  ['start', 'Terminal', 'getting-started', '安装与快速开始', 'Getting started', '安装、启动与源码开发', 'Install, launch, develop', '#8bb6fb'],
  ['interaction', 'MessagesSquare', 'interaction', '交互与命令', 'Interaction & commands', '快捷键、鼠标与会话工作流', 'Keys, mouse, sessions', '#65d4bc'],
  ['configuration', 'Settings2', 'configuration', '配置参考', 'Configuration', 'Cordis、模型、MCP 与环境变量', 'Cordis, models, MCP, environment', '#e5c07b'],
  ['themes', 'Palette', 'themes', '主题系统', 'Themes', '内置主题、自动检测与自定义配色', 'Built-in and custom palettes', '#e697bc'],
  ['architecture', 'Workflow', 'architecture', '架构与限制', 'Architecture & limits', '运行链路、持久化与权限边界', 'Runtime, storage, permissions', '#8bb6fb'],
  ['vscode', 'PanelsTopLeft', 'vscode', 'VS Code 使用指南', 'VS Code guide', '集成终端、多会话与历史恢复', 'Terminal, sessions, history', '#65d4bc'],
  ['plugins', 'Blocks', 'https://github.com/T-Auto/dsh-ecosystem-spec/blob/main/docs/plugin-admission-and-development.md', '插件准入与开发', 'Plugin development', '准入规范、扩展接口与验证清单', 'Admission, contracts, verification', '#e5c07b'],
  ['contributing', 'GitPullRequest', 'contributing', '贡献与开发约定', 'Contributing', '仓库地图、构建与验证矩阵', 'Repository, builds, verification', '#e697bc'],
  ['community', 'Users', 'community-management', '社区管理框架', 'Community management', '社区入口、角色与提案流程', 'Community, roles, proposals', '#8bb6fb'],
  ['roadmap', 'Route', 'roadmap', '项目路线图', 'Project roadmap', '公开目标、阶段与任务进展', 'Goals, milestones, progress', '#65d4bc'],
  ['index', 'BookOpen', 'README', '完整文档索引', 'All documentation', '全部中文与英文文档', 'The complete bilingual index', '#e5c07b'],
  ['links', 'Link', 'links', '社区与相关项目', 'Related projects', '友情链接与周边工具', 'Community links and companion tools', '#e697bc'],
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
const whale = () => {
  const colors = { D: '#1b2b62', B: '#506bff', L: '#b9e4ff', W: '#ffffff' }
  const paths = new Map(Object.keys(colors).map(key => [key, '']))
  WHALE_FRAMES[0].rows.forEach((row, y) => [...row].forEach((cell, x) => {
    if (cell !== '.') paths.set(cell, paths.get(cell) + `M${x} ${y}h1v1h-1z`)
  }))
  return [...paths].map(([cell, path]) => `<path fill="${colors[cell]}" d="${path}"/>`).join('')
}
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

function preview(language, mobile, still = false) {
  const en = language === 'en'
  const width = mobile ? 600 : 1200
  const height = mobile ? 790 : 700
  const left = mobile ? 24 : 40
  const inner = width - left * 2
  const composerY = mobile ? 274 : 256
  const transcriptY = composerY + 152
  const prompt = en ? 'Show me this example project' : '介绍一下这个示例项目'
  const draftWidth = en ? 327 : 220
  const bodySize = mobile ? 20 : 19
  const titleX = mobile ? 211 : 334
  const titleSize = mobile ? 36 : 52
  const baseline = mobile ? 136 : 132
  const response = en ? [
    'A terminal UI for DeepSeek Harness.',
    'Sessions, tools, themes. One workspace.',
  ] : ['这是 DeepSeek Harness 的终端工作台。', '会话、工具与主题，在同一处协作。']
  const styles = `
    .draft { opacity: 0; animation: draft 14s linear infinite; }
    .mask { transform-origin: 0 0; animation: typing 14s steps(${en ? 28 : 11}, end) infinite; }
    .caret { animation: cursorMove 14s steps(${en ? 28 : 11}, end) infinite, blink 1s step-end infinite; }
    .placeholder { opacity: 1; animation: placeholder 14s step-end infinite; }
    .sent { opacity: 1; animation: sent 14s step-end infinite; }
    .thinking { opacity: 0; animation: thinking 14s step-end infinite; }
    .tool { opacity: 1; animation: tool 14s step-end infinite; }
    .answer { opacity: 1; animation: answer 14s step-end infinite; }
    .answer-mask { transform-origin: 0 0; animation: response 14s steps(26, end) infinite; }
    .answer-line-two { opacity: 1; animation: second 14s step-end infinite; }
    .complete { opacity: 1; animation: complete 14s step-end infinite; }
    .meter { transform-origin: 0 0; animation: meter 14s linear infinite; }
    .dot { animation: blink 1s step-end infinite; }
    @keyframes draft { 0%,24% { opacity:1; } 25%,100% { opacity:0; } }
    @keyframes typing { 0%,4% { transform:scaleX(0); } 21%,100% { transform:scaleX(1); } }
    @keyframes cursorMove { 0%,4% { transform:translateX(0); } 21%,100% { transform:translateX(${draftWidth}px); } }
    @keyframes blink { 0%,49% { opacity:1; } 50%,100% { opacity:0; } }
    @keyframes placeholder { 0%,24% { opacity:0; } 25%,100% { opacity:1; } }
    @keyframes sent { 0%,24% { opacity:0; } 25%,100% { opacity:1; } }
    @keyframes thinking { 0%,25% { opacity:0; } 26%,44% { opacity:1; } 45%,100% { opacity:0; } }
    @keyframes tool { 0%,43% { opacity:0; } 44%,100% { opacity:1; } }
    @keyframes answer { 0%,54% { opacity:0; } 55%,100% { opacity:1; } }
    @keyframes response { 0%,54% { transform:scaleX(0); } 73%,100% { transform:scaleX(1); } }
    @keyframes second { 0%,75% { opacity:0; } 76%,100% { opacity:1; } }
    @keyframes complete { 0%,82% { opacity:0; } 83%,100% { opacity:1; } }
    @keyframes meter { 0%,25% { transform:scaleX(.08); } 80%,100% { transform:scaleX(1); } }
    ${still ? `
      .draft,.mask,.caret,.placeholder,.sent,.thinking,.tool,.answer,.answer-mask,.answer-line-two,.complete,.meter,.dot { animation:none !important; }
      .draft,.thinking { opacity:0; }
      .placeholder,.sent,.tool,.answer,.answer-line-two,.complete { opacity:1; }
    ` : ''}`
  const content = `
    <defs>
      <clipPath id="draft-clip"><rect class="mask" x="0" y="-25" width="${draftWidth}" height="34"/></clipPath>
      <clipPath id="answer-clip"><rect class="answer-mask" x="0" y="-26" width="${inner - 32}" height="38"/></clipPath>
    </defs>
    <rect x="1" y="1" width="${width - 2}" height="${height - 2}" rx="8" fill="#0f1113" stroke="#303741" stroke-width="2"/>
    <path d="M1 48H${width - 1}" stroke="#303741"/>
    ${icon('Terminal', left, 15, '#8bb6fb', 20)}
    ${text(left + 32, 31, 'dsh-TUI', 17, '#f0f3f7', 'font-weight="700"')}
    ${text(width - left, 31, en ? 'SVG DEMO / LOOP' : 'SVG 动画演示', 14, '#e5c07b', 'text-anchor="end"')}
    <g transform="translate(${mobile ? 12 : 32} 69) scale(${mobile ? 4.8 : 6.5})" shape-rendering="crispEdges">${whale()}</g>
    ${text(titleX, baseline, 'DEEPSEEK', titleSize, '#8bb6fb', 'font-weight="700"')}
    ${text(titleX, baseline + titleSize + 4, 'HARNESS', titleSize, '#c5dafb', 'font-weight="700"')}
    ${text(titleX, baseline + titleSize + 39, 'deepseek-v4-flash', mobile ? 16 : 18, '#e5c07b')}
    ${mobile ? '' : text(794, 112, '/demo/dsh-tui', 17, '#99a5b5')}
    ${mobile ? '' : text(794, 146, en ? 'session  /  README' : '会话  /  README', 16, '#99a5b5')}
    ${mobile ? '' : text(794, 180, en ? 'high effort' : 'high 推理强度', 16, '#65d4bc')}
    ${text(left, composerY - 14, en ? 'PROMPT' : '输入区', 15, '#99a5b5')}
    ${text(width - left, composerY - 14, en ? 'ANIMATED, NOT EDITABLE' : '动画演示 · 非可编辑控件', 14, '#99a5b5', 'text-anchor="end"')}
    <rect x="${left}" y="${composerY}" width="${inner}" height="80" rx="6" fill="#15191f" stroke="#759fdf" stroke-width="1.5"/>
    ${text(left + 18, composerY + 47, '>', 25, '#8bb6fb')}
    <g class="draft" transform="translate(${left + 48} ${composerY + 46})">
      <g clip-path="url(#draft-clip)">${text(0, 0, prompt, 20, '#f0f3f7')}</g>
      <rect class="caret" x="3" y="-20" width="9" height="24" fill="#8bb6fb"/>
    </g>
    <g class="placeholder">${text(left + 48, composerY + 47, en ? 'Ask a follow-up...' : '继续提问…', 20, '#99a5b5')}</g>
    <g class="sent">${text(left, transcriptY - 26, `> ${prompt}`, bodySize, '#e5c07b')}</g>
    <g class="thinking">
      <circle class="dot" cx="${left + 6}" cy="${transcriptY + 10}" r="4" fill="#65d4bc"/>
      ${text(left + 24, transcriptY + 16, en ? 'Thinking...' : '正在思考…', bodySize, '#65d4bc')}
    </g>
    <g class="tool">
      ${icon('FileText', left, transcriptY, '#65d4bc', 19)}
      ${text(left + 30, transcriptY + 16, 'Read  /demo/README.md', bodySize, '#8bb6fb')}
      ${text(left + 30, transcriptY + 47, en ? 'Demo project / scripted data' : '示例项目 / 预设演示数据', mobile ? 17 : 16, '#99a5b5')}
    </g>
    <g class="answer">
      <circle cx="${left + 6}" cy="${transcriptY + 85}" r="4" fill="#8bb6fb"/>
      ${text(left + 24, transcriptY + 92, en ? 'Preview result' : '预览结果', bodySize, '#8bb6fb', 'font-weight="700"')}
      <g transform="translate(${left + 24} ${transcriptY + 129})" clip-path="url(#answer-clip)">
        ${text(0, 0, response[0], bodySize)}
      </g>
      <g class="answer-line-two">${text(left + 24, transcriptY + 163, response[1], bodySize)}</g>
    </g>
    <path d="M${left} ${height - 112}H${width - left}" stroke="#303741"/>
    ${text(left, height - 86, en ? 'context  896 / 131k' : '上下文  896 / 131k', 15, '#99a5b5')}
    <g class="complete">${text(width - left, height - 86, en ? 'COMPLETE' : '演示完成', 15, '#65d4bc', 'text-anchor="end"')}</g>
    <rect x="${left}" y="${height - 70}" width="${inner}" height="5" rx="2" fill="#303741"/>
    <g transform="translate(${left} ${height - 70})"><rect class="meter" width="${mobile ? 46 : 74}" height="5" rx="2" fill="#65d4bc"/></g>
    ${text(left, height - 30, en ? 'high / main / dsh-tui' : 'high / main / dsh-tui', 14, '#99a5b5')}
    ${text(width - left, height - 30, en ? 'SCRIPTED DATA' : '预设演示数据', 13, '#99a5b5', 'text-anchor="end"')}
  `
  return svg(width, height, en ? 'dsh-TUI animated interface preview' : 'dsh-TUI 动态界面预览',
    en ? 'A scripted prompt, thinking, file result and reply loop. This SVG is an image, not an editable terminal. Respects reduced motion.'
      : '输入、思考、文件结果与回复的循环动画。此 SVG 是图片，不是可编辑终端；遵循系统减少动态效果设置。', content, styles)
}

function tile(entry, language) {
  const en = language === 'en'
  const title = entry[en ? 4 : 3]
  const description = entry[en ? 6 : 5]
  const target = href(entry, language)
  const absolute = target.startsWith('https:') ? target : repository + target
  return svg(560, 106, title, description, `
    <a href="${xml(absolute)}">
      <rect class="tile" x="1" y="4" width="558" height="98" rx="6" fill="#111519" stroke="#303741"/>
      ${icon(entry[1], 22, 26, entry[7], 25)}
      ${text(65, 42, title, 22, '#edf1f6', 'font-weight="600"')}
      ${text(65, 75, description, 16, '#aeb8c6')}
      ${icon('ArrowUpRight', 514, 25, entry[7], 22)}
    </a>`)
}

function navigation(language) {
  const links = docs.map(entry =>
    `  <a href="${href(entry, language)}"><img src="docs/assets/readme/nav-${entry[0]}-${language}.svg" width="440" alt="${entry[language === 'en' ? 4 : 3]}"></a>`)
  return `<p align="center">\n${links.join('\n')}\n</p>`
}

await mkdir(directory, { recursive: true })
for (const language of ['zh', 'en']) {
  for (const mobile of [false, true]) {
    for (const still of [false, true]) {
      await writeFile(resolve(directory, `preview-${language}${mobile ? '-mobile' : ''}${still ? '-still' : ''}.svg`), preview(language, mobile, still))
    }
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
console.log('Generated 4 animated previews, 4 reduced-motion previews and 24 linked documentation tiles; updated both README indexes.')
