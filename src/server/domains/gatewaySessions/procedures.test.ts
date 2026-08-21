import { describe, expect, test } from "bun:test";

import { TRPCError } from "@trpc/server";

import type {
    GatewaySessionActionResult,
    ListGatewaySessionsResult,
} from "../../../contracts/gatewaySessions.ts";
import type { ApplicationCapability } from "../../../contracts/security.ts";
import type { RequestContext } from "../../trpc/context.ts";
import { router } from "../../trpc/trpc.ts";
import type { GatewaySessionControlRequestContext } from "./controlAudit.ts";
import {
    GatewaySessionControlForbiddenError,
    GatewaySessionControlUnknownOutcomeError,
} from "./errors.ts";
import type { GatewaySessionMutationAccess } from "./mutationAccess.ts";
import { gatewaySessionsRouter } from "./procedures.ts";
import type { GatewaySessionsService } from "./service.ts";

const timestampMs = 1_800_000_000_000;

function snapshot(): ListGatewaySessionsResult {
    return {
        filter: "ALL",
        projectionTruncated: false,
        sessions: [],
        source: {
            checkedAtMs: timestampMs,
            connection: "connected",
            freshness: "fresh",
            observedAtMs: timestampMs,
        },
        stats: {
            activeInLastHour: 0,
            byKind: { cron: 0, hook: 0, main: 0, subagent: 0, unknown: 0 },
            byModel: [],
            shown: 0,
            tokenTotalState: "complete",
            totalTokens: 0,
            unknownModelCount: 0,
        },
    };
}

function testService(
    calls: string[],
    contexts: GatewaySessionControlRequestContext[] = []
): GatewaySessionsService {
    function actionResult(action: "compact" | "delete" | "reset", key: string) {
        calls.push(`${action}:${key}`);
        return Promise.resolve<GatewaySessionActionResult>({
            action,
            key,
            outcome: "changed",
            refresh: { snapshot: snapshot(), status: "available" },
        });
    }
    return {
        compact: ({ key }, context) => {
            contexts.push(context);
            return actionResult("compact", key);
        },
        delete: ({ key }, context) => {
            contexts.push(context);
            return actionResult("delete", key);
        },
        list: () => {
            calls.push("list");
            return Promise.resolve(snapshot());
        },
        reset: ({ key }, context) => {
            contexts.push(context);
            return actionResult("reset", key);
        },
    };
}

function sessionContext(
    service: GatewaySessionsService,
    mutationAccess: GatewaySessionMutationAccess,
    capabilities: readonly ApplicationCapability[] = [
        "gateway-sessions:read",
        "gateway-sessions:write",
    ]
): RequestContext {
    return {
        authentication: {
            kind: "authenticated",
            principal: {
                authorizationVersion: 1,
                capabilities: [...capabilities],
                authenticatorId: "a".repeat(32),
                id: "019fc968-1a9b-7770-8f1b-d5b863b0e7b4",
                kind: "session",
            },
        },
        authenticationLease: {
            expiresAtMs: Number.MAX_SAFE_INTEGER,
            revalidate: () => Promise.reject(new Error("Not used by this test")),
        },
        gatewaySessionMutationAccess: mutationAccess,
        gatewaySessionsService: service,
        requestId: "01900000-0000-7000-8000-000000000001",
        responseHeaders: new Headers(),
        services: {},
    } as unknown as RequestContext;
}

function anonymousContext(service: GatewaySessionsService): RequestContext {
    return {
        authentication: { kind: "anonymous" },
        gatewaySessionsService: service,
        requestId: "01900000-0000-7000-8000-000000000001",
        responseHeaders: new Headers(),
        services: {},
    } as unknown as RequestContext;
}

const testRouter = router({ gatewaySessions: gatewaySessionsRouter });

async function captureFailure(work: () => Promise<unknown>): Promise<unknown> {
    try {
        await work();
    } catch (error) {
        return error;
    }
    throw new Error("Expected work to fail");
}

describe("Gateway session procedures", () => {
    test("serves session reads and all explicit recently-authorized controls", async () => {
        const calls: string[] = [];
        const contexts: GatewaySessionControlRequestContext[] = [];
        const caller = testRouter.createCaller(
            sessionContext(testService(calls, contexts), {
                authorizeRecentMfa: () => "authorized",
            })
        ).gatewaySessions;

        expect(await caller.list({ filter: "ALL" })).toEqual(snapshot());
        expect(await caller.compact({ key: "agent:main:main" })).toMatchObject({
            action: "compact",
        });
        expect(await caller.reset({ key: "agent:coder:main" })).toMatchObject({
            action: "reset",
        });
        expect(
            await caller.delete({
                expectedSessionId: "cron-session-id",
                key: "cron:daily",
            })
        ).toMatchObject({
            action: "delete",
        });
        expect(calls).toEqual([
            "list",
            "compact:agent:main:main",
            "reset:agent:coder:main",
            "delete:cron:daily",
        ]);
        expect(contexts).toEqual([
            {
                actor: {
                    authenticatorId: "a".repeat(32),
                    id: "019fc968-1a9b-7770-8f1b-d5b863b0e7b4",
                    kind: "user",
                },
                requestId: "01900000-0000-7000-8000-000000000001",
            },
            {
                actor: {
                    authenticatorId: "a".repeat(32),
                    id: "019fc968-1a9b-7770-8f1b-d5b863b0e7b4",
                    kind: "user",
                },
                requestId: "01900000-0000-7000-8000-000000000001",
            },
            {
                actor: {
                    authenticatorId: "a".repeat(32),
                    id: "019fc968-1a9b-7770-8f1b-d5b863b0e7b4",
                    kind: "user",
                },
                requestId: "01900000-0000-7000-8000-000000000001",
            },
        ]);
    });

    test("rejects anonymous reads before invoking the OpenClaw service", async () => {
        const calls: string[] = [];
        const caller = testRouter.createCaller(
            anonymousContext(testService(calls))
        ).gatewaySessions;
        const failure = await captureFailure(() => caller.list({ filter: "ALL" }));

        expect(failure).toBeInstanceOf(TRPCError);
        expect(calls).toEqual([]);
    });

    test("enforces separate session read and write capabilities", async () => {
        const calls: string[] = [];
        const service = testService(calls);
        const access: GatewaySessionMutationAccess = {
            authorizeRecentMfa: () => "authorized",
        };
        const readOnly = testRouter.createCaller(
            sessionContext(service, access, ["gateway-sessions:read"])
        ).gatewaySessions;
        expect(await readOnly.list({ filter: "ALL" })).toEqual(snapshot());
        expect(
            await captureFailure(() => readOnly.reset({ key: "agent:main:main" }))
        ).toBeInstanceOf(TRPCError);

        const writeOnly = testRouter.createCaller(
            sessionContext(service, access, ["gateway-sessions:write"])
        ).gatewaySessions;
        expect(
            await captureFailure(() => writeOnly.list({ filter: "ALL" }))
        ).toBeInstanceOf(TRPCError);
        expect(calls).toEqual(["list"]);
    });

    test("denies controls without recent MFA before invoking OpenClaw", async () => {
        for (const status of [
            "mfa-enrollment-required",
            "step-up-required",
            "session-changed",
        ] as const) {
            const calls: string[] = [];
            const context = sessionContext(testService(calls), {
                authorizeRecentMfa: () => status,
            });
            const failure = await captureFailure(() =>
                testRouter
                    .createCaller(context)
                    .gatewaySessions.reset({ key: "agent:main:main" })
            );

            expect(failure).toBeInstanceOf(TRPCError);
            expect(calls).toEqual([]);
            if (status === "session-changed") {
                expect(context.responseHeaders.get("set-cookie")).toContain("Max-Age=0");
            }
        }
    });

    test("maps the local primary-session deletion policy to a safe forbidden response", async () => {
        const calls: string[] = [];
        const baseService = testService(calls);
        const service: GatewaySessionsService = {
            ...baseService,
            delete: () => Promise.reject(new GatewaySessionControlForbiddenError()),
        };
        const caller = testRouter.createCaller(
            sessionContext(service, {
                authorizeRecentMfa: () => "authorized",
            })
        ).gatewaySessions;

        const failure = await captureFailure(() =>
            caller.delete({
                expectedSessionId: "primary-session-id",
                key: "agent:main:main",
            })
        );
        expect(failure).toBeInstanceOf(TRPCError);
        expect(failure).toMatchObject({
            code: "FORBIDDEN",
            message: "The primary Gateway session cannot be deleted",
        });
        expect(calls).toEqual([]);
    });

    test("maps an unconfirmed control to the shared allowlisted operation reason", async () => {
        const calls: string[] = [];
        const baseService = testService(calls);
        const service: GatewaySessionsService = {
            ...baseService,
            reset: () => Promise.reject(new GatewaySessionControlUnknownOutcomeError()),
        };
        const caller = testRouter.createCaller(
            sessionContext(service, {
                authorizeRecentMfa: () => "authorized",
            })
        ).gatewaySessions;

        const failure = await captureFailure(() =>
            caller.reset({ key: "agent:coder:main" })
        );
        expect(failure).toMatchObject({
            code: "SERVICE_UNAVAILABLE",
            message: "Gateway session control outcome could not be confirmed",
        });
        expect(failure).toHaveProperty("cause.reason", "operation_outcome_unknown");
        expect(String(failure)).not.toContain("agent:coder:main");
    });
});
