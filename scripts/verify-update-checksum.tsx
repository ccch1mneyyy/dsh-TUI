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
 *  - 下载体积上限：content-length 声明超过 512MB 直接拒绝；
 *  - 流式中断（DoS，红队 P-5）：无 content-length 的无界流在「读到上限
 *    即刻」断连中止——server 侧只送出上限附近的字节而非全量，资产
 *    不落盘（注入 2MB 小上限测同一代码路径）；
 *  - 清单流式限额（CodeRabbit Moderate）：清单抓取同样流式中断——无
 *    content-length 的无界清单流注入 64KB 小上限，server 只送出上限
 *    附近字节而非全量（红态：response.text() 全量缓冲后才查上限）。
 *  - 镜像回退路径的清单校验（红队 P-2）：GitHub API 失败 → registry
 *    版本号 → 拼直链时 checksumUrl 丢失。断言回退路径按固定命名规则
 *    探测 SHA256SUMS：存在 → 强校验（篡改资产被拒）；404 → 保持
 *    transition 警告放行（老 release 兼容）。
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
// 无界流统计：server 侧实际写出的字节数（客户端断连即停止累计）。
let streamWritten = 0
let streamClosed = false
const STREAM_CHUNK = 64 * 1024
const STREAM_CHUNKS = 128 // 总量 8MB，注入上限 2MB → 中断应发生在约 1/4 处
// 清单无界流统计（CodeRabbit Moderate：清单抓取同样要流式限额）。
let manifestStreamWritten = 0
let manifestStreamClosed = false
const MANIFEST_STREAM_CHUNK = 16 * 1024
const MANIFEST_STREAM_CHUNKS = 128 // 总量 2MB，注入上限 64KB → 中断应发生在约 1/32 处
const realAssetBytes = makeAssetArchive('legit-new-binary\n')
const evilAssetBytes = makeAssetArchive('evil-tampered-binary\n')
const realDigest = createHash('sha256').update(realAssetBytes).digest('hex')
const ASSET_NAME = 'dsh-tui-standalone-linux-x64.tar.gz'

const server = http.createServer(async (req, res) => {
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
  if (url === '/stream-unbounded') {
    // 无 content-length 的无界流（chunked）：恶意镜像可用它把 arrayBuffer()
    // 全量读进内存后才检查。按 backpressure 节流写出，客户端断连后停止
    // 累计，streamWritten 即「对端实际消费的量级」。
    res.writeHead(200)
    res.on('close', () => { streamClosed = true })
    const chunk = Buffer.alloc(STREAM_CHUNK, 0x41)
    for (let i = 0; i < STREAM_CHUNKS && !streamClosed; i++) {
      const writable = res.write(chunk)
      streamWritten += chunk.length
      if (!writable) await new Promise<void>(resolve => res.once('drain', resolve))
      await new Promise<void>(resolve => setImmediate(resolve))
    }
    res.end()
    return
  }
  if (url === '/stream-manifest-unbounded') {
    // 清单版无界流：主资产已流式限额，但清单抓取若仍是 response.text()
    // 全量缓冲后才查上限（修复前形态），无声明/谎报头的 chunked 清单流
    // 同样可以先吃满内存。同一 backpressure 节流模式。
    res.writeHead(200)
    res.on('close', () => { manifestStreamClosed = true })
    const chunk = Buffer.alloc(MANIFEST_STREAM_CHUNK, 0x42)
    for (let i = 0; i < MANIFEST_STREAM_CHUNKS && !manifestStreamClosed; i++) {
      const writable = res.write(chunk)
      manifestStreamWritten += chunk.length
      if (!writable) await new Promise<void>(resolve => res.once('drain', resolve))
      await new Promise<void>(resolve => setImmediate(resolve))
    }
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
  | ((url: string, onProgress?: (text: string) => void, checksumUrl?: string,
      options?: { maxAssetBytes?: number, maxChecksumManifestBytes?: number }) =>
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

  // (e) 无 content-length 的无界流（红队 P-5）：注入 2MB 小上限（同一
  // 代码路径，默认 512MB），server 发 8MB。断言「读中断点」——server
  // 只送出上限附近（远小于全量）的字节、结果失败、不落盘。红态
  // （修复前 arrayBuffer 全量读入）：8MB 全部送出且错误来自后续解压。
  const streamCap = 2 * 1024 * 1024
  streamWritten = 0
  streamClosed = false
  const streamResult = await downloadFn(`${base}/stream-unbounded`, undefined, undefined, { maxAssetBytes: streamCap })
  const totalStream = STREAM_CHUNK * STREAM_CHUNKS
  check(
    '无界流在超出上限时中断（server 送出远小于全量的字节）',
    streamWritten < totalStream * 0.9 && streamWritten <= streamCap + STREAM_CHUNK * 4,
    `written=${streamWritten} total=${totalStream} cap=${streamCap}`,
  )
  check('无界流超限被拒绝', !streamResult.success, JSON.stringify(streamResult))
  check(
    '无界流拒绝错误信息提及大小上限',
    /over the .* cap|上限|超过/i.test(streamResult.error ?? ''),
    JSON.stringify(streamResult.error),
  )
  check('无界流拒绝后缓存目录无下载残留', cacheLeftovers().length === 0, cacheLeftovers().join(','))

  // (f) 清单流无 content-length 超限（CodeRabbit Moderate）：主资产流式
  // 限额修复后，清单抓取仍是 response.text() 全量缓冲后才查上限——无
  // 声明头的 chunked 清单流可以先吃满内存。主资产正常下载（/asset 带
  // 合法清单可校验的归档），清单换成 2MB 无界流，注入 64KB 小上限（同
  // 一代码路径，默认 1MB）。断言「读中断点」——server 只送出上限附近
  // （远小于全量）的字节、结果失败含上限字样、不落盘。红态（修复前
  // text() 全量读）：2MB 全部送出。
  const manifestCap = 64 * 1024
  manifestStreamWritten = 0
  manifestStreamClosed = false
  const manifestStreamResult = await downloadFn(
    `${base}/asset`, undefined, `${base}/stream-manifest-unbounded`, { maxChecksumManifestBytes: manifestCap },
  )
  const manifestTotal = MANIFEST_STREAM_CHUNK * MANIFEST_STREAM_CHUNKS
  check(
    '清单无界流在超出上限时中断（server 送出远小于全量的字节）',
    manifestStreamWritten < manifestTotal * 0.9 && manifestStreamWritten <= manifestCap + MANIFEST_STREAM_CHUNK * 4,
    `written=${manifestStreamWritten} total=${manifestTotal} cap=${manifestCap}`,
  )
  check('清单无界流超限被拒绝', !manifestStreamResult.success, JSON.stringify(manifestStreamResult))
  check(
    '清单无界流拒绝错误信息提及大小上限',
    /over the .* cap|上限|超过/i.test(manifestStreamResult.error ?? ''),
    JSON.stringify(manifestStreamResult.error),
  )
  check('清单无界流拒绝后缓存目录无下载残留', cacheLeftovers().length === 0, cacheLeftovers().join(','))
} else {
  check('downloadAndReplaceStandaloneBinary 已导出', false)
}


// ═══════════════ Part 4：镜像回退路径的清单校验（红队 P-2） ═══════════════

// 场景：GitHub API 失败（超时/不可达）→ registry 提供 latest 版本号 →
// 更新器拼 GitHub 直链下载。旧实现在这条回退路径上丢失 checksumUrl，
// 篡改资产无校验直接放行。mock 全局 fetch 按 URL 分流（registry /
// api.github.com / github.com 直链）。
{
  const realFetch = globalThis.fetch
  const realStandalone = process.env.DSH_TUI_STANDALONE
  const realRegistry = process.env.NPM_CONFIG_REGISTRY
  const resolveTarget = updateModule.resolveTuiUpdateTarget as
    | (() => Promise<Record<string, unknown>>)
    | undefined

  if (typeof resolveTarget === 'function' && typeof downloadFn === 'function') {
    process.env.DSH_TUI_STANDALONE = '1'
    process.env.NPM_CONFIG_REGISTRY = 'https://registry.npmjs.org'
    const FALLBACK_DOWNLOAD = `https://github.com/ccch1mneyyy/dsh-TUI/releases/download/v9.9.9/${ASSET_NAME}`
    const FALLBACK_SUMS = 'https://github.com/ccch1mneyyy/dsh-TUI/releases/download/v9.9.9/SHA256SUMS'

    let manifestStatus = 200
    let fallbackAssetTampered = false
    globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url.includes('api.github.com')) {
        // GitHub API 不可达 → 触发 registry 回退路径。
        return new Response('', { status: 503 })
      }
      if (url.endsWith('/latest')) {
        return Response.json({ version: '9.9.9' })
      }
      if (url.endsWith('/SHA256SUMS')) {
        if (manifestStatus !== 200) return new Response('not found', { status: manifestStatus })
        return new Response(`${realDigest}  ${ASSET_NAME}\n`)
      }
      if (url.endsWith(ASSET_NAME)) {
        const bytes = fallbackAssetTampered ? evilAssetBytes : realAssetBytes
        return new Response(bytes, { headers: { 'content-length': String(bytes.length) } })
      }
      return new Response('', { status: 404 })
    }) as typeof fetch

    // (a) 回退路径解析出固定命名清单 URL，且清单匹配的资产成功替换
    writeFileSync(fakeCurrentBinary, 'old binary\n')
    fallbackAssetTampered = false
    manifestStatus = 200
    const targetA = await resolveTarget()
    check(
      '镜像回退路径探测到固定命名 SHA256SUMS（checksumUrl 不再丢失）',
      targetA.kind === 'update' && targetA.checksumUrl === FALLBACK_SUMS,
      JSON.stringify(targetA),
    )
    check(
      '回退路径拼出的直链下载地址正确',
      targetA.downloadUrl === FALLBACK_DOWNLOAD,
      JSON.stringify(targetA.downloadUrl),
    )
    const resultA = await downloadFn(
      targetA.downloadUrl as string, undefined, targetA.checksumUrl as string,
    )
    check('回退路径 + 清单匹配 → 更新成功且经过校验', resultA.success, JSON.stringify(resultA))
    check(
      '回退路径 + 清单匹配 → 二进制被替换为新内容',
      readFileSync(fakeCurrentBinary, 'utf8') === 'legit-new-binary\n',
    )

    // (b) 清单存在但资产被篡改 → 回退路径同样拒绝（红态：旧实现无校验
    // 直接放行，篡改归档是合法 tar.gz、解压替换全部成功）
    writeFileSync(fakeCurrentBinary, 'old binary\n')
    fallbackAssetTampered = true
    const targetB = await resolveTarget()
    const resultB = await downloadFn(
      targetB.downloadUrl as string, undefined, targetB.checksumUrl as string,
    )
    check('回退路径 + 清单存在但资产被篡改 → 拒绝替换', !resultB.success, JSON.stringify(resultB))
    check(
      '回退路径篡改拒绝时错误信息提及校验和',
      /checksum|sha256/i.test(resultB.error ?? ''),
      JSON.stringify(resultB.error),
    )
    check(
      '回退路径篡改拒绝时当前二进制保持原内容',
      readFileSync(fakeCurrentBinary, 'utf8') === 'old binary\n',
    )

    // (c) 清单 404（老 release）→ transition 警告放行（兼容不变）
    writeFileSync(fakeCurrentBinary, 'old binary\n')
    fallbackAssetTampered = false
    manifestStatus = 404
    const lines: string[] = []
    const targetC = await resolveTarget()
    check(
      '回退路径清单 404 → checksumUrl 缺省（transition 警告路径）',
      targetC.kind === 'update' && targetC.checksumUrl === undefined,
      JSON.stringify(targetC),
    )
    const resultC = await downloadFn(targetC.downloadUrl as string, text => lines.push(text), undefined)
    check('回退路径清单 404 → 更新继续成功（老 release 兼容）', resultC.success, JSON.stringify(resultC))
    check(
      '回退路径清单 404 → 进度输出携带「无校验和」警告',
      lines.some(line => /no checksum|no sha256sums|无校验和/i.test(line)),
      JSON.stringify(lines),
    )

    globalThis.fetch = realFetch
    if (realStandalone === undefined) delete process.env.DSH_TUI_STANDALONE
    else process.env.DSH_TUI_STANDALONE = realStandalone
    if (realRegistry === undefined) delete process.env.NPM_CONFIG_REGISTRY
    else process.env.NPM_CONFIG_REGISTRY = realRegistry
  } else {
    check('resolveTuiUpdateTarget 已导出', typeof resolveTarget === 'function')
  }
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
