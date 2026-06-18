import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, jest } from "bun:test";

import { createQueryWrapper } from "../test/queryClient";
import { stubGlobal } from "../test/testUtils";
import { useDatabaseOverview } from "./useDatabase";

describe("useDatabaseOverview", () => {
    it("fetches database overview", async () => {
        const overview = {
            overview: {
                totalDatabaseSizeBytes: 1024,
                totalBackends: 2,
                averageCacheHitRatio: 0.99,
                connections: {},
                pgStatStatementsEnabled: true,
                torrentCounts: { comet: 0, bitmagnet: 0 },
                pgbouncer: {
                    clientConnections: 1,
                    serverConnections: 1,
                    waitingClients: 0,
                    maxWait: 0,
                    avgQueryTime: 0,
                    avgTransactionTime: 0,
                },
            },
            databases: [],
            deadTuples: [],
            topQueries: [],
            pgbouncerPools: [],
            pgbouncerStats: [],
        };
        const fetchMock = jest
            .fn()
            .mockResolvedValue({ ok: true, status: 200, json: async () => overview });
        stubGlobal("fetch", fetchMock);

        const { result } = renderHook(() => useDatabaseOverview(), {
            wrapper: createQueryWrapper(),
        });

        await waitFor(() =>
            expect(result.current.data?.overview.totalDatabaseSizeBytes).toBe(1024)
        );
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/database/overview",
            expect.any(Object)
        );
    });
});
