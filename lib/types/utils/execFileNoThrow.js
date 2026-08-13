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
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => {
            stdout += chunk.toString();
        });
        child.stderr.on('data', (chunk) => {
            stderr += chunk.toString();
        });
        child.on('error', () => {
            resolve({ code: 1, stdout, stderr });
        });
        child.on('close', code => {
            resolve({ code, stdout, stderr });
        });
        if (options?.input !== undefined)
            child.stdin.write(options.input);
        child.stdin.end();
    });
}
