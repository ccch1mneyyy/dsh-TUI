/**
 * Focused verification for the `@` file-suggestion pure utilities and the
 * mention parser shared rules. Run: node --import tsx/esm scripts/verify-file-suggestions.ts
 */
import assert from 'node:assert/strict'
import {
  fuzzySubsequenceScore,
  isPathLikeQuery,
  preserveSelection,
  rankFileCandidates,
  type FileCandidate,
} from '../src/utils/fileSuggestions.ts'
import { extractMentions, mentionAtCaret } from '../src/utils/mentions.ts'

const candidate = (
  path: string,
  kind: 'file' | 'directory' = 'file',
): FileCandidate => ({
  id: path,
  path,
  displayPath: path,
  name: path.split('/').pop() ?? path,
  kind,
  score: 0,
})

// --- isPathLikeQuery -------------------------------------------------------
assert.equal(isPathLikeQuery('mentions'), false)
assert.equal(isPathLikeQuery('src/'), true)
assert.equal(isPathLikeQuery('./src'), true)
assert.equal(isPathLikeQuery('../lib'), true)
assert.equal(isPathLikeQuery('~/notes'), true)
assert.equal(isPathLikeQuery('/abs/path'), true)
assert.equal(isPathLikeQuery('~'), true)
assert.equal(isPathLikeQuery('.'), true)
assert.equal(isPathLikeQuery('..'), true)
assert.equal(isPathLikeQuery('src\\util'), true)
assert.equal(isPathLikeQuery('D:/proj'), true)

// --- fuzzy scoring ---------------------------------------------------------
assert.notEqual(fuzzySubsequenceScore('mentions', 'src/utils/mentions.ts'), undefined)
assert.equal(fuzzySubsequenceScore('zzz', 'src/utils/mentions.ts'), undefined)
// Prefix matches outrank scattered subsequence matches.
const prefix = fuzzySubsequenceScore('ment', 'mentions.ts')!
const scattered = fuzzySubsequenceScore('ment', 'src/environments/keep.ts')!
assert.ok(prefix > scattered, `prefix ${prefix} should beat scattered ${scattered}`)

// --- ranking ---------------------------------------------------------------
const pool = [
  candidate('src/utils/mentions.ts'),
  candidate('docs/mentions.md'),
  candidate('src/components/PromptInput.tsx'),
  candidate('src/ink/', 'directory'),
]
const ranked = rankFileCandidates(pool, 'mentions', 10)
assert.equal(ranked.length, 3)
assert.equal(ranked[0]!.path, 'docs/mentions.md') // shorter path wins
assert.ok(rankFileCandidates(pool, 'zzzz', 10).length === 0)
// topK slices.
assert.ok(rankFileCandidates(pool, '', 2).length === 2)

// --- preserveSelection -----------------------------------------------------
const a = candidate('src/a.ts')
const next = [candidate('src/b.ts'), a, candidate('src/c.ts')]
assert.equal(preserveSelection(a, next, 0), 1)
assert.equal(preserveSelection(candidate('src/gone.ts'), next, 2), 2)
assert.equal(preserveSelection(undefined, next, 5), 2)
assert.equal(preserveSelection(a, [], 0), 0)

// --- mention parser --------------------------------------------------------
const tokens = extractMentions('check @src/a.ts and @"my dir/b.ts" plus @src/c.ts, email a@b.c stays')
assert.deepEqual(
  tokens.map(token => token.path),
  ['src/a.ts', 'my dir/b.ts', 'src/c.ts,'],
)
const caret = mentionAtCaret('check @src/uti', 14)
assert.equal(caret?.start, 6)
assert.equal(caret?.query, 'src/uti')
// Windows separator stays part of the caret token.
const winCaret = mentionAtCaret('check @src\\uti', 14)
assert.equal(winCaret?.query, 'src\\uti')
// Quoted path under the caret: scanning back stops at the opening quote,
// so only positions inside the quote body report the token (existing rule).
const quoted = mentionAtCaret('see @"my dir/x', 7)
assert.equal(quoted?.start, 4)
assert.equal(quoted?.query, 'm')

console.log('verify-file-suggestions: all assertions passed')
