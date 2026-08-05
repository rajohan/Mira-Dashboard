/** Exact Bun PHC representation approved for Dashboard operator passwords. */
const dashboardPasswordHashPattern =
    /^\$argon2id\$v=19\$m=65536,t=3,p=1\$[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]\$[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]$/u;

export const dashboardPasswordHashLength = 118;

/**
 * Rejects persisted PHC parameters that could select unreviewed Argon2 work.
 * @param value Persisted password-hash candidate.
 * @returns Whether the candidate is the exact reviewed Dashboard PHC representation.
 */
export function isDashboardPasswordHash(value: string): boolean {
    return (
        value.length === dashboardPasswordHashLength &&
        dashboardPasswordHashPattern.test(value)
    );
}
