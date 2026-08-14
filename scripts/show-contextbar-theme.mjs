/**
 * 肉眼对比 contextBar 亮/暗色渲染（issue #29 白色条条修复验证）
 *
 * 用法：node scripts/show-contextbar-theme.mjs
 * 在暗色终端下运行：上面是修复前（亮灰 #E8E8E8，刺眼白条），
 * 下面是修复后（深蓝灰 #2E3440 + 灰蓝文字）。亮色终端两者区别不大。
 */
import { renderContextBar } from '../lib/types/screens/StatusMetrics.js'

// 模拟一段典型的上下文占用（used 44k / window 128k）
const segments = { system: 12000, prompt: 8000, assistant: 15000, thinking: 3000, tools: 6000 }
const used = 44000
const window = 128000
const width = 60

console.log('=== 修复前（light 主题现状：#E8E8E8 亮灰自由段）===')
console.log(renderContextBar(segments, used, window, width))
console.log('')
console.log('=== 修复后（dark/dark-ansi 主题：#2E3440 深蓝灰 + #8D95A6 文字）===')
console.log(renderContextBar(segments, used, window, width, { freeFill: '#2E3440', freeText: '#8D95A6' }))
console.log('')
