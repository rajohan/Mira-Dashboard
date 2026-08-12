import { describe, expect, test } from "bun:test";

import * as v from "valibot";

import { procedureContracts } from "./contractRegistry.ts";
import {
    getServiceActionsStatusResultSchema,
    requestServiceActionInputSchema,
    requestServiceActionResultSchema,
    serviceActionIds,
    serviceActionProcedureContracts,
} from "./serviceActions.ts";

const runId = "018f6f50-6a9e-7b88-8000-000000000001";
const idempotencyKey = "A".repeat(43);

function queuedRun(actionKey: string) {
    return {
        actionKey,
        attemptCount: 0,
        attemptLimit: 1,
        availableAtMs: 1000,
        cancellationPolicy: "never" as const,
        displayName: "Service action",
        eventCount: 1,
        id: runId,
        priority: 0,
        queuedAtMs: 1000,
        resourceClass: "exclusive" as const,
        resourceKeys: ["host.mutation"],
        retrySafe: false,
        state: "queued" as const,
        stateVersion: 1,
        timeoutMs: 60_000,
        triggerType: "manual" as const,
        updatedAtMs: 1000,
    };
}

describe("service action contracts", () => {
    test("registers one session-only status query and one recent-MFA mutation", () => {
        expect(
            serviceActionProcedureContracts.map(
                ({ access, errors, kind, name, transport }) => ({
                    access,
                    errors,
                    kind,
                    name,
                    transport,
                })
            )
        ).toEqual([
            {
                access: {
                    capabilities: ["service-actions:read"],
                    capabilityPolicy: "all",
                    kind: "authenticated",
                    principalKinds: ["session"],
                },
                errors: ["FORBIDDEN", "SERVICE_UNAVAILABLE", "UNAUTHORIZED"],
                kind: "query",
                name: "serviceActions.getStatus",
                transport: {
                    batching: "adapter-default",
                    handler: "default",
                    requestBody: "default",
                },
            },
            {
                access: {
                    capabilities: ["service-actions:write"],
                    kind: "recent-auth",
                    principalKinds: ["session"],
                    whenMfaDisabled: "deny",
                    whenMfaEnabled: "mfa",
                },
                errors: ["CONFLICT", "FORBIDDEN", "SERVICE_UNAVAILABLE", "UNAUTHORIZED"],
                kind: "mutation",
                name: "serviceActions.request",
                transport: {
                    batching: "forbidden",
                    handler: "default",
                    requestBody: "default",
                },
            },
        ]);
        expect(
            procedureContracts
                .filter(({ domain }) => domain === "service-actions")
                .map(({ name }) => name)
        ).toEqual(serviceActionProcedureContracts.map(({ name }) => name));
    });

    test("accepts only exact fixed action confirmations and idempotency keys", () => {
        const valid = [
            ["openclaw-cleanup", "cleanup-openclaw"],
            ["openclaw-update", "update-openclaw"],
            ["system-restart", "restart-system"],
            ["system-update", "update-system"],
        ] as const;

        for (const [actionId, confirmation] of valid) {
            expect(
                v.parse(requestServiceActionInputSchema, {
                    actionId,
                    confirmation,
                    idempotencyKey,
                })
            ).toEqual({ actionId, confirmation, idempotencyKey });
        }

        for (const input of [
            {
                actionId: "system-restart",
                confirmation: "update-system",
                idempotencyKey,
            },
            {
                actionId: "system-cleanup",
                confirmation: "cleanup-system",
                idempotencyKey,
            },
            {
                actionId: "system-update",
                confirmation: "update-system",
                idempotencyKey: "short",
            },
            {
                actionId: "system-update",
                confirmation: "update-system",
                idempotencyKey,
                command: "apt-get upgrade",
            },
        ]) {
            expect(
                v.safeParse(requestServiceActionInputSchema, input).success
            ).toBeFalse();
        }

        expect(
            v.parse(requestServiceActionResultSchema, {
                actionId: "system-update",
                jobRunId: runId,
                queued: true,
            })
        ).toEqual({ actionId: "system-update", jobRunId: runId, queued: true });
    });

    test("requires the complete canonical fixed inventory and bounded run projections", () => {
        const actions = serviceActionIds.map((id, index) => ({
            ...(index === 0 ? { activeRun: queuedRun("openclaw.sessions.cleanup") } : {}),
            availability: index === 3 ? "unavailable" : "available",
            id,
        }));
        expect(
            v
                .parse(getServiceActionsStatusResultSchema, {
                    actions,
                    observedAtMs: 2000,
                })
                .actions.map(({ id }) => id)
        ).toEqual(serviceActionIds);

        for (const invalidActions of [
            actions.slice(1),
            actions.toReversed(),
            [...actions.slice(0, -1), actions[0]],
            [...actions, actions[0]],
        ]) {
            expect(
                v.safeParse(getServiceActionsStatusResultSchema, {
                    actions: invalidActions,
                    observedAtMs: 2000,
                }).success
            ).toBeFalse();
        }

        expect(
            v.safeParse(getServiceActionsStatusResultSchema, {
                actions: actions.map((action, index) =>
                    index === 0
                        ? {
                              ...action,
                              activeRun: {
                                  ...action.activeRun,
                                  payload: { command: "apt-get upgrade" },
                              },
                          }
                        : action
                ),
                observedAtMs: 2000,
            }).success
        ).toBeFalse();
    });
});
