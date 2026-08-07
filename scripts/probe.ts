/**
 * Loader-less plugin assembly probe: imports every package named in
 * cordis.yml the way the Loader would, reporting export shapes. Run with:
 *   node --import tsx/esm scripts/probe.ts
 */
const plugins = [
  '@deepseek-ai/dsh-cc-tui',
  '@deepseek-ai/dsh-llm-deepseek',
  '@deepseek-ai/dsh-subprocess-local',
  '@deepseek-ai/dsh-bash-local',
  '@deepseek-ai/dsh-agent-spine-demo',
]

for (const name of plugins) {
  try {
    const mod = await import(name)
    const keys = Object.keys(mod)
    const hasName = typeof mod.name === 'string'
    const hasApply = typeof mod.apply === 'function'
    console.log(`OK   ${name} -> name=${hasName} apply=${hasApply} exports=[${keys.slice(0, 8).join(', ')}]`)
  } catch (error) {
    console.log(`FAIL ${name}: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`)
  }
}
