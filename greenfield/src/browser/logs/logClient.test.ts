import { describe, expect, jest, test } from "bun:test";

import type { DashboardTrpcClient } from "../api/trpcClient.ts";
import { logClient } from "./logClient.ts";

describe("logClient", () => {
    test("exposes only the bound logs query and mutation transport", async () => {
        const receivers: unknown[] = [];
        const query = jest.fn(function (this: unknown, name: string, input: unknown) {
            receivers.push(this);
            return Promise.resolve({ name, input });
        });
        const mutation = jest.fn(function (this: unknown, name: string, input: unknown) {
            receivers.push(this);
            return Promise.resolve({ name, input });
        });
        const dashboardClient = { mutation, query } as unknown as DashboardTrpcClient;

        const client = logClient(dashboardClient);
        const detachedQuery = client.query;
        const detachedMutation = client.mutation;

        await detachedQuery("logs.listSources", {});
        await detachedMutation("logs.requestMaintenance", {
            dryRun: false,
            idempotencyKey: "a".repeat(32),
            policyId: "docker-managed",
        });

        expect(Object.isFrozen(client)).toBeTrue();
        expect(query).toHaveBeenCalledWith("logs.listSources", {});
        expect(mutation).toHaveBeenCalledWith("logs.requestMaintenance", {
            dryRun: false,
            idempotencyKey: "a".repeat(32),
            policyId: "docker-managed",
        });
        expect(receivers).toEqual([dashboardClient, dashboardClient]);
        expect(Object.keys(client).toSorted()).toEqual(["mutation", "query"]);
    });
});
