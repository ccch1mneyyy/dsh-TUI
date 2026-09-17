// Only these editorial labels differ from the preserved terminal capture.
// Widths are explicit for these fixed ASCII/CJK copy runs, not a general wcwidth.
export function withWelcomeCopy(recording) {
  const chinese = recording.language === 'zh'
  const pathRuns = chinese
    ? [['欢迎使用', 2], [' dsh-TUI', 1], [' · ', 1], ['从这里开始', 2]]
    : [['Welcome to dsh-TUI', 1]]
  const folderRuns = chinese ? [['欢迎使用', 2]] : [['welcome', 1]]
  const edits = []
  const frames = recording.frames.map(frame => {
    let cells = frame.cells.map(cell => [...cell])
    for (let row = 0; row < recording.rows; row++) {
      const line = cells.filter(cell => cell[1] === row).sort((a, b) => a[0] - b[0])
      const chars = line.map(cell => cell[2]).join('')
      const pathStart = chars.indexOf('H:\\CODEX\\')
      const folderStart = chars.startsWith('deepseek-') ? chars.lastIndexOf('workspace') : -1
      if (pathStart < 0 && folderStart < 0) continue
      const start = pathStart >= 0 ? pathStart : folderStart
      const column = line[start][0]
      const end = pathStart >= 0 ? recording.cols : column + 'workspace'.length
      const template = line[start]
      cells = cells.filter(cell => cell[1] !== row || cell[0] < column || cell[0] >= end)
      let x = column
      const runs = pathStart >= 0 ? pathRuns : folderRuns
      for (const [text, span] of runs) for (const char of text) {
        if (x + span > end) throw new Error(`Welcome copy exceeds the captured field in ${frame.name}`)
        cells.push([x, row, char, span, ...template.slice(4)])
        x += span
      }
      edits.push({ frame: frame.name, row, column, end, text: runs.map(run => run[0]).join('') })
    }
    cells.sort((a, b) => a[1] - b[1] || a[0] - b[0])
    return { ...frame, cells }
  })
  return { ...recording, cellWidth: 8.25, frames, editorialLabels: edits }
}
