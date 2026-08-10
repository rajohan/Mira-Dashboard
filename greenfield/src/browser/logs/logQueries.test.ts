import { describe, expect, test } from "bun:test";

import { QueryClient } from "@tanstack/react-query";

import { jobRunDetailQueryKey } from "../jobs/jobQueries.ts";
import type { LogClient } from "./logClient.ts";
import {
    logMaintenanceQueryOptions,
    logMaintenanceQueryKey,
    logMaintenanceRefreshIntervalMs,
    logMaintenanceRealtimeFallbackRefreshIntervalMs,
    logSnapshotQueryOptions,
    refreshLogMaintenanceQueries,
} from "./logQueries.ts";

const client = Object.freeze({}) as LogClient;

describe("log snapshot query identity", () => {
    test("never carries rows across source or search query keys", () => {
        const sourceA = logSnapshotQueryOptions(
            client,
            { limit: 100, mode: "tail", sourceId: "dashboard.web.stdout" },
            true
        );
        const sourceB = logSnapshotQueryOptions(
            client,
            { limit: 200, mode: "tail", sourceId: "openclaw.20260809" },
            true
        );
        const search = logSnapshotQueryOptions(
            client,
            {
                mode: "search",
                limit: 500,
                query: "worker",
                sourceId: "openclaw.20260809",
            },
            true
        );

        expect(sourceA.queryKey).not.toEqual(sourceB.queryKey);
        expect(sourceB.queryKey).not.toEqual(search.queryKey);
        expect(sourceA.placeholderData).toBeUndefined();
        expect(sourceB.placeholderData).toBeUndefined();
        expect(search.placeholderData).toBeUndefined();
    });

    test("polls maintenance availability every 15 seconds even while realtime is healthy", () => {
        const options = logMaintenanceQueryOptions(client);

        expect(logMaintenanceRefreshIntervalMs).toBe(15_000);
        expect(options.refetchInterval).toBe(logMaintenanceRefreshIntervalMs);
        expect(options.refetchIntervalInBackground).toBeFalse();
    });

    test("invalidates maintenance and one followed run with a 30-second fallback", async () => {
        const queryClient = new QueryClient();
        const runId = "019fdf70-0000-7000-8000-000000000020";
        const runKey = jobRunDetailQueryKey(runId);
        queryClient.setQueryData(logMaintenanceQueryKey, { policies: [] });
        queryClient.setQueryData(runKey, { run: { id: runId } });

        await refreshLogMaintenanceQueries(queryClient, runId);

        expect(logMaintenanceRealtimeFallbackRefreshIntervalMs).toBe(30_000);
        expect(
            queryClient.getQueryState(logMaintenanceQueryKey)?.isInvalidated
        ).toBeTrue();
        expect(queryClient.getQueryState(runKey)?.isInvalidated).toBeTrue();
        queryClient.clear();
    });
});
