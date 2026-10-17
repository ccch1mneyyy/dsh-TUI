/** Keyless real-runtime provider fixture; never installed in a user profile. */
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
const require = createRequire(process.env.DST_TEST_DSH_BIN)
const { LlmAdapter } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-llm')).href)
class TestAdapter extends LlmAdapter {
  async *stream() {
    const text = 'CLI_RUNTIME_OK 🐋'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'usage', usage: { inputTokens: 4, outputTokens: 3 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
export const name = 'dst-test-provider'
export const inject = ['llm']
export function apply(ctx) { ctx.llm.registerAdapter(['dst-test'], new TestAdapter()) }
