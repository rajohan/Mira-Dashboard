import { describe, expect, jest, test } from "bun:test";

import type { DashboardTrpcClient } from "../api/trpcClient.ts";
import { dockerClient } from "./index.ts";

describe("dockerClient", () => {
    test("exposes only the bound Docker query and mutation transport", async () => {
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

        const client = dockerClient(dashboardClient);
        const detachedQuery = client.query;
        const detachedMutation = client.mutation;

        await detachedQuery("docker.overview", {});
        await detachedMutation("docker.requestOperation", {
            confirmation: "restart-docker-container",
            containerId: "c".repeat(64),
            idempotencyKey: "b".repeat(32),
            operation: "container-restart",
            sourceRevision: "a".repeat(64),
        });

        expect(Object.isFrozen(client)).toBeTrue();
        expect(query).toHaveBeenCalledWith("docker.overview", {});
        expect(mutation).toHaveBeenCalledWith("docker.requestOperation", {
            confirmation: "restart-docker-container",
            containerId: "c".repeat(64),
            idempotencyKey: "b".repeat(32),
            operation: "container-restart",
            sourceRevision: "a".repeat(64),
        });
        expect(receivers).toEqual([dashboardClient, dashboardClient]);
        expect(Object.keys(client).toSorted()).toEqual(["mutation", "query"]);
    });
});
