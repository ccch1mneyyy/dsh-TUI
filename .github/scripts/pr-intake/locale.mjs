// 标题+正文里汉字占「汉字+字母」≥ 20%，或汉字 ≥ 12，回中文。
// 先剥模板注释、代码块、URL，避免 API 名把拉丁字母撑高。
export function detectReplyLocale(title, body) {
  const text = `${title || ''}\n${body || ''}`
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]+`/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
  const cjk = (text.match(/\p{Script=Han}/gu) || []).length
  const latin = (text.match(/[A-Za-z]/g) || []).length
  if (cjk === 0) return 'en'
  if (latin === 0) return 'zh'
  return (cjk / (cjk + latin) >= 0.2 || cjk >= 12) ? 'zh' : 'en'
}
