/**
 * 便携包更新下载 SHA256 校验框架回归（src/update.ts）。
 *
 * 安全审查高危（第一半）：更新器从 GitHub Release 下载主资产后直接落盘
 * 解压替换，无任何完整性校验——下载链路（代理/镜像/劫持）任何一环篡改
 * 字节都会直接变成被执行的二进制。断言：
 *  - verifyAssetChecksum：SHA256SUMS 清单解析（`hex␣␣name` / `hex␣*name`
 *    二进制格式 / 大小写 hex / 单资产纯 digest 旁注）、篡改字节拒绝、
 *    缺条目拒绝（fail-closed）、畸形清单拒绝；
 *  - fetchGithubLatestRelease：release 资产列表中的 SHA256SUMS /
 *    *.sha256 旁注被解析成 checksumUrl（注入 apiBaseUrl + 本地 http）；
 *  - downloadAndReplaceStandaloneBinary（本地 http server + 临时假二进制）：
 *    (a) sums 匹配 → 替换成功；篡改资产字节 → 拒绝替换且磁盘不留下载
 *    残留；(c) 无 sums → transition 期警告路径继续；
 *  - 下载体积上限：content-length 声明超过 512MB 直接拒绝。
 *
 * Run: node --import tsx/esm scripts/verify-update-checksum.tsx
 */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as http from 'node:http'

let failures = 0
function check(name: string, condition: boolean, detail = ''): void {
  console.log(`${condition ? 'PASS' : 'FAIL'}: ${name}${detail === '' ? '' : `  (${detail})`}`)
  if (!condition) failures += 1
}

const updateModule = (await import('../src/update.js')) as Record<string, unknown>
const verifyAssetChecksum = updateModule.verifyAssetChecksum as
  | ((buffer: Buffer, manifestText: string, assetName: string) => boolean)
  | undefined

const scratch = mkdtempSync(join(tmpdir(), 'verify-update-checksum-'))

// ═══════════════ Part 1：verifyAssetChecksum 纯函数 ═══════════════

check('verifyAssetChecksum 已导出', typeof verifyAssetChecksum === 'function')

if (typeof verifyAssetChecksum === 'function') {
  const payload = Buffer.from('legit binary bytes\n')
  const digest = createHash('sha256').update(payload).digest('hex')
  const upper = digest.toUpperCase()
  const asset = 'dsh-tui-standalone-linux-x64.tar.gz'

  check('标准 SHA256SUMS 行（两空格分隔）匹配', verifyAssetChecksum(payload, `${digest}  ${asset}\n`, asset))
  check('二进制格式（* 前缀）匹配', verifyAssetChecksum(payload, `${digest} *${asset}\n`, asset))
  check('大写 hex 摘要匹配', verifyAssetChecksum(payload, `${upper}  ${asset}\n`, asset))
  check('多行清单按资产名取行', verifyAssetChecksum(
    payload,
    `${createHash('sha256').update(Buffer.from('other')).digest('hex')}  dsh-tui-standalone-win-x64.zip\n`
      + `${digest}  ${asset}\n`,
    asset,
  ))
  check('单资产纯 digest 旁注（.sha256 无名行）匹配', verifyAssetChecksum(payload, `${digest}\n`, asset))
  check('CRLF 清单匹配', verifyAssetChecksum(payload, `${digest}  ${asset}\r\n`, asset))

  const tampered = Buffer.from('evil binary bytes\n')
  check('篡改字节后摘要不匹配 → 拒绝', !verifyAssetChecksum(tampered, `${digest}  ${asset}\n`, asset))
  check('清单缺该资产条目 → 拒绝（fail-closed）', !verifyAssetChecksum(
    payload,
    `${createHash('sha256').update(Buffer.from('other')).digest('hex')}  some-other-asset.zip\n`,
    asset,
  ))
  check('畸形清单行 → 拒绝', !verifyAssetChecksum(payload, `not-a-hash  ${asset}\n`, asset))
  check('多个裸 digest 行 → 拒绝（无法定位资产）', !verifyAssetChecksum(payload, `${digest}\n${digest}\n`, asset))
  check('空清单 → 拒绝', !verifyAssetChecksum(payload, '', asset))
}

// ═══════════════ Part 2：fetchGithubLatestRelease 解析 checksumUrl ═══════════════

// 本地 http server 充当 GitHub：/releases/latest 返回 JSON，/asset 返回
// 归档字节（tampered 标志切换内容），/SHA256SUMS 返回清单。
let tamperAsset = false
let omitSums = false
const realAssetBytes = makeAssetArchive('legit-new-binary\n')
const evilAssetBytes = makeAssetArchive('evil-tampered-binary\n')
const realDigest = createHash('sha256').update(realAssetBytes).digest('hex')
const ASSET_NAME = 'dsh-tui-standalone-linux-x64.tar.gz'

const server = http.createServer((req, res) => {
  const url = req.url ?? ''
  // 注意：fetchGithubLatestRelease 请求的是 `<apiBaseUrl>/repos/<repo>/releases/latest`。
  if (url === '/repos/ccch1mneyyy/dsh-TUI/releases/latest') {
    const assets: Array<Record<string, string>> = [
      { name: ASSET_NAME, browser_download_url: `http://127.0.0.1:${serverPort()}/asset` },
    ]
    if (!omitSums) {
      assets.push({ name: 'SHA256SUMS', browser_download_url: `http://127.0.0.1:${serverPort()}/SHA256SUMS` })
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ tag_name: 'v9.9.9', assets }))
    return
  }
  if (url === '/asset') {
    const bytes = tamperAsset ? evilAssetBytes : realAssetBytes
    res.writeHead(200, { 'content-length': String(bytes.length) })
    res.end(bytes)
    return
  }
  if (url === '/SHA256SUMS') {
    // 无论资产是否被篡改，清单始终登记「合法」字节的摘要。
    const body = `${realDigest}  ${ASSET_NAME}\n`
    res.writeHead(200, { 'content-length': String(body.length) })
    res.end(body)
    return
  }
  if (url === '/huge') {
    // 声明超限的 content-length：检查必须发生在读 body 之前。
    res.writeHead(200, { 'content-length': String(600 * 1024 * 1024) })
    res.end()
    return
  }
  res.writeHead(404)
  res.end('not found')
})
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
function serverPort(): number {
  return (server.address() as { port: number }).port
}
const base = `http://127.0.0.1:${serverPort()}`

{
  const release = await updateModule.fetchGithubLatestRelease({ apiBaseUrl: base })
  check(
    'fetchGithubLatestRelease 解析版本号',
    (release as { version?: string } | undefined)?.version === '9.9.9',
    JSON.stringify(release),
  )
  check(
    'fetchGithubLatestRelease 从 SHA256SUMS 资产解析 checksumUrl',
    typeof (release as { checksumUrl?: string } | undefined)?.checksumUrl === 'string',
    JSON.stringify(release),
  )
  omitSums = true
  const noSums = await updateModule.fetchGithubLatestRelease({ apiBaseUrl: base })
  check(
    'release 无 SHA256SUMS 资产时 checksumUrl 缺省（走 transition 警告路径）',
    (noSums as { checksumUrl?: string } | undefined)?.checksumUrl === undefined,
    JSON.stringify(noSums),
  )
  omitSums = false
}

// ═══════════════ Part 3：downloadAndReplaceStandaloneBinary 端到端 ═══════════════

// 临时假二进制 + 临时缓存目录：DSH_TUI_STANDALONE_BINARY / _CACHE 注入，
// 替换动作发生在 scratch 内，不碰真实安装。
const fakeCurrentBinary = join(scratch, 'current', 'dsh-tui')
mkdirSync(join(scratch, 'current'), { recursive: true })
writeFileSync(fakeCurrentBinary, 'old binary\n')
chmodSync(fakeCurrentBinary, 0o755)
const cacheDir = join(scratch, 'cache')
mkdirSync(cacheDir, { recursive: true })
process.env.DSH_TUI_STANDALONE_BINARY = fakeCurrentBinary
process.env.DSH_TUI_STANDALONE_CACHE = cacheDir

const downloadFn = updateModule.downloadAndReplaceStandaloneBinary as
  | ((url: string, onProgress?: (text: string) => void, checksumUrl?: string) =>
      Promise<{ success: boolean; error?: string }>)
  | undefined

function cacheLeftovers(): string[] {
  try {
    return readdirSync(cacheDir).filter(name => name.startsWith('.update-'))
  } catch {
    return []
  }
}

if (typeof downloadFn === 'function') {
  // (a) sums 匹配 → 成功替换
  tamperAsset = false
  const okResult = await downloadFn(`${base}/asset`, undefined, `${base}/SHA256SUMS`)
  check('sums 匹配时更新成功', okResult.success, JSON.stringify(okResult))
  check(
    'sums 匹配时二进制被替换为新内容',
    readFileSync(fakeCurrentBinary, 'utf8') === 'legit-new-binary\n',
  )
  check('成功路径缓存目录无下载残留', cacheLeftovers().length === 0, cacheLeftovers().join(','))

  // (b) 篡改资产字节 → 拒绝替换且不留盘（fail-closed）
  tamperAsset = true
  writeFileSync(fakeCurrentBinary, 'old binary\n')
  const tamperedResult = await downloadFn(`${base}/asset`, undefined, `${base}/SHA256SUMS`)
  check('篡改资产字节后拒绝替换（fail-closed）', !tamperedResult.success, JSON.stringify(tamperedResult))
  check(
    '篡改被拒绝时错误信息提及校验和',
    /checksum|sha256|校验/i.test(tamperedResult.error ?? ''),
    JSON.stringify(tamperedResult.error),
  )
  check(
    '篡改被拒绝时当前二进制保持原内容',
    readFileSync(fakeCurrentBinary, 'utf8') === 'old binary\n',
    readFileSync(fakeCurrentBinary, 'utf8'),
  )
  check('篡改被拒绝后缓存目录无下载残留', cacheLeftovers().length === 0, cacheLeftovers().join(','))

  // (c) 无 sums → transition 期警告路径继续
  tamperAsset = false
  const progressLines: string[] = []
  const noSumsResult = await downloadFn(`${base}/asset`, text => progressLines.push(text), undefined)
  check('无 sums 时（transition 期）更新继续成功', noSumsResult.success, JSON.stringify(noSumsResult))
  check(
    '无 sums 时进度输出携带「无校验和」警告',
    progressLines.some(line => /no checksum|no sha256sums|无校验和/i.test(line)),
    JSON.stringify(progressLines),
  )

  // (d) content-length 超过 512MB → 拒绝
  const hugeResult = await downloadFn(`${base}/huge`, undefined, undefined)
  check('content-length 超过 512MB 直接拒绝', !hugeResult.success, JSON.stringify(hugeResult))
  check(
    '超限拒绝错误信息提及大小限制',
    /cap|512\s*MB|too large|超过|exceed/i.test(hugeResult.error ?? ''),
    JSON.stringify(hugeResult.error),
  )
  check('超限拒绝后缓存目录无下载残留', cacheLeftovers().length === 0, cacheLeftovers().join(','))
} else {
  check('downloadAndReplaceStandaloneBinary 已导出', false)
}

server.close()
try { rmSync(scratch, { recursive: true, force: true }) } catch { /* best effort */ }

/** 用系统 tar 造一个内容为 given 文本的 dsh-tui 成员归档（与 release 包同构）。 */
function makeAssetArchive(memberContent: string): Buffer {
  const dir = join(scratch, 'asset-src')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'dsh-tui'), memberContent)
  const archive = join(scratch, 'asset.tar.gz')
  execFileSync('tar', ['-czf', archive, '-C', dir, 'dsh-tui'])
  return Buffer.from([...readFileSync(archive)])
}

if (failures > 0) {
  console.error(`\nverify-update-checksum: ${failures} 个断言失败`)
  process.exit(1)
}
console.log('\nverify-update-checksum: 全部断言通过')
