// Store all instances of Ink (instance.js) to ensure that consecutive render() calls
// use the same instance of Ink and don't create a new one
//
// This map has to be stored in a separate file, because render.js creates instances,
// but instance.js should delete itself from the map on unmount

import type Ink from './ink.js'

/**
 * Live Ink instances keyed by their output stream, so consecutive render()
 * calls reuse the instance for a stream instead of creating a new one.
 * Lives in its own module: render.js creates instances while instance.js
 * deletes its own entry on unmount.
 */
const instances = new Map<NodeJS.WriteStream, Ink>()
export default instances
