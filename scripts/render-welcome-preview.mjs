/** Build a self-contained comparison from preview-welcome.mjs captures. */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import sharp from 'sharp'

const directory = '.local/welcome-preview'
const before = JSON.parse(await readFile(`${directory}/before.json`, 'utf8'))
const after = JSON.parse(await readFile(`${directory}/after.json`, 'utf8'))

function screenSvg(capture, title) {
  const escape = text => text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
  const dark = capture.theme === 'dark'
  const background = dark ? '#141820' : '#F8F9FC'
  const foreground = dark ? '#E8E6E0' : '#343945'
  const width = capture.columns * 10 + 48
  const height = capture.cells.length * 20 + 80
  let content = `<rect width="${width}" height="${height}" rx="12" fill="${background}"/><text x="24" y="31" fill="${dark ? '#A4B2C7' : '#65728A'}" font-family="Microsoft YaHei, sans-serif" font-size="14">${escape(title)} · ${capture.columns} 列</text>`
  const rect = (x, y, w, h, fill) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}" shape-rendering="crispEdges"/>`
  capture.cells.forEach((row, y) => row.forEach((cell, x) => {
    const left = 24 + x * 10
    const top = 52 + y * 20
    const fg = cell.fg ?? foreground
    if (cell.bg) content += rect(left, top, 10 * cell.width, 20, cell.bg)
    if (cell.text === '▀') content += rect(left, top, 10, 10, fg)
    else if (cell.text === '▄') content += rect(left, top + 10, 10, 10, fg)
    else if (cell.text === '█') content += rect(left, top, 10, 20, fg)
    else if (cell.text.trim() && cell.width) content += `<text x="${left}" y="${top + 16}" fill="${fg}" opacity="${cell.dim ? 0.65 : 1}" font-family="Consolas, Microsoft YaHei, monospace" font-size="16" font-weight="${cell.bold ? 700 : 400}">${escape(cell.text)}</text>`
  }))
  return { width, height, content, svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${content}</svg>` }
}

await mkdir('docs/assets/welcome-title', { recursive: true })
for (const [columns, theme] of [[100, 'dark'], [100, 'light'], [80, 'dark'], [64, 'dark'], [48, 'dark']]) {
  const original = screenSvg(before.find(c => c.columns === columns && c.theme === theme), '修改前 · ' + (theme === 'dark' ? '深色' : '浅色'))
  const revised = screenSvg(after.find(c => c.columns === columns && c.theme === theme), '修改后 · ' + (theme === 'dark' ? '深色' : '浅色'))
  const width = original.width + 32
  const height = original.height + revised.height + 48
  const comparison = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="#080C12"/><g transform="translate(16,16)">${original.content}</g><g transform="translate(16,${original.height + 32})">${revised.content}</g></svg>`
  await writeFile(`${directory}/comparison-${columns}-${theme}.svg`, comparison)
  await sharp(Buffer.from(comparison)).png().toFile(`docs/assets/welcome-title/${columns}-${theme}.png`)
}

const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>欢迎标题 · 最终方案</title><style>body{margin:0;padding:28px;background:#0b1018;color:#e3eaf4;font:15px/1.6 'Microsoft YaHei',sans-serif}main{max-width:1120px;margin:auto}p{color:#a9b8cc}nav{display:flex;gap:20px;margin:20px 0}select{padding:8px;background:#243349;color:white}section{margin:20px 0;overflow:auto}svg{display:block;max-width:100%;height:auto}</style><main><h1>只调整标题，鲸鱼保持原版。</h1><p>统一字形 · 增加字距与行距 · 按可用宽度显示完整标题 · 保留原配色、渐变与动画</p><nav><label>终端宽度 <select id="columns"><option>100</option><option>80</option><option>64</option><option>48</option></select></label><label>主题 <select id="theme"><option value="dark">深色</option><option value="light">浅色</option></select></label></nav><section id="before"></section><section id="after"></section><p>真实组件的 ANSI 静止帧预览；实际终端的字体与行高可能不同。</p></main><script>const data=${JSON.stringify({before,after}).replaceAll('<','\\u003c')};
${screenSvg.toString()}
function update(){for(const id of ['before','after'])document.getElementById(id).innerHTML=screenSvg(data[id].find(c=>c.columns===Number(document.getElementById('columns').value)&&c.theme===document.getElementById('theme').value),id==='before'?'原版':'标题优化后').svg}document.getElementById('columns').onchange=update;document.getElementById('theme').onchange=update;update();</script></html>`
await writeFile(`${directory}/index.html`,html)
console.log('Final title-only preview ready')
