import type Ink from './ink.js';
/**
 * Live Ink instances keyed by their output stream, so consecutive render()
 * calls reuse the instance for a stream instead of creating a new one.
 * Lives in its own module: render.js creates instances while instance.js
 * deletes its own entry on unmount.
 */
declare const instances: Map<NodeJS.WriteStream, Ink>;
export default instances;
//# sourceMappingURL=instances.d.ts.map