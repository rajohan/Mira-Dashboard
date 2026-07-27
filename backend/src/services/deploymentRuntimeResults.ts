export const RELEASE_READINESS_FAILURE_NOTE_PREFIX = "Release readiness failed";
export const ROLLBACK_READINESS_FAILURE_NOTE_PREFIX = "Rollback target failed readiness";
export const ORPHANED_CUTOVER_READINESS_FAILURE_NOTE_PREFIX =
    "Interrupted release cutover recovered; automatic rollback restored";

export const DEPLOYMENT_RUNTIME_FAILURE_NOTE_PATTERNS = [
    `${RELEASE_READINESS_FAILURE_NOTE_PREFIX}%`,
    `${ROLLBACK_READINESS_FAILURE_NOTE_PREFIX}%`,
    `${ORPHANED_CUTOVER_READINESS_FAILURE_NOTE_PREFIX}%`,
] as const;

export const DEPLOYMENT_RUNTIME_FAILURE_NOTE_PREDICATE_SQL =
    DEPLOYMENT_RUNTIME_FAILURE_NOTE_PATTERNS.map(() => "note LIKE ?").join(" OR ");
