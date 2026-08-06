import { logForDebugging } from '../utils/debug.js';
import { Stream } from 'stream';
import Ink from './ink.js';
import instances from './instances.js';
/**
 * Mount a component and render the output.
 */
export const renderSync = (node, options) => {
    const opts = getOptions(options);
    const inkOptions = {
        stdout: process.stdout,
        stdin: process.stdin,
        stderr: process.stderr,
        exitOnCtrlC: true,
        patchConsole: true,
        ...opts,
    };
    const instance = getInstance(inkOptions.stdout, () => new Ink(inkOptions));
    instance.render(node);
    return {
        rerender: instance.render,
        unmount() {
            instance.unmount();
        },
        waitUntilExit: instance.waitUntilExit,
        cleanup: () => instances.delete(inkOptions.stdout),
    };
};
const wrappedRender = async (node, options) => {
    // Preserve the microtask boundary that `await loadYoga()` used to provide.
    // Without it, the first render fires synchronously before async startup work
    // (e.g. useReplBridge notification state) settles, and the subsequent Static
    // write overwrites scrollback instead of appending below the logo.
    await Promise.resolve();
    const instance = renderSync(node, options);
    logForDebugging(`[render] first ink render: ${Math.round(process.uptime() * 1000)}ms since process start`);
    return instance;
};
export default wrappedRender;
/**
 * Create an Ink root without rendering anything yet.
 * Like react-dom's createRoot — call root.render() to mount a tree.
 */
export async function createRoot({ stdout = process.stdout, stdin = process.stdin, stderr = process.stderr, exitOnCtrlC = true, patchConsole = true, onFrame, } = {}) {
    // See wrappedRender — preserve microtask boundary from the old WASM await.
    await Promise.resolve();
    const instance = new Ink({
        stdout,
        stdin,
        stderr,
        exitOnCtrlC,
        patchConsole,
        onFrame,
    });
    // Register in the instances map so that code that looks up the Ink
    // instance by stdout (e.g. external editor pause/resume) can find it.
    instances.set(stdout, instance);
    return {
        render: node => instance.render(node),
        unmount: () => instance.unmount(),
        waitUntilExit: () => instance.waitUntilExit(),
    };
}
const getOptions = (stdout = {}) => {
    if (stdout instanceof Stream) {
        return {
            stdout,
            stdin: process.stdin,
        };
    }
    return stdout;
};
const getInstance = (stdout, createInstance) => {
    let instance = instances.get(stdout);
    if (!instance) {
        instance = createInstance();
        instances.set(stdout, instance);
    }
    return instance;
};
//# sourceMappingURL=root.js.map