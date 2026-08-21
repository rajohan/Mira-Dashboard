import { Effect } from "effect";

import type { AuthenticatedPrincipal } from "../../../../contracts/security.ts";
import { testImmediateDatabaseWriteAdmission } from "../../../test/support/databaseWriteAdmission.ts";
import type { openFreshMigratedDatabase } from "../../../test/support/freshDatabase.ts";
import { createTaskRepository } from "../repository.ts";
import { createTaskService } from "../service.ts";

export type TestTaskDatabase = Awaited<ReturnType<typeof openFreshMigratedDatabase>>;

/**
 * Creates one deterministic UUIDv7 fixture identity.
 * @param index Numeric fixture discriminator.
 * @returns Stable lowercase UUIDv7.
 */
export function taskTestUuid(index: number): string {
    return `019fd000-0000-7000-8000-${index.toString(16).padStart(12, "0")}`;
}

/** Authenticated browser principal with both task capabilities. */
export const taskTestPrincipal: AuthenticatedPrincipal = Object.freeze({
    authorizationVersion: 1,
    capabilities: Object.freeze(["tasks:read", "tasks:write"] as const),
    authenticatorId: "a".repeat(32),
    id: taskTestUuid(50_000),
    kind: "session",
});

/**
 * Creates a deterministic increasing task-domain ID generator.
 * @param start First numeric discriminator.
 * @returns UUIDv7 generator.
 */
export function taskTestIdGenerator(start = 1): () => string {
    let next = start;
    return () => taskTestUuid(next++);
}

/**
 * Creates an Effect task service over one isolated migrated database.
 * @param database Isolated migrated test database.
 * @param overrides Deterministic task service boundaries.
 * @returns Task service bound to the supplied database.
 */
export function taskServiceFor(
    database: TestTaskDatabase,
    overrides: {
        readonly generateId?: () => string;
        readonly nowMs?: () => number;
        readonly wakeEventPump?: () => Promise<void> | void;
    } = {}
) {
    return createTaskService({
        generateId: overrides.generateId ?? taskTestIdGenerator(),
        nowMs: overrides.nowMs ?? (() => 10_000),
        repository: createTaskRepository(
            database.orm,
            testImmediateDatabaseWriteAdmission
        ),
        wakeEventPump: overrides.wakeEventPump,
    });
}

/**
 * Runs one task service Effect through the default test runtime.
 * @param effect Task service operation.
 * @returns Promise for its successful value.
 */
export function runTaskEffect<T, E>(effect: Effect.Effect<T, E>): Promise<T> {
    return Effect.runPromise(effect);
}

export { openFreshMigratedDatabase } from "../../../test/support/freshDatabase.ts";
