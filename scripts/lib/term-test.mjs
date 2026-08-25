/**
 * 回归脚本的公共等待与屏幕读取辅助（issue #532）。
 *
 * 三个系统性错误写法的替代品，全部围绕同一条流水线：
 * stdin 解析 → React 状态 → 节流渲染 → xterm 异步解析。它没有固定上界，
 * 所以「固定 sleep 后断言」在慢 runner 上会断言到旧屏幕。
 *
 * - settle(pred)      取代「sleep 后断言」：轮询到预期状态出现再让调用方
 *                     断言。超时不抛错——紧随其后的断言用同一条件失败，
 *                     并打印脚本自己的诊断；真回归仍然会红。
 * - writeParsed(term) 取代「write + sleep」：xterm 的 write 异步分块解析，
 *                     buffer 只在回调触发后才反映写入（官方文档语义）。
 * - viewportLines()   取代「getLine(0..ROWS) 直扫」：inline 模式有
 *                     scrollback 时（baseY > 0）直扫读的是缓冲区开头——
 *                     混入已滚出的行、漏掉视口底部。alt-screen 下
 *                     baseY 恒为 0，两种写法等价。
 *
 * 纯 ESM JS（无类型编译），.mjs 与 .tsx 脚本都能直接 import。
 * 注意：「状态不得改变」的稳定性探针（悬停离开不塌、空提交不发）不要
 * 换成 settle——对已成立的条件轮询会立即返回，等于没测；保留固定窗口。
 */

/** @param {number} ms */
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/**
 * 轮询到 pred() 为真（30ms 间隔，默认上限 4s）。超时静默返回，由调用方
 * 紧随其后的断言以同一条件失败。
 * @param {() => boolean} pred
 * @param {{ timeoutMs?: number, stepMs?: number }} [opts]
 */
export async function settle(pred, opts = {}) {
  const stepMs = opts.stepMs ?? 30
  const deadline = Date.now() + (opts.timeoutMs ?? 4000)
  while (Date.now() < deadline) {
    if (pred()) return
    await sleep(stepMs)
  }
}

/**
 * write 并等 xterm 解析完（回调触发时 buffer 才反映写入）。
 * @param {import('@xterm/headless').Terminal} term
 * @param {string} data
 */
export function writeParsed(term, data) {
  return new Promise(resolve => term.write(data, resolve))
}

/**
 * 读可见视口（baseY 起 rows 行），右侧空白已裁剪。
 * @param {import('@xterm/headless').Terminal} term
 * @param {number} [rows] 默认 term.rows
 * @returns {string[]}
 */
export function viewportLines(term, rows) {
  const buffer = term.buffer.active
  const height = rows ?? term.rows
  return Array.from(
    { length: height },
    (_, y) => buffer.getLine(buffer.baseY + y)?.translateToString(true) ?? '',
  )
}

/**
 * 视口内是否有包含 text 的行。
 * @param {import('@xterm/headless').Terminal} term
 * @param {string} text
 */
export function screenHas(term, text) {
  return viewportLines(term).some(line => line.includes(text))
}

/**
 * text 在视口内首次出现的 0 起坐标（鼠标 SGR 序列用时 +1）。
 * @param {import('@xterm/headless').Terminal} term
 * @param {string} text
 * @returns {{ col: number, row: number } | null}
 */
export function findText(term, text) {
  const lines = viewportLines(term)
  for (let row = 0; row < lines.length; row++) {
    const col = lines[row].indexOf(text)
    if (col >= 0) return { col, row }
  }
  return null
}
