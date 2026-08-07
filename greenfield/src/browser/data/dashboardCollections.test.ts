import { describe, expect, test } from "bun:test";

import { createDashboardQueryClient } from "../api/queryClient.ts";
import {
    createDashboardTrpcClient,
    type DashboardTrpcTransport,
} from "../api/trpcClient.ts";
import { createDashboardBrowserCollections } from "./dashboardCollections.ts";

const unusedTransport: DashboardTrpcTransport = Object.freeze({
    mutation: (path: string) =>
        Promise.reject(new TypeError(`Unexpected mutation: ${path}`)),
    query: (path: string) =>
        Promise.reject(new TypeError(`Unexpected query: ${path}`)),
});

describe("Dashboard browser collections", () => {
    test("observes every cleanup failure and still recreates the registry", async () => {
        const queryClient = createDashboardQueryClient();
        const collections = createDashboardBrowserCollections(
            queryClient,
            createDashboardTrpcClient(unusedTransport)
        );
        const previousAgents = collections.agents;
        const definitionsFailure = new TypeError("definitions cleanup failed");
        const statusesFailure = new TypeError("statuses cleanup failed");
        const cleanups: string[] = [];
        Reflect.set(previousAgents.definitions, "cleanup", () => {
            cleanups.push("definitions");
            return Promise.reject(definitionsFailure);
        });
        Reflect.set(previousAgents.statuses, "cleanup", () => {
            cleanups.push("statuses");
            return Promise.reject(statusesFailure);
        });

        try {
            const failure = await collections.reset().catch((error: unknown) => error);
            expect(failure).toBeInstanceOf(AggregateError);
            expect((failure as AggregateError).errors).toEqual([
                definitionsFailure,
                statusesFailure,
            ]);
            expect(cleanups).toEqual(["definitions", "statuses"]);
            expect(collections.agents).not.toBe(previousAgents);
        } finally {
            await collections.cleanup();
            queryClient.clear();
        }
    });
});
