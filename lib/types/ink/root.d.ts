import type { ReactNode } from 'react';
import type { FrameEvent } from './frame.js';
import Ink from './ink.js';
/** Options for mounting an Ink app. */
export type RenderOptions = {
    /**
     * Output stream where app will be rendered.
     *
     * @default process.stdout
     */
    stdout?: NodeJS.WriteStream;
    /**
     * Input stream where app will listen for input.
     *
     * @default process.stdin
     */
    stdin?: NodeJS.ReadStream;
    /**
     * Error stream.
     * @default process.stderr
     */
    stderr?: NodeJS.WriteStream;
    /**
     * Configure whether Ink should listen to Ctrl+C keyboard input and exit the app. This is needed in case `process.stdin` is in raw mode, because then Ctrl+C is ignored by default and process is expected to handle it manually.
     *
     * @default true
     */
    exitOnCtrlC?: boolean;
    /**
     * Patch console methods to ensure console output doesn't mix with Ink output.
     *
     * @default true
     */
    patchConsole?: boolean;
    /**
     * Called after each frame render with timing and flicker information.
     */
    onFrame?: (event: FrameEvent) => void;
};
/**
 * The handle returned by renderSync for an actively rendering Ink app.
 */
export type Instance = {
    /**
     * Replace previous root node with a new one or update props of the current root node.
     */
    rerender: Ink['render'];
    /**
     * Manually unmount the whole Ink app.
     */
    unmount: Ink['unmount'];
    /**
     * Returns a promise, which resolves when app is unmounted.
     */
    waitUntilExit: Ink['waitUntilExit'];
    cleanup: () => void;
};
/**
 * A managed Ink root, similar to react-dom's createRoot API.
 * Separates instance creation from rendering so the same root
 * can be reused for multiple sequential screens.
 */
export type Root = {
    render: (node: ReactNode) => void;
    unmount: () => void;
    waitUntilExit: () => Promise<void>;
};
/**
 * Mount a component and render the output.
 * @param node - the React element to render.
 * @param options - the output stream or render options.
 * @returns an instance handle for the running app.
 */
export declare const renderSync: (node: ReactNode, options?: NodeJS.WriteStream | RenderOptions) => Instance;
/**
 * Asynchronous render entry point that preserves a microtask boundary
 * before the first synchronous render, letting async startup work settle.
 * @param node - the React element to render.
 * @param options - the output stream or render options.
 * @returns a promise resolving to the instance handle once mounted.
 */
declare const wrappedRender: (node: ReactNode, options?: NodeJS.WriteStream | RenderOptions) => Promise<Instance>;
export default wrappedRender;
/**
 * Create an Ink root without rendering anything yet.
 * Like react-dom's createRoot — call root.render() to mount a tree.
 * @param options - the render options; defaults match renderSync defaults.
 * @returns a promise resolving to the managed root.
 */
export declare function createRoot(options?: RenderOptions): Promise<Root>;
//# sourceMappingURL=root.d.ts.map