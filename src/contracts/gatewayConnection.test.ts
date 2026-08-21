import { describe, expect, test } from "bun:test";

import * as v from "valibot";

import {
    gatewayConnectionProcedureContracts,
    getGatewayConnectionInputSchema,
    getGatewayConnectionResultSchema,
} from "./gatewayConnection.ts";

const checkedAtMs = 1_800_000_000_000;

describe("Gateway connection contracts", () => {
    test("accepts only a consistent sanitized phase and freshness projection", () => {
        expect(
            v.parse(getGatewayConnectionResultSchema, {
                checkedAtMs,
                connectedAtMs: checkedAtMs - 1000,
                connectionGeneration: 3,
                freshness: "fresh",
                lastActivityAtMs: checkedAtMs - 10,
                lastDisconnectedAtMs: checkedAtMs - 2000,
                phase: "connected",
                reconnectAttempt: 0,
            })
        ).toBeDefined();
        expect(
            v.safeParse(getGatewayConnectionResultSchema, {
                checkedAtMs,
                connectionGeneration: 3,
                freshness: "fresh",
                phase: "degraded",
                reconnectAttempt: 1,
            }).success
        ).toBeFalse();
        expect(
            v.safeParse(getGatewayConnectionResultSchema, {
                checkedAtMs,
                connectedAtMs: checkedAtMs + 1,
                connectionGeneration: 3,
                freshness: "fresh",
                phase: "connected",
                reconnectAttempt: 0,
            }).success
        ).toBeFalse();
    });

    test("rejects input selectors and secret-bearing output fields", () => {
        expect(v.safeParse(getGatewayConnectionInputSchema, {}).success).toBeTrue();
        expect(
            v.safeParse(getGatewayConnectionInputSchema, { includeEndpoint: true })
                .success
        ).toBeFalse();
        expect(
            v.safeParse(getGatewayConnectionResultSchema, {
                checkedAtMs,
                connectionGeneration: 0,
                endpoint: "ws://secret.example",
                freshness: "unavailable",
                phase: "stopped",
                reconnectAttempt: 0,
            }).success
        ).toBeFalse();
    });

    test("locks the snapshot to browser sessions with the existing read capability", () => {
        expect(gatewayConnectionProcedureContracts).toHaveLength(1);
        expect(gatewayConnectionProcedureContracts[0]).toMatchObject({
            access: {
                capabilities: ["gateway-sessions:read"],
                capabilityPolicy: "all",
                kind: "authenticated",
                principalKinds: ["session"],
            },
            errors: ["FORBIDDEN", "SERVICE_UNAVAILABLE", "UNAUTHORIZED"],
            kind: "query",
            name: "gateway.connection.get",
        });
    });
});
