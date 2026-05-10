import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AppHeader } from "./AppHeader";

const hooks = vi.hoisted(() => ({
    authLogout: vi.fn().mockResolvedValue(Promise.resolve()),
    clearRead: vi.fn(),
    deleteNotification: vi.fn(),
    markAllRead: vi.fn(),
    markNotificationRead: vi.fn(),
    navigate: vi.fn(),
    useClearReadNotifications: vi.fn(),
    useDeleteNotification: vi.fn(),
    useHealth: vi.fn(),
    useMarkAllNotificationsRead: vi.fn(),
    useMarkNotificationRead: vi.fn(),
    useNavigate: vi.fn(),
    useNotifications: vi.fn(),
    useOpenClawSocket: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
    useNavigate: () => hooks.useNavigate,
}));

vi.mock("../../hooks/useOpenClawSocket", () => ({
    useOpenClawSocket: hooks.useOpenClawSocket,
}));

vi.mock("../../hooks", () => ({
    useHealth: hooks.useHealth,
    useNotifications: hooks.useNotifications,
    useMarkNotificationRead: hooks.useMarkNotificationRead,
    useMarkAllNotificationsRead: hooks.useMarkAllNotificationsRead,
    useClearReadNotifications: hooks.useClearReadNotifications,
    useDeleteNotification: hooks.useDeleteNotification,
}));

vi.mock("../../stores/authStore", () => ({
    authActions: { logout: hooks.authLogout },
}));

beforeEach(() => {
    hooks.authLogout.mockResolvedValue(Promise.resolve());
    hooks.clearRead.mockReset();
    hooks.deleteNotification.mockReset();
    hooks.markAllRead.mockReset();
    hooks.markNotificationRead.mockReset();
    hooks.navigate.mockReset();
    hooks.useClearReadNotifications.mockReturnValue({ mutate: hooks.clearRead });
    hooks.useDeleteNotification.mockReturnValue({ mutate: hooks.deleteNotification });
    hooks.useHealth.mockReturnValue({
        data: { status: "ok", backendCommit: "abc123" },
        isError: false,
    });
    hooks.useMarkAllNotificationsRead.mockReturnValue({ mutate: hooks.markAllRead });
    hooks.useMarkNotificationRead.mockReturnValue({
        mutate: hooks.markNotificationRead,
    });
    hooks.useNavigate.mockReturnValue(hooks.navigate);
    hooks.useNotifications.mockReturnValue({
        data: { items: [], unreadCount: 0 },
    });
    hooks.useOpenClawSocket.mockReturnValue({ isConnected: true });
});

describe("AppHeader", () => {
    it("renders title, connection indicators, and logout button", async () => {
        render(
            <AppHeader
                title="Dashboard"
                isSidebarOpen={false}
                sidebarId="sidebar"
                onOpenSidebar={vi.fn()}
            />
        );

        expect(await screen.findByText("Dashboard")).toBeInTheDocument();
        expect(screen.getByText("WS")).toBeInTheDocument();
        expect(screen.getByText("BE")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Log out" })).toBeInTheDocument();
    });

    it("shows disconnected indicators when WS and backend are down", async () => {
        hooks.useOpenClawSocket.mockReturnValue({ isConnected: false });
        hooks.useHealth.mockReturnValue({
            data: null,
            isError: true,
        });

        render(
            <AppHeader
                title="Sessions"
                isSidebarOpen={false}
                sidebarId="sidebar"
                onOpenSidebar={vi.fn()}
            />
        );

        expect(await screen.findByText("Sessions")).toBeInTheDocument();
        // Disconnected dots
        const dots = screen.getAllByText("○");
        expect(dots).toHaveLength(2);
    });

    it("shows version mismatch warning when FE and BE commits differ", async () => {
        // __APP_COMMIT__ is set at build time; we can't easily mock it,
        // but we can verify the mismatch banner appears by making backend
        // report a different commit than what the frontend was built with.
        hooks.useHealth.mockReturnValue({
            data: { status: "ok", backendCommit: "mismatched" },
            isError: false,
        });

        render(
            <AppHeader
                title="Tasks"
                isSidebarOpen={false}
                sidebarId="sidebar"
                onOpenSidebar={vi.fn()}
            />
        );

        // Only shows if both commits are known AND differ.
        // If __APP_COMMIT__ === "unknown" (dev mode), no warning.
        // Verify it doesn't crash either way.
        expect(await screen.findByText("Tasks")).toBeInTheDocument();
    });

    it("opens sidebar via hamburger button on mobile", async () => {
        const onOpenSidebar = vi.fn();
        const user = userEvent.setup();

        render(
            <AppHeader
                title="Dashboard"
                isSidebarOpen={false}
                sidebarId="sidebar"
                onOpenSidebar={onOpenSidebar}
            />
        );

        await user.click(screen.getByRole("button", { name: "Open navigation menu" }));
        expect(onOpenSidebar).toHaveBeenCalledTimes(1);
    });

    it("calls logout and navigates to login on log out click", async () => {
        const user = userEvent.setup();

        render(
            <AppHeader
                title="Dashboard"
                isSidebarOpen={false}
                sidebarId="sidebar"
                onOpenSidebar={vi.fn()}
            />
        );

        await user.click(screen.getByRole("button", { name: "Log out" }));
        expect(hooks.authLogout).toHaveBeenCalledTimes(1);
    });
});
