#!/usr/bin/env node
/**
 * verify-workspaces-degrade.mjs — tuiWorkspaces 服务可选化回归（issue #183）。
 *
 * dsh CLI 从「安装锚点优先命中的拷贝」（通常是全局启动器）读 bundle 的
 * cordis.patch.yml，却从 profile 拷贝装载插件模块；两份拷贝版本错位时
 * 旧 patch 没有 dsh-tui-workspaces 行。本脚本锁定降级契约，防止回退：
 *
 *   - 代码层 inject 不得再含 tuiWorkspaces（硬注入 = 启动死锁）
 *   - plugin/channel 两处消费必须带 createLocalWorkspaceRuntime 兜底
 *   - profile 启动且服务缺失时恰好一处 warn（可诊断），裸嵌入静默
 *   - bundle patch 保留服务行 + 行级 inject 顺序保证（正常安装不降级）
 *   - 本地兜底运行时的行为：绝对路径/file URL 可解析、provider URI 返回
 *     undefined（触发既有的 fail-loud 报错）、list 至少含当前目录
 *
 * 运行：pnpm build && node scripts/verify-workspaces-degrade.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createLocalWorkspaceRuntime } from '../lib/types/dsh-adapter/workspaces.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = rel => readFileSync(join(root, rel), 'utf8')

const entry = read('lib/types/dsh-adapter/index.js')
const injectMatch = entry.match(/export const inject = \[([^\]]*)\]/)
assert.ok(injectMatch, 'compiled entry exports an inject list')
assert.match(injectMatch[1], /'agents'/, 'code-level inject keeps agents')
assert.doesNotMatch(
  injectMatch[1],
  /tuiWorkspaces/,
  'code-level inject must NOT hard-require tuiWorkspaces (stale patch = boot deadlock, #183)',
)

for (const rel of ['lib/types/dsh-adapter/plugin.js', 'lib/types/dsh-adapter/channel.js']) {
  const compiled = read(rel)
  assert.match(compiled, /createLocalWorkspaceRuntime/, `${rel} carries the local-only fallback`)
  assert.match(compiled, /get\('tuiWorkspaces'\)/, `${rel} reads the service optionally via ctx.get`)
}

const plugin = read('lib/types/dsh-adapter/plugin.js')
assert.equal(
  [...plugin.matchAll(/tuiWorkspaces service is not mounted/g)].length,
  1,
  'the degraded-boot warning exists exactly once',
)
assert.match(
  plugin,
  /resolveDshProfileName\(\) !== undefined/,
  'the warning is gated on profile launches (bare embedders stay silent)',
)

const patch = read('cordis.patch.yml')
assert.match(
  patch,
  /- id: dsh-tui-workspaces\n\s+name: '@deepseek-harness-tui\/dsh-tui\/workspaces'/,
  'bundle patch still mounts the workspaces row',
)
assert.match(
  patch,
  /- id: dsh-tui\n\s+name: '@deepseek-harness-tui\/dsh-tui'\n[\s\S]{0,240}inject: \[[^\]]*\btuiWorkspaces\b[^\]]*\]/,
  'row-level inject keeps tuiWorkspaces as the mount-ordering guarantee',
)
assert.ok(
  patch.indexOf('- id: dsh-tui-workspaces') < patch.indexOf("- id: dsh-tui\n"),
  'the workspaces row precedes the dsh-tui row',
)

// 本地兜底运行时行为：覆盖启动 workspace 目标解析的三类输入。
const fallback = createLocalWorkspaceRuntime()
const byPath = await fallback.resolve(process.cwd())
assert.equal(byPath?.kind, 'local', 'absolute path resolves to a local target')
assert.equal(byPath?.badge, 'LOCAL')
const byFileUrl = await fallback.resolve(`file://${process.cwd()}`)
assert.equal(byFileUrl?.cwd, byPath?.cwd, 'file URL resolves to the same local target')
assert.equal(
  await fallback.resolve('ssh://example.invalid/work'),
  undefined,
  'provider URIs stay unresolved so the caller fails loud',
)
const listed = await fallback.list(process.cwd())
assert.ok(
  listed.some(target => target.cwd === byPath?.cwd),
  'list always offers the current directory',
)
assert.equal(fallback.commands().length, 0, 'no provider commands without providers')
await assert.rejects(() => fallback.rename(process.cwd(), 'x'), /unavailable/, 'rename fails loud without the registry')

console.log('verify-workspaces-degrade: OK')
