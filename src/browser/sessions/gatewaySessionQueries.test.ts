import { describe, expect, test } from "bun:test";

import type { TRPCRequestOptions } from "@trpc/client";

import {
    deriveGatewaySessionStats,
    type ListGatewaySessionsResult,
} from "../../contracts/gatewaySessions.ts";
import { createDashboardQueryClient } from "../api/queryClient.ts";
import type { DashboardTrpcClient } from "../api/trpcClient.ts";
import {
    gatewaySessionQueryKey,
    gatewaySessionQueryOptions,
    gatewaySessionRefreshIntervalMs,
} from "./gatewaySessionQueries.ts";

const timestampMs = 1_800_000_000_000;
const snapshot: ListGatewaySessionsResult = {
    filter: "ALL",
    projectionTruncated: false,
    sessions: [],
    source: {
        checkedAtMs: timestampMs,
        connection: "connected",
        freshness: "fresh",
        observedAtMs: timestampMs,
    },
    stats: deriveGatewaySessionStats([], timestampMs),
};

describe("Gateway session query", () => {
    test("locks one exact bounded ALL snapshot key and request", async () => {
        const calls: Array<{
            input: unknown;
            name: string;
            signal: AbortSignal | undefined;
        }> = [];
        const client = {
            query(name: string, input: unknown, options?: TRPCRequestOptions) {
                calls.push({ input, name, signal: options?.signal });
                return Promise.resolve(snapshot);
            },
        } as unknown as DashboardTrpcClient;
        const queryClient = createDashboardQueryClient();

        try {
            const options = gatewaySessionQueryOptions(client);
            expect(await queryClient.fetchQuery(options)).toEqual(snapshot);
            expect(options.queryKey).toEqual(gatewaySessionQueryKey);
            expect(options.refetchInterval).toBe(gatewaySessionRefreshIntervalMs);
            expect(calls).toHaveLength(1);
            expect(calls[0]).toMatchObject({
                input: { filter: "ALL" },
                name: "gatewaySessions.list",
            });
            expect(calls[0]?.signal).toBeInstanceOf(AbortSignal);
        } finally {
            queryClient.clear();
        }
    });
});
