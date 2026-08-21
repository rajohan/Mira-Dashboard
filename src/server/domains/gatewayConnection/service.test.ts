import { describe, expect, test } from "bun:test";

import { GatewayConnectionUnavailableError } from "./errors.ts";
import {
    createGatewayConnectionService,
    unavailableGatewayConnectionStateProvider,
} from "./service.ts";

const checkedAtMs = 1_800_000_000_000;

describe("Gateway connection service", () => {
    test("projects connected transport state without upstream identity or secrets", () => {
        const service = createGatewayConnectionService({
            nowMs: () => checkedAtMs,
            provider: {
                snapshot: {
                    connectedAtMs: checkedAtMs - 1000,
                    connectionGeneration: 4,
                    lastActivityAtMs: checkedAtMs - 10,
                    lastKnownGood: {
                        connectionId: "secret-connection-id",
                        protocol: 4,
                        serverVersion: "secret-server-version",
                    },
                    phase: "connected",
                    reconnectAttempt: 0,
                },
            },
        });

        const result = service.get();
        expect(result).toEqual({
            checkedAtMs,
            connectedAtMs: checkedAtMs - 1000,
            connectionGeneration: 4,
            freshness: "fresh",
            lastActivityAtMs: checkedAtMs - 10,
            lastDisconnectedAtMs: undefined,
            nextReconnectAtMs: undefined,
            phase: "connected",
            reconnectAttempt: 0,
        });
        expect(JSON.stringify(result)).not.toContain("secret");
    });

    test("distinguishes stale last-known-good from never-connected unavailable state", () => {
        const stale = createGatewayConnectionService({
            nowMs: () => checkedAtMs,
            provider: {
                snapshot: {
                    connectionGeneration: 5,
                    lastActivityAtMs: checkedAtMs - 5000,
                    lastDisconnectedAtMs: checkedAtMs - 4000,
                    lastKnownGood: {},
                    nextReconnectAtMs: checkedAtMs + 1000,
                    phase: "degraded",
                    reconnectAttempt: 2,
                },
            },
        }).get();
        const unavailable = createGatewayConnectionService({
            nowMs: () => checkedAtMs,
            provider: unavailableGatewayConnectionStateProvider,
        }).get();

        expect(stale).toMatchObject({
            connectionGeneration: 5,
            freshness: "stale",
            phase: "degraded",
            reconnectAttempt: 2,
        });
        expect(unavailable).toMatchObject({
            connectionGeneration: 0,
            freshness: "unavailable",
            phase: "stopped",
            reconnectAttempt: 0,
        });
    });

    test("turns malformed transport or clock state into one safe error", () => {
        const invalidSource = createGatewayConnectionService({
            nowMs: () => checkedAtMs,
            provider: {
                snapshot: {
                    connectedAtMs: checkedAtMs + 1,
                    connectionGeneration: 1,
                    lastKnownGood: {},
                    phase: "connected",
                    reconnectAttempt: 0,
                },
            },
        });
        const invalidClock = createGatewayConnectionService({
            nowMs: () => Number.NaN,
            provider: unavailableGatewayConnectionStateProvider,
        });

        expect(() => invalidSource.get()).toThrow(GatewayConnectionUnavailableError);
        expect(() => invalidClock.get()).toThrow(GatewayConnectionUnavailableError);
    });
});
