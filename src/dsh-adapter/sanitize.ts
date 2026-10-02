/** Compatibility path: the render-path sanitization contract moved to the
 *  backend-neutral channel layer (`src/channel/sanitize.ts`); UI and adapter
 *  imports of this module keep working unchanged. */
export * from '../channel/sanitize.js'
