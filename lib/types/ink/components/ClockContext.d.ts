export type Clock = {
    subscribe: (onChange: () => void, keepAlive: boolean) => () => void;
    now: () => number;
    setTickInterval: (ms: number) => void;
};
export declare function createClock(tickIntervalMs: number): Clock;
export declare const ClockContext: any;
export declare function ClockProvider(t0: any): any;
//# sourceMappingURL=ClockContext.d.ts.map