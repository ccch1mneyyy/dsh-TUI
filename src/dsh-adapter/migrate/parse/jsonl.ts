/**
 * Line-delimited JSON reading shared by every migration source.
 *
 * Foreign stores are read defensively: a malformed line costs that line,
 * never the file. Legal JSON that is not a record (`null`, scalars, arrays)
 * is skipped silently — it is well-formed, just not a row — while text that
 * fails to parse is COUNTED, so a truncated or corrupted source shows up in
 * the import stats instead of vanishing quietly.
 *
 * @module @deepseek-harness-tui/dsh-tui/migrate/parse/jsonl
 */

// The reader is shared with the Claude backend's transcript reader and lives
// in the backend-neutral seam (`src/backends/shared/jsonl.ts`, D15) so a
// backend never reads `src/utils/`; re-exported here for the migration sources.
export { isRecord, parseJsonl, type JsonlRows, type JsonRecord } from '../../../backends/shared/jsonl.js'
