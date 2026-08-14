/**
 * The `AppContext` value: a function to manually exit (unmount) the Ink app.
 */
export type Props = {
    /**
     * Exit (unmount) the whole Ink app.
     */
    readonly exit: (error?: Error) => void;
};
/**
 * `AppContext` is a React context, which exposes a method to manually exit the app (unmount).
 */
declare const AppContext: import("react").Context<Props>;
export default AppContext;
//# sourceMappingURL=AppContext.d.ts.map