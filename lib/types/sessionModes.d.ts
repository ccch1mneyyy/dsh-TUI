export interface SessionModeSpec {
    /** Stable id; also the display name unless `label` is set or the id is a
     *  localized built-in (`default`/`plan`/`full`). */
    id: string;
    /** Optional display label; wins over the built-in i18n name. */
    label?: string;
    /** Plan mode on/off (dsh-plan-mode `/plan`). */
    plan?: boolean;
    /** Sandbox mode override (dsh-sandbox-policy `sandbox/mode`). */
    sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';
    /** Approval policy override (dsh-user-approval `approval/policy`). */
    approval?: 'ask' | 'never';
}
/** The shipped cycle when cordis.yml pins no `modes` — array order IS the
 *  Shift+Tab cycle order; index 0 is the unmarked base mode. */
export declare const DEFAULT_SESSION_MODES: readonly SessionModeSpec[];
/** Config → cycle list: undefined/empty → DEFAULT_SESSION_MODES; entries
 *  declaring no atom at all are dropped (their ids are returned for the
 *  caller to warn about); if nothing survives, DEFAULT_SESSION_MODES. Atom
 *  vocabularies are already enforced by the plugin Schema at load, so no
 *  value validation happens here. */
export declare function resolveSessionModes(raw: readonly SessionModeSpec[] | undefined): {
    modes: readonly SessionModeSpec[];
    dropped: readonly string[];
};
/** Display name: explicit `label` > built-in i18n (`mode-default`/
 *  `mode-plan`/`mode-full` for those ids) > the raw id. */
export declare function modeDisplayName(spec: SessionModeSpec): string;
//# sourceMappingURL=sessionModes.d.ts.map