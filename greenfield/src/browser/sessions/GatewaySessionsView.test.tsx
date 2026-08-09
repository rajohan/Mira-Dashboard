import { describe, expect, jest, test } from "bun:test";

import type {
    GatewaySession,
    GatewaySessionAction,
    GatewaySessionActionResult,
    ListGatewaySessionsResult,
} from "../../contracts/gatewaySessions.ts";
import {
    deriveGatewaySessionStats,
    gatewayPrimarySessionKey,
} from "../../contracts/gatewaySessions.ts";
import { formatDashboardDateTime } from "../lib/formatDateTime.ts";
import { GatewaySessionsView } from "./GatewaySessionsView.tsx";

const { render, screen, waitFor, within } = await import("@testing-library/react");
const userEventModule = await import("@testing-library/user-event");
const userEvent = userEventModule.default;

const timestampMs = 1_800_000_000_000;

function session(
    key: string,
    kind: GatewaySession["kind"],
    displayName: string,
    updatedAtMs: number,
    overrides: Partial<GatewaySession> = {}
): GatewaySession {
    return {
        displayName,
        hasActiveRun: false,
        key,
        kind,
        model: "gpt-5.6-sol",
        modelProvider: "openai",
        sessionId: `${key}-generation`,
        totalTokens: 1200,
        totalTokensFresh: true,
        updatedAtMs,
        ...overrides,
    };
}

const sessions = [
    session(gatewayPrimarySessionKey, "main", "Primary main", timestampMs - 20_000, {
        hasActiveRun: true,
    }),
    session("agent:coder:main", "subagent", "Beta main", timestampMs - 10_000),
    session(
        "agent:main:subagent:one",
        "subagent",
        "Alpha subagent",
        timestampMs - 30_000
    ),
    session("hook:startup", "hook", "Startup hook", timestampMs - 40_000),
    session("cron:daily", "cron", "Daily cron", timestampMs - 50_000),
] satisfies GatewaySession[];

function snapshot(
    overrides: Partial<ListGatewaySessionsResult> = {}
): ListGatewaySessionsResult {
    return {
        filter: "ALL",
        projectionTruncated: false,
        sessions,
        source: {
            checkedAtMs: timestampMs,
            connection: "connected",
            freshness: "fresh",
            observedAtMs: timestampMs,
        },
        stats: deriveGatewaySessionStats(sessions, timestampMs),
        ...overrides,
    };
}

function actionResult(
    action: GatewaySessionActionResult["action"],
    key: string
): GatewaySessionActionResult {
    return {
        action,
        key,
        outcome: "changed",
        refresh: { snapshot: snapshot(), status: "available" },
    };
}

describe("Gateway sessions view", () => {
    test("renders same-snapshot stats, exact timestamps, and labelled mobile cells", () => {
        render(
            <GatewaySessionsView
                onAction={(action, row) => Promise.resolve(actionResult(action, row.key))}
                snapshot={snapshot()}
            />
        );

        expect(screen.getByText("Connected")).toBeTruthy();
        expect(
            screen.getByText(
                "Updates automatically every 10 seconds and when OpenClaw reports a change."
            )
        ).toBeTruthy();
        expect(screen.queryByRole("button", { name: "Refresh" })).toBeNull();
        expect(screen.getAllByText("5", { selector: "dd" })).toHaveLength(2);
        expect(screen.getByText("2", { selector: "dd" })).toBeTruthy();
        const observation = screen.getByText(formatDashboardDateTime(timestampMs));
        expect(observation).toHaveAttribute(
            "dateTime",
            new Date(timestampMs).toISOString()
        );
        const table = screen.getByRole("table", { name: "Current OpenClaw sessions" });
        expect(table).toHaveClass("border-separate", "border-spacing-0");
        expect(table.parentElement).toHaveClass(
            "overflow-x-auto",
            "overscroll-x-contain"
        );
        expect(within(table).getByRole("columnheader", { name: "Type" })).toHaveClass(
            "bg-primary-950"
        );
        expect(table.querySelector(".dashboard-data-table-label")).toHaveTextContent(
            "Type"
        );
        const rows = within(table).getAllByRole("row");
        expect(rows[1]).toHaveTextContent("Primary main");
    });

    test("uses sortable buttons and aria-sort while keeping primary main first", async () => {
        const user = userEvent.setup();
        render(
            <GatewaySessionsView
                onAction={(action, row) => Promise.resolve(actionResult(action, row.key))}
                snapshot={snapshot()}
            />
        );
        const table = screen.getByRole("table", { name: "Current OpenClaw sessions" });
        expect(within(table).getByRole("columnheader", { name: "Type" })).toHaveAttribute(
            "aria-sort",
            "ascending"
        );

        await user.click(
            within(table).getByRole("button", {
                name: "Sort by Session ascending",
            })
        );
        expect(
            within(table).getByRole("columnheader", { name: "Session" })
        ).toHaveAttribute("aria-sort", "ascending");
        await user.click(
            within(table).getByRole("button", {
                name: "Sort by Session descending",
            })
        );
        const rows = within(table).getAllByRole("row");
        expect(rows[1]).toHaveTextContent("Primary main");
        expect(rows[2]).toHaveTextContent("Startup hook");
    });

    test("applies the exact ALL MAIN SUBAGENT HOOK CRON filters locally", async () => {
        const user = userEvent.setup();
        render(
            <GatewaySessionsView
                onAction={(action, row) => Promise.resolve(actionResult(action, row.key))}
                snapshot={snapshot()}
            />
        );
        const filter = screen.getByRole("group", { name: "Session type filter" });
        expect(
            within(filter)
                .getAllByRole("button")
                .map(({ textContent }) => textContent)
        ).toEqual(["ALL", "MAIN", "SUBAGENT", "HOOK", "CRON"]);

        await user.click(within(filter).getByRole("button", { name: "CRON" }));
        expect(within(filter).getByRole("button", { name: "CRON" })).toHaveAttribute(
            "aria-pressed",
            "true"
        );
        const table = screen.getByRole("table", { name: "Current OpenClaw sessions" });
        expect(within(table).getByText("Daily cron")).toBeTruthy();
        expect(within(table).queryByText("Primary main")).toBeNull();
    });

    test("disables primary transcript deletion and confirms a generation-fenced delete", async () => {
        const user = userEvent.setup();
        render(
            <GatewaySessionsView
                onAction={(action, row) => Promise.resolve(actionResult(action, row.key))}
                snapshot={snapshot()}
            />
        );
        expect(
            screen.getByRole("button", {
                name: `Delete Primary main transcript unavailable for the primary main session; key ${gatewayPrimarySessionKey}`,
            })
        ).toBeDisabled();
        const trigger = screen.getByRole("button", {
            name: "Delete Daily cron transcript; key cron:daily",
        });
        await user.click(trigger);
        const dialog = screen.getByRole("dialog", {
            name: "Delete session transcript?",
        });
        expect(dialog).toHaveTextContent("and its OpenClaw transcript");
        expect(dialog).toHaveTextContent("cannot be undone");

        await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
        await waitFor(() => expect(document.activeElement).toBe(trigger));
    });

    test("retains unknown session kinds under ALL and shows unknown activity", () => {
        const unknown = session(
            "provider:new-kind",
            "unknown",
            "Provider session",
            timestampMs,
            { updatedAtMs: undefined }
        );
        render(
            <GatewaySessionsView
                onAction={(action, row) => Promise.resolve(actionResult(action, row.key))}
                snapshot={snapshot({
                    sessions: [...sessions, unknown],
                    stats: deriveGatewaySessionStats([...sessions, unknown], timestampMs),
                })}
            />
        );

        const table = screen.getByRole("table", { name: "Current OpenClaw sessions" });
        const row = within(table).getByText("Provider session").closest("tr");
        expect(row).not.toBeNull();
        if (row === null) throw new Error("Missing unknown session row");
        expect(row).toHaveTextContent("Unknown");
    });

    test("marks non-fresh token usage explicitly and includes known context", () => {
        const staleTokens = session(
            "agent:main:subagent:stale",
            "subagent",
            "Stale token session",
            timestampMs,
            {
                contextTokens: 200_000,
                totalTokensFresh: false,
            }
        );
        render(
            <GatewaySessionsView
                onAction={(action, row) => Promise.resolve(actionResult(action, row.key))}
                snapshot={snapshot({
                    sessions: [staleTokens],
                    stats: deriveGatewaySessionStats([staleTokens], timestampMs),
                })}
            />
        );

        expect(
            screen.getByText(
                `~${new Intl.NumberFormat().format(1200)} / ${new Intl.NumberFormat().format(200_000)} (last known)`
            )
        ).toBeTruthy();
    });

    test("runs the confirmed exact action and reports success without raw errors", async () => {
        const user = userEvent.setup();
        const onAction = jest.fn((action: GatewaySessionAction, row: GatewaySession) =>
            Promise.resolve(actionResult(action, row.key))
        );
        render(<GatewaySessionsView onAction={onAction} snapshot={snapshot()} />);
        const trigger = screen.getByRole("button", {
            name: `Summarize Primary main; key ${gatewayPrimarySessionKey}`,
        });
        await user.click(trigger);
        const dialog = screen.getByRole("dialog", {
            name: "Summarize older context?",
        });
        await user.click(
            within(dialog).getByRole("button", { name: "Summarize session" })
        );

        await waitFor(() =>
            expect(onAction).toHaveBeenCalledWith("compact", sessions[0])
        );
        expect(await screen.findByText("Older session context summarized.")).toBeTruthy();
        expect(
            screen.queryByRole("dialog", { name: "Summarize older context?" })
        ).toBeNull();
        expect(onAction).toHaveBeenCalledTimes(1);
        await waitFor(() => expect(document.activeElement).toBe(trigger));
    });

    test("marks last-known-good data separately from an initial unavailable state", () => {
        render(
            <GatewaySessionsView
                onAction={(action, row) => Promise.resolve(actionResult(action, row.key))}
                snapshot={snapshot({
                    source: {
                        checkedAtMs: timestampMs + 10_000,
                        connection: "disconnected",
                        freshness: "stale",
                        observedAtMs: timestampMs,
                    },
                })}
            />
        );

        expect(screen.getByText("Last known")).toBeTruthy();
        expect(screen.getByRole("alert")).toHaveTextContent("Showing session data from");
        expect(
            screen.getByRole("table", { name: "Current OpenClaw sessions" })
        ).toBeTruthy();
    });
});
