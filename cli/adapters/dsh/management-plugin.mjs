/** DSH-only read adapter, mounted by the official profile loader (no UI). */
export const name = 'dst-cli-management'

function service(ctx, key) {
  const value = ctx.get(key)
  if (value === undefined) throw Object.assign(new Error(`Missing service ${key}`), { code: 'CAPABILITY_UNAVAILABLE' })
  return value
}

function headerDto(record) {
  const h = record.header
  return {
    sessionId: h.id, cwd: h.cwd, createdAt: h.createdAt,
    ...(h.parentSession === undefined ? {} : { parentSession: h.parentSession }),
    ...(h.agentPreset === undefined ? {} : { agentPreset: h.agentPreset }),
    persisted: record.persisted, live: record.live,
  }
}

function compatible(snapshot, cwd) {
  const h = snapshot.session
  return h.cwd === cwd && h.origin !== 'subagent' && h.parentSession === undefined
    && h.agentPreset === undefined
    && !snapshot.events.some(event => event.type === 'agent-preset/selected')
}

function markdown(snapshot) {
  const lines = [`# Session ${snapshot.session.id}`, '']
  for (const event of snapshot.events) {
    if (!['user/message', 'assistant/message'].includes(event.type)) continue
    const message = event.data?.message
    const text = message?.content?.filter(block => block.type === 'text').map(block => block.text).join('\n')
    if (text) lines.push(`## ${event.type === 'user/message' ? 'User' : 'Assistant'}`, '', text, '')
  }
  return lines.join('\n')
}

/** Public service calls only. No file scanning, private format or credential values. */
export async function manage(ctx, request) {
  if (request.kind === 'session') {
    const query = service(ctx, 'sessionQuery')
    if (request.action === 'show') return query.readSession(request.sessionId)
    if (request.action === 'export') return markdown(await query.readSurface(request.sessionId))
    const rows = (await query.listSessions()).filter(row => request.all || row.header.cwd === request.cwd)
    if (request.action === 'list') return rows.slice(0, request.limit ?? 50).map(headerDto)
    if (request.action === 'continue') {
      // listSessions is newest-first by header; choose by latest validated activity.
      let latest
      for (const row of rows) {
        if (!row.persisted || row.live || row.header.origin === 'subagent' || row.header.parentSession !== undefined || row.header.agentPreset !== undefined) continue
        const snapshot = await query.readSession(row.header.id)
        if (!compatible(snapshot, request.cwd)) continue
        const time = snapshot.events.at(-1)?.time ?? snapshot.session.createdAt
        if (latest === undefined || time > latest.time) latest = { sessionId: row.header.id, time }
      }
      if (latest === undefined) throw Object.assign(new Error('No compatible session'), { code: 'SESSION_NOT_FOUND' })
      return { sessionId: latest.sessionId }
    }
  }
  if (request.kind === 'models') {
    const llm = service(ctx, 'llm')
    const providers = llm.listProviders().filter(provider => !request.provider || provider.id === request.provider)
    if (request.provider && providers.length === 0) throw Object.assign(new Error('Unknown provider'), { code: 'PROVIDER_NOT_FOUND' })
    const result = []
    for (const provider of providers) {
      const models = await llm.listModels(provider.id)
      result.push({ provider: provider.id, models: models.map(model => ({ id: model.id, name: model.name })) })
    }
    return result
  }
  if (request.kind === 'skills') {
    return (await service(ctx, 'skills').list({ cwd: request.cwd })).map(skill => ({
      name: skill.name, description: skill.description, source: skill.source,
      provider: skill.provider, invocation: skill.invocation,
    }))
  }
  if (request.kind === 'mcp') {
    const names = service(ctx, 'tools').schemas().map(tool => tool.name).filter(name => name.startsWith('mcp__'))
    const servers = new Map()
    for (const name of names) {
      const server = name.split('__')[1]
      const tools = servers.get(server) ?? []
      tools.push(name)
      servers.set(server, tools)
    }
    return { observation: 'registered-tools', connectionHealth: 'unavailable', servers: [...servers].map(([name, tools]) => ({ name, tools })) }
  }
  if (request.kind === 'auth') {
    const info = await service(ctx, 'credentials').describe('DEEPSEEK_API_KEY')
    return { credentialRef: 'DEEPSEEK_API_KEY', configured: info.configured === true, writable: info.writable === true, ...(typeof info.source === 'string' ? { source: info.source } : {}) }
  }
  throw Object.assign(new Error('Unsupported management action'), { code: 'CAPABILITY_UNAVAILABLE' })
}

/** Do not await loader settlement from apply: that would wait on this fiber. */
export function apply(ctx, config) {
  const run = async () => {
    await ctx.get('loader')?.await()
    const exit = service(ctx, 'appExit')
    try {
      const data = await manage(ctx, config.request)
      await new Promise((resolve, reject) => process.stdout.write(`${JSON.stringify({ schemaVersion: 1, type: 'final', data })}\n`, error => error ? reject(error) : resolve()))
      exit(0)
    } catch (error) {
      const code = error.code === 'SESSION_QUERY_SESSION_NOT_FOUND' ? 'SESSION_NOT_FOUND'
        : ['SESSION_NOT_FOUND', 'PROVIDER_NOT_FOUND', 'CAPABILITY_UNAVAILABLE'].includes(error.code) ? error.code : 'MANAGEMENT_FAILED'
      process.stdout.write(`${JSON.stringify({ schemaVersion: 1, type: 'error', code, message: 'DSH management operation failed' })}\n`, () => exit(1))
    }
  }
  void run().catch(() => ctx.get('appExit')?.(1))
}
