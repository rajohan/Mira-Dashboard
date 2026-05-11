import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { DatabaseOverviewResponse } from "../../../hooks/useDatabase";
import { DatabaseOverviewCards } from "./DatabaseOverviewCards";

const overview: DatabaseOverviewResponse["overview"] = {
    averageCacheHitRatio: 99.5,
    connections: { active: 3, idle: 7 },
    pgStatStatementsEnabled: true,
    pgbouncer: {
        avgQueryTime: 12,
        avgTransactionTime: 15,
        clientConnections: 4,
        maxWait: 0,
        serverConnections: 5,
        waitingClients: 0,
    },
    torrentCounts: { bitmagnet: 987_654, comet: 123_456 },
    totalBackends: 10,
    totalDatabaseSizeBytes: 25 * 1024 * 1024,
};

describe("DatabaseOverviewCards", () => {
    it("renders formatted database overview metrics", () => {
        render(<DatabaseOverviewCards overview={overview} />);

        expect(screen.getByText("Comet torrents")).toBeInTheDocument();
        expect(screen.getByText("123,456")).toBeInTheDocument();
        expect(screen.getByText("Bitmagnet torrents")).toBeInTheDocument();
        expect(screen.getByText("987,654")).toBeInTheDocument();
        expect(screen.getByText("Total DB size")).toBeInTheDocument();
        expect(screen.getByText("25 MB")).toBeInTheDocument();
        expect(screen.getByText("Connections")).toBeInTheDocument();
        expect(screen.getByText("active 3 · idle 7")).toBeInTheDocument();
    });
});
