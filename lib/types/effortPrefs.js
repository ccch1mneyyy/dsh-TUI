/**
 * Persisted reasoning-effort preference (`~/.dsh-tui/effort.json`). Shift+Tab
 * cycles the live route's adapter-owned levels (dsh-llm `LlmModelReasoningInfo`);
 * the choice lands here so the next boot starts on it. The file is
 * best-effort: a missing/corrupt file or a level the current adapter does not
 * offer just falls back to the provider default — the first request/header
 * event always re-asserts the truth on the status line.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR } from './utils/paths.js';
const PREFS_DIR = DATA_DIR;
/**
 * The persisted reasoning-effort id, or undefined when unset or invalid.
 * @param dir - Prefs directory (injectable for tests).
 * @returns The persisted effort id, if any.
 */
export function readEffortPref(dir = PREFS_DIR) {
    try {
        const parsed = JSON.parse(readFileSync(join(dir, 'effort.json'), 'utf8'));
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
            return undefined;
        const effort = parsed.effort;
        return typeof effort === 'string' && effort !== '' ? effort : undefined;
    }
    catch {
        return undefined;
    }
}
/**
 * Persist the chosen reasoning-effort id (best effort).
 * @param effort - Adapter-owned effort id to persist.
 * @param dir - Prefs directory (injectable for tests).
 * @returns True when the file was written, false on failure.
 */
export function writeEffortPref(effort, dir = PREFS_DIR) {
    try {
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'effort.json'), JSON.stringify({ effort }, null, 2));
        return true;
    }
    catch {
        return false;
    }
}
