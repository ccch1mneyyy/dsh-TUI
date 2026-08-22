import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Must run before any dsh module is imported: src/utils/paths.ts freezes
// DATA_DIR from os.homedir() at module scope, and prompt history writes
// go straight to the real ~/.dsh-tui otherwise.
const fakeHome = mkdtempSync(join(tmpdir(), 'dsh-tui-home-'));
process.env.HOME = fakeHome;
process.env.USERPROFILE = fakeHome;
