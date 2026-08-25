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

// --- line-range suffix (issue #359) ----------------------------------------
const ranged = extractMentions('see @src/a.ts#L12-14 and @b.ts#L7 and @c.ts#L14-12 and @"my dir/d.ts"#L3-5')
assert.deepEqual(
  [ranged[0]?.path, ranged[0]?.startLine, ranged[0]?.endLine, ranged[0]?.literal, ranged[0]?.end],
  ['src/a.ts', 12, 14, 'src/a.ts#L12-14', 20],
)
// Single-line form: start === end.
assert.deepEqual([ranged[1]?.path, ranged[1]?.startLine, ranged[1]?.endLine], ['b.ts', 7, 7])
// Inverted range is NOT a suffix — kept as a literal path (pre-#359 behavior).
assert.deepEqual([ranged[2]?.path, ranged[2]?.startLine], ['c.ts#L14-12', undefined])
// Quoted body + suffix: token extends past the closing quote.
assert.deepEqual(
  [ranged[3]?.path, ranged[3]?.startLine, ranged[3]?.endLine, ranged[3]?.literal],
  ['my dir/d.ts', 3, 5, 'my dir/d.ts#L3-5'],
)
// A legal filename containing `#` never trips the suffix (must anchor at END).
const hashName = extractMentions('open @report#L12.md plus @x#L0 and @y#L3-')[0]
assert.equal(hashName?.path, 'report#L12.md')
assert.equal(hashName?.startLine, undefined)
// `#L0` (0-line) and dangling `#L3-` are malformed → literal, and `@y#L3-`
// dedupes independently of a plain `@y` mention.
const malformed = extractMentions('a @x#L0 b @y#L3- c @y')
assert.deepEqual(malformed.map(token => token.path), ['x#L0', 'y#L3-', 'y'])
// Caret query strips the suffix: completion matches on the path portion,
// and pathEnd marks where the typed suffix starts (accept must not eat it).
const rangeEnd = mentionAtCaret('see @src/a.ts#L12', 17)
assert.equal(rangeEnd?.query, 'src/a.ts')
assert.equal(rangeEnd?.pathEnd, 13)
const rangeMid = mentionAtCaret('see @src/a.ts#L12', 10)
assert.equal(rangeMid?.query, 'src/a')
assert.equal(rangeMid?.pathEnd, 13)

console.log('verify-file-suggestions: all assertions passed')
