import { describe, expect, test } from "bun:test";

import { TRPCError } from "@trpc/server";

import type { GatewayConnectionSnapshot } from "../../../contracts/gatewayConnection.ts";
import type { ApplicationCapability } from "../../../contracts/security.ts";
import type { RequestContext } from "../../trpc/context.ts";
import { router } from "../../trpc/trpc.ts";
import { GatewayConnectionUnavailableError } from "./errors.ts";
import { gatewayRouter } from "./procedures.ts";
import type { GatewayConnectionService } from "./service.ts";

const snapshot: GatewayConnectionSnapshot = {
    checkedAtMs: 1_800_000_000_000,
    connectedAtMs: 1_799_999_999_000,
    connectionGeneration: 2,
    freshness: "fresh",
    lastActivityAtMs: 1_800_000_000_000,
    phase: "connected",
    reconnectAttempt: 0,
};

function authenticatedContext(
    service: GatewayConnectionService,
    options: {
        readonly capabilities?: readonly ApplicationCapability[];
        readonly kind?: "automation" | "session";
    } = {}
): RequestContext {
    return {
        authentication: {
            kind: "authenticated",
            principal: {
                authorizationVersion: 1,
                capabilities: [...(options.capabilities ?? ["gateway-sessions:read"])],
                authenticatorId: "a".repeat(32),
                id:
                    options.kind === "automation"
                        ? "test-automation"
                        : "019fc968-1a9b-7770-8f1b-d5b863b0e7b4",
                kind: options.kind ?? "session",
            },
        },
        authenticationLease: {
            expiresAtMs: Number.MAX_SAFE_INTEGER,
            revalidate: () => Promise.reject(new Error("Not used by this test")),
        },
        gatewayConnectionService: service,
        responseHeaders: new Headers(),
        services: {},
    } as unknown as RequestContext;
}

function anonymousContext(service: GatewayConnectionService): RequestContext {
    return {
        authentication: { kind: "anonymous" },
        gatewayConnectionService: service,
        responseHeaders: new Headers(),
        services: {},
    } as unknown as RequestContext;
}

async function captureFailure(work: () => Promise<unknown>): Promise<TRPCError> {
    try {
        await work();
    } catch (error) {
        if (error instanceof TRPCError) return error;
        throw error;
    }
    throw new Error("Expected query to fail");
}

const testRouter = router({ gateway: gatewayRouter });

describe("Gateway connection procedure", () => {
    test("returns the exact sanitized snapshot to an authorized browser session", async () => {
        const caller = testRouter.createCaller(
            authenticatedContext({ get: () => snapshot })
        );

        expect(await caller.gateway.connection.get({})).toEqual(snapshot);
    });

    test("rejects automation, missing capability, and anonymous callers", async () => {
        const service = { get: () => snapshot };
        const automation = testRouter.createCaller(
            authenticatedContext(service, { kind: "automation" })
        );
        const missingCapability = testRouter.createCaller(
            authenticatedContext(service, { capabilities: [] })
        );
        const anonymous = testRouter.createCaller(anonymousContext(service));

        expect(
            await captureFailure(() => automation.gateway.connection.get({}))
        ).toMatchObject({ code: "FORBIDDEN" });
        expect(
            await captureFailure(() => missingCapability.gateway.connection.get({}))
        ).toMatchObject({ code: "FORBIDDEN" });
        expect(
            await captureFailure(() => anonymous.gateway.connection.get({}))
        ).toMatchObject({ code: "UNAUTHORIZED" });
    });

    test("maps an invalid transport projection to one safe availability error", async () => {
        const secret = "secret-native-gateway-detail";
        const caller = testRouter.createCaller(
            authenticatedContext({
                get() {
                    throw new GatewayConnectionUnavailableError();
                },
            })
        );

        const failure = await captureFailure(() => caller.gateway.connection.get({}));
        expect(failure).toMatchObject({
            code: "SERVICE_UNAVAILABLE",
            message: "Gateway connection state is temporarily unavailable",
        });
        expect(JSON.stringify(failure)).not.toContain(secret);
    });
});
