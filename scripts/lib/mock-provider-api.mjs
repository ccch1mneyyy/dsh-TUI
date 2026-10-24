/**
 * 引导（Onboarding）端到端回归用的**本地回环** mock provider API。
 *
 * 只监听 `127.0.0.1` 的随机端口，提供引导登录/采纳流程真正会打到的那几个
 * 端点，并把每次请求原样记下来供断言：
 *
 *   GET  /v1/models              模型目录（`{ object: 'list', data: [...] }`）
 *   POST /oauth/authorize        登录第一步，回 `{ code, state }`
 *   POST /oauth/token            登录第二步，回 `{ access_token, ... }`
 *   POST /v1/chat/completions    回 `pong`（证明"打的是 mock，不是真接口"）
 *
 * 纪律：**禁止真实网络**由调用方把 `globalThis.fetch` 包成「非 127.0.0.1
 * 即抛」的守卫（见 `verify-onboarding-e2e-mock.tsx`），本模块自己不碰外部网络。
 *
 * 纯 ESM JS（无类型编译），`.mjs` 与 `.tsx` 脚本都能直接 import。
 */

import { createServer } from 'node:http'

/** @typedef {{ provider: string, id: string, name: string }} ModelRef */
/** @typedef {{ method: string, url: string, body: string, host: string | undefined, authorization: string | undefined, at: number }} RecordedRequest */

/**
 * 起一个 mock provider API。返回的对象上：
 * - `baseUrl`   `http://127.0.0.1:<port>`
 * - `requests`  按时间序的请求记录（可直接深比较）
 * - `signedIn`  是否已经走过 `/oauth/token`
 * - `signIn()` 走一遍真实的 authorize→token HTTP 流程（走 mock，不走真接口）
 * - `close()`  关服务器
 * @param {{ models?: readonly ModelRef[] }} [options]
 */
export async function startMockProviderApi(options = {}) {
  /** @type {readonly ModelRef[]} */
  const models = options.models ?? []
  /** @type {RecordedRequest[]} */
  const requests = []
  const json = (/** @type {import('node:http').ServerResponse} */ res, /** @type {number} */ status, /** @type {unknown} */ payload) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(JSON.stringify(payload))
  }
  const server = createServer((req, res) => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      requests.push({
        method: req.method ?? 'GET',
        url: req.url ?? '/',
        body,
        host: req.headers.host,
        authorization: typeof req.headers.authorization === 'string' ? req.headers.authorization : undefined,
        at: Date.now(),
      })
      const url = req.url ?? '/'
      if (req.method === 'GET' && url === '/v1/models') {
        return json(res, 200, {
          object: 'list',
          data: models.map(model => ({ id: model.id, object: 'model', owned_by: model.provider })),
        })
      }
      if (req.method === 'POST' && url === '/oauth/authorize') {
        return json(res, 200, { code: 'mock-authorization-code', state: 'mock-state' })
      }
      if (req.method === 'POST' && url === '/oauth/token') {
        return json(res, 200, { access_token: 'mock-access-token', token_type: 'Bearer', expires_in: 3600 })
      }
      if (req.method === 'POST' && url === '/v1/chat/completions') {
        return json(res, 200, { choices: [{ message: { role: 'assistant', content: 'pong' } }] })
      }
      // Anthropic Messages SSE：DSH 内核的 `dsh-llm-deepseek` 打的就是
      // `POST {baseURL}/v1/messages` 且 `accept: text/event-stream`
      // （安装内核 `dsh-llm-deepseek/lib/index.js:2207,2250` → `parseSse`）。
      // 每帧用 `data: {json}`，JSON 里的 `type` 就是事件名。
      if (req.method === 'POST' && url === '/v1/messages') {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-store',
          connection: 'keep-alive',
        })
        const frame = payload => res.write(`data: ${JSON.stringify(payload)}\n\n`)
        frame({ type: 'message_start', message: { id: 'msg_mock', type: 'message', role: 'assistant', model: 'mock-model', content: [], usage: { input_tokens: 3, output_tokens: 1 } } })
        frame({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
        for (const piece of ['pong', ' from mock']) frame({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: piece } })
        frame({ type: 'content_block_stop', index: 0 })
        frame({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } })
        frame({ type: 'message_stop' })
        res.end()
        return
      }
      return json(res, 404, { error: 'not found', url })
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('mock provider API: no TCP address')
  const baseUrl = `http://127.0.0.1:${address.port}`
  const post = (path, payload) => fetch(baseUrl + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  return {
    baseUrl,
    requests,
    models,
    get messagesRequests() {
      return requests.filter(request => request.url === '/v1/messages')
    },
    get signedIn() {
      return requests.some(request => request.url === '/oauth/token')
    },
    /** 真的走 HTTP：authorize → token，两步都落在 mock 上。 */
    async signIn(/** @type {string} */ provider) {
      const authorize = await post('/oauth/authorize', { provider, redirect_uri: 'http://127.0.0.1/callback' })
      if (!authorize.ok) throw new Error(`mock authorize failed: ${authorize.status}`)
      const { code } = /** @type {{ code: string }} */ (await authorize.json())
      const token = await post('/oauth/token', { provider, code, grant_type: 'authorization_code' })
      if (!token.ok) throw new Error(`mock token failed: ${token.status}`)
      return /** @type {{ access_token: string }} */ (await token.json())
    },
    /** 打一次 completions，证明对话也走 mock。 */
    async chat(/** @type {string} */ prompt) {
      const response = await post('/v1/chat/completions', { model: models[0]?.id, messages: [{ role: 'user', content: prompt }] })
      if (!response.ok) throw new Error(`mock completions failed: ${response.status}`)
      return /** @type {{ choices: Array<{ message: { content: string } }> }} */ (await response.json())
    },
    async close() {
      await new Promise(resolve => server.close(resolve))
    },
  }
}
