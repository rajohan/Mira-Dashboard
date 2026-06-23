import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, jest } from "bun:test";
import { createElement, type ReactNode } from "react";

import { NotificationBell } from "./components/layout/NotificationBell";
import { apiFetch, UnauthorizedError } from "./hooks/useApi";
import type { NotificationItem } from "./hooks/useNotifications";
import { handleSocketMessage } from "./lib/socket/socketMessageRouter";
import { Tasks } from "./pages/Tasks";
import { authActions, authStore } from "./stores/authStore";
import type { Task } from "./types/task";
import { getColumnId, getPriority, isTaskMatchSearch } from "./utils/taskUtilities";

function task(overrides: Partial<Task> & Pick<Task, "number" | "title">): Task {
    return {
        number: overrides.number,
        title: overrides.title,
        body: overrides.body ?? "",
        state: overrides.state ?? "OPEN",
        labels: overrides.labels ?? [],
        assignees: overrides.assignees ?? [{ login: "mira-2026", name: "Mira" }],
        createdAt: overrides.createdAt ?? "2026-06-19T08:00:00.000Z",
        updatedAt: overrides.updatedAt ?? "2026-06-19T08:00:00.000Z",
        url: overrides.url ?? `/tasks/${overrides.number}`,
        automation: overrides.automation,
    };
}

function createApi(tasks: Task[]) {
    return jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";

        if (url === "/api/tasks" && method === "GET") {
            return Response.json(tasks);
        }

        if (url === "/api/tasks" && method === "POST") {
            const payload = JSON.parse(String(init?.body ?? "{}")) as {
                title: string;
                body: string;
                labels: string[];
                assignee: string;
            };
            const created = task({
                number: tasks.length + 1,
                title: payload.title,
                body: payload.body,
                labels: payload.labels.map((name) => ({ name })),
                assignees: [{ login: payload.assignee, name: payload.assignee }],
                updatedAt: "2026-06-19T09:00:00.000Z",
            });
            tasks.unshift(created);
            return Response.json(created, { status: 201 });
        }

        throw new Error(`Unexpected frontend API call: ${method} ${url}`);
    });
}

function notification(
    overrides: Partial<NotificationItem> & Pick<NotificationItem, "id" | "title">
): NotificationItem {
    return {
        id: overrides.id,
        title: overrides.title,
        description: overrides.description ?? "",
        type: overrides.type ?? "info",
        source: overrides.source,
        dedupeKey: overrides.dedupeKey,
        metadata: overrides.metadata ?? {},
        isRead: overrides.isRead ?? false,
        createdAt: overrides.createdAt ?? "2026-06-23T08:00:00.000Z",
        updatedAt: overrides.updatedAt ?? "2026-06-23T08:00:00.000Z",
        occurredAt: overrides.occurredAt ?? "2026-06-23T08:00:00.000Z",
    };
}

function createNotificationsApi(notifications: NotificationItem[]) {
    return jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";

        if (url === "/api/notifications" && method === "GET") {
            return Response.json({
                items: notifications,
                readCount: notifications.filter((item) => item.isRead).length,
                unreadCount: notifications.filter((item) => !item.isRead).length,
            });
        }

        const markReadMatch = /^\/api\/notifications\/(\d+)\/read$/u.exec(url);
        if (markReadMatch && method === "POST") {
            const id = Number(markReadMatch[1]);
            notifications.splice(
                0,
                notifications.length,
                ...notifications.map((item) =>
                    item.id === id ? { ...item, isRead: true } : item
                )
            );
            return Response.json({ isOk: true });
        }

        if (url === "/api/notifications/mark-all-read" && method === "POST") {
            notifications.splice(
                0,
                notifications.length,
                ...notifications.map((item) => ({ ...item, isRead: true }))
            );
            return Response.json({ isOk: true });
        }

        if (url === "/api/notifications/clear-read" && method === "POST") {
            const before = notifications.length;
            notifications.splice(
                0,
                notifications.length,
                ...notifications.filter((item) => !item.isRead)
            );
            return Response.json({ deleted: before - notifications.length, isOk: true });
        }

        const deleteMatch = /^\/api\/notifications\/(\d+)$/u.exec(url);
        if (deleteMatch && method === "DELETE") {
            const id = Number(deleteMatch[1]);
            const before = notifications.length;
            notifications.splice(
                0,
                notifications.length,
                ...notifications.filter((item) => item.id !== id)
            );
            return Response.json({ deleted: before - notifications.length, isOk: true });
        }

        throw new Error(`Unexpected notification API call: ${method} ${url}`);
    });
}

function getButtonByText(text: string, index = 0): HTMLButtonElement {
    const button = screen.getAllByText(text)[index]?.closest("button");
    if (!(button instanceof HTMLButtonElement)) {
        throw new TypeError(`Button not found for text: ${text}`);
    }
    return button;
}

function renderWithQueryClient(children: ReactNode) {
    const queryClient = new QueryClient({
        defaultOptions: {
            queries: { retry: false },
            mutations: { retry: false },
        },
    });

    const view = render(
        createElement(QueryClientProvider, { client: queryClient }, children)
    );

    return {
        ...view,
        queryClient,
    };
}

describe("Mira Dashboard frontend behavior", () => {
    beforeEach(() => {
        authActions.clearSession();
    });

    afterEach(() => {
        authActions.clearSession();
    });

    it("handles API authorization failures through the shared auth boundary", async () => {
        authActions.setSession({
            authenticated: true,
            isBootstrapRequired: false,
            user: { id: 1, username: "raymond" },
        });
        const unauthorizedEvents: Event[] = [];
        addEventListener("openclaw:unauthorized", (event) => {
            unauthorizedEvents.push(event);
        });
        Object.defineProperty(globalThis, "fetch", {
            configurable: true,
            value: jest.fn(async () =>
                Response.json({ error: "Unauthorized" }, { status: 401 })
            ),
            writable: true,
        });

        await expect(apiFetch("/tasks")).rejects.toBeInstanceOf(UnauthorizedError);

        expect(authStore.state.isAuthenticated).toBe(false);
        expect(unauthorizedEvents).toHaveLength(1);
    });

    it("parses successful, empty, and failed API responses consistently", async () => {
        const fetchMock = jest.fn(
            async (input: RequestInfo | URL, init?: RequestInit) => {
                const url = String(input);
                const method = init?.method ?? "GET";

                if (url === "/api/health" && method === "GET") {
                    return Response.json({ status: "isOk" });
                }

                if (url === "/api/restart" && method === "POST") {
                    return new Response(undefined, { status: 204 });
                }

                if (url === "/api/tasks" && method === "POST") {
                    return Response.json({ error: "title is required" }, { status: 400 });
                }

                if (url === "/api/broken" && method === "GET") {
                    return new Response("not-json", { status: 500 });
                }

                throw new Error(`Unexpected API call: ${method} ${url}`);
            }
        );
        Object.defineProperty(globalThis, "fetch", {
            configurable: true,
            value: fetchMock,
            writable: true,
        });

        await expect(apiFetch("/health")).resolves.toEqual({ status: "isOk" });
        await expect(apiFetch("/restart", { method: "POST" })).resolves.toBeUndefined();
        await expect(
            apiFetch("/tasks", { body: JSON.stringify({}), method: "POST" })
        ).rejects.toThrow("title is required");
        await expect(apiFetch("/broken")).rejects.toThrow("Unknown error");
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/health",
            expect.objectContaining({
                credentials: "include",
                headers: expect.objectContaining({ "Content-Type": "application/json" }),
            })
        );
    });

    it("routes socket messages into dashboard connection state", () => {
        expect(handleSocketMessage({})).toBeUndefined();
        expect(handleSocketMessage({ type: "state", gatewayConnected: false })).toBe(
            false
        );
        expect(handleSocketMessage({ type: "state" })).toBe(true);
        expect(handleSocketMessage({ type: "connected" })).toBe(true);
        expect(handleSocketMessage({ type: "disconnected" })).toBe(false);
        expect(
            handleSocketMessage({
                payload: { data: { sessions: [{ id: "session-1", key: "session-1" }] } },
                type: "response",
            })
        ).toBeUndefined();
        expect(
            handleSocketMessage({
                event: "agents.list",
                payload: [{ id: "mira-2026", status: "online" }],
                type: "event",
            })
        ).toBeUndefined();
        expect(
            handleSocketMessage({
                line: "2026-06-23T10:00:00.000Z info dashboard ready",
                type: "log",
            })
        ).toBeUndefined();
    });

    it("drives notification filtering and mutations through the bell menu", async () => {
        const notifications = [
            notification({
                id: 1,
                title: "Cache refresh failed",
                description: "Needs attention",
                type: "warning",
                occurredAt: "2026-06-23T10:00:00.000Z",
            }),
            notification({
                id: 2,
                title: "Backup complete",
                isRead: true,
                type: "success",
                occurredAt: "2026-06-23T09:00:00.000Z",
            }),
        ];
        const fetchMock = createNotificationsApi(notifications);
        Object.defineProperty(globalThis, "fetch", {
            configurable: true,
            value: fetchMock,
            writable: true,
        });
        const user = userEvent.setup();

        renderWithQueryClient(createElement(NotificationBell));

        await user.click(
            await screen.findByRole("button", {
                name: /open notifications, 1 unread/i,
            })
        );
        expect(await screen.findByText("Cache refresh failed")).toBeInTheDocument();
        expect(screen.getByText("Backup complete")).toBeInTheDocument();

        await user.click(screen.getByRole("menuitemradio", { name: "Unread" }));
        expect(screen.getByText("Cache refresh failed")).toBeInTheDocument();
        expect(screen.queryByText("Backup complete")).not.toBeInTheDocument();

        await user.click(getButtonByText("Mark read"));
        await waitFor(() =>
            expect(fetchMock).toHaveBeenCalledWith(
                "/api/notifications/1/read",
                expect.objectContaining({ method: "POST" })
            )
        );

        await user.click(screen.getByRole("menuitemradio", { name: "All" }));
        await waitFor(() =>
            expect(screen.getByText("Backup complete")).toBeInTheDocument()
        );

        await user.click(getButtonByText("Clear"));
        await waitFor(() =>
            expect(fetchMock).toHaveBeenCalledWith(
                "/api/notifications/1",
                expect.objectContaining({ method: "DELETE" })
            )
        );

        await user.click(getButtonByText("Clear read"));
        await waitFor(() =>
            expect(fetchMock).toHaveBeenCalledWith(
                "/api/notifications/clear-read",
                expect.objectContaining({ method: "POST" })
            )
        );
    });

    it("renders the task board from the API and creates a task through the real hooks", async () => {
        const tasks = [
            task({
                number: 1,
                title: "Ship Bun test reset",
                labels: [{ name: "priority-high" }, { name: "in-progress" }],
            }),
        ];
        const fetchMock = createApi(tasks);
        Object.defineProperty(globalThis, "fetch", {
            configurable: true,
            value: fetchMock,
            writable: true,
        });
        const user = userEvent.setup();

        renderWithQueryClient(createElement(Tasks));

        expect(await screen.findByText("Ship Bun test reset")).toBeInTheDocument();
        expect(screen.getByText("In Progress")).toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: /new task/i }));
        await user.type(screen.getByLabelText("Title"), "Write useful tests");
        await user.type(
            screen.getByLabelText("Description (optional)"),
            "Cover behavior"
        );
        await user.click(
            within(screen.getByRole("dialog")).getByRole("button", { name: "Raymond" })
        );
        await user.click(screen.getByRole("button", { name: /^Create Task$/i }));

        await waitFor(() =>
            expect(fetchMock).toHaveBeenCalledWith(
                "/api/tasks",
                expect.objectContaining({ method: "POST" })
            )
        );
        expect(await screen.findByText("Write useful tests")).toBeInTheDocument();
    });

    it("keeps task classification and search aligned with dashboard behavior", () => {
        const unlabelled = task({ number: 2, title: "Default priority" });
        const lowPriority = task({
            number: 4,
            title: "Low priority task",
            labels: [{ name: "priority-low" }],
        });
        const blocked = task({
            number: 3,
            title: "Waiting on deploy",
            labels: [{ name: "blocked" }],
            automation: {
                type: "cron",
                recurring: true,
                cronJobId: "daily-check",
                scheduleSummary: "Every 1h",
            },
        });

        expect(getPriority(unlabelled.labels)).toBe("medium");
        expect(getPriority(lowPriority.labels)).toBe("low");
        expect(getColumnId(blocked)).toBe("blocked");
        expect(isTaskMatchSearch(blocked, "daily-check")).toBe(true);
        expect(isTaskMatchSearch(blocked, "#3")).toBe(true);
        expect(isTaskMatchSearch(blocked, "not-present")).toBe(false);
    });
});
