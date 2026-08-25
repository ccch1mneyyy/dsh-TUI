/**
 * 回归脚本的公共等待与屏幕读取辅助（issue #532）。
 *
 * 三个系统性错误写法的替代品，全部围绕同一条流水线：
 * stdin 解析 → React 状态 → 节流渲染 → xterm 异步解析。它没有固定上界，
 * 所以「固定 sleep 后断言」在慢 runner 上会断言到旧屏幕。
 *
 * - settled(pred)     取代「sleep 后断言」与「settle 后断言」：轮询到谓词
 *                     为真（或超时）后返回谓词终值，调用方把返回值直接交给
 *                     自己的 check/assert——等待条件与断言条件是同一个表达式，
 *                     「settle 等到 A、断言却要 B」这类分叉（#561）在写法上
 *                     不可能出现。
 * - settle(pred)      仅用于「等到某状态再继续操作」且后面没有紧随断言的
 *                     场景（如等界面就绪再发按键）。等待后要断言的一律用
 *                     settled。超时静默返回。
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

// CI 共享 runner 有负载抖动，条件成立即返回，加大上限只影响真失败的耗时。
const DEFAULT_TIMEOUT_MS = process.env.CI ? 8000 : 4000

/**
 * 轮询到 pred() 为真（30ms 间隔，默认上限本地 4s / CI 8s）。超时静默返回。
 * 只用于「等到某状态再继续操作」；等待后要断言的用 settled。
 * @param {() => boolean} pred
 * @param {{ timeoutMs?: number, stepMs?: number }} [opts]
 */
export async function settle(pred, opts = {}) {
  const stepMs = opts.stepMs ?? 30
  const deadline = Date.now() + (opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  while (Date.now() < deadline) {
    if (pred()) return
    await sleep(stepMs)
  }
}

/**
 * 轮询到 pred() 为真后返回其终值（超时返回最后一次求值结果）。
 * 用法：`check('label', await settled(() => cond))`——等待与断言共用
 * 同一个谓词，条件只写一遍。
 * @param {() => boolean} pred
 * @param {{ timeoutMs?: number, stepMs?: number }} [opts]
 * @returns {Promise<boolean>}
 */
export async function settled(pred, opts = {}) {
  await settle(pred, opts)
  return Boolean(pred())
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
