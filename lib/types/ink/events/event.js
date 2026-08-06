export class Event {
    _didStopImmediatePropagation = false;
    didStopImmediatePropagation() {
        return this._didStopImmediatePropagation;
    }
    stopImmediatePropagation() {
        this._didStopImmediatePropagation = true;
    }
}
//# sourceMappingURL=event.js.map