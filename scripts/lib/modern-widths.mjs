/**
 * 取证 harness 的「现代终端」宽度 provider（issue #574 取证沉淀）。
 *
 * xterm-headless 默认 Unicode provider 是旧表：Emoji_Presentation 字符
 * （⚓ U+2693 等）量 1 格；现代真实终端（Windows Terminal / kitty /
 * ghostty / iTerm2 按 EastAsianWidth W）画 2 格，src/ink/stringWidth.ts
 * 也量 2（#101 的 Doctrine：量宽跟随真实终端）。两侧不一致时，就地重绘
 * 含这类字符的行必然错位——app 以为是宽字符第二格而不重写的格子，在
 * 终端里是独立一格：旧帧残影滞留、后续宽字被半个覆盖丢弃（#574 现场
 * 思考行的「⚓⠧ 思  ·」残状）。断言这类行的回归脚本必须先让 harness
 * 与真实终端同宽，否则红的是 xterm.js 旧表，不是产品代码。
 *
 * 宽度口径直接委托 app 的 stringWidth（单码点粒度，与 provider 的
 * wcwidth 语义一致），单一真源不漂移。
 *
 * 本模块顶层 import TypeScript 源——只可被 `node --import tsx/esm`
 * 运行的脚本引入；纯 node 脚本（如 verify-working-activity）请勿引入
 * （它们也不需要：断言不含 Emoji_Presentation 字符的行）。
 */
const { stringWidth } = await import('../../src/ink/stringWidth.js')

/** 单码点宽度（wcwidth 语义：0/1/2），带缓存——xterm 逐码点查询。 */
const table = new Map()
const wcwidth = cp => {
  let w = table.get(cp)
  if (w === undefined) {
    w = stringWidth(String.fromCodePoint(cp))
    if (w !== 0 && w !== 1 && w !== 2) w = 1
    table.set(cp, w)
  }
  return w
}

// charProperties 位布局照抄 @xterm/headless 6.0.0 内建 provider：
//   property = (charKind << 3) | (width << 1) | (shouldJoin ? 1 : 0)
// 组合符（width 0）并入前格宽度（shouldJoin），与内建语义一致。
// 若升级 xterm 后布局变化，这里要与内建实现同步（typings 不导出这些
// 静态方法，只能对照打包源码核对）。
const charProperties = (cp, preceding) => {
  let w = wcwidth(cp)
  let join = w === 0 && preceding !== 0
  if (join) {
    const precedingWidth = (preceding >> 1) & 3
    if (precedingWidth === 0) join = false
    else if (precedingWidth > w) w = precedingWidth
  }
  return (0 << 3) | ((w & 3) << 1) | (join ? 1 : 0)
}

const VERSION = 'dsh-modern-eaw'

/**
 * 注册并启用现代宽度 provider（幂等：重复注册同名版本会抛错，故先查）。
 * @param {import('@xterm/headless').Terminal} term
 */
export function activateModernEmojiWidths(term) {
  if (!term.unicode.versions.includes(VERSION)) {
    term.unicode.register({ version: VERSION, wcwidth, charProperties })
  }
  term.unicode.activeVersion = VERSION
}
