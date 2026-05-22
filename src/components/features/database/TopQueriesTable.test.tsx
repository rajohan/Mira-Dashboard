import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { DatabaseOverviewResponse } from "../../../hooks/useDatabase";
import { TopQueriesTable } from "./TopQueriesTable";

const topQueries: DatabaseOverviewResponse["topQueries"] = [
    {
        calls: "12",
        mean_exec_time: "3.5",
        query: "SELECT * FROM torrents WHERE id = $1",
        rows: "12",
        shared_blks_hit: "1",
        shared_blks_read: "0",
        total_exec_time: "42",
    },
    {
        calls: "2",
        mean_exec_time: "14.5",
        query: "UPDATE streams SET watched_at = now() WHERE user_id = $1 AND stream_id = $2",
        rows: "1",
        shared_blks_hit: "4",
        shared_blks_read: "2",
        total_exec_time: "29",
    },
];

function renderTable(props: Partial<React.ComponentProps<typeof TopQueriesTable>> = {}) {
    return render(<TopQueriesTable enabled data={topQueries} {...props} />);
}

function restoreClipboard(descriptor: PropertyDescriptor | undefined) {
    if (descriptor) {
        Object.defineProperty(navigator, "clipboard", descriptor);
        return;
    }
    Reflect.deleteProperty(navigator, "clipboard");
}

describe("TopQueriesTable", () => {
    it("renders disabled state when pg_stat_statements is unavailable", () => {
        render(<TopQueriesTable enabled={false} data={[]} />);

        expect(
            screen.getByText("pg_stat_statements is not enabled.")
        ).toBeInTheDocument();
    });

    it("opens query details and copies the selected query", async () => {
        const user = userEvent.setup();
        let setTimeoutSpy: { mockRestore: () => void } | undefined;
        let resetCopied: (() => void) | undefined;
        const writeText = vi.fn().mockImplementation(async () => {});
        const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
        Object.defineProperty(navigator, "clipboard", {
            configurable: true,
            value: { writeText },
        });

        try {
            renderTable({ data: [topQueries[0]!] });

            await user.click(
                screen.getAllByText("SELECT * FROM torrents WHERE id = $1")[0]!
            );

            expect(await screen.findByText("Query details")).toBeInTheDocument();
            expect(screen.getByText("Calls: 12")).toBeInTheDocument();

            setTimeoutSpy = vi
                .spyOn(window, "setTimeout")
                .mockImplementationOnce((handler) => {
                    if (typeof handler === "function") {
                        resetCopied = handler as () => void;
                    }
                    return 1 as unknown as ReturnType<typeof setTimeout>;
                });
            await act(async () => {
                fireEvent.click(screen.getByRole("button", { name: /Copy query/u }));
                await Promise.resolve();
            });
            setTimeoutSpy.mockRestore();
            setTimeoutSpy = undefined;

            expect(writeText).toHaveBeenCalledWith(
                "SELECT * FROM torrents WHERE id = $1"
            );
            expect(screen.getByRole("button", { name: /Copied/u })).toBeInTheDocument();
            act(() => resetCopied?.());
            expect(
                screen.getByRole("button", { name: /Copy query/u })
            ).toBeInTheDocument();
        } finally {
            setTimeoutSpy?.mockRestore();
            restoreClipboard(originalClipboard);
        }
    });

    it("resets copy state when clipboard writes fail", async () => {
        const user = userEvent.setup();
        const copyError = new Error("clipboard unavailable");
        const writeText = vi
            .fn()
            .mockImplementationOnce(async () => {})
            .mockRejectedValueOnce(copyError);
        const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
        const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
        Object.defineProperty(navigator, "clipboard", {
            configurable: true,
            value: { writeText },
        });

        try {
            renderTable({ data: [topQueries[0]!] });

            await user.click(
                screen.getAllByText("SELECT * FROM torrents WHERE id = $1")[0]!
            );
            await screen.findByText("Query details");

            await act(async () => {
                fireEvent.click(screen.getByRole("button", { name: /Copy query/u }));
                await Promise.resolve();
            });
            expect(screen.getByRole("button", { name: /Copied/u })).toBeInTheDocument();

            expect(writeText).toHaveBeenCalledWith(
                "SELECT * FROM torrents WHERE id = $1"
            );

            await act(async () => {
                fireEvent.click(screen.getByRole("button", { name: /Copied/u }));
                await Promise.resolve();
            });
            expect(consoleError).toHaveBeenCalledWith("Failed to copy query", copyError);
            expect(
                screen.getByRole("button", { name: /Copy query/u })
            ).toBeInTheDocument();
            expect(
                screen.queryByRole("button", { name: /Copied/u })
            ).not.toBeInTheDocument();
        } finally {
            consoleError.mockRestore();
            restoreClipboard(originalClipboard);
        }
    });

    it("renders desktop columns, mobile summary cards, and sorted numeric data", async () => {
        renderTable();

        expect(screen.getByRole("button", { name: "Query" })).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Calls" })).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Total ms" })).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Mean ms" })).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Rows" })).toBeInTheDocument();
        expect(screen.getAllByText("Tap for full query")).toHaveLength(2);

        const table = screen.getByRole("table");
        const bodyRows = () => within(table).getAllByRole("row").slice(1);

        for (const column of ["Calls", "Total ms", "Mean ms", "Rows"]) {
            await userEvent.click(screen.getByRole("button", { name: column }));
            await userEvent.click(screen.getByRole("button", { name: column }));
        }

        expect(within(bodyRows()[0]!).getAllByRole("cell")[1]).toHaveTextContent("2");
    });

    it("opens details from a keyboard-activated mobile query card and closes cleanly", async () => {
        renderTable({ data: [topQueries[1]!] });

        const mobileCard = screen.getByRole("button", {
            name: /UPDATE streams SET watched_at/u,
        });
        mobileCard.focus();
        await userEvent.keyboard("{Enter}");

        expect(await screen.findByText("Query details")).toBeInTheDocument();
        expect(screen.getByText("Calls: 2")).toBeInTheDocument();
        expect(screen.getByText("Mean ms: 14.5")).toBeInTheDocument();
        expect(screen.getByText("Total ms: 29")).toBeInTheDocument();
        expect(screen.getByText("Rows: 1")).toBeInTheDocument();

        const dialog = screen.getByRole("dialog", { name: "Query details" });
        await userEvent.click(within(dialog).getAllByRole("button")[0]!);

        await waitFor(() => {
            expect(screen.queryByText("Query details")).not.toBeInTheDocument();
        });
    });
});
