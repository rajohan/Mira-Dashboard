import { describe, expect, test } from "bun:test";

import type { ListNotificationsResult } from "../../contracts/notifications.ts";
import { formatDashboardDateTime } from "../lib/formatDateTime.ts";
import { OverviewNotificationsCard } from "./OverviewNotificationsCard.tsx";

const { render, screen, within } = await import("@testing-library/react");

const timestampMs = 1_800_000_000_000;
const result = Object.freeze({
    nextCursor: {
        id: "019fe300-0000-7000-8000-000000000041",
        occurredAtMs: timestampMs,
    },
    notifications: [
        {
            id: "019fe300-0000-7000-8000-000000000041",
            kind: "heartbeat",
            message: "One reviewed operational warning needs attention.",
            occurredAtMs: timestampMs,
            reportId: "019fe300-0000-7000-8000-000000000040",
            severity: "warning",
            source: "monitor",
            title: "Operational warning",
        },
    ],
    readCount: 8,
    unreadCount: 3,
} satisfies ListNotificationsResult);

function metric(label: string): HTMLElement {
    const container = screen.getByText(label).closest("div");
    if (!(container instanceof HTMLElement)) {
        throw new TypeError(`Missing ${label} metric`);
    }
    return container;
}

describe("OverviewNotificationsCard", () => {
    test("separates exact global counts from the bounded newest window", () => {
        render(<OverviewNotificationsCard result={result} />);

        expect(
            screen.getByRole("heading", { level: 2, name: "Notifications" })
        ).toBeTruthy();
        expect(within(metric("Unread")).getByText("3")).toBeTruthy();
        expect(within(metric("Read")).getByText("8")).toBeTruthy();
        expect(within(metric("Newest 100")).getByText("1")).toBeTruthy();
        expect(screen.getByText("Operational warning")).toBeTruthy();
        expect(screen.getByText("warning")).toBeTruthy();
        expect(screen.getByText("unread")).toBeTruthy();
        expect(screen.getByText(formatDashboardDateTime(timestampMs))).toHaveAttribute(
            "dateTime",
            new Date(timestampMs).toISOString()
        );
        expect(screen.getByRole("link", { name: "Open report" })).toHaveAttribute(
            "href",
            "/reports?reportId=019fe300-0000-7000-8000-000000000040"
        );
        expect(screen.getByText(/Older notifications are available/u)).toBeTruthy();
        expect(screen.queryByRole("button")).toBeNull();
    });

    test("renders exact zero counts without inventing a notification total", () => {
        render(
            <OverviewNotificationsCard
                result={{ notifications: [], readCount: 0, unreadCount: 0 }}
            />
        );

        expect(screen.getByText("No notifications.")).toBeTruthy();
        expect(within(metric("Unread")).getByText("0")).toBeTruthy();
        expect(within(metric("Newest 100")).getByText("0")).toBeTruthy();
        expect(screen.queryByText(/Older notifications/u)).toBeNull();
    });
});
