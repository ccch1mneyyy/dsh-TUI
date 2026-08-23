import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PromptAutocompleteProvider } from '../../src/tui/components/prompt-editor.js'
import type { TuiCommands } from '../../src/tui/commands.js'
import type { FileCandidate } from '../../src/utils/fileSuggestions.js'

interface CandidateCall {
  query: string
  topK?: number
}

function makeCommands(
  candidates: readonly FileCandidate[] | undefined,
  calls: CandidateCall[],
  commandCompletions: TuiCommands['query']['commandCompletions'] = () => [],
): TuiCommands {
  return {
    query: {
      listFileCandidates: async (query: string, options?: { topK?: number }) => {
        calls.push({ query, topK: options?.topK })
        return candidates
      },
      commandCompletions,
    },
  } as unknown as TuiCommands
}

function candidate(path: string, kind: 'file' | 'directory' = 'file'): FileCandidate {
  const trimmed = path.endsWith('/') ? path.slice(0, -1) : path
  return {
    id: path,
    path,
    displayPath: path,
    name: trimmed.split('/').pop() ?? trimmed,
    kind,
    score: 0,
  }
}

const noAbort = { signal: new AbortController().signal }

test('@ completion forwards the fragment query and maps structured candidates', async () => {
  const calls: CandidateCall[] = []
  const provider = new PromptAutocompleteProvider(makeCommands([
    candidate('src/utils/mentions.ts'),
    candidate('src/utils/', 'directory'),
  ], calls))

  const line = 'look @ment please'
  const col = 'look @ment'.length
  const result = await provider.getSuggestions([line], 0, col, noAbort)

  // The plain fragment rides to the channel verbatim (fuzzy index mode);
  // directories surface through the pi-tui trailing-`/` label convention.
  assert.deepEqual(calls, [{ query: 'ment', topK: 50 }])
  assert.equal(result?.prefix, '@ment')
  assert.deepEqual(result?.items, [
    { value: 'src/utils/mentions.ts', label: 'mentions.ts', description: 'src/utils/mentions.ts' },
    { value: 'src/utils/', label: 'utils/', description: 'src/utils/' },
  ])
})

test('@ completion forwards path-shaped queries verbatim (the directory-only mode stays channel-side)', async () => {
  const calls: CandidateCall[] = []
  const provider = new PromptAutocompleteProvider(makeCommands([candidate('src/tui/public.ts')], calls))

  const line = '@src/tu'
  const result = await provider.getSuggestions([line], 0, line.length, noAbort)

  assert.deepEqual(calls, [{ query: 'src/tu', topK: 50 }])
  assert.equal(result?.prefix, '@src/tu')
  assert.deepEqual(result?.items, [
    { value: 'src/tui/public.ts', label: 'public.ts', description: 'src/tui/public.ts' },
  ])
})

test('@ completion drops stale (undefined) and empty candidate lists', async () => {
  const calls: CandidateCall[] = []
  const stale = new PromptAutocompleteProvider(makeCommands(undefined, calls))
  assert.equal(await stale.getSuggestions(['@a'], 0, 2, noAbort), null)

  const empty = new PromptAutocompleteProvider(makeCommands([], calls))
  assert.equal(await empty.getSuggestions(['@a'], 0, 2, noAbort), null)
})

test('@ accept: a directory inserts @dir/ without a trailing space so completion continues into it', () => {
  const provider = new PromptAutocompleteProvider(makeCommands([], []))
  const line = 'see @tui now'
  const col = 'see @tui'.length

  const result = provider.applyCompletion([line], 0, col, { value: 'src/tui/', label: 'tui/' }, '@tui')

  assert.deepEqual(result.lines, ['see @src/tui/ now'])
  assert.equal(result.cursorCol, 'see @src/tui/'.length)
})

test('@ accept: a file completes the token with a trailing space', () => {
  const provider = new PromptAutocompleteProvider(makeCommands([], []))
  const line = 'see @ment'

  const result = provider.applyCompletion(
    [line], 0, line.length,
    { value: 'src/utils/mentions.ts', label: 'mentions.ts' },
    '@ment',
  )

  assert.deepEqual(result.lines, ['see @src/utils/mentions.ts '])
  assert.equal(result.cursorCol, 'see @src/utils/mentions.ts '.length)
})

test('@ accept: a path with whitespace is quoted', () => {
  const provider = new PromptAutocompleteProvider(makeCommands([], []))

  const result = provider.applyCompletion(
    ['@my'], 0, 3,
    { value: 'my dir/a.ts', label: 'a.ts' },
    '@my',
  )

  assert.deepEqual(result.lines, ['@"my dir/a.ts" '])
})

test('Tab force-completion only fires inside an @ mention', () => {
  const provider = new PromptAutocompleteProvider(makeCommands([], []))
  assert.equal(provider.shouldTriggerFileCompletion(['plain text'], 0, 5), false)
  assert.equal(provider.shouldTriggerFileCompletion(['see @sr'], 0, 7), true)
})

test('slash completions still map command lines with descriptions', async () => {
  const provider = new PromptAutocompleteProvider(makeCommands([], [], () => [
    { commandLine: '/model', description: 'Switch model' },
  ]))

  const result = await provider.getSuggestions(['/mo'], 0, 3, noAbort)

  assert.equal(result?.prefix, '/mo')
  assert.deepEqual(result?.items, [{ value: '/model', label: '/model', description: 'Switch model' }])
})
