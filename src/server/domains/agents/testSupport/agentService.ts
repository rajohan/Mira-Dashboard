import { Effect } from "effect";

import type { AuthenticatedPrincipal } from "../../../../contracts/security.ts";
import { testImmediateDatabaseWriteAdmission } from "../../../test/support/databaseWriteAdmission.ts";
import type { openFreshMigratedDatabase } from "../../../test/support/freshDatabase.ts";
import {
    GatewaySessionProviderUnavailableError,
    type GatewaySessionsProvider,
} from "../../gatewaySessions/provider.ts";
import {
    createGatewaySessionsService,
    type GatewaySessionsService,
} from "../../gatewaySessions/service.ts";
import { createAgentRepository } from "../repository.ts";
import { createAgentService } from "../service.ts";

export type TestAgentDatabase = Awaited<ReturnType<typeof openFreshMigratedDatabase>>;

const unavailableGatewaySessionsProvider: GatewaySessionsProvider = Object.freeze({
    compactSession: () => Promise.reject(new GatewaySessionProviderUnavailableError()),
    deleteSessionTranscript: () =>
        Promise.reject(new GatewaySessionProviderUnavailableError()),
    listCurrentSessions: () =>
        Promise.reject(new GatewaySessionProviderUnavailableError()),
    resetSession: () => Promise.reject(new GatewaySessionProviderUnavailableError()),
});

/**
 * Creates a stable UUIDv7 used by deterministic agent-domain tests.
 * @param index Numeric fixture discriminator.
 * @returns Stable lowercase UUIDv7.
 */
export function agentTestUuid(index: number): string {
    return `019fd100-0000-7000-8000-${index.toString(16).padStart(12, "0")}`;
}

/** Authenticated automation principal matching the production task-tracking caller shape. */
export const agentTestPrincipal: AuthenticatedPrincipal = Object.freeze({
    authorizationVersion: 1,
    capabilities: Object.freeze(["agents:read", "agents:write"] as const),
    authenticatorId: agentTestUuid(50_000),
    id: "openclaw-task-tracking",
    kind: "automation",
});

/**
 * Creates a deterministic increasing UUIDv7 generator for agent task runs.
 * @param start First numeric discriminator.
 * @returns UUIDv7 generator.
 */
export function agentTestIdGenerator(start = 1): () => string {
    let next = start;
    return () => agentTestUuid(next++);
}

/**
 * Creates an agent service over one isolated migrated test database.
 * @param database Isolated migrated test database.
 * @param overrides Deterministic service boundaries.
 * @returns Agent service bound to the supplied database.
 */
export function agentServiceFor(
    database: TestAgentDatabase,
    overrides: {
        readonly generateId?: () => string;
        readonly gatewaySessionsService?: GatewaySessionsService;
        readonly nowMs?: () => number;
        readonly wakeEventPump?: () => Promise<void> | void;
    } = {}
) {
    return createAgentService({
        generateId: overrides.generateId ?? agentTestIdGenerator(),
        gatewaySessionsService:
            overrides.gatewaySessionsService ??
            createGatewaySessionsService({
                provider: unavailableGatewaySessionsProvider,
            }),
        nowMs: overrides.nowMs ?? (() => 10_000),
        repository: createAgentRepository(
            database.orm,
            testImmediateDatabaseWriteAdmission
        ),
        wakeEventPump: overrides.wakeEventPump,
    });
}

/**
 * Runs one agent service Effect through the default test runtime.
 * @param effect Agent service operation.
 * @returns Promise for its successful value.
 */
export function runAgentEffect<T, E>(effect: Effect.Effect<T, E>): Promise<T> {
    return Effect.runPromise(effect);
}

export { openFreshMigratedDatabase } from "../../../test/support/freshDatabase.ts";
