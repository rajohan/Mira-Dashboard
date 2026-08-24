import * as v from "valibot";

import {
    type GatewayConnectionPhase,
    type GatewayConnectionSnapshot,
    getGatewayConnectionResultSchema,
} from "../../../contracts/gatewayConnection.ts";
import { timestampMillisecondsSchema } from "../../../shared/dateTime.ts";
import { GatewayConnectionUnavailableError } from "./errors.ts";

/** Narrow structural port implemented by the process-owned persistent transport. */
export interface GatewayConnectionStateProvider {
    readonly snapshot: {
        readonly connectedAtMs?: number;
        readonly connectionGeneration: number;
        readonly lastActivityAtMs?: number;
        readonly lastDisconnectedAtMs?: number;
        readonly lastKnownGood?: object;
        readonly nextReconnectAtMs?: number;
        readonly phase: GatewayConnectionPhase;
        readonly reconnectAttempt: number;
    };
}

export interface GatewayConnectionService {
    readonly get: () => GatewayConnectionSnapshot;
}

export interface GatewayConnectionServiceDependencies {
    readonly nowMs?: () => number;
    readonly provider: GatewayConnectionStateProvider;
}

const gatewayConnectionClockSchema = timestampMillisecondsSchema(
    "Gateway connection clock is invalid"
);

function connectionFreshness(
    source: GatewayConnectionStateProvider["snapshot"]
): GatewayConnectionSnapshot["freshness"] {
    if (source.phase === "connected") return "fresh";
    return source.lastKnownGood === undefined ? "unavailable" : "stale";
}

/** Explicit no-transport source used only by focused runtimes and fail-closed startup. */
export const unavailableGatewayConnectionStateProvider: GatewayConnectionStateProvider =
    Object.freeze({
        snapshot: Object.freeze({
            connectionGeneration: 0,
            phase: "stopped",
            reconnectAttempt: 0,
        }),
    });

/**
 * Projects the process transport onto a strict non-secret browser snapshot.
 * @param dependencies Live state provider and request-check clock.
 * @returns A frozen synchronous query service.
 */
export function createGatewayConnectionService(
    dependencies: GatewayConnectionServiceDependencies
): GatewayConnectionService {
    const nowMs = dependencies.nowMs ?? Date.now;
    return Object.freeze({
        get(): GatewayConnectionSnapshot {
            try {
                const source = dependencies.provider.snapshot;
                const checkedAtMs = v.parse(gatewayConnectionClockSchema, nowMs());
                return v.parse(getGatewayConnectionResultSchema, {
                    checkedAtMs,
                    connectedAtMs: source.connectedAtMs,
                    connectionGeneration: source.connectionGeneration,
                    freshness: connectionFreshness(source),
                    lastActivityAtMs: source.lastActivityAtMs,
                    lastDisconnectedAtMs: source.lastDisconnectedAtMs,
                    nextReconnectAtMs: source.nextReconnectAtMs,
                    phase: source.phase,
                    reconnectAttempt: source.reconnectAttempt,
                });
            } catch {
                throw new GatewayConnectionUnavailableError();
            }
        },
    });
}
