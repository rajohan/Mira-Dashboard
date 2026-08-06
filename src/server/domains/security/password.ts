import { isDashboardPasswordHash } from "../../shared/passwordHash.ts";

/** Reviewed Bun Argon2id policy for Dashboard operator passwords. */
export const dashboardPasswordHashPolicy = Object.freeze({
    algorithm: "argon2id" as const,
    memoryCost: 65_536,
    timeCost: 3,
});

// A non-secret verifier keeps unknown principals and missing one-time proofs on
// the same Argon2id path as persisted Dashboard credentials.
export const authenticationDummyPasswordHash =
    "$argon2id$v=19$m=65536,t=3,p=1$MDsAhQmsM0gKFDPO1S/bJ84KkrIm1Mo2O8GOuFgx0vE$No7wOmqZQ2kag02Z+R1HguKc3iTXaAMmK4n4bW7yoE4";

/**
 * Hashes one validated password using the fixed Dashboard Argon2id policy.
 * @param password Validated operator password.
 * @returns Canonical Dashboard Argon2id PHC representation.
 */
export async function hashDashboardPassword(password: string): Promise<string> {
    const passwordHash = await Bun.password.hash(password, dashboardPasswordHashPolicy);
    if (!isDashboardPasswordHash(passwordHash)) {
        throw new Error("Bun returned an unsupported Dashboard password hash");
    }
    return passwordHash;
}

/**
 * Verifies without allowing malformed persisted hashes to escape the auth boundary.
 * @param password Validated password candidate.
 * @param passwordHash Persisted canonical Dashboard Argon2id PHC representation.
 * @returns Whether the candidate matches the persisted password hash.
 */
export async function verifyDashboardPassword(
    password: string,
    passwordHash: string
): Promise<boolean> {
    if (!isDashboardPasswordHash(passwordHash)) return false;
    try {
        return await Bun.password.verify(password, passwordHash, "argon2id");
    } catch {
        return false;
    }
}
