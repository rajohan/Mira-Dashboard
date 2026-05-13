import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { Layout } from "./Layout";

const hooks = vi.hoisted(() => ({
    authLogout: vi.fn().mockResolvedValue(Promise.resolve()),
    clearRead: vi.fn(),
    deleteNotification: vi.fn(),
    markAllRead: vi.fn(),
    markNotificationRead: vi.fn(),
    useCacheEntry: vi.fn(),
    useClearReadNotifications: vi.fn(),
    useDeleteNotification: vi.fn(),
    useHealth: vi.fn(),
    useLocation: vi.fn(),
    useMarkAllNotificationsRead: vi.fn(),
    useMarkNotificationRead: vi.fn(),
    useNavigate: vi.fn(),
    useNotifications: vi.fn(),
    useOpenClawSocket: vi.fn(),
    usePullRequests: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
    Link: ({
        to,
        children,
        className,
    }: {
        to: string;
        children: React.ReactNode;
        className?: string;
    }) => (
        <a href={to} className={className} data-testid="nav-link">
            {children}
        </a>
    ),
    useLocation: () => hooks.useLocation(),
    useNavigate: () => hooks.useNavigate,
}));

vi.mock("../../hooks/useOpenClawSocket", () => ({
    useOpenClawSocket: hooks.useOpenClawSocket,
}));

vi.mock("../../hooks", () => ({
    useHealth: hooks.useHealth,
    useCacheEntry: hooks.useCacheEntry,
    useNotifications: hooks.useNotifications,
    usePullRequests: hooks.usePullRequests,
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
    hooks.useCacheEntry.mockReturnValue({ data: null });
    hooks.useClearReadNotifications.mockReturnValue({ mutate: hooks.clearRead });
    hooks.useDeleteNotification.mockReturnValue({ mutate: hooks.deleteNotification });
    hooks.useHealth.mockReturnValue({
        data: { status: "ok", backendCommit: "abc123" },
        isError: false,
    });
    hooks.useLocation.mockReturnValue({ pathname: "/" });
    hooks.useMarkAllNotificationsRead.mockReturnValue({ mutate: hooks.markAllRead });
    hooks.useMarkNotificationRead.mockReturnValue({
        mutate: hooks.markNotificationRead,
    });
    hooks.useNavigate.mockReturnValue(vi.fn());
    hooks.useNotifications.mockReturnValue({
        data: { items: [], unreadCount: 0 },
    });
    hooks.useOpenClawSocket.mockReturnValue({ isConnected: true });
    hooks.usePullRequests.mockReturnValue({ data: [] });
});

describe("Layout", () => {
    it("renders sidebar navigation and marks active route", async () => {
        hooks.useLocation.mockReturnValue({ pathname: "/tasks" });

        render(
            <Layout>
                <p>Page content</p>
            </Layout>
        );

        expect(await screen.findByText("Page content")).toBeInTheDocument();
        expect(screen.getByText("Mira Dashboard")).toBeInTheDocument();

        // Active link styling
        const navLinks = screen.getAllByTestId("nav-link");
        const tasksLink = navLinks.find((link) => link.getAttribute("href") === "/tasks");
        expect(tasksLink).toBeTruthy();
        expect(tasksLink!.className).toContain("bg-accent-500");
    });

    it("shows pull request count badges for active and inactive PR routes", async () => {
        hooks.usePullRequests.mockReturnValue({ data: [{ number: 1 }, { number: 2 }] });
        hooks.useLocation.mockReturnValue({ pathname: "/tasks" });

        const { rerender } = render(
            <Layout>
                <p>Content</p>
            </Layout>
        );

        expect(await screen.findByText("2")).toHaveClass("bg-accent-500/20");

        hooks.useLocation.mockReturnValue({ pathname: "/pull-requests" });
        rerender(
            <Layout>
                <p>Content</p>
            </Layout>
        );

        expect(screen.getByText("2")).toHaveClass("bg-white/20");
    });

    it("falls back to the dashboard title for unknown routes", async () => {
        hooks.useLocation.mockReturnValue({ pathname: "/unknown" });

        render(
            <Layout>
                <p>Content</p>
            </Layout>
        );

        expect(
            await screen.findByRole("heading", { name: "Mira Dashboard" })
        ).toBeInTheDocument();
    });

    it("shows OpenClaw version from system.host cache", async () => {
        hooks.useCacheEntry.mockReturnValue({
            data: { data: { version: { current: "2026.5.4" } } },
        });

        render(
            <Layout>
                <p>Content</p>
            </Layout>
        );

        expect(await screen.findByText("v2026.5.4")).toBeInTheDocument();
    });

    it("shows version unknown when cache has no version data", async () => {
        hooks.useCacheEntry.mockReturnValue({ data: null });

        render(
            <Layout>
                <p>Content</p>
            </Layout>
        );

        expect(await screen.findByText("Version unknown")).toBeInTheDocument();
    });

    it("toggles mobile sidebar open and closed", async () => {
        const user = userEvent.setup();

        render(
            <Layout>
                <p>Content</p>
            </Layout>
        );

        // Open sidebar via hamburger
        await user.click(screen.getByRole("button", { name: "Open navigation menu" }));

        // Close via X button inside sidebar.
        let closeButtons = screen.getAllByRole("button", {
            name: "Close navigation menu",
        });
        await user.click(closeButtons[0]);

        await user.click(screen.getByRole("button", { name: "Open navigation menu" }));

        // Close via overlay on mobile.
        closeButtons = screen.getAllByRole("button", {
            name: "Close navigation menu",
        });
        await user.click(closeButtons.at(-1)!);
    });
});
