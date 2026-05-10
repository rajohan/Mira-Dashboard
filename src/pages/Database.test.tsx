import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { Database } from "./Database";

const hooks = vi.hoisted(() => ({
    useDatabaseOverview: vi.fn(),
}));

vi.mock("../hooks/useDatabase", () => ({
    useDatabaseOverview: hooks.useDatabaseOverview,
}));

vi.mock("../components/features/database/DatabaseOverviewCards", () => ({
    DatabaseOverviewCards: ({ overview }: { overview: { databaseCount: number } }) => (
        <div data-testid="overview-cards">databases: {overview.databaseCount}</div>
    ),
}));

vi.mock("../components/features/database/DatabaseSizesTable", () => ({
    DatabasesTable: ({ databases }: { databases: unknown[] }) => (
        <div data-testid="databases-table">database rows: {databases.length}</div>
    ),
}));

vi.mock("../components/features/database/AutovacuumHealthTable", () => ({
    AutovacuumHealthTable: ({ data }: { data: unknown[] }) => (
        <div data-testid="autovacuum-table">dead tuples: {data.length}</div>
    ),
}));

vi.mock("../components/features/database/TopQueriesTable", () => ({
    TopQueriesTable: ({ data, enabled }: { data: unknown[]; enabled: boolean }) => (
        <div data-testid="top-queries-table">
            top queries: {data.length}, enabled: {String(enabled)}
        </div>
    ),
}));

describe("Database page", () => {
    beforeEach(() => {
        hooks.useDatabaseOverview.mockReset();
    });

    it("renders loading state", () => {
        hooks.useDatabaseOverview.mockReturnValue({
            data: undefined,
            error: null,
            isLoading: true,
        });

        render(<Database />);

        expect(screen.getByText("Loading database metrics...")).toBeInTheDocument();
    });

    it("renders error state", () => {
        hooks.useDatabaseOverview.mockReturnValue({
            data: undefined,
            error: new Error("failed"),
            isLoading: false,
        });

        render(<Database />);

        expect(screen.getByText("Failed to load database metrics.")).toBeInTheDocument();
    });

    it("renders database sections with overview data", () => {
        hooks.useDatabaseOverview.mockReturnValue({
            data: {
                databases: [{ name: "mira" }, { name: "n8n" }],
                deadTuples: [{ table: "tasks" }],
                overview: {
                    databaseCount: 2,
                    pgStatStatementsEnabled: true,
                },
                pgbouncerPools: [],
                pgbouncerStats: [],
                topQueries: [{ query: "select 1" }, { query: "select 2" }],
            },
            error: null,
            isLoading: false,
        });

        render(<Database />);

        expect(screen.getByText("Databases")).toBeInTheDocument();
        expect(screen.getByText("Maintenance")).toBeInTheDocument();
        expect(screen.getByText("Query performance")).toBeInTheDocument();
        expect(screen.getByTestId("overview-cards")).toHaveTextContent("databases: 2");
        expect(screen.getByTestId("databases-table")).toHaveTextContent(
            "database rows: 2"
        );
        expect(screen.getByTestId("autovacuum-table")).toHaveTextContent(
            "dead tuples: 1"
        );
        expect(screen.getByTestId("top-queries-table")).toHaveTextContent(
            "top queries: 2, enabled: true"
        );
    });
});
