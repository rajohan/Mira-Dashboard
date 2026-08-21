import path from "node:path";

import * as v from "valibot";

import { nonnegativeSafeIntegerSchema } from "../../../shared/validation.ts";

const unitIdentifierPattern = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/iu;
const unitNamePattern =
    /^mira-dashboard-sse-memory-[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/iu;
const userIdSchema = nonnegativeSafeIntegerSchema();

/**
 * Creates a unique systemd unit name without accepting user-controlled fragments.
 * @param identifier UUID-compatible random identifier.
 * @returns Valid transient service name without the `.service` suffix.
 */
export function createSseMemoryUnitName(
    identifier: string = crypto.randomUUID()
): string {
    if (!unitIdentifierPattern.test(identifier)) {
        throw new TypeError("SSE memory evidence unit identifier is invalid");
    }
    return `mira-dashboard-sse-memory-${identifier}`;
}

/**
 * Requires the exact unit-name grammar used by the capped evidence.
 * @param unitName Candidate transient unit name.
 */
export function assertSseMemoryUnitName(unitName: string): void {
    if (!unitNamePattern.test(unitName)) {
        throw new TypeError("SSE memory evidence unit name is invalid");
    }
}

/**
 * Requires a process to run inside the transient unit created by its parent.
 * @param cgroupPath Current process cgroup path.
 * @param expectedPath Exact cgroup path derived by the parent.
 */
export function assertSseMemoryUnitCgroupPath(
    cgroupPath: string,
    expectedPath: string
): void {
    if (cgroupPath !== expectedPath) {
        throw new Error(
            `SSE memory evidence expected cgroup ${expectedPath}; observed ${cgroupPath}`
        );
    }
}

/**
 * Returns the deterministic cgroup path for an explicitly app.slice-bound user unit.
 * @param userId POSIX user ID that owns the user manager.
 * @param unitName Validated transient service name.
 * @returns Exact unified cgroup path for the transient unit.
 */
export function expectedSseMemoryUnitCgroupPath(
    userId: number,
    unitName: string
): string {
    assertSseMemoryUnitName(unitName);
    if (!v.safeParse(userIdSchema, userId).success) {
        throw new TypeError("SSE memory evidence user ID is invalid");
    }
    return path.posix.join(
        "/user.slice",
        `user-${userId}.slice`,
        `user@${userId}.service`,
        "app.slice",
        `${unitName}.service`
    );
}

/**
 * Returns the POSIX user ID required by the Linux cgroup evidence.
 * @returns Current POSIX user ID.
 */
export function currentIntegrationUserId(): number {
    if (process.getuid === undefined) {
        throw new Error("SSE memory evidence requires a POSIX user ID");
    }
    return process.getuid();
}
