/**
 * Disposing the entry's root while the profile may still be composing into it:
 * @deepseek-ai/dsh-hmr deadlocks when disposed while its init starts config
 * watchers, so a root dispose first lets the Loader settle, and the composition
 * skips its audit and readiness once a dispose is waiting.
 */
import type { Context } from '@deepseek-ai/cordis'

interface Composition {
  /** `loader.await()`. */
  readonly settle: () => Promise<unknown>
  disposing: boolean
}

const compositions = new WeakMap<object, Composition>()

export interface CompositionTracker {
  /** True once a root dispose waits for the composition: stop short of the audit and readiness. */
  readonly disposing: boolean
  /** Composed, failed or stopped. */
  done(): void
}

/** A root dispose waits for `settle` first. */
export function trackComposition(root: Context, settle: () => Promise<unknown>): CompositionTracker {
  const key = root.root
  const composition: Composition = { settle, disposing: false }
  compositions.set(key, composition)
  return {
    get disposing() { return composition.disposing },
    done() {
      if (compositions.get(key) === composition) compositions.delete(key)
    },
  }
}

/** Dispose the root once a composition in progress on it has let its Loader settle. */
export async function disposeRootSettled(ctx: Context, dispose: () => Promise<unknown> = () => ctx.root.fiber.dispose()): Promise<unknown> {
  const composition = compositions.get(ctx.root)
  if (composition !== undefined) {
    composition.disposing = true
    try {
      await composition.settle()
    } catch {
      // A failed activation is the composition's to report; dispose anyway.
    }
  }
  return dispose()
}
