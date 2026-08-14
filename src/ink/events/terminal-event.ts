import { Event } from './event.js'

type EventPhase = 'none' | 'capturing' | 'at_target' | 'bubbling'

type TerminalEventInit = {
  bubbles?: boolean
  cancelable?: boolean
}

/**
 * Base class for all terminal events with DOM-style propagation.
 *
 * Extends Event so existing event types (ClickEvent, InputEvent,
 * TerminalFocusEvent) share a common ancestor and can migrate later.
 *
 * Mirrors the browser's Event API: target, currentTarget, eventPhase,
 * stopPropagation(), preventDefault(), timeStamp.
 */
export class TerminalEvent extends Event {
  /**
   * The event type name, e.g. 'keydown', 'focus', or 'resize'.
   */
  readonly type: string

  /**
   * The time the event was created, in milliseconds via `performance.now()`.
   */
  readonly timeStamp: number

  /**
   * Whether the event bubbles from the target up through its ancestors.
   */
  readonly bubbles: boolean

  /**
   * Whether `preventDefault()` can cancel the event's default behavior.
   */
  readonly cancelable: boolean

  private _target: EventTarget | null = null
  private _currentTarget: EventTarget | null = null
  private _eventPhase: EventPhase = 'none'
  private _propagationStopped = false
  private _defaultPrevented = false

  constructor(type: string, init?: TerminalEventInit) {
    super()
    this.type = type
    this.timeStamp = performance.now()
    this.bubbles = init?.bubbles ?? true
    this.cancelable = init?.cancelable ?? true
  }

  /**
   * The node the event was dispatched to, or null before and after dispatch.
   */
  get target(): EventTarget | null {
    return this._target
  }

  /**
   * The node whose listener is currently running, or null outside dispatch.
   */
  get currentTarget(): EventTarget | null {
    return this._currentTarget
  }

  /**
   * The current propagation phase: 'none', 'capturing', 'at_target', or 'bubbling'.
   */
  get eventPhase(): EventPhase {
    return this._eventPhase
  }

  /**
   * Whether `preventDefault()` was called on this event.
   */
  get defaultPrevented(): boolean {
    return this._defaultPrevented
  }

  /**
   * Stop the event from reaching listeners on any further nodes; listeners on
   * the current node still run.
   */
  stopPropagation(): void {
    this._propagationStopped = true
  }

  override stopImmediatePropagation(): void {
    super.stopImmediatePropagation()
    this._propagationStopped = true
  }

  /**
   * Cancel the event's default behavior when the event is cancelable.
   */
  preventDefault(): void {
    if (this.cancelable) {
      this._defaultPrevented = true
    }
  }

  // -- Internal setters used by the Dispatcher

  /**
   * Set the node the event was dispatched to. Used by the dispatcher.
   * @internal
   * @param target - the dispatch target node.
   */
  _setTarget(target: EventTarget): void {
    this._target = target
  }

  /**
   * Set the node whose listener is currently running. Used by the dispatcher.
   * @internal
   * @param target - the current target node, or null outside dispatch.
   */
  _setCurrentTarget(target: EventTarget | null): void {
    this._currentTarget = target
  }

  /**
   * Set the current propagation phase. Used by the dispatcher.
   * @internal
   * @param phase - the phase to record.
   */
  _setEventPhase(phase: EventPhase): void {
    this._eventPhase = phase
  }

  /**
   * Whether `stopPropagation()` was called on this event. Used by the dispatcher.
   * @internal
   * @returns true when propagation has been stopped.
   */
  _isPropagationStopped(): boolean {
    return this._propagationStopped
  }

  /**
   * Whether `stopImmediatePropagation()` was called on this event. Used by the
   * dispatcher.
   * @internal
   * @returns true when immediate propagation has been stopped.
   */
  _isImmediatePropagationStopped(): boolean {
    return this.didStopImmediatePropagation()
  }

  /**
   * Hook for subclasses to do per-node setup before each handler fires.
   * Default is a no-op.
   * @param _target - the node the next listener belongs to.
   */
  _prepareForTarget(_target: EventTarget): void {}
}

/**
 * A node in the component tree that can receive events: its parent node and
 * its per-event-type handler maps.
 */
export type EventTarget = {
  parentNode: EventTarget | undefined
  _eventHandlers?: Record<string, unknown>
}
