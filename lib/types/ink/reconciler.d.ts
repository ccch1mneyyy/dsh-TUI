import createReconciler from 'react-reconciler';
import { type DOMElement, type TextNode } from './dom.js';
import { Dispatcher } from './events/dispatcher.js';
/**
 * Walk a fiber's owner chain and return the names of the components that
 * rendered it, skipping host elements.
 * @param fiber - the fiber whose owner chain to walk.
 * @returns the component display names, outermost first.
 */
export declare function getOwnerChain(fiber: unknown): string[];
/**
 * Read the CLAUDE_CODE_DEBUG_REPAINTS flag once and cache it.
 * @returns whether repaint debugging is enabled.
 */
export declare function isDebugRepaintsEnabled(): boolean;
/** The terminal event dispatcher that routes input events to registered handlers. */
export declare const dispatcher: Dispatcher;
/**
 * Record the yoga layout duration of the current commit.
 * @param ms - the layout duration in milliseconds.
 */
export declare function recordYogaMs(ms: number): void;
/**
 * The yoga layout duration recorded by recordYogaMs.
 * @returns the layout duration in milliseconds.
 */
export declare function getLastYogaMs(): number;
/** Mark the start of the current commit for commit-duration profiling. */
export declare function markCommitStart(): void;
/**
 * The duration of the last commit, from markCommitStart to resetAfterCommit.
 * @returns the commit duration in milliseconds.
 */
export declare function getLastCommitMs(): number;
/** Reset all commit and layout profiling counters to zero. */
export declare function resetProfileCounters(): void;
/**
 * The react-reconciler instance that renders React elements into the Ink
 * DOM tree, wired to the event dispatcher for update priorities.
 */
declare const reconciler: createReconciler.Reconciler<DOMElement, DOMElement, TextNode, DOMElement, unknown, DOMElement>;
export default reconciler;
//# sourceMappingURL=reconciler.d.ts.map