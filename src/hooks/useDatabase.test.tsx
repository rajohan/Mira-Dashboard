import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { createQueryWrapper } from "../test/queryClient";
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
        const fetchMock = vi
            .fn()
            .mockResolvedValue({ ok: true, status: 200, json: async () => overview });
        vi.stubGlobal("fetch", fetchMock);

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
