import { describe, expect, test } from "bun:test";

import { liveHistoryArchiveQueryKey } from "../api/liveHistory.ts";
import { createDashboardQueryClient } from "../api/queryClient.ts";
import {
    createDashboardTrpcClient,
    type DashboardTrpcTransport,
} from "../api/trpcClient.ts";
import {
    taskListQueryOptions,
    taskListQueryRoot,
    taskOverviewQueryOptions,
    taskQueryKey,
    refreshTaskQueries,
} from "./taskQueries.ts";

class TaskQueryTransport implements DashboardTrpcTransport {
    input: unknown;

    mutation(): Promise<unknown> {
        return Promise.reject(new TypeError("Unexpected task mutation"));
    }

    query(path: string, input?: unknown): Promise<unknown> {
        if (path !== "tasks.list") {
            return Promise.reject(new TypeError(`Unexpected task query: ${path}`));
        }
        this.input = input;
        return Promise.resolve({ tasks: [] });
    }
}

describe("task browser queries", () => {
    test("invalidates mutable task progress archive pages", async () => {
        const queryClient = createDashboardQueryClient();
        const archiveKey = liveHistoryArchiveQueryKey([
            ...taskQueryKey,
            "progress",
            "task-1",
        ]);
        queryClient.setQueryData(archiveKey, { pages: [] });

        await refreshTaskQueries(queryClient);

        expect(queryClient.getQueryState(archiveKey)?.isInvalidated).toBeTrue();
    });

    test("isolates a bounded unfinished overview beneath the task-list root", async () => {
        const transport = new TaskQueryTransport();
        const queryClient = createDashboardQueryClient();

        try {
            const options = taskOverviewQueryOptions(
                createDashboardTrpcClient(transport)
            );
            await queryClient.fetchQuery(options);

            expect(options.queryKey).toEqual([...taskListQueryRoot, "overview"]);
            expect(transport.input).toEqual({
                filters: { statuses: ["blocked", "in-progress", "todo"] },
                limit: 100,
            });
        } finally {
            queryClient.clear();
        }
    });

    test("sends bounded server filters through the validated task contract", async () => {
        const transport = new TaskQueryTransport();
        const queryClient = createDashboardQueryClient();

        try {
            await queryClient.fetchInfiniteQuery(
                taskListQueryOptions(createDashboardTrpcClient(transport), {
                    assignees: ["mira-2026"],
                    automation: "recurring",
                    search: "host",
                })
            );

            expect(transport.input).toEqual({
                filters: {
                    assignees: ["mira-2026"],
                    automation: "recurring",
                    search: "host",
                },
                limit: 100,
            });
        } finally {
            queryClient.clear();
        }
    });
});
