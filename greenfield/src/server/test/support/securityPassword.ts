/** Canonical non-secret Argon2id-shaped fixture; it is not a usable password hash. */
export const testDashboardPasswordHash = `$argon2id$v=19$m=65536,t=3,p=1$${"A".repeat(43)}$${"B".repeat(42)}E`;
