import type { Meta, StoryObj } from "@storybook/tanstack-react";
import { expect, within } from "storybook/test";

import type { NotificationRecord } from "../../../contracts/monitoring.ts";
import type { ListNotificationsResult } from "../../../contracts/notifications.ts";
import { OverviewNotificationsCard } from "../OverviewNotificationsCard.tsx";

const timestampMs = 1_800_000_000_000;
const latestNotification = Object.freeze({
    id: "019fe300-0000-7000-8000-000000000041",
    kind: "heartbeat",
    message: "One reviewed operational warning needs attention.",
    occurredAtMs: timestampMs,
    reportId: "019fe300-0000-7000-8000-000000000040",
    severity: "warning",
    source: "monitor",
    title: "Operational warning",
} as const satisfies NotificationRecord);
const result = Object.freeze({
    nextCursor: {
        id: "019fe300-0000-7000-8000-000000000041",
        occurredAtMs: timestampMs,
    },
    notifications: [latestNotification],
    readCount: 8,
    unreadCount: 3,
} satisfies ListNotificationsResult);

const meta = {
    args: { result },
    component: OverviewNotificationsCard,
    parameters: { layout: "padded" },
    title: "Overview/OverviewNotificationsCard",
} satisfies Meta<typeof OverviewNotificationsCard>;

export default meta;

type Story = StoryObj<typeof meta>;

export const LatestUnread: Story = {
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement);
        await expect(
            canvas.getByRole("heading", { name: "Notifications" })
        ).toBeVisible();
        await expect(canvas.getByText("Operational warning")).toBeVisible();
        await expect(canvas.getByRole("link", { name: "Open report" })).toHaveAttribute(
            "href",
            "/reports?reportId=019fe300-0000-7000-8000-000000000040"
        );
    },
};

export const Empty: Story = {
    args: { result: { notifications: [], readCount: 0, unreadCount: 0 } },
    play: async ({ canvasElement }) => {
        await expect(within(canvasElement).getByText("No notifications.")).toBeVisible();
    },
};

export const ReadLatest: Story = {
    args: {
        result: {
            ...result,
            notifications: [
                {
                    ...latestNotification,
                    readAtMs: timestampMs + 1000,
                },
            ],
            readCount: 9,
            unreadCount: 2,
        },
    },
    play: async ({ canvasElement }) => {
        await expect(within(canvasElement).getByText("read")).toBeVisible();
    },
};
