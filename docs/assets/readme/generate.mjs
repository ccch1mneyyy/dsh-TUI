// Run with Node 24 from the repository root: node docs/assets/readme/generate.mjs
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'
import icons from './lucide-icons.json' with { type: 'json' }
import { WHALE_FRAMES } from '../../../src/components/whaleFrames.ts'

const directory = dirname(fileURLToPath(import.meta.url))
const root = resolve(directory, '../../..')
const packageVersion = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8')).version
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
const cleanLines = value => String(value).replace(/[ \t]+$/gm, '').trim()
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

function preview(language, mobile) {
  const en = language === 'en'
  const width = mobile ? 600 : 1200
  const height = mobile ? 920 : 800
  const left = mobile ? 24 : 38
  const inner = width - left * 2
  const headerBottom = mobile ? 270 : 258
  const transcriptTop = headerBottom + 18
  const statusY = mobile ? 734 : 612
  const promptY = mobile ? 826 : 706
  const bodySize = mobile ? 20 : 19
  const userPrompt = 'hi'
  const response = en ? [
    'Hi! I am your terminal coding partner.',
    'I can write code, fix bugs, research, or improve docs.',
  ] : ['你好！我是你的终端开发搭档。', '可以写代码、修 bug、查资料或梳理文档。']
  const draft = en ? 'Show me where to start in this project' : '帮我看看这个项目从哪里开始'
  const draftWidth = en ? 366 : 252
  const titleX = mobile ? left : left + 224
  const titleY = mobile ? 78 : 72
  const whaleMarkup = mobile ? '' : `
    <g transform="translate(${left + 2} 67) scale(4.15)" shape-rendering="crispEdges">${whale()}</g>
    ${text(left + 50, 226, en ? 'Explore the uncharted!' : '探索未至之境！', 18, '#416fcb', 'font-weight="700"')}`
  const thinking = en
    ? ['Reading the workspace and current session.', 'Preparing a concise welcome and useful next steps.', 'Keeping the composer ready for a follow-up.']
    : ['正在读取工作区与当前会话。', '准备简短欢迎语和下一步入口。', '输入框保持可用，随时可以继续提问。']
  const styles = `
    .spinner-a { animation: spinnerA 1s steps(1,end) infinite; }
    .spinner-b { animation: spinnerB 1s steps(1,end) infinite; }
    .thinking-row { animation: thinkingRow 16s step-end infinite; }
    .tool-row { animation: toolRow 16s step-end infinite; }
    .tool-running { animation: toolRunning 16s step-end infinite; }
    .tool-done { animation: toolDone 16s step-end infinite; }
    .answer { animation: answer 16s step-end infinite; }
    .answer-mask { transform-origin:0 0; animation: answerReveal 16s steps(31,end) infinite; }
    .answer-two { animation: answerTwo 16s step-end infinite; }
    .draft { animation: draft 16s step-end infinite; }
    .draft-mask { transform-origin:0 0; animation: draftReveal 16s steps(${en ? 44 : 16},end) infinite; }
    .draft-caret { animation: draftCaret 16s steps(${en ? 44 : 16},end) infinite, blink 1s step-end infinite; }
    .empty-caret { animation: emptyCaret 16s step-end infinite, blink 1s step-end infinite; }
    .pending { animation: pending 16s step-end infinite; }
    .busy-status { animation: busyStatus 16s step-end infinite; }
    .idle-status { animation: idleStatus 16s step-end infinite; }
    .activity { transform-origin:0 0; animation: activity 16s linear infinite; }
    .live-dot { animation: pulse 1.4s ease-in-out infinite; }
    @keyframes spinnerA { 0%,49% { opacity:1 } 50%,100% { opacity:0 } }
    @keyframes spinnerB { 0%,49% { opacity:0 } 50%,100% { opacity:1 } }
    @keyframes blink { 0%,48% { opacity:1 } 49%,100% { opacity:0 } }
    @keyframes pulse { 0%,100% { opacity:.35 } 50% { opacity:1 } }
    @keyframes thinkingRow { 0%,33% { opacity:1 } 34%,100% { opacity:.38 } }
    @keyframes toolRow { 0%,20% { opacity:0 } 22%,100% { opacity:1 } }
    @keyframes toolRunning { 0%,20% { opacity:0 } 22%,46% { opacity:1 } 47%,100% { opacity:0 } }
    @keyframes toolDone { 0%,46% { opacity:0 } 47%,100% { opacity:1 } }
    @keyframes answer { 0%,48% { opacity:0 } 50%,100% { opacity:1 } }
    @keyframes answerReveal { 0%,49% { transform:scaleX(0) } 74%,100% { transform:scaleX(1) } }
    @keyframes answerTwo { 0%,73% { opacity:0 } 75%,100% { opacity:1 } }
    @keyframes draft { 0%,70% { opacity:0 } 72%,100% { opacity:1 } }
    @keyframes draftReveal { 0%,71% { transform:scaleX(0) } 91%,100% { transform:scaleX(1) } }
    @keyframes draftCaret { 0%,71% { transform:translateX(0) } 91%,100% { transform:translateX(${draftWidth}px) } }
    @keyframes emptyCaret { 0%,71% { opacity:1 } 72%,100% { opacity:0 } }
    @keyframes pending { 0%,91% { opacity:0 } 92%,100% { opacity:1 } }
    @keyframes busyStatus { 0%,91% { opacity:1 } 92%,100% { opacity:0 } }
    @keyframes idleStatus { 0%,91% { opacity:0 } 92%,100% { opacity:1 } }
    @keyframes activity { 0% { transform:scaleX(.07) } 92%,100% { transform:scaleX(1) } }
  `
  const content = `
    <defs>
      <clipPath id="answer-clip"><rect class="answer-mask" x="0" y="-25" width="${inner - 54}" height="64"/></clipPath>
      <clipPath id="draft-clip"><rect class="draft-mask" x="0" y="-25" width="${draftWidth}" height="34"/></clipPath>
    </defs>
    <rect x="1" y="1" width="${width - 2}" height="${height - 2}" rx="6" fill="#f7f8fa" stroke="#c8d0dc" stroke-width="2"/>
    <rect x="1" y="1" width="${width - 2}" height="42" rx="6" fill="#edf1f6"/>
    <path d="M1 42H${width - 1}" stroke="#c8d0dc"/>
    ${icon('Terminal', left, 11, '#416fcb', 19)}
    ${text(left + 29, 28, 'dsh-TUI', 16, '#303743', 'font-weight="700"')}
    <circle class="live-dot" cx="${width - left - (mobile ? 78 : 112)}" cy="21" r="4" fill="#2f9c83"/>
    ${text(width - left, 27, en ? 'LIVE RUNTIME' : '实际运行态', 13, '#2f806f', 'text-anchor="end" font-weight="700"')}
    ${whaleMarkup}
    ${text(titleX, titleY - 18, `✦ dsh-TUI  v${packageVersion}`, mobile ? 16 : 15, '#48515f')}
    ${text(titleX, titleY + 28, 'DEEPSEEK', mobile ? 34 : 42, '#416fcb', 'font-weight="700"')}
    ${text(titleX, titleY + 70, 'HARNESS', mobile ? 34 : 42, '#7b9fd8', 'font-weight="700"')}
    ${text(titleX, titleY + 101, 'deepseek-v4-flash · Max effort', mobile ? 15 : 16, '#4b5563')}
    ${text(titleX, titleY + 127, '~/projects/dsh-TUI-693', mobile ? 14 : 15, '#7a8492')}
    ${text(titleX, titleY + 153, en ? 'Tip: Ctrl+O expands details · /tips for more' : '提示：Ctrl+O 展开详情 · /tips 查看更多', mobile ? 13 : 14, '#7a8492')}
    ${mobile ? text(left, headerBottom - 4, en ? 'Explore the uncharted!' : '探索未至之境！', 17, '#416fcb', 'font-weight="700"') : ''}
    <path d="M${left} ${headerBottom}H${width - left}" stroke="#d7dde6"/>
    <rect x="${left}" y="${transcriptTop}" width="${inner}" height="40" fill="#eee6cf"/>
    ${text(left + 10, transcriptTop + 27, '›', 24, '#416fcb', 'font-weight="700"')}
    ${text(left + 34, transcriptTop + 26, userPrompt, mobile ? 17 : 18, '#303743', 'font-weight="600"')}
    <g class="thinking-row">
      <g class="spinner-a">${text(left, transcriptTop + 74, '∷', 23, '#6787bd')}</g>
      <g class="spinner-b">${text(left, transcriptTop + 74, '⋮', 23, '#6787bd')}</g>
      ${text(left + 26, transcriptTop + 72, en ? 'Thinking · 5s  (ctrl+o to expand)' : '思考中 · 5s  (ctrl+o 展开)', 17, '#667085', 'font-style="italic"')}
      ${text(left + 26, transcriptTop + 101, thinking[0], 15, '#87919f')}
      ${text(left + 26, transcriptTop + 125, thinking[1], 15, '#87919f')}
      ${mobile ? '' : text(left + 26, transcriptTop + 149, thinking[2], 15, '#87919f')}
    </g>
    <g class="tool-row">
      <rect x="${left}" y="${transcriptTop + (mobile ? 168 : 174)}" width="${inner}" height="82" fill="#eef2f7"/>
      <g class="tool-running"><circle cx="${left + 10}" cy="${transcriptTop + (mobile ? 193 : 199)}" r="5" fill="#d39b32"/>${text(left + 26, transcriptTop + (mobile ? 199 : 205), 'Read  AGENTS.md', mobile ? 17 : 18, '#416fcb', 'font-weight="700"')}${text(left + 26, transcriptTop + (mobile ? 229 : 235), en ? '└ Loading project guidance…' : '└ 正在读取项目指引…', 15, '#7a8492')}</g>
      <g class="tool-done"><circle cx="${left + 10}" cy="${transcriptTop + (mobile ? 193 : 199)}" r="5" fill="#2f9c83"/>${text(left + 26, transcriptTop + (mobile ? 199 : 205), 'Read  AGENTS.md · 0.6s', mobile ? 17 : 18, '#416fcb', 'font-weight="700"')}${text(left + 26, transcriptTop + (mobile ? 229 : 235), en ? '└ Project guidance loaded' : '└ 已读取项目指引', 15, '#7a8492')}</g>
    </g>
    <g class="answer">
      <circle cx="${left + 7}" cy="${transcriptTop + (mobile ? 296 : 260)}" r="5" fill="#303743"/>
      <g transform="translate(${left + 24} ${transcriptTop + (mobile ? 302 : 266)})" clip-path="url(#answer-clip)">${text(0, 0, response[0], mobile ? 17 : 18, '#303743', 'font-weight="600"')}</g>
      <g class="answer-two">${text(left + 24, transcriptTop + (mobile ? 334 : 298), response[1], mobile ? 17 : 18, '#303743')}${text(left + 24, transcriptTop + (mobile ? 365 : 326), en ? 'Tell me what you want to build.' : '直接说需求就行。', mobile ? 14 : 16, '#5d6674')}</g>
    </g>
    <path d="M${left} ${promptY}H${width - left}" stroke="#7fa2d8" stroke-width="2"/>
    <path d="M${left} ${promptY + 72}H${width - left}" stroke="#7fa2d8" stroke-width="2"/>
    ${text(left + 2, promptY + 43, '›', 25, '#303743', 'font-weight="700"')}
    <rect class="empty-caret" x="${left + 30}" y="${promptY + 20}" width="10" height="29" fill="#303743"/>
    <g class="draft" transform="translate(${left + 31} ${promptY + 43})"><g clip-path="url(#draft-clip)">${text(0, 0, draft, mobile ? 17 : 18, '#303743')}</g><rect class="draft-caret" x="2" y="-23" width="9" height="28" fill="#416fcb"/></g>
    <g class="pending">${text(left + 2, promptY - 14, en ? '⚡ Steer · delivered next' : '⚡ 插话 · 下一步送达', 14, '#2f806f')}${text(width - left, promptY - 14, en ? 'Esc interrupts and sends immediately' : 'Esc 打断并立即发送', 13, '#7a8492', 'text-anchor="end"')}</g>
    <g class="busy-status">${text(left, statusY + 17, 'spat', 14, '#416fcb', 'font-weight="700"')}${mobile ? '' : text(width / 2, statusY + 17, en ? 'working' : '工作中', 14, '#5d6674', 'text-anchor="middle"')}${text(width - left, statusY + 17, mobile ? 'ctx 6.9% · 22 tps' : 'ctx 9.1k / 131k · 6.9% · 22 tps', 14, '#5d6674', 'text-anchor="end"')}</g>
    <g class="idle-status">${text(left, statusY + 17, 'spat', 14, '#416fcb', 'font-weight="700"')}${mobile ? '' : text(width / 2, statusY + 17, en ? 'free' : '空闲', 14, '#5d6674', 'text-anchor="middle"')}${text(width - left, statusY + 17, mobile ? 'ctx 7.2% · 0 tps' : 'ctx 9.4k / 131k · 7.2% · 0 tps', 14, '#5d6674', 'text-anchor="end"')}</g>
    <rect x="${left}" y="${statusY + 31}" width="${inner}" height="4" fill="#dce2ea"/><g transform="translate(${left} ${statusY + 31})"><rect class="activity" width="${mobile ? 68 : 104}" height="4" fill="#416fcb"/></g>
    ${text(left, statusY + 61, mobile ? 'deepseek-v4-flash · max' : 'deepseek-v4-flash · max · 9.4k→386', mobile ? 13 : 14, '#5d6674')}
    ${text(width - left, statusY + 61, mobile ? 'main · ?' : en ? 'main · dsh-TUI-693 · ? shortcuts' : 'main · dsh-TUI-693 · ? 快捷键', mobile ? 13 : 14, '#416fcb', 'text-anchor="end"')}
  `
  return svg(width, height, en ? 'dsh-TUI live runtime preview' : 'dsh-TUI 实际运行态预览',
    en ? 'An animated reconstruction of the real terminal hierarchy: logo header, transcript, thinking preview, tool card, composer and status line.'
      : '按真实终端层级重构的动态预览：Logo 头部、消息流、思考预览、工具卡、输入框与状态栏。', cleanLines(content), cleanLines(styles))
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

await mkdir(directory, { recursive: true })
for (const language of ['zh', 'en']) {
  for (const mobile of [false, true]) {
    await writeFile(resolve(directory, `preview-${language}${mobile ? '-mobile' : ''}.svg`), preview(language, mobile))
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
console.log('Generated 4 automatic animated previews and 24 linked documentation tiles; updated both README indexes.')
