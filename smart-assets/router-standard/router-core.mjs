/**
 * router-pro: reasoning-mode routing for DeepSeek V4 Pro (measured-optimal).
 *
 * V4 PRO-SPECIFIC DESIGN (all numbers from official-API probes, 2026-08-15):
 *
 * 1. THREE-BAND STRUCTURE (n=570, AIC 668.7 vs logit 697.9):
 *      spec [0, 0.025]     -> psi1 = 0.925   (RL interface)
 *      transition [0.025, 0.455] -> psi1 = 0.464 (competition trap)
 *      react [0.455, 1]    -> psi1 = 0.073   (doer)
 *    The transition band is never selected automatically.
 *
 * 2. WEAK = router-v2 few-shot, NOT w6c. Discrimination (n=10):
 *      router-v2 +2.6 | react +2.2 | w7 +2.0 | neutral +1.1 | w6c +0.2
 *
 * 3. Maintenance tasks use the RL interface; build tasks use the doer
 *    interface. Tool-schema anchoring remains effective without an output cap.
 *
 * Vendored from dsh-router-standard v0.3.0's router-pro core. Smart selects
 * this route only for a V4 Pro model; Flash keeps Router Standard behavior.
 */

export const MODE_SPEC = 0
export const MODE_REACT = 1
export const MODE_WEAK = 'weak'

const RL_PERSONA = 'You are a helpful software engineer assistant.'

const REACT_PERSONA =
  'You are a hands-on software engineer who delivers working output fast.\n'
  + 'Work directly: write or edit code, then verify it by reading and running. '
  + 'Keep the loop tight - produce, verify, fix - and do not build test '
  + 'harnesses, scaffolding, or ceremony the user did not ask for. '
  + 'Finish with a usable deliverable and a short summary.'

const WEAK_PRO =
  'You are a software engineer. Match your working style to the task type.\n'
  + 'Example 1: "fix the broken login flow" -> inspect first, plan, then edit carefully.\n'
  + 'Example 2: "write a new CSV processing script" -> write the code directly and verify it runs.\n'
  + 'Follow the same rule for the actual request.'

const WEAK_FLASH =
  'You are a helpful assistant.\n'
  + 'Before acting, decide the task type (build or fix) and adopt the matching '
  + 'style: build -> hands-on production; fix -> inspect-and-plan.\n'
  + 'Before acting, briefly review what you have already done in this session and continue from where you left off; do not repeat completed steps. Do not run environment checks (echo, whoami, uname, node --version, date) or exhaustive grep/glob scans.\n'
  + 'Think deeply first, then produce.'

export function isFlashModel(modelId) {
  return typeof modelId === 'string' && /flash/i.test(modelId)
}

/** Smart keeps Router Standard for every route except DeepSeek V4 Pro. */
export function isProModel(modelId) {
  return typeof modelId === 'string' && /deepseek[-_/]?v4(?:[-_/].*)?[-_/]pro$/i.test(modelId)
}

const COMPLEX_RE = /(重构|架构|全面|详细|设计|系统|优化|分析|survey|overview|architecture|refactor|comprehensive|detailed|design|system|optimize|analyze)/i

export function isComplexTask(text) {
  return typeof text === 'string' && (text.length > 120 || COMPLEX_RE.test(text))
}

export const BAND_SPEC_MAX = 0.03
export const BAND_REACT_MIN = 0.455

export function bandOf(mode) {
  if (mode === 'weak') return 'weak'
  const m = clamp01(mode)
  if (m < BAND_SPEC_MAX) return 'spec'
  if (m < BAND_REACT_MIN) return 'transition'
  return 'react'
}

export function personaFor(mode, modelId) {
  switch (bandOf(mode)) {
    case 'spec': return RL_PERSONA
    case 'weak': return isFlashModel(modelId) ? WEAK_FLASH : WEAK_PRO
    case 'transition': return RL_PERSONA
    default: return REACT_PERSONA
  }
}

export function coreFor(mode) {
  switch (bandOf(mode)) {
    case 'spec': return ['str_replace_editor']
    case 'weak': return ['str_replace_editor']
    case 'transition': return ['read', 'write', 'edit']
    default: return ['read', 'write', 'edit']
  }
}

export function bandFor(mode) {
  const band = bandOf(mode)
  return band === 'transition' ? 'mixed' : band
}

export function testinessFor(mode) {
  return bandOf(mode) === 'react' ? 'suppressed' : 'normal'
}

const REACT_RE = /(开发|创建|写一个|生成|从零|做一个|游戏|网页|网站|构建|新项目|搭建|实现|做出|上线|落地|脚本|工具|应用|build|create|develop|generate|implement|make a|new project)/gi
const SPEC_RE = /(修复|修一下|调试|重构|维护|排查|报错|出错|崩溃|优化|审查|review|fix|debug|refactor|maintain|repair|broken|break|为什么|异常|故障|迁移|升级|兼容)/gi

function countHits(regex, text) {
  return [...text.matchAll(regex)].length
}

export function classifyTask(text) {
  const react = countHits(REACT_RE, text)
  const spec = countHits(SPEC_RE, text)
  if (react > spec) return 1
  if (spec > react) return 0
  return 'weak'
}

export function sessionMode(session) {
  const userMessage = session.events.find(event => event.type === 'user/message')
  return classifyTask(extractText(userMessage?.data))
}

export function extractText(data) {
  if (!data) return ''
  const payload = data && typeof data.message === 'object' && data.message !== null ? data.message : data
  const content = Array.isArray(payload.content) ? payload.content : []
  return content.map(entry => (typeof entry === 'string' ? entry : (entry.text ?? ''))).join(' ')
}

export function clamp01(value) {
  return Math.min(1, Math.max(0, Number(value) || 0))
}

export function applyPersona(sections, personaText) {
  const rest = (sections || []).filter(
    section => section.name !== 'persona' && !/persona/i.test(section.name),
  )
  return [...rest, { name: 'router-persona', text: personaText, order: 0 }]
}

export function parseMode(token) {
  if (token === undefined || token === null) return null
  const text = String(token).trim().toLowerCase()
  if (text === 'auto') return 'auto'
  if (text === 'weak' || text === 'router') return 'weak'
  if (text === 'spec' || text === 'spec-lean') return 0
  if (text === 'react' || text === 'react-lean') return 1
  const numeric = Number(text)
  if (!Number.isFinite(numeric)) return null
  if (text.includes('.')) return clamp01(numeric)
  return clamp01(numeric / 100)
}
