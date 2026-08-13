/* eslint-disable custom-rules/no-top-level-side-effects */
import { appendFileSync } from 'fs';
import createReconciler from 'react-reconciler';
import { getYogaCounters } from '../native-ts/yoga-layout/index.js';
import { isEnvTruthy } from '../utils/envUtils.js';
import { appendChildNode, clearYogaNodeReferences, createNode, createTextNode, insertBeforeNode, markDirty, removeChildNode, setAttribute, setStyle, setTextNodeValue, setTextStyles, } from './dom.js';
import { Dispatcher } from './events/dispatcher.js';
import { EVENT_HANDLER_PROPS } from './events/event-handlers.js';
import { getFocusManager, getRootNode } from './focus.js';
import { LayoutDisplay } from './layout/node.js';
import applyStyles from './styles.js';
// We need to conditionally perform devtools connection to avoid
// accidentally breaking other third-party code.
// See https://github.com/vadimdemedes/ink/issues/384
if (process.env.NODE_ENV === 'development') {
    try {
        // eslint-disable-next-line custom-rules/no-top-level-dynamic-import -- dev-only; NODE_ENV check is DCE'd in production
        void import('./devtools.js');
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }
    catch (error) {
        if (error.code === 'ERR_MODULE_NOT_FOUND') {
            // biome-ignore lint/suspicious/noConsole: intentional warning
            console.warn(`
The environment variable DEV is set to true, so Ink tried to import \`react-devtools-core\`,
but this failed as it was not installed. Debugging with React Devtools requires it.

To install use this command:

$ npm install --save-dev react-devtools-core
				`.trim() + '\n');
        }
        else {
            // eslint-disable-next-line @typescript-eslint/only-throw-error
            throw error;
        }
    }
}
const diff = (before, after) => {
    if (before === after) {
        return;
    }
    if (!before) {
        return after;
    }
    const changed = {};
    let isChanged = false;
    for (const key of Object.keys(before)) {
        const isDeleted = after ? !Object.hasOwn(after, key) : true;
        if (isDeleted) {
            changed[key] = undefined;
            isChanged = true;
        }
    }
    if (after) {
        for (const key of Object.keys(after)) {
            if (after[key] !== before[key]) {
                changed[key] = after[key];
                isChanged = true;
            }
        }
    }
    return isChanged ? changed : undefined;
};
const cleanupYogaNode = (node) => {
    const yogaNode = node.yogaNode;
    if (yogaNode) {
        yogaNode.unsetMeasureFunc();
        // Clear all references BEFORE freeing to prevent other code from
        // accessing freed WASM memory during concurrent operations
        clearYogaNodeReferences(node);
        yogaNode.freeRecursive();
    }
};
function setEventHandler(node, key, value) {
    if (!node._eventHandlers) {
        node._eventHandlers = {};
    }
    node._eventHandlers[key] = value;
}
function applyProp(node, key, value) {
    if (key === 'children')
        return;
    if (key === 'style') {
        setStyle(node, value);
        if (node.yogaNode) {
            applyStyles(node.yogaNode, value);
        }
        return;
    }
    if (key === 'textStyles') {
        node.textStyles = value;
        return;
    }
    if (EVENT_HANDLER_PROPS.has(key)) {
        setEventHandler(node, key, value);
        return;
    }
    setAttribute(node, key, value);
}
/**
 * Walk a fiber's owner chain and return the names of the components that
 * rendered it, skipping host elements.
 * @param fiber - the fiber whose owner chain to walk.
 * @returns the component display names, outermost first.
 */
export function getOwnerChain(fiber) {
    const chain = [];
    const seen = new Set();
    let cur = fiber;
    for (let i = 0; cur && i < 50; i++) {
        if (seen.has(cur))
            break;
        seen.add(cur);
        const t = cur.elementType;
        const name = typeof t === 'function'
            ? t.displayName ||
                t.name
            : typeof t === 'string'
                ? undefined // host element (ink-box etc) — skip
                : t?.displayName || t?.name;
        if (name && name !== chain[chain.length - 1])
            chain.push(name);
        cur = cur._debugOwner ?? cur.return;
    }
    return chain;
}
let debugRepaints;
/**
 * Read the CLAUDE_CODE_DEBUG_REPAINTS flag once and cache it.
 * @returns whether repaint debugging is enabled.
 */
export function isDebugRepaintsEnabled() {
    if (debugRepaints === undefined) {
        debugRepaints = isEnvTruthy(process.env.CLAUDE_CODE_DEBUG_REPAINTS);
    }
    return debugRepaints;
}
/** The terminal event dispatcher that routes input events to registered handlers. */
export const dispatcher = new Dispatcher();
// --- COMMIT INSTRUMENTATION (temp debugging) ---
// eslint-disable-next-line custom-rules/no-process-env-top-level -- debug instrumentation, read-once is fine
const COMMIT_LOG = process.env.CLAUDE_CODE_COMMIT_LOG;
let _commits = 0;
let _lastLog = 0;
let _lastCommitAt = 0;
let _maxGapMs = 0;
let _createCount = 0;
let _prepareAt = 0;
// --- END ---
// --- SCROLL PROFILING (bench/scroll-e2e.sh reads via getLastYogaMs) ---
// Set by onComputeLayout wrapper in ink.tsx; read by onRender for phases.
let _lastYogaMs = 0;
let _lastCommitMs = 0;
let _commitStart = 0;
/**
 * Record the yoga layout duration of the current commit.
 * @param ms - the layout duration in milliseconds.
 */
export function recordYogaMs(ms) {
    _lastYogaMs = ms;
}
/**
 * The yoga layout duration recorded by recordYogaMs.
 * @returns the layout duration in milliseconds.
 */
export function getLastYogaMs() {
    return _lastYogaMs;
}
/** Mark the start of the current commit for commit-duration profiling. */
export function markCommitStart() {
    _commitStart = performance.now();
}
/**
 * The duration of the last commit, from markCommitStart to resetAfterCommit.
 * @returns the commit duration in milliseconds.
 */
export function getLastCommitMs() {
    return _lastCommitMs;
}
/** Reset all commit and layout profiling counters to zero. */
export function resetProfileCounters() {
    _lastYogaMs = 0;
    _lastCommitMs = 0;
    _commitStart = 0;
}
// --- END ---
/**
 * The react-reconciler instance that renders React elements into the Ink
 * DOM tree, wired to the event dispatcher for update priorities.
 */
const reconciler = createReconciler({
    getRootHostContext: () => ({ isInsideText: false }),
    prepareForCommit: () => {
        if (COMMIT_LOG)
            _prepareAt = performance.now();
        return null;
    },
    preparePortalMount: () => null,
    clearContainer: () => false,
    resetAfterCommit(rootNode) {
        _lastCommitMs = _commitStart > 0 ? performance.now() - _commitStart : 0;
        _commitStart = 0;
        if (COMMIT_LOG) {
            const now = performance.now();
            _commits++;
            const gap = _lastCommitAt > 0 ? now - _lastCommitAt : 0;
            if (gap > _maxGapMs)
                _maxGapMs = gap;
            _lastCommitAt = now;
            const reconcileMs = _prepareAt > 0 ? now - _prepareAt : 0;
            if (gap > 30 || reconcileMs > 20 || _createCount > 50) {
                // eslint-disable-next-line custom-rules/no-sync-fs -- debug instrumentation
                appendFileSync(COMMIT_LOG, `${now.toFixed(1)} gap=${gap.toFixed(1)}ms reconcile=${reconcileMs.toFixed(1)}ms creates=${_createCount}\n`);
            }
            _createCount = 0;
            if (now - _lastLog > 1000) {
                // eslint-disable-next-line custom-rules/no-sync-fs -- debug instrumentation
                appendFileSync(COMMIT_LOG, `${now.toFixed(1)} commits=${_commits}/s maxGap=${_maxGapMs.toFixed(1)}ms\n`);
                _commits = 0;
                _maxGapMs = 0;
                _lastLog = now;
            }
        }
        const _t0 = COMMIT_LOG ? performance.now() : 0;
        if (typeof rootNode.onComputeLayout === 'function') {
            rootNode.onComputeLayout();
        }
        if (COMMIT_LOG) {
            const layoutMs = performance.now() - _t0;
            if (layoutMs > 20) {
                const c = getYogaCounters();
                // eslint-disable-next-line custom-rules/no-sync-fs -- debug instrumentation
                appendFileSync(COMMIT_LOG, `${_t0.toFixed(1)} SLOW_YOGA ${layoutMs.toFixed(1)}ms visited=${c.visited} measured=${c.measured} hits=${c.cacheHits} live=${c.live}\n`);
            }
        }
        if (process.env.NODE_ENV === 'test') {
            if (rootNode.childNodes.length === 0 && rootNode.hasRenderedContent) {
                return;
            }
            if (rootNode.childNodes.length > 0) {
                rootNode.hasRenderedContent = true;
            }
            rootNode.onImmediateRender?.();
            return;
        }
        const _tr = COMMIT_LOG ? performance.now() : 0;
        rootNode.onRender?.();
        if (COMMIT_LOG) {
            const renderMs = performance.now() - _tr;
            if (renderMs > 10) {
                // eslint-disable-next-line custom-rules/no-sync-fs -- debug instrumentation
                appendFileSync(COMMIT_LOG, `${_tr.toFixed(1)} SLOW_PAINT ${renderMs.toFixed(1)}ms\n`);
            }
        }
    },
    getChildHostContext(parentHostContext, type) {
        const previousIsInsideText = parentHostContext.isInsideText;
        const isInsideText = type === 'ink-text' || type === 'ink-virtual-text' || type === 'ink-link';
        if (previousIsInsideText === isInsideText) {
            return parentHostContext;
        }
        return { isInsideText };
    },
    shouldSetTextContent: () => false,
    createInstance(originalType, newProps, _root, hostContext, internalHandle) {
        if (hostContext.isInsideText && originalType === 'ink-box') {
            throw new Error(`<Box> can't be nested inside <Text> component`);
        }
        const type = originalType === 'ink-text' && hostContext.isInsideText
            ? 'ink-virtual-text'
            : originalType;
        const node = createNode(type);
        if (COMMIT_LOG)
            _createCount++;
        for (const [key, value] of Object.entries(newProps)) {
            applyProp(node, key, value);
        }
        if (isDebugRepaintsEnabled()) {
            node.debugOwnerChain = getOwnerChain(internalHandle);
        }
        return node;
    },
    createTextInstance(text, _root, hostContext) {
        if (!hostContext.isInsideText) {
            throw new Error(`Text string "${text}" must be rendered inside <Text> component`);
        }
        return createTextNode(text);
    },
    resetTextContent() { },
    hideTextInstance(node) {
        setTextNodeValue(node, '');
    },
    unhideTextInstance(node, text) {
        setTextNodeValue(node, text);
    },
    getPublicInstance: (instance) => instance,
    hideInstance(node) {
        node.isHidden = true;
        node.yogaNode?.setDisplay(LayoutDisplay.None);
        markDirty(node);
    },
    unhideInstance(node) {
        node.isHidden = false;
        node.yogaNode?.setDisplay(LayoutDisplay.Flex);
        markDirty(node);
    },
    appendInitialChild: appendChildNode,
    appendChild: appendChildNode,
    insertBefore: insertBeforeNode,
    finalizeInitialChildren(_node, _type, props) {
        return props['autoFocus'] === true;
    },
    commitMount(node) {
        getFocusManager(node).handleAutoFocus(node);
    },
    isPrimaryRenderer: true,
    supportsMutation: true,
    supportsPersistence: false,
    supportsHydration: false,
    scheduleTimeout: setTimeout,
    cancelTimeout: clearTimeout,
    noTimeout: -1,
    getCurrentUpdatePriority: () => dispatcher.currentUpdatePriority,
    beforeActiveInstanceBlur() { },
    afterActiveInstanceBlur() { },
    detachDeletedInstance() { },
    getInstanceFromNode: () => null,
    prepareScopeUpdate() { },
    getInstanceFromScope: () => null,
    appendChildToContainer: appendChildNode,
    insertInContainerBefore: insertBeforeNode,
    removeChildFromContainer(node, removeNode) {
        removeChildNode(node, removeNode);
        cleanupYogaNode(removeNode);
        getFocusManager(node).handleNodeRemoved(removeNode, node);
    },
    // React 19 commitUpdate receives old and new props directly instead of an updatePayload
    commitUpdate(node, _type, oldProps, newProps) {
        const props = diff(oldProps, newProps);
        const style = diff(oldProps['style'], newProps['style']);
        if (props) {
            for (const [key, value] of Object.entries(props)) {
                if (key === 'style') {
                    setStyle(node, value);
                    continue;
                }
                if (key === 'textStyles') {
                    setTextStyles(node, value);
                    continue;
                }
                if (EVENT_HANDLER_PROPS.has(key)) {
                    setEventHandler(node, key, value);
                    continue;
                }
                setAttribute(node, key, value);
            }
        }
        if (style && node.yogaNode) {
            applyStyles(node.yogaNode, style, newProps['style']);
        }
    },
    commitTextUpdate(node, _oldText, newText) {
        setTextNodeValue(node, newText);
    },
    removeChild(node, removeNode) {
        removeChildNode(node, removeNode);
        cleanupYogaNode(removeNode);
        if (removeNode.nodeName !== '#text') {
            const root = getRootNode(node);
            root.focusManager.handleNodeRemoved(removeNode, root);
        }
    },
    // React 19 required methods
    maySuspendCommit() {
        return false;
    },
    preloadInstance() {
        return true;
    },
    startSuspendingCommit() { },
    suspendInstance() { },
    waitForCommitToBeReady() {
        return null;
    },
    NotPendingTransition: null,
    HostTransitionContext: {
        $$typeof: Symbol.for('react.context'),
        _currentValue: null,
    },
    setCurrentUpdatePriority(newPriority) {
        dispatcher.currentUpdatePriority = newPriority;
    },
    resolveUpdatePriority() {
        return dispatcher.resolveEventPriority();
    },
    resetFormInstance() { },
    requestPostPaintCallback() { },
    shouldAttemptEagerTransition() {
        return false;
    },
    trackSchedulerEvent() { },
    resolveEventType() {
        return dispatcher.currentEvent?.type ?? null;
    },
    resolveEventTimeStamp() {
        return dispatcher.currentEvent?.timeStamp ?? -1.1;
    },
});
// Wire the reconciler's discreteUpdates into the dispatcher.
// This breaks the import cycle: dispatcher.ts doesn't import reconciler.ts.
dispatcher.discreteUpdates = reconciler.discreteUpdates.bind(reconciler);
export default reconciler;
