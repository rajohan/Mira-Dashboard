import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { NotificationBell } from "./NotificationBell";

const hooks = vi.hoisted(() => ({
    clearRead: vi.fn(),
    deleteNotification: vi.fn(),
    markAllRead: vi.fn(),
    markNotificationRead: vi.fn(),
    useClearReadNotifications: vi.fn(),
    useDeleteNotification: vi.fn(),
    useMarkAllNotificationsRead: vi.fn(),
    useMarkNotificationRead: vi.fn(),
    useNotifications: vi.fn(),
}));

vi.mock("../../hooks", () => ({
    useClearReadNotifications: hooks.useClearReadNotifications,
    useDeleteNotification: hooks.useDeleteNotification,
    useMarkAllNotificationsRead: hooks.useMarkAllNotificationsRead,
    useMarkNotificationRead: hooks.useMarkNotificationRead,
    useNotifications: hooks.useNotifications,
}));

beforeEach(() => {
    hooks.clearRead.mockReset();
    hooks.deleteNotification.mockReset();
    hooks.markAllRead.mockReset();
    hooks.markNotificationRead.mockReset();
    hooks.useClearReadNotifications.mockReturnValue({ mutate: hooks.clearRead });
    hooks.useDeleteNotification.mockReturnValue({ mutate: hooks.deleteNotification });
    hooks.useMarkAllNotificationsRead.mockReturnValue({ mutate: hooks.markAllRead });
    hooks.useMarkNotificationRead.mockReturnValue({
        mutate: hooks.markNotificationRead,
    });
    hooks.useNotifications.mockReturnValue({
        data: {
            items: [
                {
                    createdAt: "2026-05-10T09:00:00.000Z",
                    dedupeKey: null,
                    description: "A warning notification",
                    id: 1,
                    isRead: false,
                    metadata: {},
                    occurredAt: "2026-05-10T10:00:00.000Z",
                    source: null,
                    title: "Backup stale",
                    type: "warning",
                    updatedAt: "2026-05-10T09:00:00.000Z",
                },
                {
                    createdAt: "2026-05-10T08:00:00.000Z",
                    dedupeKey: null,
                    description: "An info notification",
                    id: 2,
                    isRead: true,
                    metadata: {},
                    occurredAt: "2026-05-10T08:00:00.000Z",
                    source: null,
                    title: "Cache refreshed",
                    type: "info",
                    updatedAt: "2026-05-10T08:00:00.000Z",
                },
            ],
            unreadCount: 1,
        },
    });
});

describe("NotificationBell", () => {
    it("renders notifications, filters them, and invokes actions", async () => {
        const user = userEvent.setup();

        render(<NotificationBell />);

        expect(screen.getByText("1")).toBeInTheDocument();
        await user.click(screen.getByRole("button"));

        expect(screen.getByText("Backup stale")).toBeInTheDocument();
        expect(screen.getByText("Cache refreshed")).toBeInTheDocument();

        await user.click(screen.getByText("Unread"));
        expect(screen.getByText("Backup stale")).toBeInTheDocument();
        expect(screen.queryByText("Cache refreshed")).not.toBeInTheDocument();

        await user.click(screen.getByText("Warning"));
        expect(screen.getByText("Backup stale")).toBeInTheDocument();

        await user.click(screen.getByText("Mark read"));
        await user.click(screen.getByText("Mark all read"));
        await user.click(screen.getByText("Clear read"));
        await user.click(screen.getAllByText("Clear")[0]);

        expect(hooks.markNotificationRead).toHaveBeenCalledWith(1);
        expect(hooks.markAllRead).toHaveBeenCalledTimes(1);
        expect(hooks.clearRead).toHaveBeenCalledTimes(1);
        expect(hooks.deleteNotification).toHaveBeenCalledWith(1);
    });

    it("renders empty filtered state and disables bulk actions without notifications", async () => {
        const user = userEvent.setup();
        hooks.useNotifications.mockReturnValue({ data: undefined });

        render(<NotificationBell />);

        await user.click(screen.getByRole("button"));

        expect(screen.getByText("No notifications for this filter.")).toBeInTheDocument();
        expect(screen.getByText("Clear read").closest("button")).toBeDisabled();
        expect(screen.getByText("Mark all read").closest("button")).toBeDisabled();
    });
});
