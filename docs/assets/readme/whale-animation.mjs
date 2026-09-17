import { WHALE_FRAMES } from '../../../src/components/whaleFrames.ts'

// Palette and 40-column/13-row geometry match src/components/Whale.tsx.
const colors = { D: '#142660', B: '#4e6fff', L: '#bee1ff', W: '#ffffff', H: '#cc3399', Z: '#808080' }

export function whaleRegion(recording) {
  if (recording.cols < 64) return null
  const marker = recording.frames[0].cells.find(cell => cell[2] === '✦')
  if (!marker || marker[0] < 42) throw new Error('Captured whale header anchor is missing')
  return { col: marker[0] - 42, row: marker[1] + 1, cols: 40, rows: 13 }
}

export function withoutCapturedWhale(recording) {
  const region = whaleRegion(recording)
  if (!region) return recording
  return { ...recording, frames: recording.frames.map(frame => ({
    ...frame, cells: frame.cells.filter(([x, y]) =>
      x < region.col || x >= region.col + region.cols || y < region.row || y >= region.row + region.rows),
  })) }
}

export function whaleAnimation(recording) {
  const region = whaleRegion(recording)
  if (!region) return { content: '', styles: '' }
  if (WHALE_FRAMES.length !== 22) throw new Error('Expected the credited 22-frame source set')
  const styles = []
  const frames = WHALE_FRAMES.map((frame, index) => {
    const paths = new Map(Object.keys(colors).map(key => [key, '']))
    frame.rows.forEach((row, y) => [...row].forEach((pixel, x) => {
      if (pixel === '.') return
      if (!paths.has(pixel)) throw new Error(`Unknown source pixel: ${pixel}`)
      paths.set(pixel, paths.get(pixel) + `M${x} ${y}h1v1h-1z`)
    }))
    const start = (index / 22 * 100).toFixed(6)
    const end = ((index + 1) / 22 * 100).toFixed(6)
    styles.push(`.whale-${index}{animation:whale${index} 1000ms step-end infinite}
@keyframes whale${index}{${index === 0 ? '0%{visibility:visible}' : `0%{visibility:hidden}${start}%{visibility:visible}`}${end}%{visibility:hidden}}`)
    return `<g class="whale-frame whale-${index}" data-whale-frame="${index}" data-pose="${frame.name}">${[...paths].filter(([,d])=>d).map(([key,d])=>`<path fill="${colors[key]}" d="${d}"/>`).join('')}</g>`
  })
  return {
    styles: '.whale-frame{visibility:hidden}' + styles.join('\n'),
    content: `<g id="credited-whale" data-fps="22" transform="translate(${region.col * recording.cellWidth} ${region.row * recording.cellHeight}) scale(${recording.cellWidth} ${recording.cellHeight / 2})" shape-rendering="crispEdges">${frames.join('')}</g>`,
  }
}
