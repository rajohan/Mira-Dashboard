import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, jest, mock } from "bun:test";

import { hoisted } from "../../test/testUtils";
import { NotificationBell } from "./NotificationBell";

const hooks = hoisted(() => ({
    clearRead: jest.fn(),
    deleteNotification: jest.fn(),
    markAllRead: jest.fn(),
    markNotificationRead: jest.fn(),
    useClearReadNotifications: jest.fn(),
    useDeleteNotification: jest.fn(),
    useMarkAllNotificationsRead: jest.fn(),
    useMarkNotificationRead: jest.fn(),
    useNotifications: jest.fn(),
}));

mock.module("../../hooks", () => ({
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
            readCount: 1,
            unreadCount: 1,
        },
    });
});

describe("NotificationBell", () => {
    it("renders notifications, filters them, and invokes actions", async () => {
        const user = userEvent.setup();

        render(<NotificationBell />);

        expect(screen.getByText("1")).toBeInTheDocument();
        await user.click(
            screen.getByRole("button", {
                name: "Open notifications, 1 unread",
            })
        );

        expect(screen.getByText("Backup stale")).toBeInTheDocument();
        expect(screen.getByText("Cache refreshed")).toBeInTheDocument();
        expect(screen.getByRole("menuitemradio", { name: "All" })).toHaveAttribute(
            "aria-checked",
            "true"
        );

        await user.click(screen.getByRole("menuitemradio", { name: "Unread" }));
        expect(screen.getByRole("menuitemradio", { name: "Unread" })).toHaveAttribute(
            "aria-checked",
            "true"
        );
        expect(screen.getByText("Backup stale")).toBeInTheDocument();
        expect(screen.queryByText("Cache refreshed")).not.toBeInTheDocument();

        await user.click(screen.getByRole("menuitemradio", { name: "Warning" }));
        expect(screen.getByRole("menuitemradio", { name: "Warning" })).toHaveAttribute(
            "aria-checked",
            "true"
        );
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

        await user.click(screen.getByRole("button", { name: "Open notifications" }));

        expect(screen.getByText("No notifications for this filter.")).toBeInTheDocument();
        expect(screen.getByText("Clear read").closest("button")).toBeDisabled();
        expect(screen.getByText("Mark all read").closest("button")).toBeDisabled();
    });

    it("disables clear read until at least one notification is read", async () => {
        const user = userEvent.setup();
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
                ],
                readCount: 0,
                unreadCount: 1,
            },
        });

        render(<NotificationBell />);

        await user.click(
            screen.getByRole("button", {
                name: "Open notifications, 1 unread",
            })
        );

        expect(screen.getByText("Clear read").closest("button")).toBeDisabled();
        expect(screen.getByText("Mark all read").closest("button")).toBeEnabled();
    });

    it("disables mark all read after every notification is already read", async () => {
        const user = userEvent.setup();
        hooks.useNotifications.mockReturnValue({
            data: {
                items: [
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
                readCount: 1,
                unreadCount: 0,
            },
        });

        render(<NotificationBell />);

        await user.click(screen.getByRole("button", { name: "Open notifications" }));

        expect(screen.getByText("Clear read").closest("button")).toBeEnabled();
        expect(screen.getByText("Mark all read").closest("button")).toBeDisabled();
    });

    it("enables clear read when older read notifications are outside the page", async () => {
        const user = userEvent.setup();
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
                ],
                readCount: 4,
                unreadCount: 1,
            },
        });

        render(<NotificationBell />);

        await user.click(
            screen.getByRole("button", {
                name: "Open notifications, 1 unread",
            })
        );

        expect(screen.getByText("Clear read").closest("button")).toBeEnabled();
    });

    it("falls back to created time when notification occurred time is invalid", async () => {
        const user = userEvent.setup();
        hooks.useNotifications.mockReturnValue({
            data: {
                items: [
                    {
                        createdAt: "2026-05-10T12:00:00.000Z",
                        dedupeKey: null,
                        description: "Malformed event time",
                        id: 3,
                        isRead: false,
                        metadata: {},
                        occurredAt: "not-a-date",
                        source: null,
                        title: "Recovered timestamp",
                        type: "warning",
                        updatedAt: "2026-05-10T12:00:00.000Z",
                    },
                    {
                        createdAt: "2026-05-10T08:00:00.000Z",
                        dedupeKey: null,
                        description: "Older valid event",
                        id: 4,
                        isRead: false,
                        metadata: {},
                        occurredAt: "2026-05-10T08:00:00.000Z",
                        source: null,
                        title: "Older notification",
                        type: "info",
                        updatedAt: "2026-05-10T08:00:00.000Z",
                    },
                ],
                readCount: 0,
                unreadCount: 2,
            },
        });

        render(<NotificationBell />);

        await user.click(
            screen.getByRole("button", {
                name: "Open notifications, 2 unread",
            })
        );

        expect(screen.queryByText("Invalid Date")).not.toBeInTheDocument();
        expect(screen.queryByText("not-a-date")).not.toBeInTheDocument();
        expect(screen.getAllByText(/10\.05\.2026/u).length).toBeGreaterThan(0);

        const titles = screen
            .getAllByText(/Recovered timestamp|Older notification/u)
            .map((element) => element.textContent);
        expect(titles).toEqual(["Recovered timestamp", "Older notification"]);
    });

    it("renders unknown time when notification timestamps are invalid", async () => {
        const user = userEvent.setup();
        hooks.useNotifications.mockReturnValue({
            data: {
                items: [
                    {
                        createdAt: "also-not-a-date",
                        dedupeKey: null,
                        description: "Malformed event and created times",
                        id: 5,
                        isRead: false,
                        metadata: {},
                        occurredAt: "not-a-date",
                        source: null,
                        title: "Unknown timestamp",
                        type: "warning",
                        updatedAt: "also-not-a-date",
                    },
                ],
                readCount: 0,
                unreadCount: 1,
            },
        });

        render(<NotificationBell />);

        await user.click(
            screen.getByRole("button", {
                name: "Open notifications, 1 unread",
            })
        );

        expect(screen.getByText("Unknown timestamp")).toBeInTheDocument();
        expect(screen.getByText("Unknown time")).toBeInTheDocument();
        expect(screen.queryByText("Invalid Date")).not.toBeInTheDocument();
    });
});
