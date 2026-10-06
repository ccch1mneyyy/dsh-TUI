/**
 * Claude SDK 安装器回归（`src/backends/claude/install.ts` 的 spawn 面）：
 *   1. store 解析：profile 已有 `node_modules/.modules.yaml` 时用它记的
 *      `storeDir`（pnpm 加不加引号都要认），从未装过时落到 profile 同级的
 *      共享 store（通常在 workspace 内，沙箱也写得进去）；
 *   2. `pnpm add` 的命令行原样带上解析出的 `--store-dir`，argv 顺序就是
 *      「add <specifier> --store-dir <dir>」——面板给用户的手动兜底命令与
 *      向导真正执行的是同一条；
 *   3. 结束态映射：退出码 0 → ok，ENOENT → pnpm-missing，输出里出现
 *      `ERR_PNPM_UNEXPECTED_STORE` → store-mismatch（带 storeDir，面板据此
 *      指出对齐用的 store），其余非零 → failed + 输出尾部。
 *
 * pnpm 用 PATH 桩替掉：桩把 argv 记进文件，所以这里验的是真实 spawn 出来的
 * 参数，而不是复述实现。
 *
 * 运行：node --import tsx/esm scripts/verify-claude-sdk-install.ts
 */
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  claudeSdkAddArgs,
  CLAUDE_SDK_SPECIFIER,
  resolveSdkStoreDir,
  startClaudeSdkInstall,
  type SdkInstallResult,
} from '../src/backends/claude/install.js'

let checks = 0
function check(ok: boolean, what: string): void {
  checks += 1
  assert.ok(ok, what)
}

const root = mkdtempSync(join(tmpdir(), 'dsh-sdk-install-'))
const stubDir = join(root, 'stub-bin')
const argvFile = join(root, 'pnpm-argv.json')
mkdirSync(stubDir, { recursive: true })
process.env.DSH_TEST_PNPM_ARGV = argvFile

/** A `pnpm` that records its argv and ends the way the case under test needs. */
writeFileSync(join(stubDir, 'pnpm'), `#!/bin/sh
printf '%s\\n' "$@" > "$DSH_TEST_PNPM_ARGV"
[ -n "$DSH_TEST_PNPM_STDERR" ] && printf '%s\\n' "$DSH_TEST_PNPM_STDERR" >&2
exit "\${DSH_TEST_PNPM_EXIT:-0}"
`)
chmodSync(join(stubDir, 'pnpm'), 0o755)
process.env.PATH = `${stubDir}:${process.env.PATH ?? ''}`

/** A DSH profile: `<profiles>/<name>`, with node_modules when the case needs it. */
function profile(name: string, modulesYaml?: string): string {
  const dir = join(root, 'profiles', name)
  mkdirSync(dir, { recursive: true })
  if (modulesYaml !== undefined) {
    mkdirSync(join(dir, 'node_modules'), { recursive: true })
    writeFileSync(join(dir, 'node_modules', '.modules.yaml'), modulesYaml)
  }
  return dir
}

/** Run one install to completion, capturing the argv the stub saw. No argv
 *  file is a legitimate outcome: when pnpm cannot be spawned at all the stub
 *  never runs, which is exactly the pnpm-missing case. */
async function install(dir: string, env: { readonly exit?: string; readonly stderr?: string } = {}): Promise<{ readonly result: SdkInstallResult; readonly argv: readonly string[] }> {
  rmSync(argvFile, { force: true })
  if (env.exit !== undefined) process.env.DSH_TEST_PNPM_EXIT = env.exit
  else delete process.env.DSH_TEST_PNPM_EXIT
  if (env.stderr !== undefined) process.env.DSH_TEST_PNPM_STDERR = env.stderr
  else delete process.env.DSH_TEST_PNPM_STDERR
  const result = await startClaudeSdkInstall(dir).result
  const argv = existsSync(argvFile) ? readFileSync(argvFile, 'utf8').split('\n').filter(line => line !== '') : []
  return { result, argv }
}

try {
  // 1. Store resolution — pnpm's own record wins, in either quoting.
  const quoted = profile('quoted', 'storeDir: "/tmp/elsewhere/.pnpm-store/v11"\n')
  assert.equal(resolveSdkStoreDir(quoted), '/tmp/elsewhere/.pnpm-store/v11', '已装过的 profile 沿用 .modules.yaml 记的 store')
  checks += 1
  const plain = profile('plain', 'storeDir: /tmp/plain/store/v11\n')
  assert.equal(resolveSdkStoreDir(plain), '/tmp/plain/store/v11', 'pnpm 不加引号写的路径同样要认')
  checks += 1

  // 2. Never installed → the shared sibling store, not a `$HOME`-dependent answer.
  const fresh = profile('fresh')
  assert.equal(resolveSdkStoreDir(fresh), join(root, 'profiles', '.pnpm-store'), '未装过的 profile 用 profiles 目录下的共享 store')
  checks += 1
  assert.equal(resolveSdkStoreDir(join(root, 'profiles', 'deep', 'nested')), join(root, 'profiles', 'deep', '.pnpm-store'), '共享 store 取 profile 的父目录')
  checks += 1

  // 3. The install names that store on the command line, in the shape the
  //    manual fallback command spells out.
  const ok = await install(fresh)
  assert.deepEqual(ok.result, { kind: 'ok' }, '退出码 0 → ok')
  checks += 1
  assert.deepEqual(ok.argv, ['add', CLAUDE_SDK_SPECIFIER, '--store-dir', join(root, 'profiles', '.pnpm-store')], 'argv = add <specifier> --store-dir <dir>')
  checks += 1
  assert.deepEqual(claudeSdkAddArgs('/x/store'), ['add', CLAUDE_SDK_SPECIFIER, '--store-dir', '/x/store'], '面板兜底命令与向导 argv 同源')
  checks += 1

  const recorded = await install(quoted)
  assert.deepEqual(recorded.argv, ['add', CLAUDE_SDK_SPECIFIER, '--store-dir', '/tmp/elsewhere/.pnpm-store/v11'], '已装过的 profile 按记录传参，不再漂到别的 store')
  checks += 1

  // 4. Ending states the wizard renders.
  const failed = await install(fresh, { exit: '1', stderr: 'ERR_PNPM_LINKING_FAILED something' })
  check(failed.result.kind === 'failed' && failed.result.exitCode === 1, '普通非零退出 → failed + exitCode')
  check(failed.result.kind === 'failed' && failed.result.tail.some(line => line.includes('ERR_PNPM_LINKING_FAILED')), 'failed 带上输出尾部')
  const mismatch = await install(fresh, { exit: '1', stderr: '[ERR_PNPM_UNEXPECTED_STORE] Unexpected store location' })
  assert.deepEqual(mismatch.result, { kind: 'store-mismatch', storeDir: join(root, 'profiles', '.pnpm-store') }, 'store 漂移单独成态并带上要指认的 store')
  checks += 1

  // 5. pnpm absent from PATH → pnpm-missing (the preflight's wording). The
  //    empty dir is deliberate: Node's own bin dir ships a `pnpm` shim, so it
  //    cannot stand in for "no pnpm".
  const realPath = process.env.PATH
  const emptyPath = join(root, 'empty-bin')
  mkdirSync(emptyPath, { recursive: true })
  process.env.PATH = emptyPath
  try {
    const absent = await install(fresh)
    check(absent.result.kind === 'pnpm-missing', 'PATH 上没有 pnpm → pnpm-missing')
  } finally {
    process.env.PATH = realPath
  }

  console.log(`verify:claude-sdk-install OK (${checks} checks)`)
} finally {
  rmSync(root, { recursive: true, force: true })
}
