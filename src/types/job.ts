/** Records why a scheduled job is intentionally disabled. */
export type JobDisableIntent =
    | { mode: "indefinite"; comment: string }
    | { mode: "until"; comment: string; until: string };
