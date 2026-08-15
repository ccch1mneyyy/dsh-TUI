/**
 * Persisted working-activity indicator preference, mirroring the pi
 * working-activity extension's `~/.pi/agent/working-activity.json`
 * (`frames` key). dsh-tui keeps its own copy at
 * `~/.dsh-tui/working-activity.json` so the `/activity` choice survives
 * restarts. The file is best-effort: a missing or corrupt file (or an
 * unknown preset left behind by an older version) just falls back to the
 * default preset.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isPresetName } from './components/activityFrames.js';
import { DATA_DIR } from './utils/paths.js';
const PREFS_DIR = DATA_DIR;
/**
 * Parse a persisted `{ frames }` value; anything else yields undefined.
 * @param text - Raw file contents.
 * @returns The preset name when valid, else undefined.
 */
export function parseActivityFrames(text) {
    try {
        const parsed = JSON.parse(text);
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
            return undefined;
        const frames = parsed.frames;
        return typeof frames === 'string' && isPresetName(frames) ? frames : undefined;
    }
    catch {
        return undefined;
    }
}
/**
 * The persisted indicator preset name, or undefined when unset or invalid.
 * @param dir - Prefs directory (injectable for tests).
 * @returns The persisted preset name, if any.
 */
export function readActivityFrames(dir = PREFS_DIR) {
    try {
        return parseActivityFrames(readFileSync(join(dir, 'working-activity.json'), 'utf8'));
    }
    catch {
        return undefined;
    }
}
/**
 * Persist the chosen indicator preset (best effort).
 * @param name - Preset name to persist.
 * @param dir - Prefs directory (injectable for tests).
 * @returns True when the file was written, false on failure.
 */
export function writeActivityFrames(name, dir = PREFS_DIR) {
    try {
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'working-activity.json'), JSON.stringify({ frames: name }, null, 2));
        return true;
    }
    catch {
        return false;
    }
}
