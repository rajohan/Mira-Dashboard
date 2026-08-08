import type { Meta, StoryObj } from "@storybook/tanstack-react";
import { expect, fn, userEvent, within } from "storybook/test";

import type { NotificationRecord } from "../../../contracts/monitoring.ts";
import { NotificationListItem } from "../NotificationListItem.tsx";

const timestampMs = 1_800_000_000_000;

const unreadNotification = Object.freeze({
    id: "019fe500-0000-7000-8000-000000000002",
    incidentGeneration: 2,
    incidentId: "019fe400-0000-7000-8000-000000000002",
    kind: "cache",
    message: "The latest refresh failed and the last-known-good value is stale.",
    occurredAtMs: timestampMs,
    severity: "warning",
    source: "cache.freshness",
    title: "Cache refresh failed",
} satisfies NotificationRecord);

const meta = {
    args: {
        actionsDisabled: false,
        itemRef: null,
        notification: unreadNotification,
        onDelete: fn(),
        onMarkRead: fn(),
    },
    component: NotificationListItem,
    decorators: [
        (Story) => (
            <ul className="w-full max-w-2xl">
                <Story />
            </ul>
        ),
    ],
    parameters: {
        layout: "padded",
    },
    title: "Notifications/NotificationListItem",
} satisfies Meta<typeof NotificationListItem>;

export default meta;

type Story = StoryObj<typeof meta>;

export const UnreadIncident: Story = {
    play: async ({ args, canvasElement }) => {
        await userEvent.click(
            within(canvasElement).getByRole("button", {
                name: /^Mark Cache refresh failed read/u,
            })
        );
        await expect(args.onMarkRead).toHaveBeenCalledWith(unreadNotification.id);
    },
};

export const ReadReport: Story = {
    args: {
        notification: {
            id: "019fe500-0000-7000-8000-000000000001",
            kind: "daily-summary",
            message: "The scheduled report completed without actionable findings.",
            occurredAtMs: timestampMs - 3_600_000,
            readAtMs: timestampMs - 3_000_000,
            reportId: "019fe600-0000-7000-8000-000000000001",
            severity: "info",
            source: "daily-summary",
            title: "Daily summary ready",
        },
    },
};

export const ActionsDisabled: Story = {
    args: {
        actionsDisabled: true,
        notification: {
            ...unreadNotification,
            severity: "error",
        },
    },
};
