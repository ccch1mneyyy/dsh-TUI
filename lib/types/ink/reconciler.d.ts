import createReconciler from 'react-reconciler';
import { type DOMElement, type TextNode } from './dom.js';
import { Dispatcher } from './events/dispatcher.js';
export declare function getOwnerChain(fiber: unknown): string[];
export declare function isDebugRepaintsEnabled(): boolean;
export declare const dispatcher: Dispatcher;
export declare function recordYogaMs(ms: number): void;
export declare function getLastYogaMs(): number;
export declare function markCommitStart(): void;
export declare function getLastCommitMs(): number;
export declare function resetProfileCounters(): void;
declare const reconciler: createReconciler.Reconciler<DOMElement, DOMElement, TextNode, DOMElement, unknown, DOMElement>;
export default reconciler;
//# sourceMappingURL=reconciler.d.ts.map