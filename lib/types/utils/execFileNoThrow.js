import { spawn } from 'node:child_process';
/**
 * Run a command without throwing: resolves with `{ code, stdout, stderr }`
 * even when the process exits non-zero or cannot spawn.
 * @param file - The executable path to spawn.
 * @param args - Command-line arguments; defaults to none.
 * @param options - Spawn options (input, timeout, cwd).
 * @returns The process outcome: exit code, captured stdout, and captured stderr.
 */
export function execFileNoThrow(file, args, options) {
    return new Promise(resolve => {
        const child = spawn(file, args ?? [], { timeout: options?.timeout, cwd: options?.cwd });
        // Collect raw bytes and decode once at close: per-chunk toString() splits
        // multi-byte UTF-8 characters straddling a chunk boundary into U+FFFD.
        const stdoutChunks = [];
        const stderrChunks = [];
        child.stdout.on('data', (chunk) => {
            stdoutChunks.push(chunk);
        });
        child.stderr.on('data', (chunk) => {
            stderrChunks.push(chunk);
        });
        child.on('error', () => {
            resolve({
                code: 1,
                stdout: Buffer.concat(stdoutChunks).toString('utf8'),
                stderr: Buffer.concat(stderrChunks).toString('utf8'),
            });
        });
        child.on('close', code => {
            resolve({
                code,
                stdout: Buffer.concat(stdoutChunks).toString('utf8'),
                stderr: Buffer.concat(stderrChunks).toString('utf8'),
            });
        });
        if (options?.input !== undefined)
            child.stdin.write(options.input);
        child.stdin.end();
    });
}
