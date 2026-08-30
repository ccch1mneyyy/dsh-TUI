# Native Task & CodeBlock Parser Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build native stream-level detection for hallucinated/unexecuted bash code blocks and polish Markdown code block rendering in dsh-TUI so non-executed commands and status fences never break the UI or leave task lists unexecuted.

**Architecture:** 
1. Enhance `src/cc/markdown.ts` to detect pseudo-code blocks (blocks containing exclusively comments, status summaries, or metrics) and render them with a clean status-callout presentation instead of raw unexecuted code fences.
2. Enhance `src/dsh-adapter/channel.ts` with an unexecuted command interceptor that detects when an assistant response contains executable bash blocks during a pending task execution turn without an accompanying tool call, surfacing clear actionable warnings and preventing silent task abandonment.
3. Add a dedicated regression test suite in `scripts/verify-codeblock-parser.ts` integrated into `pnpm verify:build`.

**Tech Stack:** TypeScript, Node.js 24, Ink/React TUI, Chalk, Marked.

## Global Constraints
- Pure ESM with `.js` extensions on relative imports.
- Maintain `@deepseek-ai/*` isolation inside `src/dsh-adapter/` only.
- Strict sub-16ms rendering latency: no heavy regex allocations in rendering loops.
- `pnpm verify:build` must pass with 0 errors.

---

### Task 1: Pseudo-CodeBlock & Status Fence Parser in `src/cc/markdown.ts`

**Files:**
- Modify: `Projects/dsh-TUI/src/cc/markdown.ts`
- Test: `Projects/dsh-TUI/scripts/verify-codeblock-parser.ts`

**Interfaces:**
- Consumes: Marked `Tokens.Code`, `RenderState`, `getActiveTheme()`
- Produces: Sanitized ANSI string for code blocks and status annotations

- [ ] **Step 1: Write test case for code block parser in `scripts/verify-codeblock-parser.ts`**

```ts
import { applyMarkdown } from '../src/cc/markdown.js'
import assert from 'node:assert/strict'

// Test 1: Standard executable bash block renders with code fence
const bashCode = '```bash\necho "hello"\nls -la\n```'
const renderedCode = applyMarkdown(bashCode)
assert.ok(renderedCode.includes('echo "hello"'))

// Test 2: Pseudo-code status block with only comments/reports renders cleanly without broken fence
const statusBlock = '```bash\n# Memory & Harness Health Status\nMemory Hygiene: 0 active frictions\n```'
const renderedStatus = applyMarkdown(statusBlock)
assert.ok(renderedStatus.includes('Memory & Harness Health Status'))
console.log('✓ CodeBlock parser tests passed')
```

- [ ] **Step 2: Run test to observe baseline**

Run: `node --import tsx/esm /home/ujji/Projects/dsh-TUI/scripts/verify-codeblock-parser.ts`

- [ ] **Step 3: Implement pseudo-code and status block detection in `src/cc/markdown.ts`**

Update `renderCodeBlock` in `src/cc/markdown.ts`:
```ts
function isStatusOrCommentBlock(text: string): boolean {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean)
  if (lines.length === 0) return false
  // True if all non-empty lines are comments (#) or header annotations
  return lines.every(l => l.startsWith('#') || l.includes(': ') || l.startsWith('- '))
}
```

- [ ] **Step 4: Verify test passes**

Run: `node --import tsx/esm /home/ujji/Projects/dsh-TUI/scripts/verify-codeblock-parser.ts`
Expected: `✓ CodeBlock parser tests passed`

- [ ] **Step 5: Commit**

```bash
git -C /home/ujji/Projects/dsh-TUI add src/cc/markdown.ts scripts/verify-codeblock-parser.ts
git -C /home/ujji/Projects/dsh-TUI commit -m "feat(markdown): add clean status block parsing for bash comments"
```

---

### Task 2: Unexecuted Command Interceptor in `src/dsh-adapter/channel.ts`

**Files:**
- Modify: `Projects/dsh-TUI/src/dsh-adapter/channel.ts`
- Test: `Projects/dsh-TUI/scripts/verify-codeblock-parser.ts`

**Interfaces:**
- Consumes: Session transcript events (`agent/message`, `tools/post-execute`)
- Produces: Warning annotations or synthesized tool-execution hints when bash blocks are emitted in text during active task execution

- [ ] **Step 1: Add unit tests for unexecuted command detection**

Add tests to `scripts/verify-codeblock-parser.ts` verifying that markdown text containing unexecuted commands is detected.

- [ ] **Step 2: Implement command scanner in `src/dsh-adapter/channel.ts`**

Detect unexecuted tool code blocks in assistant text turns and attach diagnostic flags so the UI warns the user rather than silently dropping execution.

- [ ] **Step 3: Run verification test**

Run: `node --import tsx/esm /home/ujji/Projects/dsh-TUI/scripts/verify-codeblock-parser.ts`

- [ ] **Step 4: Commit**

```bash
git -C /home/ujji/Projects/dsh-TUI add src/dsh-adapter/channel.ts scripts/verify-codeblock-parser.ts
git -C /home/ujji/Projects/dsh-TUI commit -m "feat(channel): add unexecuted command detection in assistant turns"
```

---

### Task 3: Full Build Verification & Regression Battery

**Files:**
- Modify: `Projects/dsh-TUI/package.json` (register `verify:codeblock-parser` in `verify:build`)

- [ ] **Step 1: Register script in package.json**
- [ ] **Step 2: Run `pnpm compile` and `pnpm verify:build`**
- [ ] **Step 3: Verify profile boot with `dsh --profile dsh-tui --dump-config`**
- [ ] **Step 4: Commit**

```bash
git -C /home/ujji/Projects/dsh-TUI add package.json
git -C /home/ujji/Projects/dsh-TUI commit -m "chore: integrate verify:codeblock-parser into build gate"
```
